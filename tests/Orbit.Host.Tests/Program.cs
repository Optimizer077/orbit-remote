using System.Diagnostics;
using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Orbit.Host;
using Orbit.Host.Platform;

var failures = new List<string>();
var checks = 0;
void Check(bool condition, string message) { checks++; if (!condition) failures.Add(message); }
void Reject(Action action, string message)
{
    checks++;
    try { action(); failures.Add(message); } catch (Exception ex) when (ex is ArgumentException or UnauthorizedAccessException or InvalidOperationException) { }
}
var temporaryRoot = Path.Combine(Path.GetTempPath(), "orbit-security-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temporaryRoot);
Process? host = null;
Task<string>? hostOutput = null;
Task<string>? hostError = null;
try
{
    Check(Security.IsTailscaleAddress(IPAddress.Parse("100.64.0.1")), "Tailscale lower boundary is accepted");
    Check(Security.IsTailscaleAddress(IPAddress.Parse("100.127.255.255")), "Tailscale upper boundary is accepted");
    foreach (var ip in new[] { "100.63.255.255", "100.128.0.0", "192.168.1.1", "127.0.0.1", "::1", "fd7a:115c:a1e1::1" }) Check(!Security.IsTailscaleAddress(IPAddress.Parse(ip)), "Non-tailnet IP rejected: " + ip);
    Check(Security.IsTailscaleAddress(IPAddress.Parse("fd7a:115c:a1e0::1234")), "Tailscale IPv6 accepted");
    foreach (var path in new[] { "../secrets", "..\\secrets", "C:password", "CON", "NUL.txt", "test.", "test ", "a/b", "a\\b", "", ".", "..", "COM1.txt", "a\0b" }) Reject(() => Security.ValidateFileName(path), "Unsafe filename rejected: " + path);
    Check(Security.ValidateFileName("hello.txt") == "hello.txt", "Valid filename accepted");
    Check(Security.TokenEquals("a", "a") && !Security.TokenEquals("a", "b") && !Security.TokenEquals(null, null), "Constant-time token comparison semantics");
    Check(Security.IsStrongTls(SslProtocols.Tls13, TlsCipherSuite.TLS_AES_256_GCM_SHA384) && Security.IsStrongTls(SslProtocols.Tls13, TlsCipherSuite.TLS_CHACHA20_POLY1305_SHA256), "TLS 1.3 AEAD suites meet the link policy");
    Check(Security.IsStrongTls(SslProtocols.Tls12, TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384), "TLS 1.2 ECDHE + AES-GCM meets the link policy");
    foreach (var weak in new[] { TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA384, TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA, TlsCipherSuite.TLS_RSA_WITH_AES_256_GCM_SHA384, TlsCipherSuite.TLS_RSA_WITH_AES_128_CBC_SHA, TlsCipherSuite.TLS_DHE_RSA_WITH_AES_256_GCM_SHA384 })
        Check(!Security.IsStrongTls(SslProtocols.Tls12, weak), "Weak TLS 1.2 suite is refused: " + weak);
    Check(!Security.IsStrongTls(SslProtocols.Tls12, TlsCipherSuite.TLS_AES_256_GCM_SHA384), "TLS 1.3 suite reported with TLS 1.2 is refused");
#pragma warning disable SYSLIB0039 // Deliberately checks that obsolete protocol versions are refused.
    Check(!Security.IsStrongTls(SslProtocols.Tls11, TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384), "TLS 1.1 is refused");
#pragma warning restore SYSLIB0039
    Check(!Security.IsStrongTls(SslProtocols.Tls13, null), "Unknown negotiated suite is refused");
    Check(Security.SelectFrameMonitor(null, "session-monitor") == "session-monitor", "Absent frame monitor preserves session default");
    Check(Security.SelectFrameMonitor("second-monitor", "session-monitor") == "second-monitor", "Per-frame monitor selection does not change session default");
    Reject(() => Security.SelectFrameMonitor(new string('x', 129), null), "Oversized frame monitor is rejected before native capture");
    Reject(() => Security.SelectFrameMonitor("", null), "Explicit empty frame monitor is rejected");
    var lease = new InputLeases(); var leaseNow = DateTimeOffset.UtcNow;
    lease.Record("session", new("key", Key: "ShiftLeft", IsDown: true), leaseNow);
    lease.Record("session", new("pointerMove", X: 1, Y: 1), leaseNow.AddSeconds(9));
    Check(lease.HasExpired(leaseNow.AddSeconds(11)), "Mouse movement and frame polling cannot extend a lost key-up lease");
    lease.Record("session", new("key", Key: "ShiftLeft", IsDown: true), leaseNow.AddSeconds(9));
    Check(!lease.HasExpired(leaseNow.AddSeconds(11)), "Intentional repeat key-down renews only its held-key lease");
    lease.Record("session", new("key", Key: "ShiftLeft", IsDown: false), leaseNow.AddSeconds(12));
    Check(!lease.HasExpired(leaseNow.AddMinutes(1)), "Key-up clears its held lease");
    lease.Record("session", new("pointerButton", Button: "left", IsDown: true), leaseNow);
    Check(lease.HasExpired(leaseNow.AddSeconds(11)), "Lost pointer button-up also expires");
    lease.Clear(); Check(!lease.HasExpired(leaseNow.AddMinutes(1)), "Explicit disconnect clears input leases");

    SessionResumeChecks.Run(Check, Reject, temporaryRoot);
    var stateDir = Path.Combine(temporaryRoot, "unit-state");
    var state = new HostState(stateDir);
    Reject(() => state.CreateInvite(new(null, new()), "https://127.0.0.1:47832", "pin"), "No-permissions invitation rejected");
    var invite = state.CreateInvite(new("Approved computer", new(true, true, false, false, false)), "https://127.0.0.1:47832", "pin");
    var secret = DecodeInvite(invite.InviteUri).GetProperty("secret").GetString()!;
    Reject(() => state.Pair(new("wrong-secret", "Attacker"), "attacker-pin"), "Invalid invitation rejected");
    var device = state.Pair(new(secret, "Requesting device"), "real-pin");
    Check(device.Name == "Approved computer", "Locally approved device name takes precedence");
    Reject(() => state.Pair(new(secret, "Replay"), "other-pin"), "Invitation cannot be replayed");
    Check(!File.ReadAllText(Path.Combine(stateDir, "host.json")).Contains(secret), "Invitation secret is absent from persisted state");
    Check(!File.ReadAllText(Path.Combine(stateDir, "audit.jsonl")).Contains(secret), "Invitation secret is absent from audit");
    var control = state.StartSession(device, null);
    Reject(() => state.StartSession(device, null), "Multiple simultaneous controllers rejected");
    var viewer = state.StartSession(device, null, true);
    Check(!viewer.Permissions.Control && !viewer.Permissions.Clipboard && !viewer.Permissions.Power, "View-only removes privileged permissions");
    Check(state.GetSession(control.Id, "forged-id") is null, "Session ownership enforced");
    Check(state.Revoke(device.Id) && state.FindDevice("real-pin") is null && state.Sessions.Length == 0, "Revocation removes authorization and active sessions");
    Reject(() => state.StartSession(device, null), "Stale device record cannot start a session after revocation");
    Reject(() => state.GetSafeFilePath("test.txt"), "File access disabled by default");
    var filesDir = Path.Combine(temporaryRoot, "transfer"); Directory.CreateDirectory(filesDir);
    state.UpdateSettings(new(false, true, filesDir));
    Check(state.GetSafeFilePath("safe.txt") == Path.Combine(filesDir, "safe.txt"), "Sandbox path remains within dedicated folder");
    Reject(() => state.GetSafeFilePath("../outside.txt"), "Sandbox blocks traversal");
    Reject(() => state.UpdateSettings(new(false, true, Path.GetPathRoot(filesDir))), "Disk root cannot be configured as transfer sandbox");
    using (var identity = new HostIdentity(stateDir, state.HostId, IPAddress.Loopback))
    {
        var pin = identity.Fingerprint;
        Check(Security.IsClientCertificateUsable(identity.Certificate), "Generated certificate is valid for client authentication");
        using var reloaded = new HostIdentity(stateDir, state.HostId, IPAddress.Loopback);
        Check(pin == reloaded.Fingerprint, "Identity pin survives restart");
        if (OperatingSystem.IsWindows())
        {
            var persisted = File.ReadAllBytes(Path.Combine(stateDir, "identity.dpapi"));
            var raw = identity.Certificate.Export(X509ContentType.Pfx);
            Check(!persisted.SequenceEqual(raw), "Persisted Windows identity is DPAPI protected");
        }
    }
    await using (var backend = PlatformBackendFactory.Create())
    {
        var status = await backend.GetStatusAsync();
        Check(!string.IsNullOrWhiteSpace(status.OperatingSystem) && status.Limitations is not null, "Native backend reports honest status without changing desktop");
        Reject(() => backend.ApplyInputAsync(new("key", Key: "forged;shutdown", IsDown: true)).GetAwaiter().GetResult(), "Native backend rejects unrecognized keyboard codes without injecting input");
        Reject(() => backend.ApplyInputAsync(new("pointerButton", Button: "left;touch", IsDown: true)).GetAwaiter().GetResult(), "Native backend rejects unrecognized mouse buttons without moving pointer");
        Reject(() => backend.ApplyInputAsync(new("pointerMove", X: int.MinValue, Y: int.MinValue)).GetAwaiter().GetResult(), "Native backend rejects pointer coordinates outside all monitors");
        Reject(() => backend.ApplyInputAsync(new("arbitrary-command")).GetAwaiter().GetResult(), "Native backend rejects unsupported event kinds");
    }

    // Codec tests use synthetic pixels only; no desktop capture or real input is performed.
    var png = PngEncoder.EncodeBgra([0, 0, 255, 0, 0, 255, 0, 0], 2, 1, CancellationToken.None);
    Check(png.AsSpan(0, 8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }), "PNG signature is correct");
    Check(BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16, 4)) == 2 && BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20, 4)) == 1,
        "PNG dimensions preserve synthetic image geometry");
    Check(png[24] == 8 && png[25] == 2 && png[26] == 0 && png[27] == 0 && png[28] == 0,
        "PNG header declares RGB8 with valid zero compression, filter and interlace methods");
    var chunkOffset = 8;
    using (var compressed = new MemoryStream())
    {
        var crcValid = true;
        var sawEnd = false;
        while (chunkOffset < png.Length)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(chunkOffset, 4));
            var name = Encoding.ASCII.GetString(png, chunkOffset + 4, 4);
            uint crc = 0xFFFFFFFF;
            foreach (var value in png.AsSpan(chunkOffset + 4, length + 4))
            {
                crc ^= value;
                for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xEDB88320u : 0u);
            }
            crcValid &= (crc ^ 0xFFFFFFFF) == BinaryPrimitives.ReadUInt32BigEndian(png.AsSpan(chunkOffset + 8 + length, 4));
            if (name == "IDAT") compressed.Write(png, chunkOffset + 8, length);
            if (name == "IEND") sawEnd = length == 0;
            chunkOffset += length + 12;
        }
        Check(crcValid && sawEnd && chunkOffset == png.Length, "Every PNG chunk has a valid independent CRC and end marker");
        compressed.Position = 0;
        using var decoder = new ZLibStream(compressed, CompressionMode.Decompress);
        using var decoded = new MemoryStream();
        decoder.CopyTo(decoded);
        Check(decoded.ToArray().SequenceEqual(new byte[] { 0, 255, 0, 0, 0, 255, 0 }), "PNG RGB pixels round-trip independently through zlib, ignoring undefined GDI alpha");
    }
    Reject(() => PngEncoder.EncodeBgra([], 2, 1, CancellationToken.None), "PNG rejects mismatched pixel buffer");
    Reject(() => PngEncoder.EncodeBgra([], 100_000, 100_000, CancellationToken.None), "PNG rejects oversized display before allocation");
    Reject(() => PlatformLimits.CheckClipboard("a\0b"), "Clipboard rejects embedded null text");
    Reject(() => PlatformLimits.CheckClipboard(new string('x', PlatformLimits.MaximumClipboardCharacters + 1)), "Clipboard rejects oversized text");

    // Integration checks exercise real Kestrel TLS and actual presented client certificates.
    var token = Security.RandomToken();
    var controlPort = FreePort(); var remotePort = FreePort();
    while (remotePort == controlPort) remotePort = FreePort();
    var hostAssembly = typeof(HostState).Assembly.Location;
    var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
    info.ArgumentList.Add(hostAssembly); info.ArgumentList.Add("--loopback-test");
    info.Environment["ORBIT_CONTROL_TOKEN"] = token; info.Environment["ORBIT_DATA_DIR"] = Path.Combine(temporaryRoot, "integration-state");
    info.Environment["ORBIT_CONTROL_PORT"] = controlPort.ToString(); info.Environment["ORBIT_REMOTE_PORT"] = remotePort.ToString();
    info.Environment["ORBIT_PARENT_WATCH"] = "1";
    host = Process.Start(info) ?? throw new InvalidOperationException("Test host failed to launch.");
    hostOutput = host.StandardOutput.ReadToEndAsync(); hostError = host.StandardError.ReadToEndAsync();
    using var local = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{controlPort}"), Timeout = TimeSpan.FromSeconds(5) };
    local.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    var ready = false;
    for (var i = 0; i < 60; i++)
    {
        if (host.HasExited) throw new InvalidOperationException("Test host exited before readiness: " + await hostError);
        try { using var response = await local.GetAsync("/api/status"); ready = response.IsSuccessStatusCode; if (ready) break; } catch (HttpRequestException) { }
        await Task.Delay(100);
    }
    Check(ready, "Host starts on loopback-test listeners");
    using (var unauth = new HttpClient()) Check((await unauth.GetAsync($"http://127.0.0.1:{controlPort}/api/status")).StatusCode == HttpStatusCode.Unauthorized, "Local API rejects missing control token");
    using (var request = new HttpRequestMessage(HttpMethod.Get, "/api/status"))
    {
        request.Headers.Add("Origin", "https://attacker.invalid");
        Check((await local.SendAsync(request)).StatusCode == HttpStatusCode.Forbidden, "Local API blocks browser-origin access even with token");
    }
    using (var request = new HttpRequestMessage(HttpMethod.Get, "/api/status"))
    {
        request.Headers.Host = "attacker.invalid:47831";
        Check((await local.SendAsync(request)).StatusCode == HttpStatusCode.Forbidden, "Local API rejects untrusted Host to prevent DNS rebinding");
    }
    var exported = await local.GetFromJsonAsync<JsonElement>("/api/identity/export");
    using var pemController = X509Certificate2.CreateFromPem(exported.GetProperty("certificatePem").GetString()!, exported.GetProperty("privateKeyPem").GetString()!);
    using var controller = X509CertificateLoader.LoadPkcs12(pemController.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
    var fingerprint = exported.GetProperty("fingerprint").GetString()!;
    using var remote = NewRemote(controller, fingerprint, remotePort);
    Check((await remote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "Unpaired presented certificate cannot access remote API");
    var inviteResponse = await local.PostAsJsonAsync("/api/invites", new { deviceName = "Integration controller", permissions = new { view = true, control = false, clipboard = false, files = false, power = false } });
    inviteResponse.EnsureSuccessStatusCode();
    var inviteJson = await inviteResponse.Content.ReadFromJsonAsync<JsonElement>();
    var wireSecret = DecodeInvite(inviteJson.GetProperty("inviteUri").GetString()!).GetProperty("secret").GetString()!;
    var pairResponse = await remote.PostAsJsonAsync("/api/pair", new { secret = wireSecret, deviceName = "Test controller" });
    pairResponse.EnsureSuccessStatusCode();
    var pairJson = await pairResponse.Content.ReadFromJsonAsync<JsonElement>();
    Check((await remote.GetAsync("/api/info")).IsSuccessStatusCode, "Paired actual TLS certificate authorizes remote access");
    var remoteInfo = await remote.GetFromJsonAsync<JsonElement>("/api/info");
    if (remoteInfo.GetProperty("platform").GetProperty("canCapture").GetBoolean())
    {
        var startResponse = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); startResponse.EnsureSuccessStatusCode();
        var sessionJson = await startResponse.Content.ReadFromJsonAsync<JsonElement>();
        var sessionId = sessionJson.GetProperty("id").GetString();
        Check((await remote.PostAsJsonAsync($"/api/sessions/{sessionId}/input", new { kind = "key", key = "KeyA", isDown = true })).StatusCode == HttpStatusCode.NotFound, "View-only device cannot inject input");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/clipboard")).StatusCode == HttpStatusCode.NotFound, "View-only device cannot read clipboard");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/files")).StatusCode == HttpStatusCode.NotFound, "View-only device cannot list files");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?monitorId=" + new string('x', 129))).StatusCode == HttpStatusCode.BadRequest, "Oversized monitor query returns 400 before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?monitorId=orbit-nonexistent-monitor")).StatusCode == HttpStatusCode.BadRequest, "Unknown monitor is rejected by the native backend without capturing a display");
        Check((await remote.PostAsJsonAsync($"/api/sessions/{sessionId}/power", new { action = "restart" })).StatusCode == HttpStatusCode.NotFound, "View-only device cannot request restart");
        Check((await remote.DeleteAsync($"/api/sessions/{sessionId}")).IsSuccessStatusCode, "Remote peer can end its own session");
        var resumableResponse = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); resumableResponse.EnsureSuccessStatusCode();
        var resumable = await resumableResponse.Content.ReadFromJsonAsync<JsonElement>();
        var previousEpoch = resumable.GetProperty("resumeEpoch").GetString();
        Check(!string.IsNullOrEmpty(previousEpoch), "Session API issues automatic-resume authorization");
        Check((await local.PostAsync("/api/disconnect-all", null)).IsSuccessStatusCode, "Host can explicitly disconnect all sessions");
        var deniedResume = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true, resumeEpoch = previousEpoch });
        Check(deniedResume.StatusCode == HttpStatusCode.Gone, "Host disconnect refuses automatic renewal with HTTP 410");
        Check((await deniedResume.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "session_ended_by_host", "Host stop carries an explicit terminal reason");
        var explicitResponse = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); explicitResponse.EnsureSuccessStatusCode();
        var explicitSession = await explicitResponse.Content.ReadFromJsonAsync<JsonElement>();
        Check(explicitSession.GetProperty("resumeEpoch").GetString() != previousEpoch, "Explicit new connection receives current authorization after host stop");
        Check((await local.DeleteAsync("/api/sessions/" + explicitSession.GetProperty("id").GetString())).IsSuccessStatusCode, "Local host can end one active session");
        Check((await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true, resumeEpoch = explicitSession.GetProperty("resumeEpoch").GetString() })).StatusCode == HttpStatusCode.Gone, "Single-session local stop also refuses automatic renewal");
    }
    Check((await remote.PostAsJsonAsync("/api/pair", new { secret = wireSecret, deviceName = "Replay" })).StatusCode == HttpStatusCode.Forbidden, "Actual TLS pairing rejects invitation replay");
    Check((await remote.GetAsync("/api/identity/export")).StatusCode == HttpStatusCode.NotFound, "Remote peer cannot export local private identity");
    using var otherKey = RSA.Create(2048);
    var req = new CertificateRequest("CN=Unpaired test device", otherKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.2") }, false));
    using var ephemeralOther = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
    using var otherCertificate = X509CertificateLoader.LoadPkcs12(ephemeralOther.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
    using var unpairedRemote = NewRemote(otherCertificate, fingerprint, remotePort);
    unpairedRemote.DefaultRequestHeaders.Add("X-Orbit-Device-Id", pairJson.GetProperty("deviceId").GetString());
    Check((await unpairedRemote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "Supplying a paired device ID cannot replace actual TLS certificate authentication");
    Check((await local.DeleteAsync("/api/peers/" + pairJson.GetProperty("deviceId").GetString())).IsSuccessStatusCode, "Local device revocation succeeds");
    Check((await remote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "Revocation is enforced on the next request of an existing TLS connection");
    Check(!(await local.GetStringAsync("/api/audit")).Contains(wireSecret), "API audit does not leak pairing secrets");
    using var noCertificate = new HttpClient(new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, certificate, _, _) => certificate is not null && Security.Fingerprint(certificate) == fingerprint }) { BaseAddress = new Uri($"https://127.0.0.1:{remotePort}"), Timeout = TimeSpan.FromSeconds(5) };
    var noCertDenied = false;
    try { noCertDenied = !(await noCertificate.GetAsync("/api/info")).IsSuccessStatusCode; } catch (HttpRequestException) { noCertDenied = true; }
    Check(noCertDenied, "Remote listener rejects clients without a TLS certificate");
    host.StandardInput.Close();
    using var parentExitTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
    await host.WaitForExitAsync(parentExitTimeout.Token);
    Check(host.ExitCode == 0, "Closing the owner stdin pipe gracefully stops the host without orphaning its listeners");
}
catch (Exception ex) { failures.Add("Unexpected test failure: " + ex); }
finally
{
    if (host is not null) { if (!host.HasExited) { host.Kill(entireProcessTree: true); await host.WaitForExitAsync(); } host.Dispose(); }
    if (failures.Count > 0 && hostOutput is not null) Console.Error.WriteLine(await hostOutput);
    if (failures.Count > 0 && hostError is not null) Console.Error.WriteLine(await hostError);
    var resolved = Path.GetFullPath(temporaryRoot);
    if (resolved.StartsWith(Path.GetFullPath(Path.GetTempPath()), StringComparison.OrdinalIgnoreCase) && Path.GetFileName(resolved).StartsWith("orbit-security-tests-", StringComparison.Ordinal)) Directory.Delete(resolved, true);
}
foreach (var failure in failures) Console.Error.WriteLine("FAIL: " + failure);
Console.WriteLine($"{checks - failures.Count}/{checks} security checks passed.");
return failures.Count == 0 ? 0 : 1;

static JsonElement DecodeInvite(string uri)
{
    var encoded = uri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
    encoded = encoded.PadRight((encoded.Length + 3) / 4 * 4, '=');
    return JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(encoded));
}
static HttpClient NewRemote(X509Certificate2 certificate, string pin, int port)
{
    var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, cert, _, _) => cert is not null && Security.Fingerprint(cert) == pin };
    handler.ClientCertificates.Add(certificate);
    return new HttpClient(handler) { BaseAddress = new Uri($"https://127.0.0.1:{port}"), Timeout = TimeSpan.FromSeconds(5) };
}
static int FreePort() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
