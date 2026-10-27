using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Orbit.Host;
using Orbit.Host.Platform;

internal static class MacFrameFallbackChecks
{
    internal static async Task RunAsync(Action<bool, string> check)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "global.json"))) root = root.Parent;
        if (root is null) throw new InvalidOperationException("Run Mac native checks from the source checkout.");
        var temporary = Path.Combine(Path.GetTempPath(), "orbit-mac-fallback-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        var controlPort = FreePort();
        var remotePort = FreePort();
        while (remotePort == controlPort) remotePort = FreePort();
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var start = new ProcessStartInfo("dotnet") { UseShellExecute = false, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.Combine(root.FullName, "src/Orbit.Host/bin/Debug/net10.0/Orbit.Host.dll"));
        start.ArgumentList.Add("--loopback-test");
        start.Environment["ORBIT_CONTROL_TOKEN"] = token;
        start.Environment["ORBIT_CONTROL_PORT"] = controlPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["ORBIT_REMOTE_PORT"] = remotePort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["ORBIT_DATA_DIR"] = Path.Combine(temporary, "host");
        start.Environment["ORBIT_PARENT_WATCH"] = "1";
        using var host = Process.Start(start) ?? throw new InvalidOperationException("Fallback test host did not start.");
        var output = host.StandardOutput.ReadToEndAsync();
        var error = host.StandardError.ReadToEndAsync();
        try
        {
            using var local = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{controlPort}"), Timeout = TimeSpan.FromSeconds(3) };
            local.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            JsonElement status = default;
            for (var attempt = 0; attempt < 80; attempt++)
            {
                try { status = await local.GetFromJsonAsync<JsonElement>("/api/status"); break; }
                catch (HttpRequestException) when (!host.HasExited) { await Task.Delay(100); }
            }
            if (status.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Fallback test host did not become ready.");
            var platform = status.GetProperty("platform");
            check(!platform.GetProperty("canScaleFrames").GetBoolean() && !platform.GetProperty("canConditionalFrames").GetBoolean(),
                "Real Mac API advertises full-scale/no-conditional capabilities");
            check(!platform.GetProperty("canJpegFrames").GetBoolean(), "Encoded-only Mac capture does not advertise unwired JPEG");
            var clientDirectory = Path.Combine(temporary, "client"); Directory.CreateDirectory(clientDirectory);
            using var identity = new HostIdentity(clientDirectory, "mac-frame-test", IPAddress.Loopback);
            var pin = status.GetProperty("certificateFingerprint").GetString();
            using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, certificate, _, _) =>
                certificate is not null && Security.Fingerprint(certificate) == pin };
            handler.ClientCertificates.Add(identity.Certificate);
            using var remote = new HttpClient(handler) { BaseAddress = new Uri($"https://127.0.0.1:{remotePort}"), Timeout = TimeSpan.FromSeconds(15) };
            using var invited = await local.PostAsJsonAsync("/api/invites", new { deviceName = "Mac fallback test", permissions = new { view = true } });
            invited.EnsureSuccessStatusCode();
            var invite = await invited.Content.ReadFromJsonAsync<JsonElement>();
            var encoded = invite.GetProperty("inviteUri").GetString()!["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
            var decoded = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
            using var paired = await remote.PostAsJsonAsync("/api/pair", new { secret = decoded.GetProperty("secret").GetString(), deviceName = "Mac fallback test" });
            paired.EnsureSuccessStatusCode();
            using var created = await remote.PostAsJsonAsync("/api/sessions", new { viewOnly = true }); created.EnsureSuccessStatusCode();
            var session = await created.Content.ReadFromJsonAsync<JsonElement>();
            var monitor = platform.GetProperty("monitors").EnumerateArray().First(entry => entry.GetProperty("primary").GetBoolean());
            var route = $"/api/sessions/{session.GetProperty("id").GetString()}/frame?scale=0.33&monitorId=" + Uri.EscapeDataString(monitor.GetProperty("id").GetString()!);
            for (var repeat = 0; repeat < 2; repeat++)
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, route + (repeat == 0 ? "" : "&format=jpeg&quality=75"));
                request.Headers.IfNoneMatch.Add(new EntityTagHeaderValue("\"mac-encoded-fallback\""));
                using var frame = await remote.SendAsync(request);
                check(frame.StatusCode == HttpStatusCode.OK, "Real encoded Mac capture returns200, never304, with a conditional request");
                check(frame.Headers.ETag is null, "Mac fallback emits no reusable ETag");
                check(frame.Content.Headers.ContentType?.MediaType == "image/png" && frame.Headers.GetValues("X-Orbit-Frame-Format").Single() == "png",
                    "Default and unsupported-JPEG Mac requests identify the actual PNG body");
                check(!frame.Headers.Contains("X-Orbit-Frame-Quality"), "PNG fallback does not claim JPEG quality");
                check(frame.Headers.GetValues("X-Orbit-Scale").Single() == "1", "Mac fallback reports the actual full-scale representation");
                var dimensions = PngEncoder.ReadDimensions(await frame.Content.ReadAsByteArrayAsync());
                check(dimensions.Width == monitor.GetProperty("width").GetInt32() && dimensions.Height == monitor.GetProperty("height").GetInt32(),
                    "Requested downscale preserves native Retina pixels on the encoded Mac fallback");
                check(frame.Headers.GetValues("X-Orbit-Encoded-Width").Single() == dimensions.Width.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    "Mac fallback encoded-width metadata agrees with actual PNG pixels");
            }
        }
        finally
        {
            host.StandardInput.Close();
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await host.WaitForExitAsync(deadline.Token); }
            catch (OperationCanceledException) { host.Kill(entireProcessTree: true); await host.WaitForExitAsync(); }
            await output; await error;
            Directory.Delete(temporary, recursive: true);
        }
    }

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port;
    }
}
