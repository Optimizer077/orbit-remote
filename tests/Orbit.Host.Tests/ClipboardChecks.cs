using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

/// <summary>H-1: clipboard routes on a fake backend. No native clipboard is touched.</summary>
internal static class ClipboardChecks
{
    private const string Content = "generated-clipboard-secret-é";

    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        LimiterChecks(check);
        var clock = new Clock();
        var state = new HostState(Path.Combine(temporaryRoot, "clipboard"), clock);
        var peer = Pair(state, "generated-clipboard-peer", new(View: true, Clipboard: true));
        var first = state.StartSession(peer, null);
        var second = state.StartSession(peer, null);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        await using var platform = new ClipboardPlatform();
        using var gate = new SemaphoreSlim(1, 1);
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        app.MapClipboard(state, platform, (context, id) => SessionAccess.FindSession(state, peer, id, value => value.Clipboard), gate, ClipboardEndpoints.CreateLimiter(clock));
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
        try
        {
            platform.Text = Content;
            var statuses = new List<HttpStatusCode>();
            for (var i = 0; i <= ClipboardEndpoints.Burst; i++)
            {
                using var response = await client.GetAsync($"/api/sessions/{first.Id}/clipboard");
                statuses.Add(response.StatusCode);
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                    check(response.Headers.RetryAfter?.Delta == TimeSpan.FromSeconds(1)
                        && (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "clipboard_rate_limited",
                        "H-1: a rate-limited clipboard request returns 429 clipboard_rate_limited with Retry-After");
            }
            check(statuses.Take(ClipboardEndpoints.Burst).All(status => status == HttpStatusCode.OK) && statuses[^1] == HttpStatusCode.TooManyRequests,
                "H-1: a device gets its clipboard burst, then the next immediate read returns 429");
            check(platform.Reads == ClipboardEndpoints.Burst, "H-1: a rate-limited read never reaches the native clipboard");
            // The budget belongs to the device: another (or a fresh) session of it cannot reset it.
            using (var other = await client.GetAsync($"/api/sessions/{second.Id}/clipboard"))
                check(other.StatusCode == HttpStatusCode.TooManyRequests && platform.Reads == ClipboardEndpoints.Burst,
                    "H-1: a second session of the same device is refused once the device budget is spent");
            check(state.EndSession(second.Id, peer.Id), "Clipboard fixture: the peer ends its second session");
            var fresh = state.StartSession(peer, null);
            using (var churned = await client.GetAsync($"/api/sessions/{fresh.Id}/clipboard"))
                check(churned.StatusCode == HttpStatusCode.TooManyRequests, "H-1: ending and starting a session does not reset the clipboard budget");
            clock.Now += TimeSpan.FromSeconds(1);
            using (var refilled = await client.GetAsync($"/api/sessions/{first.Id}/clipboard"))
                check(refilled.StatusCode == HttpStatusCode.OK, "H-1: the clipboard budget refills over time");

            using (var write = await client.PutAsJsonAsync($"/api/sessions/{fresh.Id}/clipboard", new { text = Content }))
                check(write.StatusCode == HttpStatusCode.NoContent && platform.Written == Content, "H-1: an allowed clipboard write still reaches the backend");

            var audit = state.Audit;
            var reads = audit.Where(entry => entry.Kind == "clipboard.read").ToArray();
            var writes = audit.Where(entry => entry.Kind == "clipboard.write").ToArray();
            var bytes = System.Text.Encoding.UTF8.GetByteCount(Content);
            check(reads.Length == 1 && reads[0].DeviceId == peer.Id && reads[0].Detail.Contains($"({bytes} bytes)", StringComparison.Ordinal),
                "H-1/H-4: clipboard reads are audited with device and UTF-8 byte count, once per device per minute");
            check(writes.Length == 1 && writes[0].Detail.Contains($"({bytes} bytes)", StringComparison.Ordinal), "H-1: a clipboard write is audited with its byte count");
            clock.Now += HostState.AuditCoalesceWindow;
            var later = state.StartSession(peer, null);
            using (var nextMinute = await client.GetAsync($"/api/sessions/{later.Id}/clipboard"))
                check(nextMinute.StatusCode == HttpStatusCode.OK, "Clipboard fixture: a read in the next minute succeeds");
            var reported = state.Audit.First(entry => entry.Kind == "clipboard.read");
            check(state.Audit.Count(entry => entry.Kind == "clipboard.read") == 2
                && reported.Detail.Contains($"{ClipboardEndpoints.Burst} similar earlier events", StringComparison.Ordinal),
                "H-4: the next minute's clipboard entry reports how many reads were coalesced");
            check(!audit.Any(entry => entry.Detail.Contains("generated-clipboard-secret", StringComparison.Ordinal))
                && !File.ReadAllText(Path.Combine(temporaryRoot, "clipboard", "audit.jsonl")).Contains("generated-clipboard-secret", StringComparison.Ordinal),
                "H-1: clipboard text never reaches the audit history or file");
        }
        finally { await app.StopAsync(); }
    }

    private static void LimiterChecks(Action<bool, string> check)
    {
        var clock = new Clock();
        var limiter = ClipboardEndpoints.CreateLimiter(clock);
        var allowed = Enumerable.Range(0, 20).Count(_ => limiter.TryAcquire("generated-session"));
        check(allowed == ClipboardEndpoints.Burst, "H-1 limiter: a burst is capped at the bucket size");
        clock.Now += TimeSpan.FromSeconds(10);
        var sustained = 0;
        for (var tick = 0; tick < 40; tick++) { clock.Now += TimeSpan.FromMilliseconds(250); if (limiter.TryAcquire("generated-session")) sustained++; }
        // Ten seconds of polling at 4/s: a full burst plus two per second, never more.
        check(sustained <= ClipboardEndpoints.Burst + 20 && sustained >= 20, "H-1 limiter: sustained polling is held to the refill rate");
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

    private sealed class ClipboardPlatform : IPlatformBackend
    {
        internal string Text = "";
        internal string? Written;
        internal int Reads;
        public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task ReleaseInputsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default) { Interlocked.Increment(ref Reads); return Task.FromResult(Text); }
        public Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default) { Written = text; return Task.CompletedTask; }
        public Task LockAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
