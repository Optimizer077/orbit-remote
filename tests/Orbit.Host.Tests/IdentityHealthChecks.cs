using System.Net;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Orbit.Host;

public static class IdentityHealthChecks
{
    public static void Run(Action<bool, string> check, Action<Action, string> reject, string temporaryRoot)
    {
        var directory = Path.Combine(temporaryRoot, "identity-recovery");
        var state = new HostState(directory);
        using var identity = new HostIdentity(directory, state.HostId, IPAddress.Loopback);
        var expires = new DateTimeOffset(identity.Certificate.NotAfter.ToUniversalTime());
        check(!IdentityHealth.FromCertificate(identity.Certificate, expires.AddDays(-31)).Warning, "Identity warning stays off before thirty days");
        var warning = IdentityHealth.FromCertificate(identity.Certificate, expires.AddDays(-30));
        check(warning.Warning && warning.DaysRemaining == 30 && !warning.Expired, "Identity warns at thirty days without silently rotating");
        var expired = IdentityHealth.FromCertificate(identity.Certificate, expires);
        check(expired.Expired && expired.DaysRemaining == 0 && expired.Warning, "Identity expires exactly at certificate boundary");
        check(IdentityHealth.FromCertificate(identity.Certificate, expires.AddDays(1)).DaysRemaining == 0, "Expired identity does not report negative remaining days");

        var invite = state.CreateInvite(new(null, new(true)), "https://127.0.0.1:47832", identity.Fingerprint);
        var payload = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var document = JsonDocument.Parse(Convert.FromBase64String(payload.PadRight((payload.Length + 3) / 4 * 4, '=')));
        var device = state.Pair(new(document.RootElement.GetProperty("secret").GetString()!, "Synthetic test viewer"), "synthetic-certificate-pin");
        var session = state.StartSession(device, null, true);
        var oldPin = identity.Fingerprint;
        var revoked = -1;
        reject(() => identity.Rotate("wrong-current-fingerprint", () => revoked = state.InvalidatePairingsForIdentityRotation()), "Wrong current fingerprint cannot rotate");
        check(revoked == -1 && state.GetSession(session.Id, device.Id) is not null, "Rejected rotation does not mutate sessions or pairings");
        identity.Rotate(oldPin, () =>
        {
            revoked = state.InvalidatePairingsForIdentityRotation();
            using var stillOld = new HostIdentity(directory, state.HostId, IPAddress.Loopback);
            var fromDisk = new HostState(directory);
            check(stillOld.Fingerprint == oldPin && fromDisk.FindDevice(device.Fingerprint) is null,
                "Pairing revocation is reloadable from disk before the staged identity replaces the old one");
            check(!Directory.EnumerateFiles(directory, "host.json.*.tmp").Any(), "Successful state writes leave no private staging files");
            if (!OperatingSystem.IsWindows())
                check(File.GetUnixFileMode(Path.Combine(directory, "host.json")) == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "State replacement preserves owner-only file permissions");
        });
        check(revoked == 1 && state.Sessions.Length == 0 && state.FindDevice(device.Fingerprint) is null, "Rotation ends sessions and revokes every pairing before identity replacement");
        using var reloaded = new HostIdentity(directory, state.HostId, IPAddress.Loopback);
        check(reloaded.Fingerprint != oldPin && Security.IsClientCertificateUsable(reloaded.Certificate), "Explicit rotation persists a new usable identity");
        check(identity.Fingerprint == oldPin, "Live identity remains stable until restart");
        var stateReloaded = new HostState(directory);
        check(stateReloaded.FindDevice(device.Fingerprint) is null, "Rotation revocation survives host restart");
        reject(() => stateReloaded.StartSession(device, null, true, session.ResumeEpoch), "Old automatic resume cannot survive identity rotation");
        check(!Directory.EnumerateFiles(directory, "*.tmp").Any(), "Rotation removes its bounded temporary identity file");

        var failedDirectory = Path.Combine(temporaryRoot, "state-replacement-failure");
        var failedState = new HostState(failedDirectory);
        var failedPath = Path.Combine(failedDirectory, "host.json");
        File.Delete(failedPath); Directory.CreateDirectory(failedPath);
        var replacementDenied = false;
        try { failedState.InvalidatePairingsForIdentityRotation(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { replacementDenied = true; }
        check(replacementDenied && Directory.Exists(failedPath), "State replacement failure propagates without replacing an unexpected destination object");
        check(!Directory.EnumerateFiles(failedDirectory, "host.json.*.tmp").Any(), "Failed state replacement cleans only its own private staging file");

        var expiredDirectory = Path.Combine(temporaryRoot, "expired-identity");
        Security.CreatePrivateDirectory(expiredDirectory);
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Orbit synthetic expired test", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var expiredCertificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-2), DateTimeOffset.UtcNow.AddDays(-1));
        var pfx = expiredCertificate.Export(X509ContentType.Pfx);
        try
        {
            // Write the platform's actual protected format in an isolated profile.
            // WindowsSecret stays internal, so use the same OS DPAPI via reflection.
            var encoded = pfx;
            if (OperatingSystem.IsWindows())
            {
                var secret = typeof(HostIdentity).Assembly.GetType("Orbit.Host.WindowsSecret")!;
                encoded = (byte[])secret.GetMethod("Protect")!.Invoke(null, [pfx])!;
            }
            Security.WritePrivateNewFile(Path.Combine(expiredDirectory, OperatingSystem.IsWindows() ? "identity.dpapi" : "identity.pfx"), encoded);
            var httpDirectory = Path.Combine(temporaryRoot, "identity-expired-http");
            _ = new HostState(httpDirectory);
            Security.WritePrivateNewFile(Path.Combine(httpDirectory, OperatingSystem.IsWindows() ? "identity.dpapi" : "identity.pfx"), encoded);
        }
        finally { CryptographicOperations.ZeroMemory(pfx); }
        reject(() => { using var blocked = new HostIdentity(expiredDirectory, "synthetic", null); }, "Expired identity fails closed for ordinary callers");
        using var recovery = new HostIdentity(expiredDirectory, "synthetic", null, allowExpiredForLocalAdministration: true);
        check(recovery.Health.Expired, "Expired profile remains available for explicit local administration");
        reject(() => recovery.ExportForLocalController(), "Expired identity cannot export client credentials");
        recovery.Rotate(recovery.Fingerprint, () => { });
        using var repaired = new HostIdentity(expiredDirectory, "synthetic", null);
        check(!repaired.Health.Expired, "Expired identity recovers only after explicit rotation and reload");
    }

    public static async Task RunIntegrationAsync(Action<bool, string> check, string temporaryRoot)
    {
        await RunProfileAsync(check, Path.Combine(temporaryRoot, "identity-recovery-http"), false);
        await RunProfileAsync(check, Path.Combine(temporaryRoot, "identity-expired-http"), true);
    }
    private static async Task RunProfileAsync(Action<bool, string> check, string directory, bool expiredStart)
    {
        var state = new HostState(directory);
        string oldPin;
        using (var identity = new HostIdentity(directory, state.HostId, null, allowExpiredForLocalAdministration: true)) oldPin = identity.Fingerprint;
        var token = Security.RandomToken();
        var localPort = FreePort(); var remotePort = FreePort();
        while (remotePort == localPort) remotePort = FreePort();
        var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(typeof(HostIdentity).Assembly.Location); info.ArgumentList.Add("--loopback-test");
        info.Environment["ORBIT_CONTROL_TOKEN"] = token; info.Environment["ORBIT_DATA_DIR"] = directory;
        info.Environment["ORBIT_CONTROL_PORT"] = localPort.ToString(); info.Environment["ORBIT_REMOTE_PORT"] = remotePort.ToString();
        info.Environment["ORBIT_PARENT_PROOF"] = "0"; info.Environment["ORBIT_PARENT_WATCH"] = "1";
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Isolated recovery host did not start.");
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new($"http://127.0.0.1:{localPort}"), Timeout = TimeSpan.FromSeconds(10) };
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            JsonElement status = default;
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (process.HasExited) throw new InvalidOperationException("Isolated recovery host exited unexpectedly.");
                try { status = await client.GetFromJsonAsync<JsonElement>("/api/status"); break; } catch (HttpRequestException) { await Task.Delay(100); }
            }
            check(status.GetProperty("identity").GetProperty("expired").GetBoolean() == expiredStart, "Live local status publishes exact identity health for normal and expired profiles");
            if (expiredStart)
            {
                check(!status.GetProperty("remoteEnabled").GetBoolean(), "Expired identity retains local administration with remote access disabled");
                check((await client.GetAsync("/api/identity/export")).StatusCode == HttpStatusCode.Conflict, "Expired live host refuses private-key export");
                check((await client.PostAsJsonAsync("/api/invites", new { permissions = new { view = true } })).StatusCode == HttpStatusCode.Conflict, "Expired live host refuses pairing invitations");
                var listening = false;
                using var probe = new TcpClient();
                try { await probe.ConnectAsync(IPAddress.Loopback, remotePort); listening = true; } catch (SocketException) { }
                check(!listening, "Expired identity never starts the remote listener even in loopback-test mode");
            }
            check((await client.PostAsJsonAsync("/api/identity/rotate", new { confirmRePair = false, expectedFingerprint = oldPin })).StatusCode == HttpStatusCode.BadRequest, "Local rotation requires explicit re-pair confirmation");
            check((await client.PostAsJsonAsync("/api/identity/rotate", new { confirmRePair = true, expectedFingerprint = "stale-fingerprint" })).StatusCode == HttpStatusCode.Conflict, "Live rotation refuses a stale expected fingerprint");
            using (var noToken = new HttpClient { BaseAddress = client.BaseAddress })
                check((await noToken.PostAsJsonAsync("/api/identity/rotate", new { confirmRePair = true, expectedFingerprint = oldPin })).StatusCode == HttpStatusCode.Unauthorized, "Rotation remains local bearer protected");
            var response = await client.PostAsJsonAsync("/api/identity/rotate", new { confirmRePair = true, expectedFingerprint = oldPin });
            check(response.StatusCode == HttpStatusCode.Accepted && (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("requiresRePair").GetBoolean(), "Explicit live rotation returns accepted with mandatory re-pair semantics");
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await process.WaitForExitAsync(timeout.Token);
            check(process.ExitCode == 0, "Identity rotation gracefully stops the old listener for a clean restart");
            using var replacement = new HostIdentity(directory, state.HostId, null);
            check(replacement.Fingerprint != oldPin, "Live rotation commits the new protected identity in the isolated profile");
            var audit = File.ReadAllText(Path.Combine(directory, "audit.jsonl"));
            check(audit.Contains("identity.rotated") && !audit.Contains(oldPin) && !audit.Contains(replacement.Fingerprint), "Rotation audit records only action and count, without identity fingerprints");
        }
        finally
        {
            if (!process.HasExited) { process.StandardInput.Close(); using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5)); try { await process.WaitForExitAsync(timeout.Token); } catch (OperationCanceledException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); } }
            await output; await error;
        }
    }

    private static int FreePort() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
}
