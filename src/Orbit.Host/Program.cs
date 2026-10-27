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
#if ORBIT_DIAGNOSTICS
DiagnosticSource.Options diagnosticOptions;
try { diagnosticOptions = DiagnosticSource.PrepareEnvironment(loopbackTest, Environment.GetEnvironmentVariable("ORBIT_DATA_DIR")); }
catch (Exception ex) when (ex is ArgumentException or PlatformUnavailableException)
{ Console.Error.WriteLine(ex.Message); return 2; }
#endif
using var parentProof = Environment.GetEnvironmentVariable("ORBIT_PARENT_PROOF") == "1"
    ? await ParentProof.ReadBootstrapAsync(Console.In) : null;
var network = await TailscaleNetwork.DiscoverAsync(loopbackTest);
var dataDirectory = Environment.GetEnvironmentVariable("ORBIT_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OrbitRemote", "host");
var state = new HostState(Path.GetFullPath(dataDirectory));
using var identity = new HostIdentity(dataDirectory, state.HostId, network.Address is null ? null : IPAddress.Parse(network.Address), allowExpiredForLocalAdministration: true);
#if ORBIT_DIAGNOSTICS
await using var platform = DiagnosticSource.Create(diagnosticOptions);
#else
await using var platform = PlatformBackendFactory.Create();
#endif
var startedAt = DateTimeOffset.UtcNow;
var remoteAddress = network.Address is null || identity.Health.Expired ? null : $"https://{network.Address}:{remotePort}";
var identityRotationPending = 0;
var remoteIdentityCache = new ConcurrentDictionary<string, DateTimeOffset>();
var captureGate = new SemaphoreSlim(1, 1);
var inputGate = new SemaphoreSlim(1, 1);
var inputLeases = new InputLeases();
var frameWaits = new FrameWaitGate();

var builder = WebApplication.CreateBuilder(args.Where(a => a != "--loopback-test").ToArray());
HostShutdown.Add(builder.Services);
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
    if (remoteAddress is not null)
        options.Listen(IPAddress.Parse(network.Address!), remotePort, listener =>
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
var shutdown = app.Services.GetRequiredService<HostShutdown>();
var uploads = new UploadStore(state, UploadMetadata.Create(app.Logger),
    () => app.Logger.LogWarning("An upload staging file could not be removed; a later startup will retry stale staging cleanup."));
var cleanupWarning = 0;
uploads.CleanupStale(DateTimeOffset.UtcNow, () =>
{
    if (Interlocked.Exchange(ref cleanupWarning, 1) == 0) app.Logger.LogWarning("Some stale upload staging files could not be cleaned up.");
});

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
RemoteSession? Session(HttpContext context, string id, Func<DevicePermissions, bool> permission, bool allowStopping = false) =>
    SessionAccess.FindSession(state, Peer(context), id, permission,
        identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0,
        shutdown.IsStopping || app.Lifetime.ApplicationStopping.IsCancellationRequested, allowStopping);
async Task<PlatformStatus> PlatformInfo(CancellationToken cancellationToken)
{
    var status = await platform.GetStatusAsync(cancellationToken);
    return status with { CanLocalCursor = status.CanCapture && VideoStreamEndpoints.CanLocalCursor(platform) };
}
object SessionInfo(RemoteSession session) => new
{
    session.Id, session.DeviceId, session.DeviceName, session.MonitorId, session.Permissions, session.CreatedAt,
    session.ExpiresAt, session.LastActivityAt, session.LastInputAt, session.ResumeEpoch,
    canVideoStream = VideoStreamEndpoints.CanVideoStream, videoCodecs = VideoStreamEndpoints.VideoCodecs,
    canLocalCursor = VideoStreamEndpoints.CanLocalCursor(platform),
    canWakeDisplay = DisplayAvailability.CanWake(platform),
};

app.Use(async (context, next) =>
{
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
    if (context.Request.Headers.ContainsKey("Origin") || context.Request.Headers.ContainsKey("Sec-Fetch-Site"))
    { context.Response.StatusCode = 403; await context.Response.WriteAsJsonAsync(new { error = "Browser requests are not accepted. Use the Orbit desktop application." }); return; }
    var requestSize = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (requestSize is { IsReadOnly: false }) requestSize.MaxRequestBodySize = RequestBodyPolicy.LimitFor(context.Request.Method, context.Request.Path, maxTransferBytes);
    if (IsLocal(context))
    {
        if (!IPAddress.IsLoopback(context.Connection.RemoteIpAddress ?? IPAddress.None) || context.Request.Host.Host != "127.0.0.1") { context.Response.StatusCode = 403; return; }
        if (context.Request.Path != "/api/parent-proof" || parentProof is null)
        {
            var authorization = context.Request.Headers.Authorization.ToString();
            if (!authorization.StartsWith("Bearer ", StringComparison.Ordinal) || !Security.TokenEquals(authorization[7..], controlToken)) { context.Response.StatusCode = 401; return; }
        }
    }
    else
    {
        if (identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0) { context.Response.StatusCode = 503; return; }
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
    await SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger);
});
app.UseRateLimiter();

app.MapGet("/api/parent-proof", (HttpContext context) =>
{
    if (!IsLocal(context) || parentProof is null) return Results.NotFound();
    var challenges = context.Request.Headers["X-Orbit-Challenge"];
    if (challenges.Count != 1) return Results.BadRequest(new { error = "One parent challenge is required." });
    var payload = JsonSerializer.SerializeToUtf8Bytes(parentProof.CreateResponse(challenges.ToString(), context.Connection.LocalPort, context.Connection.RemotePort));
    context.Response.ContentLength = payload.Length;
    return Results.Bytes(payload, "application/json");
});

app.MapGet("/api/status", async (HttpContext context) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    return Results.Ok(new { state.HostId, state.HostName, version = "0.1.0", startedAt,
#if ORBIT_DIAGNOSTICS
        diagnosticSource = DiagnosticSource.Status(platform),
#endif
        remoteEnabled = remoteAddress is not null && !identity.Health.Expired && Volatile.Read(ref identityRotationPending) == 0, remoteAddress, certificateFingerprint = identity.Fingerprint, identity = identity.Health, transport = network, platform = await PlatformInfo(context.RequestAborted), settings = state.Settings, pairedDevices = state.Devices, sessions = state.Sessions });
});
app.MapGet("/api/peers", (HttpContext context) => LocalOnly(context, () => Results.Ok(state.Devices)));
app.MapGet("/api/tailnet-peers", (HttpContext context) => LocalOnly(context, () => Results.Ok(network.Peers)));
app.MapGet("/api/audit", (HttpContext context) => LocalOnly(context, () => Results.Ok(state.Audit)));
app.MapGet("/api/settings", (HttpContext context) => LocalOnly(context, () => Results.Ok(state.Settings)));
app.MapPut("/api/settings", (HttpContext context, HostSettings settings) => LocalOnly(context, () => { state.UpdateSettings(settings); return Results.Ok(state.Settings); }));
app.MapGet("/api/identity/export", (HttpContext context) => LocalOnly(context, () => identity.Health.Expired ? Results.Conflict(new { error = "Host identity expired. Rotate it locally and pair devices again before connecting." }) : Volatile.Read(ref identityRotationPending) != 0 ? Results.Conflict(new { error = "Identity recovery is in progress." }) : Results.Ok(identity.ExportForLocalController())));
app.MapGet("/api/client-identity", (HttpContext context) => LocalOnly(context, () => identity.Health.Expired ? Results.Conflict(new { error = "Host identity expired. Rotate it locally and pair devices again before connecting." }) : Volatile.Read(ref identityRotationPending) != 0 ? Results.Conflict(new { error = "Identity recovery is in progress." }) : Results.Ok(identity.ExportForLocalController())));
app.MapPost("/api/identity/rotate", async (HttpContext context, IdentityRotationRequest request) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    if (!request.ConfirmRePair) return Results.BadRequest(new { error = "Confirm that every device must pair again before rotating this identity." });
    if (!Security.TokenEquals(request.ExpectedFingerprint, identity.Fingerprint)) return Results.Conflict(new { error = "The current identity changed. Review its fingerprint and confirm again." });
    if (Interlocked.CompareExchange(ref identityRotationPending, 1, 0) != 0) return Results.Conflict(new { error = "Identity recovery is already in progress." });
    try
    {
        state.EndAllSessions(explicitHostStop: false);
        await inputGate.WaitAsync(context.RequestAborted);
        try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); } finally { inputGate.Release(); }
        var revoked = 0;
        identity.Rotate(request.ExpectedFingerprint, () => revoked = state.InvalidatePairingsForIdentityRotation());
        state.AddAudit("identity.rotated", null, $"Identity rotated; {revoked} pairings revoked. Every device must pair again.");
        context.Response.OnCompleted(() => { app.Lifetime.StopApplication(); return Task.CompletedTask; });
        return Results.Accepted(value: new { state = "restarting", pairingsRevoked = revoked, requiresRePair = true });
    }
    catch { Volatile.Write(ref identityRotationPending, 0); throw; }
});
app.MapPost("/api/invites", (HttpContext context, InviteRequest request) => LocalOnly(context, () => remoteAddress is null || identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0 ? Results.Conflict(new { error = "Remote listening is unavailable. Check Tailscale and identity status before pairing." }) : Results.Ok(state.CreateInvite(request, remoteAddress, identity.Fingerprint))));
app.MapDelete("/api/peers/{id}", async (HttpContext context, string id) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    if (!state.Revoke(id, out var revokedControllingSession)) return Results.NotFound();
    if (!revokedControllingSession) return Results.NoContent();
    await inputGate.WaitAsync(context.RequestAborted);
    try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); } finally { inputGate.Release(); }
    return Results.NoContent();
});
app.MapPost("/api/peers/{id}/allow", (HttpContext context, string id) =>
    LocalOnly(context, () => state.AllowDevice(id) is { } device ? Results.Ok(device) : Results.NotFound()));
app.MapPost("/api/peers/{id}/block", async (HttpContext context, string id) =>
{
    if (!IsLocal(context)) return Results.NotFound();
    if (!state.BlockDevice(id, out var endedControllingSession)) return Results.NotFound();
    if (!endedControllingSession) return Results.NoContent();
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
app.MapGet("/api/info", async (HttpContext context) => Peer(context) is { } peer ? Results.Ok(new { state.HostId, state.HostName, platform = await PlatformInfo(context.RequestAborted), permissions = peer.Permissions, settings = new { state.Settings.AllowRemotePower, state.Settings.FileTransferEnabled } }) : Results.NotFound());
app.MapSessions(state, platform, Peer, (context, id) => Session(context, id, p => p.View, allowStopping: true), SessionInfo,
    () => identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0, inputGate, inputLeases, shutdown);
app.MapDelete("/api/sessions/{id}", async (HttpContext context, string id) =>
{
    var deviceId = IsLocal(context) ? null : Peer(context)?.Id;
    if (!IsLocal(context) && deviceId is null || !state.EndSession(id, deviceId, out var endedControllingSession)) return Results.NotFound();
    if (!endedControllingSession) return Results.NoContent();
    await inputGate.WaitAsync(context.RequestAborted);
    try { await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear(); } finally { inputGate.Release(); }
    return Results.NoContent();
});
app.MapVideoStream(state, platform, () => identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0, Peer);
app.MapFrame(state, platform, (context, id) => Session(context, id, p => p.View, allowStopping: true), Peer,
    () => identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0, captureGate, frameWaits, shutdown);
using var inputShutdown = new InputEndpoints(app, state, platform, (context, id) => Session(context, id, p => p.Control),
    inputGate, inputLeases, shutdown, message => Console.Error.WriteLine(message));
app.MapWakeDisplay(state, platform, (context, id) => Session(context, id, p => p.View, allowStopping: true),
    Peer, () => identity.Health.Expired || Volatile.Read(ref identityRotationPending) != 0, inputGate, shutdown);
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
    // Denied requests must not queue behind or delay another device's input.
    if (Session(context, id, p => p.Power && p.Control) is null || !state.Settings.AllowRemotePower) return Results.NotFound();
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
app.MapList(state, (context, id) => Session(context, id, p => p.Files));
app.MapDownload(state, (context, id) => Session(context, id, p => p.Files), maxTransferBytes, shutdown);
app.MapUpload(state, uploads, (context, id) => Session(context, id, p => p.Files), maxTransferBytes, shutdown);

state.AddAudit("host.started", null, identity.Health.Expired ? "Host identity expired. Only local recovery is available." : network.Mode == "loopback-test" ? "Local integration-test mode. Remote listener is loopback only." : remoteAddress is null ? "Host started offline. No remote listener." : "Host started on verified Tailscale address.");
// Keep authorization metadata available during the bounded terminal drain:
// otherwise a new frame/stream/control request observes a misleading 404.
// Input/data routes already refuse work once ApplicationStopping is cancelled.
app.Lifetime.ApplicationStopped.Register(() => state.EndAllSessions(false));
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
Console.WriteLine(remoteAddress is null ? "Remote listening disabled. Check Tailscale and identity status." : $"Remote mTLS listener: {remoteAddress} ({network.Mode})");
try { await app.RunAsync(); }
finally
{
    // A final serialized release also covers cleanup/callback failures and a
    // late native completion while the host was tearing down.
    try { await inputShutdown.ReleaseAsync(); }
    catch (Exception ex) { Console.Error.WriteLine($"Best-effort final input release failed ({ex.GetType().Name})."); }
}
try { await inputSafetyTask.WaitAsync(TimeSpan.FromSeconds(2)); }
catch (TimeoutException) { Console.Error.WriteLine("Input safety worker did not stop within its shutdown budget."); }
return 0;

static int PortFromEnvironment(string name, int defaultPort)
{
    var value = Environment.GetEnvironmentVariable(name);
    if (value is null) return defaultPort;
    return int.TryParse(value, out var port) && port is > 1023 and <= 65535 ? port : throw new ArgumentException($"{name} must be a port between 1024 and 65535.");
}
