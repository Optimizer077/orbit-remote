using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

internal static class SessionAccessChecks
{
    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        foreach (var mode in new[] { "owner", "owner-all", "revoke", "remote-end", "lifecycle", "expiry", "restart" })
            await RoutesAsync(check, temporaryRoot, mode);
        await DownloadAsync(check, temporaryRoot, false);
        await DownloadAsync(check, temporaryRoot, true);
        foreach (var stream in new[] { false, true })
            foreach (var mode in new[] { "owner", "revoke", "remote-end", "lifecycle" })
                await LookupRaceAsync(check, temporaryRoot, stream, mode);
        foreach (var revoke in new[] { false, true })
            foreach (var beforeFirstChunk in new[] { false, true })
                await BeforeDownloadAsync(check, temporaryRoot, revoke, beforeFirstChunk);
    }

    private static async Task RoutesAsync(Action<bool, string> check, string root, string mode)
    {
        var directory = Path.Combine(root, "session-access-" + mode);
        var clock = new Clock(); var state = new HostState(directory, clock);
        var peer = Pair(state, "generated-primary-" + mode, new(View: true, Control: true, Clipboard: true, Files: true));
        var session = state.StartSession(peer, null);
        var other = Pair(state, "generated-other-" + mode, new(View: true));
        var otherSession = state.StartSession(other, null, viewOnly: true);
        var epoch = peer.ResumeEpoch;
        check(SessionAccess.CurrentPeer(state, peer with { Id = "forged-snapshot-id", Permissions = new(View: true) })?.Id == peer.Id,
            "Session access: current certificate pin, rather than cached device ID/grants, selects authority: " + mode);
        if (mode == "restart") state = new HostState(directory, clock);
        var folder = Path.Combine(root, "session-access-folder-" + mode); Directory.CreateDirectory(folder);
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build(); await using var platform = new FakePlatform();
        using var inputGate = new SemaphoreSlim(1, 1); using var captureGate = new SemaphoreSlim(1, 1);
        var shutdown = app.Services.GetRequiredService<HostShutdown>();
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        RemoteSession? Find(HttpContext _, string id, Func<DevicePermissions, bool> permission) =>
            SessionAccess.FindSession(state, peer, id, permission);
        RemoteSession? View(HttpContext context, string id) => Find(context, id, value => value.View);
        RemoteSession? Files(HttpContext context, string id) => Find(context, id, value => value.Files);
        app.MapFrame(state, platform, View, _ => peer, () => false, captureGate, new FrameWaitGate(), shutdown);
        app.MapVideoStream(state, platform, () => false, _ => peer);
        app.MapSessions(state, platform, _ => peer, View, value => value, () => false, inputGate, new InputLeases(), shutdown);
        using var inputs = new InputEndpoints(app, state, platform, (context, id) => Find(context, id, value => value.Control), inputGate, new InputLeases(), shutdown, _ => { });
        app.MapList(state, Files); app.MapDownload(state, Files, 1024 * 1024, shutdown);
        app.MapUpload(state, new UploadStore(state, new NoMetadata()), Files, 1024, shutdown);
        await app.StartAsync();
        try
        {
            if (mode == "owner") state.BlockDevice(peer.Id, out _);
            if (mode == "owner-all") state.EndAllSessions();
            if (mode == "revoke") state.Revoke(peer.Id);
            if (mode == "remote-end") state.EndSession(session.Id, peer.Id);
            if (mode == "lifecycle") state.EndAllSessions(false);
            if (mode == "expiry") clock.Now = clock.Now.AddSeconds(31);
            using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
            var ownerEnded = mode is "owner" or "owner-all";
            var expected = ownerEnded ? HttpStatusCode.Forbidden : mode == "revoke" ? HttpStatusCode.Unauthorized : HttpStatusCode.NotFound;
            var requests = new (HttpMethod Method, string Path, object? Body)[]
            {
                (HttpMethod.Get, "frame", null), (HttpMethod.Get, "stream", null),
                (HttpMethod.Post, "stream/control", new { ack = 1 }),
                (HttpMethod.Post, "input", new { kind = "invalid-generated-event" }),
                (HttpMethod.Get, "files", null), (HttpMethod.Get, "files/generated.bin", null),
                (HttpMethod.Put, "files/generated.bin", null), (HttpMethod.Get, "", null),
            };
            foreach (var item in requests)
            {
                using var request = new HttpRequestMessage(item.Method, $"/api/sessions/{session.Id}" + (item.Path.Length == 0 ? "" : "/" + item.Path));
                if (item.Path == "frame") request.Headers.TryAddWithoutValidation("If-None-Match", "\"prior-generated-frame\"");
                if (item.Body is not null) request.Content = JsonContent.Create(item.Body);
                using var response = await client.SendAsync(request);
                check(response.StatusCode == expected, $"Session access HTTP: {mode} {item.Method} {item.Path} returns {expected} before missing-session renewal or native work");
                if (ownerEnded || mode == "revoke")
                {
                    var terminal = false;
                    try
                    {
                        var reason = await response.Content.ReadFromJsonAsync<JsonElement>();
                        terminal = reason.TryGetProperty("code", out var code) && code.GetString() == (ownerEnded ? OwnerEndedException.Code : SessionRevokedException.Code);
                    }
                    catch (JsonException) { }
                    check(terminal,
                        "Session access HTTP: terminal reason survives the removed session row: " + mode + " " + item.Path);
                }
            }
            check(platform.Effects == 0 && !Directory.EnumerateFiles(folder).Any(), "Session access: denied/missing routes perform no fake capture, input, clipboard or file writes: " + mode);
            if (mode is "owner" or "revoke")
            {
                check(SessionAccess.CurrentPeer(state, other)?.Id == other.Id && state.GetSession(otherSession.Id, other.Id) is not null,
                    "Session access: terminal authority is scoped to its certificate and leaves another device live: " + mode);
            }
            else if (mode == "owner-all") check(state.GetSession(otherSession.Id, other.Id) is null && state.Devices.Where(device => device.RevokedAt is null).All(device => device.BlockedByOwner),
                "Session access: owner Disconnect all consistently terminates every connected device");
            else
            {
                using var renewed = await client.PostAsJsonAsync("/api/sessions", new SessionRequest(ViewOnly: true, ResumeEpoch: epoch));
                var body = await renewed.Content.ReadFromJsonAsync<JsonElement>();
                check(renewed.IsSuccessStatusCode && body.GetProperty("id").GetString() != session.Id && body.GetProperty("resumeEpoch").GetString() == epoch && !body.GetProperty("permissions").GetProperty("control").GetBoolean(),
                    "Session access: an authorized missing session still accepts one protected view-only renewal: " + mode);
            }
        }
        finally { await app.StopAsync(); }
    }

    private static async Task DownloadAsync(Action<bool, string> check, string root, bool revoke)
    {
        var suffix = revoke ? "revoke" : "owner";
        var state = new HostState(Path.Combine(root, "session-download-state-" + suffix));
        var peer = Pair(state, "generated-download-" + suffix, new(View: true, Files: true));
        var session = state.StartSession(peer, null);
        var folder = Path.Combine(root, "session-download-folder-" + suffix); Directory.CreateDirectory(folder);
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        await File.WriteAllBytesAsync(Path.Combine(folder, "generated.bin"), new byte[131072]);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build(); using var shutdown = new HostShutdown(app.Lifetime);
        AbortFeature? abort = null; AfterWrite? body = null;
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        app.Use(async (context, next) =>
        {
            var original = context.Response.Body;
            abort = new(context.Features.Get<IHttpRequestLifetimeFeature>()!); context.Features.Set<IHttpRequestLifetimeFeature>(abort);
            body = new(original, () => { if (revoke) state.Revoke(peer.Id); else state.BlockDevice(peer.Id, out _); });
            context.Response.Body = body;
            try { await next(context); } finally { context.Response.Body = original; }
        });
        RemoteSession? Find(HttpContext _, string id) => SessionAccess.FindSession(state, peer, id, value => value.Files);
        app.MapDownload(state, Find, 1024 * 1024, shutdown); await app.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
            var received = 0;
            try { using var response = await client.GetAsync($"/api/sessions/{session.Id}/files/generated.bin"); received = (await response.Content.ReadAsByteArrayAsync()).Length; }
            catch (Exception ex) when (ex is HttpRequestException or IOException) { }
            check(abort?.Aborted == true && body?.Bytes == 65536 && received < 131072,
                "Session access: typed authority loss during a real download aborts before its next chunk: " + suffix);
        }
        finally { await app.StopAsync(); }
    }

    private static async Task LookupRaceAsync(Action<bool, string> check, string root, bool stream, string mode)
    {
        var suffix = (stream ? "stream-" : "ordinary-") + mode;
        var state = new HostState(Path.Combine(root, "session-race-" + suffix));
        var peer = Pair(state, "generated-race-" + suffix, new(View: true));
        var session = state.StartSession(peer, null, viewOnly: true);
        var lookups = 0;
        RemoteSession? Lookup(string id, string device)
        {
            lookups++;
            if (mode == "owner") state.BlockDevice(peer.Id, out _);
            if (mode == "revoke") state.Revoke(peer.Id);
            if (mode == "remote-end") state.EndSession(session.Id, peer.Id);
            if (mode == "lifecycle") state.EndAllSessions(false);
            return state.GetSession(id, device);
        }
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        var access = new HostStateStreamAccess(state, () => false, _ => peer, default, Lookup);
        app.MapGet("/generated", (HttpContext context) =>
        {
            var found = stream ? access.FindSession(context, session.Id)
                : SessionAccess.FindSession(state, peer, session.Id, value => value.View, lookup: Lookup);
            return found is null ? Results.NotFound() : Results.Ok();
        });
        await app.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
            using var response = await client.GetAsync("/generated");
            var expected = mode == "owner" ? 403 : mode == "revoke" ? 401 : 404;
            var correct = (int)response.StatusCode == expected && lookups == 1;
            if (mode is "owner" or "revoke")
            {
                var terminal = false;
                try
                {
                    var reason = await response.Content.ReadFromJsonAsync<JsonElement>();
                    terminal = reason.GetProperty("code").GetString() == (mode == "owner" ? OwnerEndedException.Code : SessionRevokedException.Code);
                }
                catch (JsonException) { }
                correct &= terminal;
            }
            check(correct, "Session access race: production lookup rechecks a missing row after a concurrent authority change: " + suffix);
        }
        finally { await app.StopAsync(); }
    }

    private static async Task BeforeDownloadAsync(Action<bool, string> check, string root, bool revoke, bool beforeFirstChunk)
    {
        var suffix = (revoke ? "revoke-" : "owner-") + (beforeFirstChunk ? "first-chunk" : "before-result");
        var state = new HostState(Path.Combine(root, "session-pre-download-" + suffix));
        var peer = Pair(state, "generated-pre-download-" + suffix, new(View: true, Files: true));
        var session = state.StartSession(peer, null);
        var folder = Path.Combine(root, "session-pre-download-folder-" + suffix); Directory.CreateDirectory(folder);
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        await File.WriteAllBytesAsync(Path.Combine(folder, "generated.bin"), new byte[131072]);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build(); using var shutdown = new HostShutdown(app.Lifetime);
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        var lookups = 0;
        RemoteSession? Find(HttpContext unusedContext, string id)
        {
            if (++lookups == (beforeFirstChunk ? 3 : 2))
            { if (revoke) state.Revoke(peer.Id); else state.BlockDevice(peer.Id, out _); }
            return SessionAccess.FindSession(state, peer, id, value => value.Files);
        }
        app.MapDownload(state, Find, 1024 * 1024, shutdown); await app.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
            using var response = await client.GetAsync($"/api/sessions/{session.Id}/files/generated.bin");
            var terminal = false;
            try
            {
                var body = await response.Content.ReadFromJsonAsync<JsonElement>();
                terminal = body.TryGetProperty("code", out var code) && code.GetString() == (revoke ? SessionRevokedException.Code : OwnerEndedException.Code);
            }
            catch (JsonException) { }
            check((int)response.StatusCode == (revoke ? 401 : 403) && terminal
                && response.Content.Headers.ContentDisposition is null && response.Content.Headers.ContentLength is not 131072,
                "Session access download: authority loss before any body byte remains complete typed JSON without attachment headers: " + suffix);
        }
        finally { await app.StopAsync(); }
    }

    private static PairedDevice Pair(HostState state, string fingerprint, DevicePermissions permissions)
    {
        var invitation = state.CreateInvite(new("Generated device", permissions), "https://127.0.0.1:1", "generated");
        var encoded = invitation.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
        return state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated device"), fingerprint);
    }
    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
    private sealed class NoMetadata : IUploadMetadata { public void MarkAndVerify(string path) { } }
    private sealed class FakePlatform : IPlatformBackend
    {
        internal int Effects;
        public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(new PlatformStatus("Generated", "interactive", true, true, true, true, [new("generated", "Generated", 0, 0, 64, 48, true)], []));
        public Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default) { Effects++; throw new InvalidOperationException("Denied routes must not capture."); }
        public Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default) { Effects++; throw new InvalidOperationException("Denied routes must not send input."); }
        public Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default) { Effects++; throw new InvalidOperationException("Denied routes must not read clipboard."); }
        public Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default) { Effects++; throw new InvalidOperationException("Denied routes must not write clipboard."); }
        public Task LockAsync(CancellationToken cancellationToken = default) { Effects++; throw new InvalidOperationException("Denied routes must not lock."); }
        public Task ReleaseInputsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
    private sealed class AfterWrite(Stream inner, Action after) : Stream
    {
        internal long Bytes;
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default)
        { await inner.WriteAsync(buffer, token); Bytes += buffer.Length; after(); }
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => inner.Flush(); public override Task FlushAsync(CancellationToken token) => inner.FlushAsync(token);
        public override void Write(byte[] buffer, int offset, int count) { inner.Write(buffer, offset, count); Bytes += count; after(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException(); public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException();
    }
    private sealed class AbortFeature(IHttpRequestLifetimeFeature inner) : IHttpRequestLifetimeFeature
    {
        internal bool Aborted;
        public CancellationToken RequestAborted { get => inner.RequestAborted; set => inner.RequestAborted = value; }
        public void Abort() { Aborted = true; inner.Abort(); }
    }
}
