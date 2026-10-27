using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

public static class StreamAdmissionChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        PureChecks(check);
        await FaultedEndCleanupAsync(check);
        await HttpChecksAsync(check);
    }

    private static void PureChecks(Action<bool, string> check)
    {
        var pool = new VideoStreamAdmission<object>();
        using var one = pool.TryReserve("d1", "s1", "m")!;
        using var two = pool.TryReserve("d1", "s2", "m")!;
        using var three = pool.TryReserve("d1", "s3", "m")!;
        using var four = pool.TryReserve("d1", "s4", "m")!;
        check(one is not null && two is not null && three is not null && four is not null && pool.TryReserve("d1", "s5", "m") is null,
            "Admission: pending native opens count against four slots per authenticated device");
        check(pool.TryReserve("d1", "s1", "m") is null, "Admission: an unfinished open cannot acquire a second pending replacement");
        using var other = pool.TryReserve("d2", "other-session", "m");
        check(other is not null, "Admission: another device retains capacity while the first is capped");
        one!.Activate(new object());
        using var successor = pool.TryReserve("d1", "s1", "m")!;
        check(successor.Previous is not null && !successor.PreviousReleased.IsCompleted && pool.Count == 5,
            "Admission: replacement holds the same admission position until old resources release");
        check(pool.TryReserve("d1", "s1", "m") is null && pool.TryReserve("d2", "s1", "m") is null,
            "Admission: only one successor and no device-owner substitution for an existing key");
        var earlyRejected = false;
        try { successor.Activate(new object()); } catch (InvalidOperationException) { earlyRejected = true; }
        check(earlyRejected, "Admission: successor activation before predecessor cleanup is refused");
        one.Dispose(); successor.Activate(new object()); one.Dispose();
        check(successor.PreviousReleased.IsCompleted && pool.Count == 5,
            "Admission: stale predecessor cleanup cannot remove its active successor");
        successor.Dispose();
        using var freed = pool.TryReserve("d1", "s5", "m");
        check(freed is not null, "Admission: ended resources return per-device capacity");

        var concurrent = new VideoStreamAdmission<object>();
        var reservations = new ConcurrentBag<VideoStreamAdmission<object>.Reservation>();
        Parallel.For(0, 128, i =>
        {
            var reservation = concurrent.TryReserve("d" + i % 4, "s" + i, "m");
            if (reservation is not null) reservations.Add(reservation);
        });
        check(reservations.Count == 8 && concurrent.Count == 8 && concurrent.TryReserve("fifth", "extra", "m") is null,
            "Admission: concurrent pending opens atomically obey the global eight-slot cap");
        foreach (var reservation in reservations) reservation.Dispose();
        check(concurrent.Count == 0, "Admission: all concurrent reservations release without a leaked slot");
        var cycling = new VideoStreamAdmission<object>();
        var valid = true;
        for (var i = 0; i < 100; i++)
        {
            using var initial = cycling.TryReserve("d", "s", "m")!;
            initial.Activate(new object());
            using (var canceled = cycling.TryReserve("d", "s", "m")) valid &= canceled is not null;
            using var replacement = cycling.TryReserve("d", "s", "m")!;
            initial.Dispose(); replacement.Activate(new object()); replacement.Dispose();
            using var failedOpen = cycling.TryReserve("d", "failed", "m");
            failedOpen?.Dispose(); valid &= cycling.Count == 0;
        }
        check(valid && cycling.Count == 0, "Admission: 100 canceled replacement, successful replacement and failed-open cycles leak no capacity");
    }

    private static async Task FaultedEndCleanupAsync(Action<bool, string> check)
    {
        foreach (var disposeFault in new[] { false, true })
        {
            var encoder = new VideoStreamChecks.FakeEncoder(64, 48, 60);
            var monitor = new MonitorInfo("synthetic-1", "Synthetic", 0, 0, 64, 48, true);
            var gpu = new VideoStreamChecks.FakeGpuSource(monitor);
            var gpuEncoder = gpu.TryOpenEncoder(monitor, 64, 48, 60, 8_000_000)!;
            var run = new VideoStreamRun(Stream.Null, () => { }, new VideoStreamChecks.SyntheticSource(64, 48),
                monitor, (_, _, _, _) => null, VideoStreamSettings.Default, () => VideoStreamDenial.None, default, default,
                firstEncoder: disposeFault ? new CountingEncoder(encoder, () => throw new InvalidOperationException("Generated dispose fault.")) : encoder,
                gpu: gpu, firstGpuEncoder: gpuEncoder);
            if (!disposeFault)
                typeof(VideoStreamRun).GetField("ending", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
                    .SetValue(run, Task.FromException(new InvalidOperationException("Generated non-IO terminal fault.")));
            var propagated = false;
            try { await run.DisposeAsync(); } catch (InvalidOperationException) { propagated = true; }
            check(propagated && encoder.Disposed && gpu.Disposed == 1, disposeFault
                ? "Admission cleanup: a throwing CPU disposer still releases the GPU encoder"
                : "Admission cleanup: a non-IO end-task fault still disposes both owned encoder paths");
        }
    }

    private static async Task HttpChecksAsync(Action<bool, string> check)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build(); await using var platform = new VideoStreamChecks.FakePlatform();
        var currentSession = new AsyncLocal<string?>();
        var source = new ControlledSource(() => currentSession.Value);
        var currentDevice = new AsyncLocal<string?>();
        var sessions = Enumerable.Range(1, 5).SelectMany(d => Enumerable.Range(0, 5).Select(s =>
            new RemoteSession($"d{d}s{s}", "d" + d, "Generated", null, new(View: true), DateTimeOffset.UtcNow,
                DateTimeOffset.UtcNow.AddHours(1), DateTimeOffset.UtcNow))).ToDictionary(s => s.Id);
        RemoteSession? Find(HttpContext context, string id)
        {
            var session = sessions.GetValueOrDefault(id); currentDevice.Value = session?.DeviceId; currentSession.Value = context.TraceIdentifier; return session;
        }
        var accounting = new EncoderAccounting(); var failEncoder = false; var denial = 0;
        var gpu = new VideoStreamChecks.FakeGpuSource(new("synthetic-1", "Synthetic", -1920, 0, 64, 48, true));
        var pointer = new VideoStreamChecks.FakePointerFeed();
        var slots = new VideoStreamSlots<VideoStreamRun>();
        using var stopping = new CancellationTokenSource();
        VideoStreamEndpoints.Map(app, Find, (_, _) => (VideoStreamDenial)Volatile.Read(ref denial), platform, source,
            (w, h, fps, _) => failEncoder ? null : accounting.Open(currentDevice.Value!, w, h, fps),
            () => true, stopping.Token, slots, gpu, pointers: () => pointer);
        await app.StartAsync();
        using var client = new HttpClient(new SocketsHttpHandler { MaxResponseDrainSize = 0 })
        { BaseAddress = new Uri(app.Urls.First()), Timeout = TimeSpan.FromSeconds(5) };
        var readers = new List<VideoStreamChecks.RecordReader>();
        async Task<VideoStreamChecks.RecordReader> Open(string id)
        {
            var reader = await VideoStreamChecks.RecordReader.OpenAsync(client, $"/api/sessions/{id}/stream");
            readers.Add(reader); if (reader.Response.StatusCode == HttpStatusCode.OK) await reader.ReadUntilAsync(records => records.Any(record => record.Type == 2));
            return reader;
        }
        async Task<(HttpStatusCode Status, string? Code)> Status(string id)
        {
            using var response = await client.GetAsync($"/api/sessions/{id}/stream", HttpCompletionOption.ResponseHeadersRead);
            if (response.Content.Headers.ContentType?.MediaType != "application/json") return (response.StatusCode, null);
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            return (response.StatusCode, json.TryGetProperty("code", out var code) ? code.GetString() : null);
        }
        try
        {
            var first = await Open("d1s0"); await Open("d1s1"); await Open("d1s2"); await Open("d1s3");
            var before = source.CaptureRequests; var opens = accounting.Opens;
            check(await Status("d1s4") == (HttpStatusCode.TooManyRequests, "stream_capacity") && source.CaptureRequests == before && accounting.Opens == opens,
                "Admission HTTP: a device's fifth stream is typed429 before CPU capture or encoder construction");
            using (var gpuDenied = await client.GetAsync("/api/sessions/d1s4/stream?cursor=local"))
                check(gpuDenied.StatusCode == HttpStatusCode.TooManyRequests && gpu.Opens == 0,
                    "Admission HTTP: the same device cap also refuses before the GPU encoder source is opened");
            var other = await Open("d2s0");
            check(other.Response.StatusCode == HttpStatusCode.OK, "Admission HTTP: a different authenticated session owner can still open");
            var replacement = await Open("d1s0"); await first.ReadUntilAsync(records => records.Any(record => record.Type == 4));
            check(replacement.Response.StatusCode == HttpStatusCode.OK && first.Records.LastOrDefault() is { Type: 4 } terminal
                    && JsonDocument.Parse(terminal.Payload).RootElement.GetProperty("code").GetString() == "stream_replaced" && accounting.Peak("d1") == 4,
                "Admission HTTP: replacement at the device cap flushes stream_replaced and disposes old encoder before constructing new");

            var stalled = accounting.StallNextDispose("d1");
            opens = accounting.Opens; before = source.CaptureRequests;
            var timedOut = Status("d1s0");
            await stalled.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            var response = await timedOut;
            check(response == (HttpStatusCode.TooManyRequests, "stream_capacity") && accounting.Opens == opens && source.CaptureRequests == before,
                "Admission HTTP: stalled old native disposal returns typed429 after bounded wait with no successor native work");
            check(await Status("d1s4") == (HttpStatusCode.TooManyRequests, "stream_capacity"),
                "Admission HTTP: timed-out replacement does not prematurely free old resources' device capacity");
            stalled.Release.TrySetResult(); await Until(() => accounting.Live("d1") == 3 && slots.Count == 4);
            var recovered = await Open("d1s4");
            check(recovered.Response.StatusCode == HttpStatusCode.OK && accounting.Peak("d1") == 4,
                "Admission HTTP: completed late cleanup frees capacity and never exceeds four encoders");
            var revokedStall = accounting.StallNextDispose("d1");
            var revokedReplacement = Status("d1s4");
            await revokedStall.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            Volatile.Write(ref denial, (int)VideoStreamDenial.Revoked);
            check((await revokedReplacement).Status == HttpStatusCode.Unauthorized,
                "Admission HTTP: revocation during a stalled replacement wait remains401 rather than retryable capacity denial");
            revokedStall.Release.TrySetResult(); Volatile.Write(ref denial, 0);
            foreach (var reader in readers) reader.Dispose(); await Until(() => slots.Count == 0 && accounting.TotalLive == 0);

            source.Hold();
            using var canceled = new CancellationTokenSource();
            var pending = Enumerable.Range(0, 4).Select(i => client.GetAsync($"/api/sessions/d1s{i}/stream", HttpCompletionOption.ResponseHeadersRead, canceled.Token)).ToArray();
            await Until(() => source.Waiters == 4);
            opens = accounting.Opens;
            check(await Status("d1s4") == (HttpStatusCode.TooManyRequests, "stream_capacity") && source.Waiters == 4 && accounting.Opens == opens,
                "Admission HTTP: four asynchronous captures reserve capacity before any encoder exists");
            canceled.Cancel();
            foreach (var task in pending) { try { using var pendingResponse = await task; } catch (OperationCanceledException) { } }
            await Until(() => source.Waiters == 0); source.Unhold();
            failEncoder = true;
            var failures = true;
            for (var i = 0; i < 100; i++) failures &= (await Status("d1s0")).Status == HttpStatusCode.Conflict;
            failEncoder = false;
            var afterFailures = await Open("d1s0"); var afterCancel = await Open("d1s1");
            check(failures && afterFailures.Response.StatusCode == HttpStatusCode.OK && afterCancel.Response.StatusCode == HttpStatusCode.OK,
                "Admission HTTP: canceled captures and 100 failed encoder opens release every reservation");
            await Open("d1s2"); await Open("d1s3");
            for (var d = 2; d <= 3; d++) for (var s = 0; s < 2; s++) await Open($"d{d}s{s}");
            opens = accounting.Opens;
            check(await Status("d5s0") == (HttpStatusCode.TooManyRequests, "stream_capacity") && accounting.Opens == opens && accounting.TotalLive == 8,
                "Admission HTTP: the ninth stream across distinct devices is typed429 before encoder allocation");
        }
        finally
        {
            accounting.ReleaseAll(); source.Unhold(); foreach (var reader in readers) reader.Dispose();
            await stopping.CancelAsync(); await app.StopAsync();
        }
        check(accounting.TotalLive == 0 && slots.Count == 0, "Admission HTTP: server shutdown returns all stream resources and slots");
    }

    private static async Task Until(Func<bool> condition)
    {
        using var timeout = new CancellationTokenSource(3000);
        while (!condition()) await Task.Delay(5, timeout.Token);
    }

    private sealed class ControlledSource(Func<string?> currentSession) : IVideoFrameSource
    {
        private readonly VideoStreamChecks.SyntheticSource inner = new(64, 48);
        private TaskCompletionSource? held;
        public TaskCompletionSource Entered { get; private set; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int waiters;
        public int Waiters => Volatile.Read(ref waiters);
        private readonly ConcurrentDictionary<string, int> gets = new();
        public int CaptureRequests => gets.Count;
        public void Hold() { Entered = new(TaskCreationOptions.RunContinuationsAsynchronously); held = new(TaskCreationOptions.RunContinuationsAsynchronously); }
        public void Unhold() { Interlocked.Exchange(ref held, null)?.TrySetResult(); }
        public async Task<VideoSourceFrame?> GetLatestAsync(MonitorInfo monitor, CancellationToken cancellationToken)
        {
            gets.AddOrUpdate(currentSession() ?? "unknown", 1, (_, count) => count + 1);
            if (held is { } pending)
            {
                Interlocked.Increment(ref waiters); Entered.TrySetResult();
                try { await pending.Task.WaitAsync(cancellationToken); } finally { Interlocked.Decrement(ref waiters); }
            }
            return await inner.GetLatestAsync(monitor, cancellationToken);
        }
        public Task WaitForChangeAsync(VideoSourceFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken) =>
            inner.WaitForChangeAsync(observed, maximumWaitMilliseconds, cancellationToken);
    }

    private sealed class EncoderAccounting
    {
        private readonly object gate = new();
        private readonly Dictionary<string, int> live = [], peaks = [];
        private readonly List<Stall> stalls = [];
        private int opens;
        public int Opens { get { lock (gate) return opens; } }
        public int TotalLive { get { lock (gate) return live.Values.Sum(); } }
        public int Live(string device) { lock (gate) return live.GetValueOrDefault(device); }
        public int Peak(string device) { lock (gate) return peaks.GetValueOrDefault(device); }
        public Stall StallNextDispose(string device) { lock (gate) { var stall = new Stall(device); stalls.Add(stall); return stall; } }
        public void ReleaseAll() { lock (gate) foreach (var stall in stalls) stall.Release.TrySetResult(); }
        public IVideoStreamEncoder Open(string device, int width, int height, int fps)
        {
            lock (gate) { opens++; live[device] = live.GetValueOrDefault(device) + 1; peaks[device] = Math.Max(live[device], peaks.GetValueOrDefault(device)); }
            return new CountingEncoder(new(width, height, fps), () =>
            {
                Stall? stall;
                lock (gate) { stall = stalls.FirstOrDefault(s => s.Device == device && !s.Used); if (stall is not null) stall.Used = true; }
                if (stall is not null) { stall.Entered.TrySetResult(); stall.Release.Task.Wait(TimeSpan.FromSeconds(5)); }
                lock (gate) live[device]--;
            });
        }
        internal sealed class Stall(string device)
        {
            public string Device { get; } = device;
            public bool Used;
            public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
            public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        }
    }

    private sealed class CountingEncoder(VideoStreamChecks.FakeEncoder inner, Action dispose) : IVideoStreamEncoder
    {
        private int disposed;
        public int EncodedWidth => inner.EncodedWidth;
        public int EncodedHeight => inner.EncodedHeight;
        public int FramesPerSecond => inner.FramesPerSecond;
        public IReadOnlyList<VideoEncodedUnit> Encode(ReadOnlyMemory<byte> bgra, long timestamp100ns, bool forceKeyframe) => inner.Encode(bgra, timestamp100ns, forceKeyframe);
        public IReadOnlyList<VideoEncodedUnit> Flush() => inner.Flush();
        public bool SetBitrate(int bitrateBps) => inner.SetBitrate(bitrateBps);
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) { inner.Dispose(); dispose(); } }
    }
}
