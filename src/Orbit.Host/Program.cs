using System.Collections.Concurrent;
using System.Net;
using System.Security.Authentication;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Connections.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Https;
using Orbit.Host;
using Orbit.Host.Platform;

var controlPort = PortFromEnvironment("ORBIT_CONTROL_PORT", 47831);
var remotePort = PortFromEnvironment("ORBIT_REMOTE_PORT", 47832);
if (controlPort == remotePort) throw new ArgumentException("Control and remote ports must be different.");
const long maxTransferBytes = 32L * 1024 * 1024;
var controlToken = Environment.GetEnvironmentVariable("ORBIT_CONTROL_TOKEN");
if (string.IsNullOrWhiteSpace(controlToken) || controlToken.Length < 32)
{
    Console.Error.WriteLine("ORBIT_CONTROL_TOKEN must contain at least 32 characters. Start Orbit from its desktop application or set a cryptographically random local control token.");
    return 2;
}
var loopbackTest = args.Contains("--loopback-test", StringComparer.Ordinal);
var network = await TailscaleNetwork.DiscoverAsync(loopbackTest);
var dataDirectory = Environment.GetEnvironmentVariable("ORBIT_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OrbitRemote", "host");
var state = new HostState(Path.GetFullPath(dataDirectory));
using var identity = new HostIdentity(dataDirectory, state.HostId, network.Address is null ? null : IPAddress.Parse(network.Address));
await using var platform = PlatformBackendFactory.Create();
var startedAt = DateTimeOffset.UtcNow;
var remoteAddress = network.Address is null ? null : $"https://{network.Address}:{remotePort}";
var remoteIdentityCache = new ConcurrentDictionary<string, DateTimeOffset>();
var captureGate = new SemaphoreSlim(1, 1);
var inputGate = new SemaphoreSlim(1, 1);
var inputLeases = new InputLeases();

var builder = WebApplication.CreateBuilder(args.Where(a => a != "--loopback-test").ToArray());
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
builder.WebHost.ConfigureKestrel(options =>
{
    var linkLogger = options.ApplicationServices.GetRequiredService<ILoggerFactory>().CreateLogger("Orbit.TlsPolicy");
    long nextWeakLinkWarning = 0;
    options.AddServerHeader = false;
    options.Limits.MaxRequestBodySize = maxTransferBytes;
    options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
    options.Limits.KeepAliveTimeout = TimeSpan.FromSeconds(30);
    options.Listen(IPAddress.Loopback, controlPort);
    if (network.Address is not null)
        options.Listen(IPAddress.Parse(network.Address), remotePort, listener =>
        {
            listener.UseHttps(new HttpsConnectionAdapterOptions
            {
                ServerCertificate = identity.Certificate,
                ClientCertificateMode = ClientCertificateMode.RequireCertificate,
                ClientCertificateValidation = (certificate, _, _) => Security.IsClientCertificateUsable(certificate),
                SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CheckCertificateRevocation = false // Exact certificate pins, not a public CA, authorize peers below.
            });
            // Runs after the handshake and before HTTP parsing. Platform TLS stacks (Schannel)
            // still accept CBC and static-RSA suites, so drop any connection below Orbit's link
            // policy before a pairing secret or request can be read over it.
            listener.Use(next => async connection =>
            {
                var tls = connection.Features.Get<ITlsHandshakeFeature>();
                if (tls is null || !Security.IsStrongTls(tls.Protocol, tls.NegotiatedCipherSuite))
                {
                    // Diagnose native TLS incompatibility without allowing rejected
                    // connections to flood the unattended host log.
                    var now = Environment.TickCount64;
                    var nextWarning = Volatile.Read(ref nextWeakLinkWarning);
                    if (now >= nextWarning && Interlocked.CompareExchange(ref nextWeakLinkWarning, now + 30_000, nextWarning) == nextWarning)
                        linkLogger.LogWarning("Rejected TLS link below policy: {Protocol}, {CipherSuite}, {RemoteEndpoint}. Further warnings suppressed for 30 seconds.", tls?.Protocol, tls?.NegotiatedCipherSuite, connection.RemoteEndPoint);
                    connection.Abort(); return;
                }
                await next(connection);
            });
        });
});
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("pairing", context => RateLimitPartition.GetFixedWindowLimiter(context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions { PermitLimit = 6, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
    options.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(context => RateLimitPartition.GetTokenBucketLimiter(context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new TokenBucketRateLimiterOptions { TokenLimit = 160, TokensPerPeriod = 120, ReplenishmentPeriod = TimeSpan.FromSeconds(1), AutoReplenishment = true, QueueLimit = 0 }));
});
var app = builder.Build();

// The desktop main process owns its child through a private stdin pipe. An
// unexpected owner exit closes that pipe, so the host cannot outlive its owner.
// Standalone CLI operation leaves this disabled and does not depend on stdin.
if (Environment.GetEnvironmentVariable("ORBIT_PARENT_WATCH") == "1")
{
    _ = Task.Run(async () =>
    {
        try
        {
            while (await Console.In.ReadLineAsync(app.Lifetime.ApplicationStopping) is not null) { }
            if (!app.Lifetime.ApplicationStopping.IsCancellationRequested)
            {
                app.Logger.LogWarning("Desktop owner pipe closed; stopping the host.");
                app.Lifetime.StopApplication();
            }
        }
        catch (OperationCanceledException) when (app.Lifetime.ApplicationStopping.IsCancellationRequested) { }
        catch (IOException)
        {
            if (!app.Lifetime.ApplicationStopping.IsCancellationRequested) app.Lifetime.StopApplication();
        }
    });
}

bool IsLocal(HttpContext context) => context.Connection.LocalPort == controlPort;
IResult LocalOnly(HttpContext context, Func<IResult> action) => IsLocal(context) ? action() : Results.NotFound();
PairedDevice? Peer(HttpContext context) => context.Items.TryGetValue("peer", out var value) ? value as PairedDevice : null;
RemoteSession? Session(HttpContext context, string id, Func<DevicePermissions, bool> permission)
{
    var requestPeer = Peer(context);
    var peer = requestPeer is null ? null : state.FindDevice(requestPeer.Fingerprint);
    if (peer is null || !permission(peer.Permissions)) return null;
    var session = state.GetSession(id, peer.Id);
    return session is not null && permission(session.Permissions) ? session : null;
}

app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
    if (context.Request.Headers.ContainsKey("Origin") || context.Request.Headers.ContainsKey("Sec-Fetch-Site"))
    { context.Response.StatusCode = 403; await context.Response.WriteAsJsonAsync(new { error = "Browser requests are not accepted. Use the Orbit desktop application." }); return; }
    var requestSize = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (requestSize is { IsReadOnly: false }) requestSize.MaxRequestBodySize = context.Request.Path.Value?.Contains("/files/", StringComparison.Ordinal) == true ? maxTransferBytes : 16384;
    if (IsLocal(context))
    {
        if (!IPAddress.IsLoopback(context.Connection.RemoteIpAddress ?? IPAddress.None) || context.Request.Host.Host != "127.0.0.1") { context.Response.StatusCode = 403; return; }
        var authorization = context.Request.Headers.Authorization.ToString();
        if (!authorization.StartsWith("Bearer ", StringComparison.Ordinal) || !Security.TokenEquals(authorization[7..], controlToken)) { context.Response.StatusCode = 401; return; }
    }
    else
    {
        if (!context.Request.IsHttps) { context.Response.StatusCode = 403; return; }
        var certificate = await context.Connection.GetClientCertificateAsync(context.RequestAborted);
        if (!Security.IsClientCertificateUsable(certificate)) { context.Response.StatusCode = 401; return; }
        var source = context.Connection.RemoteIpAddress?.ToString() ?? "";
        if (!remoteIdentityCache.TryGetValue(source, out var verifiedUntil) || verifiedUntil <= DateTimeOffset.UtcNow)
        {
            if (!await network.VerifyRemoteAsync(context.Connection.RemoteIpAddress, context.RequestAborted)) { context.Response.StatusCode = 403; return; }
            if (remoteIdentityCache.Count > 1024) remoteIdentityCache.Clear();
            remoteIdentityCache[source] = DateTimeOffset.UtcNow.AddSeconds(10);
        }
        if (context.Request.Path != "/api/pair")
        {
            var peer = state.FindDevice(Security.Fingerprint(certificate!));
            if (peer is null) { context.Response.StatusCode = 401; return; }
            context.Items["peer"] = peer;
        }
    }
    try { await next(context); }
    catch (SessionEndedException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 410; await context.Response.WriteAsJsonAsync(new { error = ex.Message, code = "session_ended_by_host" }); } }
    catch (PlatformUnavailableException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 409; await context.Response.WriteAsJsonAsync(new { error = ex.Message, code = ex.Code }); } }
    catch (ArgumentException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 400; await context.Response.WriteAsJsonAsync(new { error = ex.Message }); } }
    catch (UnauthorizedAccessException) { if (!context.Response.HasStarted) { context.Response.StatusCode = 403; await context.Response.WriteAsJsonAsync(new { error = "Access denied or pairing invite invalid." }); } }
    catch (InvalidOperationException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 409; await context.Response.WriteAsJsonAsync(new { error = ex.Message }); } }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    catch (BadHttpRequestException) { if (!context.Response.HasStarted) context.Response.StatusCode = 400; }
    catch (Exception ex)
    {
        app.Logger.LogError("Request failed ({ExceptionType}).", ex.GetType().Name);
        if (!context.Response.HasStarted) { context.Response.StatusCode = 500; await context.Response.WriteAsJsonAsync(new { error = "The host could not complete this operation. Check local status and audit events." }); }
    }
});
app.UseRateLimiter();

app.MapGet("/api/status", async (HttpContext context) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    return Results.Ok(new { state.HostId, state.HostName, version = "0.1.0", startedAt, remoteEnabled = remoteAddress is not null, remoteAddress, certificateFingerprint = identity.Fingerprint, transport = network, platform = await platform.GetStatusAsync(context.RequestAborted), settings = state.Settings, pairedDevices = state.Devices, sessions = state.Sessions });
});
app.MapGet("/api/peers", (HttpContext context) => LocalOnly(context, () => Results.Ok(state.Devices)));
app.MapGet("/api/tailnet-peers", (HttpContext context) => LocalOnly(context, () => Results.Ok(network.Peers)));
app.MapGet("/api/audit", (HttpContext context) => LocalOnly(context, () => Results.Ok(state.Audit)));
app.MapGet("/api/settings", (HttpContext context) => LocalOnly(context, () => Results.Ok(state.Settings)));
app.MapPut("/api/settings", (HttpContext context, HostSettings settings) => LocalOnly(context, () => { state.UpdateSettings(settings); return Results.Ok(state.Settings); }));
app.MapGet("/api/identity/export", (HttpContext context) => LocalOnly(context, () => Results.Ok(identity.ExportForLocalController())));
app.MapGet("/api/client-identity", (HttpContext context) => LocalOnly(context, () => Results.Ok(identity.ExportForLocalController())));
app.MapPost("/api/invites", (HttpContext context, InviteRequest request) => LocalOnly(context, () => remoteAddress is null ? Results.Conflict(new { error = "Tailscale is unavailable. Pairing is disabled." }) : Results.Ok(state.CreateInvite(request, remoteAddress, identity.Fingerprint))));
app.MapDelete("/api/peers/{id}", async (HttpContext context, string id) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    if (!state.Revoke(id)) return Results.NotFound();
    await inputGate.WaitAsync(context.RequestAborted);
    try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); } finally { inputGate.Release(); }
    return Results.NoContent();
});
app.MapPost("/api/disconnect-all", async (HttpContext context) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    state.EndAllSessions();
    await inputGate.WaitAsync(context.RequestAborted);
    try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); } finally { inputGate.Release(); }
    return Results.NoContent();
});

app.MapPost("/api/pair", async (HttpContext context, PairRequest request) =>
{
    if (IsLocal(context)) return Results.NotFound();
    var certificate = await context.Connection.GetClientCertificateAsync(context.RequestAborted);
    var device = state.Pair(request, Security.Fingerprint(certificate!));
    return Results.Ok(new { deviceId = device.Id, deviceName = device.Name, hostId = state.HostId, hostName = state.HostName, device.Permissions, certificateFingerprint = identity.Fingerprint });
}).RequireRateLimiting("pairing");
app.MapGet("/api/info", async (HttpContext context) => Peer(context) is { } peer ? Results.Ok(new { state.HostId, state.HostName, platform = await platform.GetStatusAsync(context.RequestAborted), permissions = peer.Permissions, settings = new { state.Settings.AllowRemotePower, state.Settings.FileTransferEnabled } }) : Results.NotFound());
app.MapPost("/api/sessions", async (HttpContext context, SessionRequest request) =>
{
    var peer = Peer(context); if (peer is null || !peer.Permissions.View) return Results.StatusCode(403);
    var status = await platform.GetStatusAsync(context.RequestAborted);
    if (!status.CanCapture) return Results.Conflict(new { error = "Screen capture is unavailable in the current desktop session.", status.Limitations });
    if (request.MonitorId is not null && !status.Monitors.Any(m => m.Id == request.MonitorId)) return Results.BadRequest(new { error = "Unknown monitor." });
    if (peer.Permissions.Control && !request.ViewOnly)
    {
        await inputGate.WaitAsync(context.RequestAborted);
        try
        {
            // Do not disturb an existing controller when another request is rejected.
            if (!state.Sessions.Any(s => s.Permissions.Control)) { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); }
            return Results.Ok(state.StartSession(peer, request.MonitorId, request.ViewOnly, request.ResumeEpoch));
        }
        finally { inputGate.Release(); }
    }
    return Results.Ok(state.StartSession(peer, request.MonitorId, request.ViewOnly, request.ResumeEpoch));
});
app.MapGet("/api/sessions/{id}", (HttpContext context, string id) => Session(context, id, p => p.View) is { } session ? Results.Ok(session) : Results.NotFound());
app.MapDelete("/api/sessions/{id}", async (HttpContext context, string id) =>
{
    var deviceId = IsLocal(context) ? null : Peer(context)?.Id;
    if (!IsLocal(context) && deviceId is null || !state.EndSession(id, deviceId)) return Results.NotFound();
    await inputGate.WaitAsync(context.RequestAborted);
    try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); } finally { inputGate.Release(); }
    return Results.NoContent();
});
app.MapGet("/api/sessions/{id}/frame", async (HttpContext context, string id) =>
{
    var session = Session(context, id, p => p.View); if (session is null) return Results.NotFound();
    var requestedMonitor = context.Request.Query["monitorId"];
    if (requestedMonitor.Count > 1) return Results.BadRequest(new { error = "Supply only one monitorId per frame request." });
    // A viewer may select any existing host monitor while sharing its authenticated
    // control session with other windows; this does not create a virtual display.
    var monitorId = Security.SelectFrameMonitor(requestedMonitor.Count == 0 ? null : requestedMonitor.ToString(), session.MonitorId);
    await captureGate.WaitAsync(context.RequestAborted);
    try
    {
        // Recheck after waiting so local revocation also cancels queued captures.
        if (state.FindDevice(Peer(context)!.Fingerprint) is null || state.GetSession(id, session.DeviceId) is null) return Results.NotFound();
        var frame = await platform.CaptureAsync(monitorId, context.RequestAborted);
        if (Session(context, id, p => p.View) is null) return Results.NotFound();
        context.Response.Headers["X-Orbit-Width"] = frame.Width.ToString(); context.Response.Headers["X-Orbit-Height"] = frame.Height.ToString();
        context.Response.Headers["X-Orbit-Left"] = frame.Left.ToString(); context.Response.Headers["X-Orbit-Top"] = frame.Top.ToString();
        context.Response.Headers["X-Orbit-Captured-At"] = frame.CapturedUtc.ToString("O");
        return Results.Bytes(frame.Png, "image/png");
    }
    finally { captureGate.Release(); }
});
app.MapPost("/api/sessions/{id}/input", async (HttpContext context, string id, RemoteInput input) =>
{
    var session = Session(context, id, p => p.Control); if (session is null) return Results.NotFound();
    await inputGate.WaitAsync(context.RequestAborted);
    try
    {
        if (state.FindDevice(Peer(context)!.Fingerprint) is null || state.GetSession(id, session.DeviceId) is null) return Results.NotFound();
        await platform.ApplyInputAsync(input, context.RequestAborted);
        inputLeases.Record(id, input, DateTimeOffset.UtcNow); state.TouchInput(id);
        return Results.NoContent();
    }
    finally { inputGate.Release(); }
});
app.MapPost("/api/sessions/{id}/release-inputs", async (HttpContext context, string id) =>
{
    if (Session(context, id, p => p.Control) is null) return Results.NotFound();
    await inputGate.WaitAsync(context.RequestAborted);
    try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); return Results.NoContent(); } finally { inputGate.Release(); }
});
app.MapGet("/api/sessions/{id}/clipboard", async (HttpContext context, string id) =>
{
    if (Session(context, id, p => p.Clipboard) is null) return Results.NotFound();
    var text = await platform.ReadClipboardAsync(context.RequestAborted);
    if (Session(context, id, p => p.Clipboard) is null) return Results.NotFound();
    return Results.Ok(new { text });
});
app.MapPut("/api/sessions/{id}/clipboard", async (HttpContext context, string id, ClipboardRequest request) =>
{
    if (Session(context, id, p => p.Clipboard) is null) return Results.NotFound();
    if (request.Text is null || request.Text.Length > 8192) return Results.BadRequest(new { error = "Clipboard text is limited to 8,192 characters." });
    await inputGate.WaitAsync(context.RequestAborted);
    try
    {
        if (Session(context, id, p => p.Clipboard) is null) return Results.NotFound();
        await platform.WriteClipboardAsync(request.Text, context.RequestAborted); return Results.NoContent();
    }
    finally { inputGate.Release(); }
});
app.MapPost("/api/sessions/{id}/power", async (HttpContext context, string id, PowerRequest request) =>
{
    await inputGate.WaitAsync(context.RequestAborted);
    try
    {
        var session = Session(context, id, p => p.Power && p.Control);
        if (session is null || !state.Settings.AllowRemotePower) return Results.NotFound();
        if (request.Action == "restart")
        {
            state.AddAudit("power.restart.requested", session.DeviceId, "Approved remote restart requested; reconnect requires verified OS startup configuration.");
            await PowerActions.RequestRestartAsync(context.RequestAborted);
            return Results.Accepted(value: new { state = "requested", message = "The operating system accepted the restart command. Automatic reconnection requires Orbit and Tailscale startup configuration; pre-login access is not verified." });
        }
        if (request.Action != "lock") return Results.BadRequest(new { error = "Supported power actions are lock and restart." });
        await platform.LockAsync(context.RequestAborted); state.AddAudit("power.lock", session.DeviceId, "Approved remote lock action requested."); return Results.NoContent();
    }
    finally { inputGate.Release(); }
});
app.MapGet("/api/sessions/{id}/files", (HttpContext context, string id) =>
{
    if (Session(context, id, p => p.Files) is null || !state.Settings.FileTransferEnabled) return Results.NotFound();
    var sentinel = state.GetSafeFilePath("orbit-validation");
    var files = Directory.EnumerateFiles(Path.GetDirectoryName(sentinel)!).Where(f => (File.GetAttributes(f) & FileAttributes.ReparsePoint) == 0).Take(500).Select(f => new FileInfo(f)).Select(f => new { name = f.Name, size = f.Length, modifiedAt = f.LastWriteTimeUtc }).ToArray();
    return Results.Ok(files);
});
app.MapGet("/api/sessions/{id}/files/{name}", (HttpContext context, string id, string name) =>
{
    if (Session(context, id, p => p.Files) is null) return Results.NotFound();
    var path = state.GetSafeFilePath(name); if (!File.Exists(path)) return Results.NotFound();
    if (new FileInfo(path).Length > maxTransferBytes) return Results.BadRequest(new { error = "Files are limited to 32 MiB." });
    state.AddAudit("file.download", Peer(context)!.Id, "A file was downloaded from the configured transfer folder.");
    return Results.File(path, "application/octet-stream", fileDownloadName: name, enableRangeProcessing: false);
});
app.MapPut("/api/sessions/{id}/files/{name}", async (HttpContext context, string id, string name) =>
{
    if (Session(context, id, p => p.Files) is null) return Results.NotFound();
    var path = state.GetSafeFilePath(name);
    if (File.Exists(path)) return Results.Conflict(new { error = "That file exists. Choose another file name; remote uploads never overwrite files." });
    // CreateNew prevents remote replacement of an existing path. No arbitrary filesystem access.
    await using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous);
    Security.RestrictFile(path);
    try
    {
        var buffer = new byte[65536]; long total = 0; int read;
        while ((read = await context.Request.Body.ReadAsync(buffer, context.RequestAborted)) > 0)
        {
            total += read; if (total > maxTransferBytes) throw new BadHttpRequestException("File too large.", 413);
            if (state.FindDevice(Peer(context)!.Fingerprint) is null || Session(context, id, p => p.Files) is null || !state.Settings.FileTransferEnabled) throw new UnauthorizedAccessException();
            await output.WriteAsync(buffer.AsMemory(0, read), context.RequestAborted);
        }
    }
    catch { await output.DisposeAsync(); File.Delete(path); throw; }
    state.AddAudit("file.upload", Peer(context)!.Id, "A file was uploaded to the configured transfer folder.");
    return Results.Created($"/api/sessions/{id}/files/{Uri.EscapeDataString(name)}", new { name, size = output.Length });
});

state.AddAudit("host.started", null, network.Mode == "loopback-test" ? "Local integration-test mode. Remote listener is loopback only." : network.Address is null ? "Host started offline. No remote listener." : "Host started on verified Tailscale address.");
app.Lifetime.ApplicationStopping.Register(() =>
{
    state.EndAllSessions(false);
    try { platform.ReleaseInputsAsync().GetAwaiter().GetResult(); }
    catch (Exception ex) { app.Logger.LogWarning("Best-effort input release during shutdown failed ({ExceptionType}).", ex.GetType().Name); }
});
var inputSafetyTask = Task.Run(async () =>
{
    var activeControl = false;
    var releasedIdleSession = "";
    using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
    try
    {
        while (await timer.WaitForNextTickAsync(app.Lifetime.ApplicationStopping))
        {
            var controlling = state.Sessions.FirstOrDefault(s => s.Permissions.Control);
            var inactive = controlling is not null && DateTimeOffset.UtcNow - controlling.LastActivityAt > TimeSpan.FromSeconds(10);
            if (activeControl && controlling is null || inactive && releasedIdleSession != controlling!.Id || inputLeases.HasExpired(DateTimeOffset.UtcNow))
            {
                await inputGate.WaitAsync(app.Lifetime.ApplicationStopping);
                try { await platform.ReleaseInputsAsync(app.Lifetime.ApplicationStopping); inputLeases.Clear(); } finally { inputGate.Release(); }
                releasedIdleSession = controlling?.Id ?? "";
            }
            if (controlling is not null && !inactive) releasedIdleSession = "";
            activeControl = controlling is not null;
        }
    }
    catch (OperationCanceledException) { }
    catch (Exception ex)
    {
        app.Logger.LogCritical("Input safety worker failed ({ExceptionType}); stopping the host.", ex.GetType().Name);
        state.EndAllSessions(false); app.Lifetime.StopApplication();
    }
});
Console.WriteLine($"Orbit Remote control: http://127.0.0.1:{controlPort}");
Console.WriteLine(remoteAddress is null ? "Remote listening disabled: Tailscale unavailable." : $"Remote mTLS listener: {remoteAddress} ({network.Mode})");
await app.RunAsync();
await inputSafetyTask;
return 0;

static int PortFromEnvironment(string name, int defaultPort)
{
    var value = Environment.GetEnvironmentVariable(name);
    if (value is null) return defaultPort;
    return int.TryParse(value, out var port) && port is > 1023 and <= 65535 ? port : throw new ArgumentException($"{name} must be a port between 1024 and 65535.");
}
