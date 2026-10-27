using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Orbit.Host;

public static class DiagnosticSourceHttpChecks
{
    public static async Task RunAsync(Action<bool, string> check, string tempRoot)
    {
        if (typeof(HostState).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration != "Diagnostic") return;
        if (!OperatingSystem.IsWindows()) return;
        await RefusedStartupAsync(check, tempRoot);
        await PatternCaseAsync(check, tempRoot, null);
        await PatternCaseAsync(check, tempRoot, "high-entropy");
    }

    private static async Task PatternCaseAsync(Action<bool, string> check, string tempRoot, string? pattern)
    {
        var localPort = FreePort(); var remotePort = FreePort(); while (localPort == remotePort) remotePort = FreePort();
        var profile = Path.Combine(tempRoot, "generated-diagnostic-http-" + (pattern ?? "default-low"));
        var token = Security.RandomToken();
        var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add(typeof(HostState).Assembly.Location); info.ArgumentList.Add("--loopback-test");
        info.Environment["ORBIT_CONTROL_TOKEN"] = token; info.Environment["ORBIT_DATA_DIR"] = profile;
        info.Environment["ORBIT_CONTROL_PORT"] = localPort.ToString(); info.Environment["ORBIT_REMOTE_PORT"] = remotePort.ToString();
        info.Environment["ORBIT_PARENT_WATCH"] = "1"; info.Environment.Remove("ORBIT_PARENT_PROOF");
        info.Environment["ORBIT_DIAGNOSTIC_SYNTHETIC"] = "1";
        info.Environment["ORBIT_DIAGNOSTIC_WIDTH"] = "640"; info.Environment["ORBIT_DIAGNOSTIC_HEIGHT"] = "360";
        info.Environment.Remove("ORBIT_DIAGNOSTIC_PATTERN");
        if (pattern is not null) info.Environment["ORBIT_DIAGNOSTIC_PATTERN"] = pattern;
        using var host = Process.Start(info) ?? throw new InvalidOperationException("Generated diagnostic fixture did not start.");
        var output = host.StandardOutput.ReadToEndAsync(); var error = host.StandardError.ReadToEndAsync();
        try
        {
            using var local = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{localPort}"), Timeout = TimeSpan.FromSeconds(5) };
            local.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var ready = false;
            for (var attempt = 0; attempt < 80; attempt++)
            {
                if (host.HasExited) throw new InvalidOperationException("Generated diagnostic fixture exited early: " + await error);
                try { using var response = await local.GetAsync("/api/status"); ready = response.IsSuccessStatusCode; if (ready) break; } catch (HttpRequestException) { }
                await Task.Delay(100);
            }
            check(ready, "Diagnostic HTTP: host starts on isolated loopback listeners");
            var status = await local.GetFromJsonAsync<JsonElement>("/api/status");
            var source = status.GetProperty("diagnosticSource");
            check(source.GetProperty("mode").GetString() == "synthetic-gpu" && source.GetProperty("width").GetInt32() == 640
                && source.GetProperty("height").GetInt32() == 360 && source.GetProperty("targetFramesPerSecond").GetInt32() == 60
                && source.GetProperty("pattern").GetString() == (pattern ?? "low-entropy"),
                "Diagnostic HTTP: authenticated status proves exact generated-source mode and configured geometry");
            var hostClock = source.GetProperty("hostMonotonicMicroseconds").GetInt64();
            check(hostClock > 0 && source.GetProperty("producerOpens").GetInt64() == 0 && source.GetProperty("gpuEncoderOpens").GetInt64() == 0
                && source.GetProperty("cpuReadbacks").GetInt64() == 0, "Diagnostic HTTP: authenticated clock/counters are sampled before the lazy GPU producer starts");
            var platform = status.GetProperty("platform");
            check(!platform.GetProperty("canInput").GetBoolean() && !platform.GetProperty("canClipboard").GetBoolean()
                && !platform.GetProperty("canLock").GetBoolean(), "Diagnostic HTTP: no real input, clipboard or power capability is advertised");
            var exported = await local.GetFromJsonAsync<JsonElement>("/api/identity/export");
            using var pem = X509Certificate2.CreateFromPem(exported.GetProperty("certificatePem").GetString()!, exported.GetProperty("privateKeyPem").GetString()!);
            using var certificate = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
            var pin = exported.GetProperty("fingerprint").GetString()!;
            using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, presented, _, _) => presented is not null && Security.Fingerprint(presented) == pin };
            handler.ClientCertificates.Add(certificate);
            using var remote = new HttpClient(handler) { BaseAddress = new Uri($"https://127.0.0.1:{remotePort}"), Timeout = TimeSpan.FromSeconds(5) };
            check((await remote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "Diagnostic HTTP: generated mode does not bypass actual certificate pairing");
            var inviteResponse = await local.PostAsJsonAsync("/api/invites", new { deviceName = "Generated fixture", permissions = new { view = true, control = true, clipboard = true, files = true, power = true } });
            inviteResponse.EnsureSuccessStatusCode(); var invite = await inviteResponse.Content.ReadFromJsonAsync<JsonElement>();
            var encoded = invite.GetProperty("inviteUri").GetString()!["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
            using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
            var pairResponse = await remote.PostAsJsonAsync("/api/pair", new { secret = payload.RootElement.GetProperty("secret").GetString(), deviceName = "Generated fixture" });
            pairResponse.EnsureSuccessStatusCode(); var paired = await pairResponse.Content.ReadFromJsonAsync<JsonElement>();
            var deviceId = paired.GetProperty("deviceId").GetString()!;
            check((await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = false })).StatusCode == HttpStatusCode.BadRequest,
                "Diagnostic HTTP: even an approved control-capable pairing must explicitly request view-only");
            async Task<string> Start()
            {
                var response = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); response.EnsureSuccessStatusCode();
                var session = await response.Content.ReadFromJsonAsync<JsonElement>(); var grants = session.GetProperty("permissions");
                check(grants.GetProperty("view").GetBoolean() && !grants.GetProperty("control").GetBoolean() && !grants.GetProperty("files").GetBoolean()
                    && !grants.GetProperty("clipboard").GetBoolean() && !grants.GetProperty("power").GetBoolean(), "Diagnostic HTTP: viewing sessions strip every data/input/power grant");
                return session.GetProperty("id").GetString()!;
            }
            var firstId = await Start(); var secondId = await Start();
            check((await remote.PostAsJsonAsync($"/api/sessions/{firstId}/input", new { kind = "key", key = "KeyA", isDown = true })).StatusCode == HttpStatusCode.NotFound
                && (await remote.GetAsync($"/api/sessions/{firstId}/clipboard")).StatusCode == HttpStatusCode.NotFound
                && (await remote.GetAsync($"/api/sessions/{firstId}/files")).StatusCode == HttpStatusCode.NotFound
                && (await remote.PostAsJsonAsync($"/api/sessions/{firstId}/power", new { action = "restart" })).StatusCode == HttpStatusCode.NotFound,
                "Diagnostic HTTP: input/clipboard/files/power are denied before any native operation");
            await using var first = await Wire.OpenAsync(remote, firstId);
            await using var second = await Wire.OpenAsync(remote, secondId);
            await Task.WhenAll(first.ReadPicturesAsync(8), second.ReadPicturesAsync(8));
            check(first.Config && first.Keyframe && second.Config && second.Keyframe,
                "Diagnostic HTTP: two authenticated streams receive real GPU config/keyframes and accept cumulative ACKs");
            status = await local.GetFromJsonAsync<JsonElement>("/api/status");
            check(status.GetProperty("diagnosticSource").GetProperty("generatedFrames").GetInt64() > 8,
                "Diagnostic HTTP: shared source counter advances while both authenticated consumers run");
            source = status.GetProperty("diagnosticSource");
            check(source.GetProperty("producerOpens").GetInt64() == 1 && source.GetProperty("gpuEncoderOpens").GetInt64() >= 2
                && source.GetProperty("cpuReadbacks").GetInt64() == 0 && source.GetProperty("hostMonotonicMicroseconds").GetInt64() > hostClock,
                "Diagnostic HTTP: two real GPU encoders share one producer with zero CPU readbacks and a fresh host-clock sample");
            check((await local.PostAsync($"/api/peers/{deviceId}/block", null)).IsSuccessStatusCode,
                "Diagnostic HTTP: local owner can block the generated stream's paired device");
            var terminals = await Task.WhenAll(first.TerminalAsync(), second.TerminalAsync());
            check(terminals.All(terminal => terminal.Code == "session_ended_by_host" && terminal.Error == OwnerEndedException.UserMessage),
                "Diagnostic HTTP: owner block terminates both GPU streams with the security reason");
            check((await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true })).StatusCode == HttpStatusCode.Forbidden,
                "Diagnostic HTTP: generated mode does not bypass the persistent owner block");
            (await local.PostAsync($"/api/peers/{deviceId}/allow", null)).EnsureSuccessStatusCode();
            var finalId = await Start(); await using var final = await Wire.OpenAsync(remote, finalId); await final.ReadPicturesAsync(2);
            (await local.DeleteAsync($"/api/peers/{deviceId}")).EnsureSuccessStatusCode();
            check((await final.TerminalAsync()).Code == "access_revoked" && (await remote.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized,
                "Diagnostic HTTP: certificate revocation ends the live GPU stream and rejects subsequent requests");
        }
        finally
        {
            if (!host.HasExited)
            {
                host.StandardInput.Close();
                try { await host.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10)); }
                catch (TimeoutException) { host.Kill(entireProcessTree: true); await host.WaitForExitAsync(); }
            }
            await output; await error;
        }
        check(host.ExitCode == 0, "Diagnostic HTTP: ownership-pipe EOF cleans up the generated host and listeners");
    }

    private static async Task RefusedStartupAsync(Action<bool, string> check, string tempRoot)
    {
        foreach (var reason in new[] { "missing-optin", "empty-optin", "missing-loopback", "unmarked-profile", "empty-pattern", "unknown-pattern" })
        {
            var directory = Path.Combine(tempRoot, "diagnostic-refused-" + reason); Directory.CreateDirectory(directory);
            if (reason == "unmarked-profile") await File.WriteAllTextAsync(Path.Combine(directory, "generated-existing.txt"), "generated placeholder");
            var first = FreePort(); var second = FreePort(); while (first == second) second = FreePort();
            var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            info.ArgumentList.Add(typeof(HostState).Assembly.Location);
            if (reason != "missing-loopback") info.ArgumentList.Add("--loopback-test");
            info.Environment["ORBIT_CONTROL_TOKEN"] = Security.RandomToken(); info.Environment["ORBIT_DATA_DIR"] = directory;
            info.Environment["ORBIT_CONTROL_PORT"] = first.ToString(); info.Environment["ORBIT_REMOTE_PORT"] = second.ToString();
            info.Environment.Remove("ORBIT_PARENT_PROOF"); info.Environment.Remove("ORBIT_DIAGNOSTIC_SYNTHETIC");
            info.Environment.Remove("ORBIT_DIAGNOSTIC_PATTERN");
            if (reason is "empty-pattern" or "unknown-pattern") info.Environment["ORBIT_DIAGNOSTIC_PATTERN"] = reason == "empty-pattern" ? "" : "unknown";
            if (reason != "missing-optin") info.Environment["ORBIT_DIAGNOSTIC_SYNTHETIC"] = reason == "empty-optin" ? "" : "1";
            using var child = Process.Start(info) ?? throw new InvalidOperationException("Diagnostic negative fixture did not start.");
            var stdout = child.StandardOutput.ReadToEndAsync(); var stderr = child.StandardError.ReadToEndAsync();
            try { await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            catch (TimeoutException) { child.Kill(entireProcessTree: true); await child.WaitForExitAsync(); check(false, "Diagnostic startup must refuse promptly: " + reason); }
            var error = await stderr; await stdout;
            check(child.ExitCode != 0 && error.Contains("Diagnostic", StringComparison.OrdinalIgnoreCase), "Diagnostic subprocess refuses startup: " + reason);
            check(!File.Exists(Path.Combine(directory, "host.json")) && !File.Exists(Path.Combine(directory, "identity.dpapi")),
                "Diagnostic refused startup creates no host state or identity: " + reason);
        }
    }

    private static int FreePort()
    { using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); return ((IPEndPoint)listener.LocalEndpoint).Port; }

    private sealed class Wire(HttpClient client, string id, HttpResponseMessage response, Stream stream) : IAsyncDisposable
    {
        public bool Config { get; private set; }
        public bool Keyframe { get; private set; }
        public static async Task<Wire> OpenAsync(HttpClient client, string id)
        {
            var response = await client.GetAsync($"/api/sessions/{id}/stream?monitorId=diagnostic-synthetic-1&cursor=local&maxFps=60", HttpCompletionOption.ResponseHeadersRead);
            response.EnsureSuccessStatusCode(); return new(client, id, response, await response.Content.ReadAsStreamAsync());
        }
        private async Task<(byte Type, byte Flags, uint Sequence, byte[] Body)> ReadAsync(CancellationToken token)
        {
            var header = new byte[24]; await stream.ReadExactlyAsync(header, token);
            var length = BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(4));
            if (length > 8 * 1024 * 1024) throw new InvalidOperationException("Generated fixture record exceeds protocol bounds.");
            var body = new byte[(int)length]; await stream.ReadExactlyAsync(body, token);
            return (header[0], header[1], BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(8)), body);
        }
        public async Task ReadPicturesAsync(int count)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10)); var pictures = 0;
            while (pictures < count)
            {
                var record = await ReadAsync(timeout.Token); if (record.Type == 1) Config = true;
                if (record.Type == 4) throw new InvalidOperationException("Generated stream ended before the expected pictures.");
                if (record.Type != 2) continue;
                Keyframe |= (record.Flags & 1) != 0; pictures++;
                (await client.PostAsJsonAsync($"/api/sessions/{id}/stream/control?monitorId=diagnostic-synthetic-1", new { ack = record.Sequence, decodeMs = 1 }, timeout.Token)).EnsureSuccessStatusCode();
            }
        }
        public async Task<(string? Code, string? Error)> TerminalAsync()
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            while (true)
            {
                var record = await ReadAsync(timeout.Token); if (record.Type != 4) continue;
                using var terminal = JsonDocument.Parse(record.Body);
                return (terminal.RootElement.GetProperty("code").GetString(), terminal.RootElement.GetProperty("error").GetString());
            }
        }
        public async ValueTask DisposeAsync() { await stream.DisposeAsync(); response.Dispose(); }
    }
}
