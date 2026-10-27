using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

public static class HostShutdownChecks
{
    private static readonly MonitorInfo Monitor = new("synthetic-1", "Synthetic", -1920, 0, 64, 48, true);

    public static async Task RunAsync(Action<bool, string> check)
    {
        await HttpShutdownAsync(check, false);
        await HttpShutdownAsync(check, true);
        await BlockedWritersAsync(check);
        await InputReleaseRaceAsync(check);
        await EarlyStopRoutesAsync(check);
        await DownloadStopAsync(check);
    }

    private static async Task HttpShutdownAsync(Action<bool, string> check, bool revoked)
    {
        const int count = 8;
        var flushed = 0;
        var directory = Path.Combine(Path.GetTempPath(), "orbit-shutdown-check-" + Guid.NewGuid().ToString("N"));
        var state = new HostState(directory);
        var peers = new List<PairedDevice>(); var sessions = new Dictionary<string, RemoteSession>();
        for (var i = 0; i < 4; i++)
        {
            var invite = state.CreateInvite(new("Generated", new(View: true)), "https://127.0.0.1:1", "generated-pin");
            var encoded = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
            using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
            var peer = state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated"), "generated-peer-" + i); peers.Add(peer);
            for (var j = 0; j < 2; j++) { var session = state.StartSession(peer, null, viewOnly: true); sessions.Add(session.Id, session); }
        }
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        HostShutdown.Add(builder.Services);
        var serverEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var serverGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var serverDescriptor = builder.Services.Last(service => service.ServiceType == typeof(IServer));
        builder.Services.Remove(serverDescriptor);
        builder.Services.AddSingleton<IServer>(provider => new StopProbe((IServer)(serverDescriptor.ImplementationInstance
            ?? serverDescriptor.ImplementationFactory?.Invoke(provider)
            ?? ActivatorUtilities.CreateInstance(provider, serverDescriptor.ImplementationType!)), () => Volatile.Read(ref flushed) == count, serverEntered, serverGate.Task));
        await using var app = builder.Build();
        var lifetime = app.Lifetime; var stopping = lifetime.ApplicationStopping;
        var stopProbe = (StopProbe)app.Services.GetRequiredService<IServer>();
        var shutdown = app.Services.GetRequiredService<HostShutdown>();
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        app.Use(async (context, next) =>
        {
            var original = context.Response.Body;
            context.Response.Body = new TerminalStream(original, 75, () => Interlocked.Increment(ref flushed));
            try { await next(context); } finally { context.Response.Body = original; }
        });
        await using var platform = new VideoStreamChecks.FakePlatform();
        PairedDevice? RequestPeer(HttpContext context) => sessions.GetValueOrDefault(context.Request.RouteValues["id"]?.ToString() ?? "") is { } session
            ? peers.First(peer => peer.Id == session.DeviceId) : null;
        var access = new HostStateStreamAccess(state, () => false, RequestPeer, stopping);
        VideoStreamEndpoints.Map(app, access.FindSession, access.Check, platform,
            new VideoStreamChecks.SyntheticSource(64, 48), (w, h, f, _) => new VideoStreamChecks.FakeEncoder(w, h, f),
            () => true, stopping, new VideoStreamSlots<VideoStreamRun>(), shutdown: shutdown);
        var frameEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var stopSignal = stopping.Register(() => stopObserved.TrySetResult());
        using var cleanup = lifetime.ApplicationStopped.Register(() => state.EndAllSessions(false));
        using var captureGate = new SemaphoreSlim(1, 1);
        platform.CaptureOverride = async token =>
        {
            frameEntered.TrySetResult(); await stopObserved.Task.WaitAsync(token);
            return new ScreenFrame([], 4, 2, -1920, 0, DateTimeOffset.UtcNow, new byte[32]);
        };
        app.MapFrame(state, platform, access.FindSession, RequestPeer, () => false, captureGate, new FrameWaitGate(), shutdown);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var startedRegistration = lifetime.ApplicationStarted.Register(() => started.TrySetResult());
        var serving = app.RunAsync(); await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var client = new HttpClient(new SocketsHttpHandler { MaxResponseDrainSize = 0 }) { BaseAddress = new Uri(app.Urls.First()) };
        var readers = new List<VideoStreamChecks.RecordReader>();
        try
        {
            foreach (var session in sessions.Values)
            {
                var reader = await VideoStreamChecks.RecordReader.OpenAsync(client, $"/api/sessions/{session.Id}/stream");
                readers.Add(reader); await reader.ReadUntilAsync(records => records.Any(record => record.Type == 2));
            }
            var frame = client.GetAsync($"/api/sessions/{sessions.Keys.First()}/frame");
            await frameEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            // Registered last: revoke during StopApplication, before stream callbacks,
            // with no opportunity to wait for the periodic authorization poll.
            using var revokeDuringStop = revoked ? stopping.Register(() => { foreach (var peer in peers) state.Revoke(peer.Id); }) : default;
            lifetime.StopApplication();
            using var frameResponse = await frame;
            check(revoked ? (int)frameResponse.StatusCode == 401 : (int)frameResponse.StatusCode == 503
                    && (await frameResponse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "host_stopping",
                revoked ? "Shutdown frame HTTP: revocation during stop remains401 rather than an ordinary reconnect hint"
                    : "Shutdown frame HTTP: an in-flight frame returns typed503 host_stopping rather than404");
            await Task.WhenAll(readers.Select(reader => reader.ReadUntilAsync(records => records.Any(record => record.Type == 4))));
            await serverEntered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            var newRequestsCorrect = true;
            foreach (var route in new[] { "stream", "stream/control", "frame" })
            {
                using var request = new HttpRequestMessage(route == "stream/control" ? HttpMethod.Post : HttpMethod.Get,
                    $"/api/sessions/{sessions.Keys.First()}/{route}");
                using var response = await client.SendAsync(request);
                newRequestsCorrect &= revoked ? (int)response.StatusCode == 401
                    && (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == SessionRevokedException.Code
                    : (int)response.StatusCode == 503
                    && (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "host_stopping";
            }
            check(newRequestsCorrect, revoked ? "Shutdown lookup HTTP: new revoked stream/control/frame requests retain security denials"
                : "Shutdown lookup HTTP: new stream/control/frame requests use real live authorization and get typed503 even after stream slots end");
            using var unknown = await client.GetAsync("/api/sessions/unknown/stream");
            check((int)unknown.StatusCode == 404, "Shutdown lookup HTTP: unknown session IDs remain404 during the drain");
            serverGate.TrySetResult();
            await serving.WaitAsync(TimeSpan.FromSeconds(5));
            var code = revoked ? "access_revoked" : "host_stopping";
            check(readers.All(reader => reader.Ended && reader.Violation is null && reader.Records.LastOrDefault() is { Type: 4 } terminal
                    && JsonDocument.Parse(terminal.Payload).RootElement.GetProperty("code").GetString() == code),
                $"Shutdown HTTP: all eight real Kestrel streams flush {code} before EOF with valid framing");
            check(stopProbe.SawAllTerminals, "Shutdown HTTP: delayed terminal flushes finish before Kestrel IServer.StopAsync begins");
            await using var late = NewRun(Stream.Null, stopping);
            check(!shutdown.TryTrack(late), "Shutdown HTTP: a stopped host cannot register a new stream");
        }
        finally
        {
            serverGate.TrySetResult(); foreach (var reader in readers) reader.Dispose(); if (!serving.IsCompleted) lifetime.StopApplication(); await serving.WaitAsync(TimeSpan.FromSeconds(5));
            var full = Path.GetFullPath(directory);
            if ((Path.GetDirectoryName(full) == Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            || Path.GetDirectoryName(full) == CanonicalTemporaryBase())
                && Path.GetFileName(full).StartsWith("orbit-shutdown-check-", StringComparison.Ordinal)) Directory.Delete(full, true);
        }
    }

    private static async Task InputReleaseRaceAsync(Action<bool, string> check)
    {
        await InputRouteStopAsync(check, false);
        await InputRouteStopAsync(check, true);
        await HungReleaseAsync(check);
    }

    private static async Task InputRouteStopAsync(Action<bool, string> check, bool stuck)
    {
        var directory = Path.Combine(Path.GetTempPath(), "orbit-shutdown-check-" + Guid.NewGuid().ToString("N"));
        var state = new HostState(directory); var peer = Pair(state, "input-stop", new(View: true, Control: true));
        var session = state.StartSession(peer, null);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build(); await using var platform = new VideoStreamChecks.FakePlatform();
        using var gate = new SemaphoreSlim(1, 1);
        var shutdown = app.Services.GetRequiredService<HostShutdown>(); var lifetime = app.Lifetime;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finishDown = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var fallback = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = false; var releases = 0;
        var events = new System.Collections.Concurrent.ConcurrentQueue<string>();
        platform.ApplyOverride = async (_, _) => { entered.TrySetResult(); await finishDown.Task; held = true; events.Enqueue("down"); };
        platform.ReleaseOverride = () => { held = false; Interlocked.Increment(ref releases); events.Enqueue("release"); fallback.TrySetResult(); return Task.CompletedTask; };
        RemoteSession? FindSession(HttpContext _, string id) => shutdown.IsStopping || lifetime.ApplicationStopping.IsCancellationRequested
            ? null : state.GetSession(id, peer.Id);
        using var input = new InputEndpoints(app, state, platform, FindSession, gate, new InputLeases(), shutdown, _ => { });
        await app.StartAsync(); using var client = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        Task? stopping = null;
        try
        {
            var request = client.PostAsJsonAsync($"/api/sessions/{session.Id}/input", new RemoteInput("key", Key: "KeyA", IsDown: true));
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var elapsed = Stopwatch.StartNew(); stopping = Task.Run(lifetime.StopApplication);
            if (stuck)
            {
                await stopping.WaitAsync(TimeSpan.FromSeconds(4));
                await fallback.Task.WaitAsync(TimeSpan.FromSeconds(1));
                check(elapsed.ElapsedMilliseconds is >= 1500 and < 3500 && !finishDown.Task.IsCompleted,
                    "Shutdown input HTTP: a stuck fake input holder cannot block the real stop callback beyond its2s gate/release budget");
            }
            else
            {
                await Task.Delay(100);
                check(Volatile.Read(ref releases) == 0 && !stopping.IsCompleted,
                    "Shutdown input HTTP: the actual stop registration waits for an in-flight fake key-down instead of releasing first");
            }
            finishDown.TrySetResult(); using var response = await request.WaitAsync(TimeSpan.FromSeconds(3));
            await stopping.WaitAsync(TimeSpan.FromSeconds(3));
            check((int)response.StatusCode == 503 && !held && events.LastOrDefault() == "release" && events.Contains("down") && gate.CurrentCount == 1,
                stuck ? "Shutdown input HTTP: a late key-down after the stop fallback is re-released before the actual input route completes"
                    : "Shutdown input HTTP: the mapped key-down finishes before final cleanup, leaving no held key");
            platform.ReleaseOverride = () => Task.FromException(new IOException("Generated release failure"));
            await input.ReleaseAsync();
            check(gate.CurrentCount == 1, "Shutdown input HTTP: failed best-effort native cleanup frees the shared input gate");
        }
        finally
        {
            finishDown.TrySetResult(); if (stopping is not null) await stopping;
            platform.ReleaseOverride = () => Task.CompletedTask;
            await app.StopAsync(); await input.ReleaseAsync(); DeleteTemporary(directory);
        }
    }

    private static async Task HungReleaseAsync(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "orbit-shutdown-check-" + Guid.NewGuid().ToString("N"));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build(); await using var platform = new VideoStreamChecks.FakePlatform();
        using var gate = new SemaphoreSlim(1, 1); var state = new HostState(directory);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        platform.ReleaseOverride = () => release.Task;
        using var input = new InputEndpoints(app, state, platform, (_, _) => null, gate, new InputLeases(), app.Services.GetRequiredService<HostShutdown>(), _ => { });
        await app.StartAsync();
        try
        {
            var elapsed = Stopwatch.StartNew(); await Task.Run(app.Lifetime.StopApplication).WaitAsync(TimeSpan.FromSeconds(4));
            check(elapsed.ElapsedMilliseconds is >= 1500 and < 3500 && !release.Task.IsCompleted,
                "Shutdown input HTTP: an unresponsive native release cannot block the stop callback indefinitely");
            elapsed.Restart(); await input.ReleaseAsync().WaitAsync(TimeSpan.FromSeconds(4));
            check(elapsed.ElapsedMilliseconds < 3500 && !release.Task.IsCompleted,
                "Shutdown input HTTP: post-Run final cleanup also has a bounded policy when the native backend stays stuck");
        }
        finally { release.TrySetResult(); await app.StopAsync(); await input.ReleaseAsync(); DeleteTemporary(directory); }
    }

    private static async Task EarlyStopRoutesAsync(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "orbit-shutdown-check-" + Guid.NewGuid().ToString("N"));
        var state = new HostState(directory);
        var peer = Pair(state, "early-stop");
        var session = state.StartSession(peer, null, viewOnly: true);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build(); await using var platform = new VideoStreamChecks.FakePlatform();
        using var inputGate = new SemaphoreSlim(1, 1); using var captureGate = new SemaphoreSlim(1, 1);
        var shutdown = app.Services.GetRequiredService<HostShutdown>();
        var stopping = app.Lifetime.ApplicationStopping;
        var identityUnavailable = false;
        var access = new HostStateStreamAccess(state, () => identityUnavailable, _ => peer, stopping);
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        app.MapSessions(state, platform, _ => peer, access.FindSession, value => value, () => identityUnavailable, inputGate, new InputLeases(), shutdown);
        app.MapFrame(state, platform, access.FindSession, _ => peer, () => false, captureGate, new FrameWaitGate(), shutdown);
        var captures = 0;
        platform.CaptureOverride = _ => { Interlocked.Increment(ref captures); throw new InvalidOperationException("Capture must not be called while stopping."); };
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        try
        {
            identityUnavailable = true;
            using var rotating = await client.PostAsJsonAsync("/api/sessions", new SessionRequest(ViewOnly: true));
            check((int)rotating.StatusCode == 503 && string.IsNullOrEmpty(await rotating.Content.ReadAsStringAsync()),
                "Shutdown session HTTP: identity rotation returns unavailable503 rather than a revoked403 or ordinary-stop hint");
            identityUnavailable = false;
            // Exactly the early phase of IHost.StopAsync: lifecycle StoppingAsync
            // has begun, but ApplicationStopping has not yet been cancelled.
            await shutdown.StoppingAsync(default);
            check(shutdown.IsStopping && !stopping.IsCancellationRequested && shutdown.StoppingToken.IsCancellationRequested,
                "Shutdown direct-stop: lifecycle transition denies work before ApplicationStopping is cancelled");
            using var get = await client.GetAsync($"/api/sessions/{session.Id}");
            using var post = await client.PostAsJsonAsync("/api/sessions", new SessionRequest(ViewOnly: true, ResumeEpoch: peer.ResumeEpoch));
            using var frame = await client.GetAsync($"/api/sessions/{session.Id}/frame");
            check(await IsStoppingAsync(get) && await IsStoppingAsync(post) && await IsStoppingAsync(frame) && state.Sessions.Length == 1 && captures == 0,
                "Shutdown direct-stop HTTP: real session GET/POST and frame route return typed503 without creating a session or capturing");
            var mutated = false;
            await shutdown.WhileRunning(() => { mutated = true; return Results.Ok(); }).ExecuteAsync(new DefaultHttpContext { Response = { Body = Stream.Null }, RequestServices = app.Services });
            check(!mutated, "Shutdown direct-stop: a session-creation action cannot execute after the transition");
            using var wrong = await client.PostAsJsonAsync("/api/sessions", new SessionRequest(ViewOnly: true, ResumeEpoch: "wrong-generated-epoch"));
            using var unknown = await client.GetAsync("/api/sessions/unknown");
            check((int)wrong.StatusCode == 410 && (int)unknown.StatusCode == 404,
                "Shutdown session HTTP: stale authorization epochs and unknown session IDs retain security/ownership denials");
            state.Revoke(peer.Id);
            using var revoked = await client.PostAsJsonAsync("/api/sessions", new SessionRequest(ViewOnly: true));
            using var revokedGet = await client.GetAsync($"/api/sessions/{session.Id}");
            check((int)revoked.StatusCode == 403 && (int)revokedGet.StatusCode == 401,
                "Shutdown session HTTP: revoked peers cannot obtain an ordinary reconnect hint");
        }
        finally { await app.StopAsync(); DeleteTemporary(directory); }
    }

    private static async Task DownloadStopAsync(Action<bool, string> check)
    {
        var directory = Path.Combine(CanonicalTemporaryBase(), "orbit-shutdown-check-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(directory);
        var state = new HostState(Path.Combine(directory, "host"));
        var transfer = Path.Combine(directory, "transfer"); Directory.CreateDirectory(transfer);
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: transfer));
        var peer = Pair(state, "download-peer", new(View: true, Files: true));
        var session = state.StartSession(peer, null);
        var path = Path.Combine(transfer, "generated.bin");
        await using (var generated = File.Create(path)) generated.SetLength(4 * 1024 * 1024);
        var smallPath = Path.Combine(transfer, "small.bin"); await File.WriteAllBytesAsync(smallPath, [0, 1, 2, 3]);
        var oversizedPath = Path.Combine(transfer, "oversized.bin");
        await using (var oversized = File.Create(oversizedPath)) oversized.SetLength(32L * 1024 * 1024 + 1);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build();
        var shutdown = app.Services.GetRequiredService<HostShutdown>();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        app.Use(async (context, next) =>
        {
            var original = context.Response.Body;
            context.Response.Body = new SlowDownloadStream(original, entered, cancelled);
            try { await next(context); } finally { context.Response.Body = original; }
        });
        var lifetime = app.Lifetime;
        RemoteSession? FindSession(HttpContext _, string id) => shutdown.IsStopping || lifetime.ApplicationStopping.IsCancellationRequested
            ? null : state.GetSession(id, peer.Id);
        app.MapDownload(state, FindSession, 32L * 1024 * 1024, shutdown);
        var prefix = $"/api/sessions/{session.Id}/files/";
        await app.StartAsync(); using var client = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        try
        {
            using var writer = new FileStream(smallPath, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
            using var small = await client.GetAsync(prefix + "small.bin");
            check(small.IsSuccessStatusCode && (await small.Content.ReadAsByteArrayAsync()).SequenceEqual(new byte[] { 0, 1, 2, 3 })
                && small.Content.Headers.ContentDisposition?.FileNameStar == "small.bin" && small.Content.Headers.ContentDisposition.FileName == "small.bin" && small.Content.Headers.ContentLength == 4,
                "Shutdown download HTTP: real file route preserves bytes/length/both download-name headers while another process has the file open for writing");
            using var oversized = await client.GetAsync(prefix + "oversized.bin");
            check((int)oversized.StatusCode == 400 && oversized.Content.Headers.ContentDisposition is null,
                "Shutdown download HTTP: the opened-file size fence rejects an attachment above32MiB");
            var shrinkPath = Path.Combine(transfer, "shrink.bin");
            await using (var shrink = File.Create(shrinkPath)) shrink.SetLength(128 * 1024);
            var shrunk = new DefaultHttpContext(); var abort = new AbortFeature();
            shrunk.Features.Set<IHttpRequestLifetimeFeature>(abort);
            shrunk.Response.Body = new TruncateOnWrite(shrinkPath);
            await new ShutdownFileResult(shrinkPath, "shrink.bin", 32L * 1024 * 1024, shutdown, default).ExecuteAsync(shrunk);
            check(abort.Aborted, "Shutdown download: a shrinking generated file explicitly aborts the production result even without Kestrel's length enforcement");
            using var response = await client.GetAsync(prefix + "generated.bin", HttpCompletionOption.ResponseHeadersRead);
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var initialLength = response.Content.Headers.ContentLength;
            var body = await response.Content.ReadAsStreamAsync();
            var first = new byte[1024]; var read = await body.ReadAsync(first);
            await shutdown.StoppingAsync(default);
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var incomplete = false;
            try { await body.CopyToAsync(Stream.Null).WaitAsync(TimeSpan.FromSeconds(2)); }
            catch (IOException) { incomplete = true; }
            check(read > 0 && initialLength == 4 * 1024 * 1024 && incomplete && !app.Lifetime.ApplicationStopping.IsCancellationRequested,
                "Shutdown download HTTP: an authorized in-flight generated file is cancelled and visibly incomplete during early drain, before Kestrel closes");
            using var late = await client.GetAsync(prefix + "generated.bin");
            check((int)late.StatusCode == 404 && late.Content.Headers.ContentDisposition is null, "Shutdown download HTTP: the real file route denies new downloads after the transition without attachment bytes");
        }
        finally { await app.StopAsync(); DeleteTemporary(directory); }
    }

    private static async Task<bool> IsStoppingAsync(HttpResponseMessage response) =>
        (int)response.StatusCode == 503 && (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "host_stopping";

    private static PairedDevice Pair(HostState state, string pin, DevicePermissions? permissions = null)
    {
        var invite = state.CreateInvite(new("Generated", permissions ?? new(View: true)), "https://127.0.0.1:1", "generated-pin");
        var encoded = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
        return state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated"), pin);
    }

    private static string CanonicalTemporaryBase()
    {
        var full = Path.GetFullPath(Path.GetTempPath()); var root = Path.GetPathRoot(full)!; var current = root;
        foreach (var component in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var info = new DirectoryInfo(Path.Combine(current, component));
            current = info.ResolveLinkTarget(returnFinalTarget: true)?.FullName ?? info.FullName;
        }
        return Path.TrimEndingDirectorySeparator(current);
    }

    private static void DeleteTemporary(string directory)
    {
        var full = Path.GetFullPath(directory);
        if ((Path.GetDirectoryName(full) == Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            || Path.GetDirectoryName(full) == CanonicalTemporaryBase())
            && Path.GetFileName(full).StartsWith("orbit-shutdown-check-", StringComparison.Ordinal)) Directory.Delete(full, true);
    }

    private sealed class SlowDownloadStream(Stream inner, TaskCompletionSource entered, TaskCompletionSource cancelled) : Stream
    {
        private int writes;
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (Interlocked.Increment(ref writes) > 1)
            {
                entered.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, cancellationToken); }
                catch (OperationCanceledException) { cancelled.TrySetResult(); throw; }
            }
            await inner.WriteAsync(buffer, cancellationToken); await inner.FlushAsync(cancellationToken);
        }
        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);
        public override void Flush() => inner.Flush();
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    private sealed class AbortFeature : IHttpRequestLifetimeFeature
    {
        public CancellationToken RequestAborted { get; set; }
        public bool Aborted;
        public void Abort() => Aborted = true;
    }

    private sealed class TruncateOnWrite(string path) : MemoryStream
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            using var changed = new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite);
            changed.SetLength(0); return ValueTask.CompletedTask;
        }
    }

    private static async Task BlockedWritersAsync(Action<bool, string> check)
    {
        using var lifetime = new TestLifetime(); using var shutdown = new HostShutdown(lifetime);
        var streams = Enumerable.Range(0, 8).Select(_ => new TerminalStream(Stream.Null, 0, () => { }) { BlockTerminal = true }).ToArray();
        // Only the coordinator starts these terminals, so a sequential drain
        // cannot be hidden by per-run stopping callbacks that start them all.
        var runs = streams.Select(output => NewRun(output, default, 5000)).ToArray();
        var running = runs.Select(run => { shutdown.TryTrack(run); return run.RunAsync(); }).ToArray();
        try
        {
            var deadline = Environment.TickCount64 + 1000;
            while (streams.Any(output => !output.SawUnit) && Environment.TickCount64 < deadline) await Task.Delay(5);
            var elapsed = Stopwatch.StartNew(); lifetime.StopApplication(); await shutdown.StoppingAsync(default);
            check(streams.All(output => output.SawUnit && output.SawTerminal) && elapsed.ElapsedMilliseconds is >= 100 and < 2000,
                "Shutdown budget: eight blocked writers share one 500ms grace rather than eight per-stream waits");
            elapsed.Restart(); await shutdown.StoppingAsync(default);
            check(elapsed.ElapsedMilliseconds < 350, "Shutdown budget: a second drain cannot start another grace period");
        }
        finally
        {
            foreach (var stream in streams) stream.Release();
            await Task.WhenAll(running).WaitAsync(TimeSpan.FromSeconds(3));
            foreach (var run in runs) await run.DisposeAsync();
        }
    }

    private static VideoStreamRun NewRun(Stream output, CancellationToken stopping, int terminalMilliseconds = 250) =>
        new(output, () => { }, new VideoStreamChecks.SyntheticSource(64, 48), Monitor,
            (w, h, fps, _) => new VideoStreamChecks.FakeEncoder(w, h, fps), new VideoStreamSettings(30, 2_000_000, 1),
            () => VideoStreamDenial.None, default, stopping, new VideoStreamTimings(TerminalMilliseconds: terminalMilliseconds));

    private sealed class StopProbe(IServer inner, Func<bool> allFlushed, TaskCompletionSource entered, Task gate) : IServer
    {
        public bool SawAllTerminals;
        public IFeatureCollection Features => inner.Features;
        public Task StartAsync<TContext>(IHttpApplication<TContext> application, CancellationToken cancellationToken) where TContext : notnull => inner.StartAsync(application, cancellationToken);
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            SawAllTerminals = allFlushed(); entered.TrySetResult();
            await gate.WaitAsync(TimeSpan.FromSeconds(3), cancellationToken); // Test-only: inspect new HTTP requests before transport teardown.
            await inner.StopAsync(cancellationToken);
        }
        public void Dispose() => inner.Dispose();
    }

    private sealed class TestLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource stopping = new();
        public CancellationToken ApplicationStarted => default;
        public CancellationToken ApplicationStopping => stopping.Token;
        public CancellationToken ApplicationStopped => default;
        public void StopApplication() => stopping.Cancel();
        public void Dispose() => stopping.Dispose();
    }

    private sealed class TerminalStream(Stream inner, int delay, Action flushed) : Stream
    {
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private bool terminal;
        public bool BlockTerminal { get; init; }
        public volatile bool SawUnit;
        public volatile bool SawTerminal;
        public void Release() => released.TrySetResult();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (buffer.Length == 24 && buffer.Span[0] == 2) SawUnit = true;
            if (buffer.Length == 24 && buffer.Span[0] == 4)
            {
                SawTerminal = true;
                terminal = true;
                if (BlockTerminal) await released.Task.WaitAsync(cancellationToken);
                else if (delay > 0) await Task.Delay(delay, cancellationToken);
            }
            await inner.WriteAsync(buffer, cancellationToken);
        }
        public override async Task FlushAsync(CancellationToken cancellationToken) { await inner.FlushAsync(cancellationToken); if (terminal) { terminal = false; flushed(); } }
        public override void Flush() => inner.Flush();
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}
