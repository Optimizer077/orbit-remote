using System.Diagnostics;
using System.Buffers.Binary;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Security;
using System.Net.Sockets;
using System.Reflection;
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
// Opt-in for machines the suite must not touch (for example a developer's own desktop):
// ORBIT_TEST_SKIP_NATIVE_DESKTOP=1 skips only the live DXGI capture group and the direct native-input probes.
// Unset, every check runs exactly as before.
var skipNativeDesktop = Environment.GetEnvironmentVariable("ORBIT_TEST_SKIP_NATIVE_DESKTOP") == "1";
var skippedChecks = new List<string>();
bool SkipNativeDesktop(string name)
{
    if (!skipNativeDesktop) return false;
    skippedChecks.Add(name);
    Console.WriteLine("SKIPPED (ORBIT_TEST_SKIP_NATIVE_DESKTOP): " + name);
    return true;
}
void NativeInputReject(Action action, string message) { if (!SkipNativeDesktop(message)) Reject(action, message); }
// macOS exposes /var as a link to /private/var. Resolve the existing temp
// ancestors before sandbox tests so they do not intentionally fail link guards.
var temporaryBase = CanonicalDirectory(Path.GetTempPath());
var temporaryRoot = Path.Combine(temporaryBase, "orbit-security-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temporaryRoot);
Process? host = null;
Task<string>? hostOutput = null;
Task<string>? hostError = null;
try
{
    if (typeof(HostState).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration == "Diagnostic")
    {
        // Diagnostic hosts never become real-desktop hosts. Run their explicit
        // source suite here; the complete production suite runs in Debug/Release.
        await DiagnosticSourceChecks.RunAsync(Check, temporaryRoot);
        await DiagnosticSourceHttpChecks.RunAsync(Check, temporaryRoot);
        await DiagnosticSourceChecks.CaptureBusyAsync(Check);
        foreach (var failure in failures) Console.Error.WriteLine("FAIL: " + failure);
        Console.WriteLine($"{checks - failures.Count}/{checks} Diagnostic source checks passed.");
        return failures.Count == 0 ? 0 : 1;
    }
    Check(Security.IsTailscaleAddress(IPAddress.Parse("100.64.0.1")), "Tailscale lower boundary is accepted");
    Check(Security.IsTailscaleAddress(IPAddress.Parse("100.127.255.255")), "Tailscale upper boundary is accepted");
    foreach (var ip in new[] { "100.63.255.255", "100.128.0.0", "192.168.1.1", "127.0.0.1", "::1", "fd7a:115c:a1e1::1" }) Check(!Security.IsTailscaleAddress(IPAddress.Parse(ip)), "Non-tailnet IP rejected: " + ip);
    Check(Security.IsTailscaleAddress(IPAddress.Parse("fd7a:115c:a1e0::1234")), "Tailscale IPv6 accepted");
    foreach (var path in new[] { "../secrets", "..\\secrets", "C:password", "CON", "NUL.txt", "test.", "test ", "a/b", "a\\b", "", ".", "..", "COM1.txt", "a\0b" }) Reject(() => Security.ValidateFileName(path), "Unsafe filename rejected: " + path);
    Check(Security.ValidateFileName("hello.txt") == "hello.txt", "Valid filename accepted");
    // H-10: device names Win32 still resolves, including trailing space/dot stems.
    foreach (var path in new[] { "COM0", "lpt0.txt", "COM¹", "com².log", "LPT³.txt", "CONIN$", "conout$.txt", "CLOCK$", "CON .txt", "nul. .log", "AUX  .md", "PRN..txt" })
        Reject(() => Security.ValidateFileName(path), "Reserved Windows device name rejected: " + path);
    foreach (var path in new[] { "CONSOLE.txt", "COM10.txt", "LPT.txt", "com.txt", "CONIN.txt", "my CON.txt", "LPT⁴.txt" })
        Check(Security.ValidateFileName(path) == path, "Non-device filename still accepted: " + path);
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
    SessionIsolationChecks.Run(Check, temporaryRoot);
    await OwnerBlockChecks.RunAsync(Check, temporaryRoot);
    await SessionAccessChecks.RunAsync(Check, temporaryRoot);
    await InputBatchChecks.RunAsync(Check, temporaryRoot);
    await DisplayAvailabilityChecks.RunAsync(Check, temporaryRoot);
    await DiagnosticSourceChecks.RunAsync(Check, temporaryRoot);
    await DiagnosticSourceHttpChecks.RunAsync(Check, temporaryRoot);
    IdentityHealthChecks.Run(Check, Reject, temporaryRoot);
    TailscaleStateChecks.Run(Check);
    await ParentProofChecks.RunAsync(Check, Reject);
    await RequestBodyPolicyChecks.RunAsync(Check);
    await ErrorDisclosureChecks.RunAsync(Check);
    RejectionAuditChecks.Run(Check, temporaryRoot);
    await ClipboardChecks.RunAsync(Check, temporaryRoot);
    await RemoteAdmissionChecks.RunAsync(Check, temporaryRoot);
    await SessionChurnChecks.RunAsync(Check, temporaryRoot);
    await ResourceLimitChecks.RunAsync(Check, temporaryRoot);
    await UploadChecks.RunAsync(Check, temporaryRoot);
    ShortPairVectors.Run(Check);
    await ShortPairChecks.RunAsync(Check, temporaryRoot);
    await StreamAdmissionChecks.RunAsync(Check);
    FrameQualityChecks.Run(Check, Reject);
    FrameEncodingChecks.Run(Check, Reject);
    JpegEncoderChecks.Run(Check);
    WindowsSessionChecks.Run(Check);
    if (!SkipNativeDesktop("DxgiCaptureChecks.Run")) DxgiCaptureChecks.Run(Check);
    await SharedMonitorChecks.RunAsync(Check, Reject);
    PointerFeedChecks.Run(Check);
    await GpuSharedMonitorChecks.RunAsync(Check);
    await FrameWaitChecks.RunAsync(Check, Reject);
    VideoStreamChecks.Run(Check);
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
        NativeInputReject(() => backend.ApplyInputAsync(new("key", Key: "forged;shutdown", IsDown: true)).GetAwaiter().GetResult(), "Native backend rejects unrecognized keyboard codes without injecting input");
        NativeInputReject(() => backend.ApplyInputAsync(new("pointerButton", Button: "left;touch", IsDown: true)).GetAwaiter().GetResult(), "Native backend rejects unrecognized mouse buttons without moving pointer");
        NativeInputReject(() => backend.ApplyInputAsync(new("pointerMove", X: int.MinValue, Y: int.MinValue)).GetAwaiter().GetResult(), "Native backend rejects pointer coordinates outside all monitors");
        NativeInputReject(() => backend.ApplyInputAsync(new("arbitrary-command")).GetAwaiter().GetResult(), "Native backend rejects unsupported event kinds");
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
    info.Environment["ORBIT_PARENT_PROOF"] = "1";
    info.Environment.Remove(ShortPairEndpoints.EnvironmentFlag); // The main host runs with experimental short-code pairing off.
    var diagnosticConfiguration = typeof(HostState).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration == "Diagnostic";
    if (!diagnosticConfiguration) info.Environment["ORBIT_DIAGNOSTIC_SYNTHETIC"] = "1";
    var parentProofKey = Security.RandomToken();
    host = Process.Start(info) ?? throw new InvalidOperationException("Test host failed to launch.");
    await host.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { version = 1, proofKey = parentProofKey }));
    await host.StandardInput.FlushAsync();
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
    var localStatus = await local.GetFromJsonAsync<JsonElement>("/api/status");
    if (!diagnosticConfiguration)
        Check(!localStatus.TryGetProperty("diagnosticSource", out _) && localStatus.GetProperty("platform").GetProperty("operatingSystem").GetString() != "Windows Diagnostic",
            "Actual normal-build subprocess ignores the diagnostic opt-in and exposes no source selector/status");
    Check(localStatus.GetProperty("transport").GetProperty("state").GetString() == "loopback-test" && localStatus.GetProperty("transport").GetProperty("mode").GetString() == "loopback-test",
        "Host status carries the machine-readable Tailscale state next to the existing transport mode");
    Check(localStatus.GetProperty("platform").GetProperty("canLocalCursor").ValueKind is JsonValueKind.True or JsonValueKind.False,
        "Privileged host status explicitly advertises the negotiated local-cursor capability");
    using (var noBearer = new HttpClient { BaseAddress = local.BaseAddress })
    using (var challengeRequest = new HttpRequestMessage(HttpMethod.Get, "/api/parent-proof"))
    {
        var challenge = Security.RandomToken(); challengeRequest.Headers.Add("X-Orbit-Challenge", challenge);
        using var response = await noBearer.SendAsync(challengeRequest); response.EnsureSuccessStatusCode();
        var bytes = await response.Content.ReadAsByteArrayAsync(); var proof = JsonSerializer.Deserialize<JsonElement>(bytes);
        Check(response.Content.Headers.ContentLength == bytes.Length && response.Headers.TransferEncodingChunked != true, "Live child proof uses bounded fixed-length framing before bearer authentication");
        Check(proof.GetProperty("pid").GetInt32() == host.Id && proof.GetProperty("challenge").GetString() == challenge, "Live child proof identifies the owned process and fresh challenge");
        Check(proof.GetProperty("proof").GetString() == ParentProofChecks.Sign(parentProofKey, challenge, host.Id, controlPort, proof.GetProperty("clientPort").GetInt32()), "Live child proof authenticates with the independent stdin-only secret");
    }
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
    // H-8: a failed pairing and the unknown-certificate probe above are audited with source and reason only.
    var guessedSecret = "generated-wrong-invite-" + Security.RandomToken();
    Check((await remote.PostAsJsonAsync("/api/pair", new { secret = guessedSecret, deviceName = "Prober" })).StatusCode == HttpStatusCode.Forbidden,
        "Real mTLS pairing with an unknown invite is refused");
    var probeAudit = await local.GetFromJsonAsync<JsonElement>("/api/audit");
    bool Audited(string kind) => probeAudit.EnumerateArray().Any(entry => entry.GetProperty("kind").GetString() == kind
        && entry.GetProperty("detail").GetString()!.Contains("127.0.0.1", StringComparison.Ordinal));
    Check(Audited("pair.rejected") && Audited("auth.unknown_certificate"),
        "H-8: real mTLS failed pairing and unknown-certificate probe are audited with their source address");
    Check(!probeAudit.GetRawText().Contains(guessedSecret, StringComparison.Ordinal), "H-8: the rejected invite value never reaches the audit");
    var inviteResponse = await local.PostAsJsonAsync("/api/invites", new { deviceName = "Integration controller", permissions = new { view = true, control = false, clipboard = false, files = false, power = false } });
    inviteResponse.EnsureSuccessStatusCode();
    var inviteJson = await inviteResponse.Content.ReadFromJsonAsync<JsonElement>();
    var wireSecret = DecodeInvite(inviteJson.GetProperty("inviteUri").GetString()!).GetProperty("secret").GetString()!;
    var pairResponse = await remote.PostAsJsonAsync("/api/pair", new { secret = wireSecret, deviceName = "Test controller" });
    pairResponse.EnsureSuccessStatusCode();
    var pairJson = await pairResponse.Content.ReadFromJsonAsync<JsonElement>();
    Check((await remote.GetAsync("/api/info")).IsSuccessStatusCode, "Paired actual TLS certificate authorizes remote access");
    var remoteInfo = await remote.GetFromJsonAsync<JsonElement>("/api/info");
    var localCursorCapability = remoteInfo.GetProperty("platform").GetProperty("canLocalCursor").GetBoolean();
    Check(remoteInfo.GetProperty("platform").GetProperty("displayState").GetString() is "on" or "off" or "dimmed" or "unknown"
        && remoteInfo.GetProperty("platform").GetProperty("canWakeDisplay").ValueKind is JsonValueKind.True or JsonValueKind.False,
        "Real mTLS platform info advertises bounded display state and explicit wake capability");
    Check(localCursorCapability == localStatus.GetProperty("platform").GetProperty("canLocalCursor").GetBoolean(),
        "Paired remote info preserves the same gated local-cursor capability as local status");
    Check(remoteInfo.GetProperty("platform").GetProperty("canInputBatch").GetBoolean(), "Real mTLS platform info advertises the input batch body");
    if (remoteInfo.GetProperty("platform").GetProperty("canCapture").GetBoolean())
    {
        var startResponse = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); startResponse.EnsureSuccessStatusCode();
        var sessionJson = await startResponse.Content.ReadFromJsonAsync<JsonElement>();
        var sessionId = sessionJson.GetProperty("id").GetString();
        Check(sessionJson.GetProperty("canLocalCursor").GetBoolean() == localCursorCapability && sessionJson.GetProperty("canVideoStream").ValueKind is JsonValueKind.True or JsonValueKind.False,
            "Session creation advertises cursor/video capabilities while retaining the session identity and grants");
        Check(sessionJson.GetProperty("canWakeDisplay").ValueKind is JsonValueKind.True or JsonValueKind.False
            && !sessionJson.GetProperty("permissions").GetProperty("control").GetBoolean(),
            "Real mTLS session wake capability does not grant Control to a view-only device");
        Check((await remote.PostAsync($"/api/sessions/{sessionId}/wake-display", null)).StatusCode == HttpStatusCode.Forbidden,
            "Real mTLS view-only wake is denied before the native provider");
        var sessionStatus = await remote.GetFromJsonAsync<JsonElement>($"/api/sessions/{sessionId}");
        Check(sessionStatus.GetProperty("canLocalCursor").GetBoolean() == localCursorCapability && sessionStatus.GetProperty("resumeEpoch").GetString() == sessionJson.GetProperty("resumeEpoch").GetString(),
            "Session status retains capability negotiation and automatic-resume authorization");
        Check((await remote.PostAsJsonAsync($"/api/sessions/{sessionId}/input", new { kind = "key", key = "KeyA", isDown = true })).StatusCode == HttpStatusCode.NotFound, "View-only device cannot inject input");
        Check((await remote.PostAsJsonAsync($"/api/sessions/{sessionId}/input", new { events = new[] { new { kind = "key", key = "KeyA", isDown = true } } })).StatusCode == HttpStatusCode.NotFound, "View-only device cannot inject a batch of input");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/clipboard")).StatusCode == HttpStatusCode.NotFound, "View-only device cannot read clipboard");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/files")).StatusCode == HttpStatusCode.NotFound, "View-only device cannot list files");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?monitorId=" + new string('x', 129))).StatusCode == HttpStatusCode.BadRequest, "Oversized monitor query returns 400 before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?monitorId=orbit-nonexistent-monitor")).StatusCode == HttpStatusCode.BadRequest, "Unknown monitor is rejected by the native backend without capturing a display");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?scale=NaN")).StatusCode == HttpStatusCode.BadRequest, "Nonfinite scale is rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?scale=0.5&scale=1")).StatusCode == HttpStatusCode.BadRequest, "Multiple scale values are rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?format=webp")).StatusCode == HttpStatusCode.BadRequest, "Unknown frame codec is rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?quality=NaN")).StatusCode == HttpStatusCode.BadRequest, "Noninteger quality is rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?quality=50&quality=75")).StatusCode == HttpStatusCode.BadRequest, "Duplicate quality is rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?format=jpeg&format=png")).StatusCode == HttpStatusCode.BadRequest, "Duplicate format is rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?q=50")).StatusCode == HttpStatusCode.BadRequest, "Ambiguous legacy q alias is rejected; the negotiated field is quality");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?wait=10000")).StatusCode == HttpStatusCode.BadRequest, "Positive long-poll wait requires a conditional validator before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?wait=NaN")).StatusCode == HttpStatusCode.BadRequest, "Noninteger wait is rejected before capture");
        Check((await remote.GetAsync($"/api/sessions/{sessionId}/frame?wait=50&wait=100")).StatusCode == HttpStatusCode.BadRequest, "Duplicate wait is rejected before capture");
        using (var invalidTag = new HttpRequestMessage(HttpMethod.Get, $"/api/sessions/{sessionId}/frame"))
        {
            invalidTag.Headers.TryAddWithoutValidation("If-None-Match", "*");
            Check((await remote.SendAsync(invalidTag)).StatusCode == HttpStatusCode.BadRequest, "Wildcard cannot turn arbitrary frame requests into304");
        }
        Check((await remote.PostAsJsonAsync($"/api/sessions/{sessionId}/power", new { action = "restart" })).StatusCode == HttpStatusCode.NotFound, "View-only device cannot request restart");
        Check((await remote.DeleteAsync($"/api/sessions/{sessionId}")).IsSuccessStatusCode, "Remote peer can end its own session");
        using (var endedConditional = new HttpRequestMessage(HttpMethod.Get, $"/api/sessions/{sessionId}/frame"))
        {
            endedConditional.Headers.TryAddWithoutValidation("If-None-Match", "\"previous\"");
            Check((await remote.SendAsync(endedConditional)).StatusCode == HttpStatusCode.NotFound, "Conditional requests cannot bypass ended-session ownership checks");
        }
        var resumableResponse = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); resumableResponse.EnsureSuccessStatusCode();
        var resumable = await resumableResponse.Content.ReadFromJsonAsync<JsonElement>();
        var previousEpoch = resumable.GetProperty("resumeEpoch").GetString();
        Check(!string.IsNullOrEmpty(previousEpoch), "Session API issues automatic-resume authorization");
        Check((await local.PostAsync("/api/disconnect-all", null)).IsSuccessStatusCode, "Host can explicitly disconnect all sessions");
        var endedRoutes = new (HttpMethod Method, string Suffix, object? Body)[]
        {
            (HttpMethod.Get, "frame", null), (HttpMethod.Get, "stream", null),
            (HttpMethod.Post, "stream/control", new { ack = 1 }),
            (HttpMethod.Post, "input", new { kind = "invalid-generated-event" }),
            (HttpMethod.Post, "power", new { action = "invalid-generated-action" }), (HttpMethod.Post, "release-inputs", null),
            (HttpMethod.Post, "wake-display", null),
            (HttpMethod.Get, "clipboard", null), (HttpMethod.Put, "clipboard", new { text = "" }),
            (HttpMethod.Get, "files", null), (HttpMethod.Get, "files/generated.bin", null),
            (HttpMethod.Put, "files/generated.bin", null),
        };
        foreach (var route in endedRoutes)
        {
            using var ended = new HttpRequestMessage(route.Method, $"/api/sessions/{resumable.GetProperty("id").GetString()}/{route.Suffix}");
            if (route.Body is not null) ended.Content = JsonContent.Create(route.Body);
            using var terminal = await remote.SendAsync(ended);
            Check(terminal.StatusCode == HttpStatusCode.Forbidden && (await terminal.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == OwnerEndedException.Code,
                "Real mTLS owner Disconnect all returns a terminal before missing-session renewal: " + route.Method + " " + route.Suffix);
        }
        var deniedResume = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true, resumeEpoch = previousEpoch });
        Check(deniedResume.StatusCode == HttpStatusCode.Forbidden, "Host disconnect refuses automatic renewal with HTTP 403");
        Check((await deniedResume.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "ended_by_owner", "Host stop carries an explicit owner-block reason");
        Check((await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true })).StatusCode == HttpStatusCode.Forbidden,
            "Explicit remote Connect cannot bypass the owner's Disconnect all");
        Check((await local.PostAsync("/api/peers/" + pairJson.GetProperty("deviceId").GetString() + "/allow", null)).IsSuccessStatusCode,
            "Local owner may explicitly Allow again after Disconnect all");
        var explicitResponse = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); explicitResponse.EnsureSuccessStatusCode();
        var explicitSession = await explicitResponse.Content.ReadFromJsonAsync<JsonElement>();
        Check(explicitSession.GetProperty("resumeEpoch").GetString() != previousEpoch, "Explicit new connection receives current authorization after host stop");
        Check((await local.DeleteAsync("/api/sessions/" + explicitSession.GetProperty("id").GetString())).IsSuccessStatusCode, "Local host can end one active session");
        Check((await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true, resumeEpoch = explicitSession.GetProperty("resumeEpoch").GetString() })).StatusCode == HttpStatusCode.Forbidden, "Single-session local stop also refuses automatic renewal");
    }
    var pairedId = pairJson.GetProperty("deviceId").GetString()!;
    Check((await remote.PostAsync("/api/peers/" + pairedId + "/allow", null)).StatusCode == HttpStatusCode.NotFound
        && (await remote.PostAsync("/api/peers/" + pairedId + "/block", null)).StatusCode == HttpStatusCode.NotFound,
        "Remote certificate cannot call owner Allow or Block routes");
    Check((await local.PostAsync("/api/peers/unknown/block", null)).StatusCode == HttpStatusCode.NotFound
        && (await local.PostAsync("/api/peers/unknown/allow", null)).StatusCode == HttpStatusCode.NotFound,
        "Owner Block and Allow return404 for unknown devices");
    Check((await local.PostAsync("/api/peers/" + pairedId + "/block", null)).IsSuccessStatusCode,
        "Owner can block a known device even after its incoming session row expired");
    var ownerDenied = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true });
    var ownerReason = await ownerDenied.Content.ReadFromJsonAsync<JsonElement>();
    Check(ownerDenied.StatusCode == HttpStatusCode.Forbidden && ownerReason.GetProperty("code").GetString() == OwnerEndedException.Code
        && ownerReason.GetProperty("error").GetString() == OwnerEndedException.UserMessage,
        "Real mTLS explicit Connect receives the exact403 owner-block contract before native capture");
    using (var blockedInfo = await remote.GetAsync("/api/info"))
        Check(blockedInfo.StatusCode == HttpStatusCode.Forbidden && (await blockedInfo.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == OwnerEndedException.Code,
            "H-7: a blocked device cannot read /api/info and receives the typed owner-block 403");
    var peerList = await local.GetFromJsonAsync<JsonElement>("/api/peers");
    Check(peerList.EnumerateArray().Single(peer => peer.GetProperty("id").GetString() == pairedId).GetProperty("blockedByOwner").GetBoolean(),
        "Local paired-device DTO exposes persisted blockedByOwner state");
    host.StandardInput.Close();
    using (var restartExitTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10))) await host.WaitForExitAsync(restartExitTimeout.Token);
    Check(host.ExitCode == 0, "Owner-block restart fixture closes its previous owned host cleanly");
    await hostOutput; await hostError; host.Dispose();
    parentProofKey = Security.RandomToken();
    host = Process.Start(info) ?? throw new InvalidOperationException("Restart fixture failed to launch.");
    await host.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { version = 1, proofKey = parentProofKey }));
    await host.StandardInput.FlushAsync();
    hostOutput = host.StandardOutput.ReadToEndAsync(); hostError = host.StandardError.ReadToEndAsync();
    ready = false;
    for (var attempt = 0; attempt < 60; attempt++)
    {
        if (host.HasExited) throw new InvalidOperationException("Restart fixture exited early: " + await hostError);
        try { using var response = await local.GetAsync("/api/peers"); ready = response.IsSuccessStatusCode; if (ready) break; } catch (HttpRequestException) { }
        await Task.Delay(100);
    }
    Check(ready, "Owner-block fixture restarts on the same isolated identity and state");
    ownerDenied = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true });
    Check(ownerDenied.StatusCode == HttpStatusCode.Forbidden
        && (await ownerDenied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == OwnerEndedException.Code,
        "Real mTLS explicit Connect remains owner-blocked after the host process restarts");
    var allowedResponse = await local.PostAsync("/api/peers/" + pairedId + "/allow", null);
    var allowedPeer = await allowedResponse.Content.ReadFromJsonAsync<JsonElement>();
    Check(allowedResponse.IsSuccessStatusCode && !allowedPeer.GetProperty("blockedByOwner").GetBoolean()
        && allowedPeer.GetProperty("permissions").GetProperty("view").GetBoolean()
        && !allowedPeer.GetProperty("permissions").GetProperty("control").GetBoolean(),
        "Local Allow clears the owner block and preserves view-only pairing grants");
    var afterAllow = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true });
    Check(afterAllow.IsSuccessStatusCode || afterAllow.StatusCode == HttpStatusCode.Conflict,
        "After local Allow, explicit Connect reaches the current native capability instead of owner denial");
    if (afterAllow.IsSuccessStatusCode)
    {
        var afterAllowSession = await afterAllow.Content.ReadFromJsonAsync<JsonElement>();
        Check((await remote.DeleteAsync("/api/sessions/" + afterAllowSession.GetProperty("id").GetString())).IsSuccessStatusCode,
            "Allowed device can end its own test session without blocking itself");
    }
    Check((await remote.PostAsJsonAsync("/api/pair", new { secret = wireSecret, deviceName = "Replay" })).StatusCode == HttpStatusCode.Forbidden, "Actual TLS pairing rejects invitation replay");
    Check((await remote.GetAsync("/api/identity/export")).StatusCode == HttpStatusCode.NotFound, "Remote peer cannot export local private identity");
    Check((await remote.PostAsJsonAsync("/api/identity/rotate", new { confirmRePair = true, expectedFingerprint = fingerprint })).StatusCode == HttpStatusCode.NotFound, "Paired remote peer cannot rotate the host identity");
    using var otherKey = RSA.Create(2048);
    var req = new CertificateRequest("CN=Unpaired test device", otherKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.2") }, false));
    using var ephemeralOther = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
    using var otherCertificate = X509CertificateLoader.LoadPkcs12(ephemeralOther.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
    using var unpairedRemote = NewRemote(otherCertificate, fingerprint, remotePort);
    unpairedRemote.DefaultRequestHeaders.Add("X-Orbit-Device-Id", pairJson.GetProperty("deviceId").GetString());
    Check((await unpairedRemote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "Supplying a paired device ID cannot replace actual TLS certificate authentication");
    // H-3: the remote listener negotiates HTTP/1.1 even when a client offers HTTP/2.
    using (var h2Client = NewRemote(controller, fingerprint, remotePort))
    {
        h2Client.DefaultRequestVersion = HttpVersion.Version20;
        h2Client.DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower;
        using var h2Response = await h2Client.GetAsync("/api/info");
        Check(h2Response.Version == HttpVersion.Version11, "H-3: the remote listener serves HTTP/1.1 only, never HTTP/2");
    }
    // H-3: the global limiter runs before certificate, pin and whois work, so an unpaired flood is throttled.
    var floodStatuses = new System.Collections.Concurrent.ConcurrentBag<HttpStatusCode>();
    await Task.WhenAll(Enumerable.Range(0, 6).Select(async _ =>
    {
        for (var attempt = 0; attempt < 60; attempt++) { using var flood = await unpairedRemote.GetAsync("/api/info"); floodStatuses.Add(flood.StatusCode); }
    }));
    Check(floodStatuses.Contains(HttpStatusCode.TooManyRequests) && floodStatuses.Contains(HttpStatusCode.Unauthorized),
        "H-3: requests from an unpaired certificate are rate-limited before authentication");
    await Task.Delay(2000); // 127.0.0.1 shares one token bucket with the local checks below; let it refill.
    // H-3: connections beyond the per-source budget are closed before any TLS handshake.
    var heldSockets = new List<TcpClient>();
    try
    {
        for (var opened = 0; opened < ConnectionBudget.RemotePerSource + 4; opened++)
        {
            var socket = new TcpClient(); heldSockets.Add(socket);
            await socket.ConnectAsync(IPAddress.Loopback, remotePort);
        }
        var closedByHost = await Task.WhenAll(heldSockets.Select(async socket =>
        {
            using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            try { return await socket.GetStream().ReadAsync(new byte[1], wait.Token) == 0; }
            catch (OperationCanceledException) { return false; }
            catch (IOException) { return true; }
        }));
        Check(closedByHost.Count(closed => closed) >= 4 && closedByHost.Count(closed => !closed) <= ConnectionBudget.RemotePerSource,
            "H-3: one source cannot hold more raw connections than its budget; excess sockets close before TLS");
    }
    finally { foreach (var socket in heldSockets) socket.Dispose(); }
    await Task.Delay(500);
    Check((await remote.GetAsync("/api/info")).IsSuccessStatusCode, "H-3: closed connections release their budget for the paired device");
    // No server-wide connection cap: a local process holding many loopback sockets cannot lock the desktop out.
    var localSockets = new List<TcpClient>();
    try
    {
        for (var opened = 0; opened < 140; opened++)
        {
            var socket = new TcpClient(); localSockets.Add(socket);
            await socket.ConnectAsync(IPAddress.Loopback, controlPort);
        }
        using var freshLocal = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{controlPort}"), Timeout = TimeSpan.FromSeconds(5) };
        freshLocal.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var reachable = false;
        try { reachable = (await freshLocal.GetAsync("/api/peers")).IsSuccessStatusCode; } catch (HttpRequestException) { }
        Check(reachable, "The local control listener stays reachable while 140 other loopback sockets are open");
    }
    finally { foreach (var socket in localSockets) socket.Dispose(); }
    await ShortPairChecks.FlagOffAsync(Check, local, remote, unpairedRemote);
    Check((await local.DeleteAsync("/api/peers/" + pairJson.GetProperty("deviceId").GetString())).IsSuccessStatusCode, "Local device revocation succeeds");
    Check((await local.PostAsync("/api/peers/" + pairedId + "/allow", null)).StatusCode == HttpStatusCode.NotFound,
        "Allow again cannot revive a revoked device through the real local API");
    Check((await remote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "Revocation is enforced on the next request of an existing TLS connection");
    using (var revokedConditional = new HttpRequestMessage(HttpMethod.Get, "/api/sessions/previous-session/frame"))
    {
        revokedConditional.Headers.TryAddWithoutValidation("If-None-Match", "\"previous\"");
        Check((await remote.SendAsync(revokedConditional)).StatusCode == HttpStatusCode.Unauthorized, "Revoked certificate cannot receive a304 heartbeat or frame metadata");
    }
    Check(!(await local.GetStringAsync("/api/audit")).Contains(wireSecret), "API audit does not leak pairing secrets");
    using var noCertificate = new HttpClient(new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, certificate, _, _) => certificate is not null && Security.Fingerprint(certificate) == fingerprint }) { BaseAddress = new Uri($"https://127.0.0.1:{remotePort}"), Timeout = TimeSpan.FromSeconds(5) };
    var noCertDenied = false;
    try { noCertDenied = !(await noCertificate.GetAsync("/api/info")).IsSuccessStatusCode; } catch (HttpRequestException) { noCertDenied = true; }
    Check(noCertDenied, "Remote listener rejects clients without a TLS certificate");
    var refusedAudit = await local.GetFromJsonAsync<JsonElement>("/api/audit");
    Check(refusedAudit.EnumerateArray().Any(entry => entry.GetProperty("kind").GetString() == "auth.certificate_refused"
        && entry.GetProperty("detail").GetString()!.Contains("127.0.0.1", StringComparison.Ordinal)),
        "H-8: connections refused at TLS (no usable client certificate) are audited with their source");
    host.StandardInput.Close();
    using var parentExitTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
    await host.WaitForExitAsync(parentExitTimeout.Token);
    Check(host.ExitCode == 0, "Closing the owner stdin pipe gracefully stops the host without orphaning its listeners");
    await IdentityHealthChecks.RunIntegrationAsync(Check, temporaryRoot);
}
catch (Exception ex) { failures.Add("Unexpected test failure: " + ex); }
finally
{
    if (host is not null) { if (!host.HasExited) { host.Kill(entireProcessTree: true); await host.WaitForExitAsync(); } host.Dispose(); }
    if (failures.Count > 0 && hostOutput is not null) Console.Error.WriteLine(await hostOutput);
    if (failures.Count > 0 && hostError is not null) Console.Error.WriteLine(await hostError);
    var resolved = Path.GetFullPath(temporaryRoot);
    var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
    if (string.Equals(Path.GetDirectoryName(resolved), temporaryBase.TrimEnd(Path.DirectorySeparatorChar), comparison) && Path.GetFileName(resolved).StartsWith("orbit-security-tests-", StringComparison.Ordinal)) Directory.Delete(resolved, true);
}
foreach (var failure in failures) Console.Error.WriteLine("FAIL: " + failure);
Console.WriteLine($"{checks - failures.Count}/{checks} security checks passed.");
if (skipNativeDesktop) Console.WriteLine($"{skippedChecks.Count} item(s) skipped by ORBIT_TEST_SKIP_NATIVE_DESKTOP; {checks} checks executed, {failures.Count} failed.");
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
static string CanonicalDirectory(string directory)
{
    var full = Path.GetFullPath(directory);
    var root = Path.GetPathRoot(full) ?? throw new InvalidOperationException("Temporary directory must be rooted.");
    var current = root;
    foreach (var component in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
    {
        var info = new DirectoryInfo(Path.Combine(current, component));
        current = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? info.FullName;
    }
    return Path.TrimEndingDirectorySeparator(current);
}
