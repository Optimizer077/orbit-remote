using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.Versioning;
using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>One picture's access unit; <paramref name="Timestamp100ns"/> is its input time relative to the stream start (null = now).</summary>
internal sealed record VideoEncodedUnit(byte[] Data, bool IsKeyframe, long? Timestamp100ns = null);

/// <summary>The minimal encoder surface the stream needs; the MF encoder in production, a fake in checks.</summary>
internal interface IVideoStreamEncoder : IDisposable
{
    int EncodedWidth { get; }
    int EncodedHeight { get; }
    int FramesPerSecond { get; }
    /// <summary>
    /// 0..n single-picture access units in decode order: an MFT may hold the first input (none) and later return two
    /// pictures at once (Qualcomm). Each one becomes its own record.
    /// </summary>
    IReadOnlyList<VideoEncodedUnit> Encode(ReadOnlyMemory<byte> bgra, long timestamp100ns, bool forceKeyframe);
    /// <summary>Drains pictures the encoder still holds (before reconfiguration).</summary>
    IReadOnlyList<VideoEncodedUnit> Flush();
    bool SetBitrate(int bitrateBps);
}

internal static class EncodedUnits
{
    /// <summary>Throws (typed <c>encode-batch-too-large</c>) when one encode's output exceeds the batch fence.</summary>
    public static void CheckBatch(IReadOnlyList<VideoEncodedUnit> units)
    {
        long total = 0;
        foreach (var unit in units)
        {
            if (unit.Data.Length > VideoStreamRecords.MaximumAccessUnitBytes) throw TooLarge();
            total += unit.Data.Length;
        }
        if (units.Count > VideoStreamRecords.MaximumBatchUnits || total > VideoStreamRecords.MaximumBatchBytes) throw TooLarge();
        static PlatformUnavailableException TooLarge() => new("encode-batch-too-large",
            $"The encoder returned more than {VideoStreamRecords.MaximumBatchUnits} access units or {VideoStreamRecords.MaximumBatchBytes / (1024 * 1024)} MiB for one input.");
    }

    /// <summary>A concatenated encoder output split into single-picture access units (fallback when no unit list exists).</summary>
    public static IReadOnlyList<VideoEncodedUnit> Split(byte[] data) =>
        data.Length == 0 ? [] : VideoStreamRecords.SplitAccessUnits(data).Select(unit => new VideoEncodedUnit(unit.Data, unit.Keyframe)).ToList();
}

/// <summary>Creates an encoder for <paramref name="width"/>×<paramref name="height"/> BGRA input, or null when unavailable.</summary>
internal delegate IVideoStreamEncoder? VideoEncoderFactory(int width, int height, int fps, int bitrateBps);

[SupportedOSPlatform("windows")]
internal sealed class MfVideoStreamEncoder(MfH264Encoder encoder) : IVideoStreamEncoder
{
    public int EncodedWidth => encoder.EncodedWidth;
    public int EncodedHeight => encoder.EncodedHeight;
    public int FramesPerSecond => encoder.FramesPerSecond;
    public IReadOnlyList<VideoEncodedUnit> Encode(ReadOnlyMemory<byte> bgra, long timestamp100ns, bool forceKeyframe) =>
        Units(encoder.Encode(bgra, timestamp100ns, forceKeyframe));
    public IReadOnlyList<VideoEncodedUnit> Flush() => encoder.Flush().Select(unit => new VideoEncodedUnit(unit.Data, unit.IsKeyframe, unit.Timestamp100ns)).ToList();

    /// <summary>The encoder's own per-picture split, each with its input timestamp; the concatenation only as a fallback.</summary>
    private static IReadOnlyList<VideoEncodedUnit> Units(H264EncodedFrame frame) =>
        frame.Units.Count > 0 ? frame.Units.Select(unit => new VideoEncodedUnit(unit.Data, unit.IsKeyframe, unit.Timestamp100ns)).ToList() : EncodedUnits.Split(frame.Data);
    public bool SetBitrate(int bitrateBps) => encoder.SetBitrate(bitrateBps);

    public void Dispose() => encoder.Dispose();
}

/// <summary>Optional per-stage timings of the stream loop (milliseconds), for profiling. Null in production.</summary>
internal sealed class VideoStreamStageTimes
{
    private readonly object gate = new();
    private readonly Dictionary<string, List<double>> samples = [];
    public void Add(string stage, long startTimestamp) => AddMilliseconds(stage, Stopwatch.GetElapsedTime(startTimestamp).TotalMilliseconds);
    public void AddMilliseconds(string stage, double milliseconds)
    {
        lock (gate)
        {
            if (!samples.TryGetValue(stage, out var list)) samples[stage] = list = [];
            if (list.Count < 1_000_000) list.Add(milliseconds);
        }
    }
    public IReadOnlyDictionary<string, double[]> Snapshot() { lock (gate) return samples.ToDictionary(pair => pair.Key, pair => pair.Value.ToArray()); }
}

/// <summary>Why a stream may not continue; maps to an HTTP status at open and a terminal code afterwards.</summary>
public enum VideoStreamDenial { None, HostStopping, IdentityUnavailable, Revoked, EndedByHost, PermissionChanged, SessionEnded, OwnerEnded }

internal sealed record VideoStreamTimings(int HeartbeatMilliseconds = 2000, int AuthorizationMilliseconds = 250,
    int TerminalMilliseconds = 250, int RetryMilliseconds = 100, int MaximumConsecutiveSourceFailures = 50, int MaximumUnackedAccessUnits = 8, double InFlightSeconds = 0.1,
    int BatchWaitMilliseconds = 1000);

/// <summary>A bounded steady-state measurement window; encoder startup and keyframes do not decide the path.</summary>
internal sealed class GpuEncodeHealthWindow
{
    public const int WarmupEncodes = 30;
    public const int MinimumSamples = 15;
    public const int MaximumSamples = 256;
    public const long MinimumSpanMicroseconds = 1_000_000;
    private readonly List<(long At, double Milliseconds)> samples = [];
    private int encodes;
    public int Count => samples.Count;
    public void Reset() { encodes = 0; samples.Clear(); }
    public double? Observe(double milliseconds, bool keyframe, long nowMicroseconds)
    {
        if (encodes < WarmupEncodes) { encodes++; return null; }
        if (keyframe || !double.IsFinite(milliseconds) || milliseconds <= 0) return null;
        if (samples.Count > 0 && nowMicroseconds < samples[^1].At) samples.Clear();
        samples.Add((nowMicroseconds, milliseconds));
        if (samples.Count > MaximumSamples) samples.RemoveAt(0);
        // Keep a full second when the encoder is fast, and at least fifteen
        // samples when it is slow. Retain the sample on the older side of the boundary.
        while (samples.Count > MinimumSamples && samples[1].At <= nowMicroseconds - MinimumSpanMicroseconds) samples.RemoveAt(0);
        return samples.Count >= MinimumSamples && nowMicroseconds - samples[0].At >= MinimumSpanMicroseconds
            ? samples.Select(sample => sample.Milliseconds).Order().ElementAt(samples.Count / 2) : null;
    }
}

internal sealed class GpuReopenFailureWindow
{
    internal const long WindowMicroseconds = 10_000_000;
    private readonly Queue<long> failures = [];
    internal int Count => failures.Count;
    internal bool Record(long now)
    {
        if (failures.Count > 0 && now < failures.Last()) failures.Clear();
        while (failures.Count > 0 && now - failures.Peek() > WindowMicroseconds) failures.Dequeue();
        if (failures.Count == 2) failures.Dequeue();
        failures.Enqueue(now);
        return failures.Count >= 2;
    }
}

/// <summary>
/// One live <c>/stream</c>: waits for a changed frame, encodes it only while the in-flight window has room (at most 8
/// unacknowledged access units and at most bitrateBps/8 × 0.1 s of their bytes, always at least one) and no write is
/// pending (otherwise capture and encode are skipped, never queued), follows each content change with a refresh tail
/// (the last frame re-encoded <see cref="RefreshTailFrames"/> times at the stream's fps, because Media Foundation ignores
/// per-frame QP and a still screen would otherwise keep its first post-change quality), heartbeats every 2 s when idle,
/// forces a keyframe on join/request/source reset, and re-checks authorization on its own timer, which ends the stream
/// with a bounded best-effort terminal record and aborts the connection when that cannot be delivered.
/// </summary>
internal sealed class VideoStreamRun : IAsyncDisposable
{
    private readonly object sync = new();
    private readonly VideoRecordWriter writer;
    private readonly Action abort;
    private readonly IVideoFrameSource source;
    private readonly MonitorInfo monitor;
    private readonly VideoEncoderFactory encoders;
    private readonly Func<VideoStreamDenial> authorize;
    private readonly Func<CancellationToken, Task<bool>>? displayAsleep;
    private readonly CancellationToken connection, hostStopping;
    private readonly Func<long> clock;
    private readonly CancellationTokenSource ended = new();
    private readonly List<(uint Sequence, int Bytes)> unacked = [];
    private long unackedBytes;
    private TaskCompletionSource nudge = NewSignal();
    private VideoStreamSettings settings;
    private VideoSourceFrame? pendingFrame;
    private IVideoStreamEncoder? encoder;
    private bool keyframeRequested, refreshRequested;
    private uint lastAccessUnit;
    private bool anyAccessUnit;
    private Task? ending;
    // Loop state shared by the CPU and GPU paths (only the loop task touches it).
    private string? configKey;
    private bool forceKeyframe = true;
    private long nextFrameAt, lastRecordAt, streamStarted;
    private int tailRemaining;
    // Optional zero-copy GPU path (W8g): only when the viewer draws the pointer (cursor=local); CPU path otherwise or after a failure.
    private readonly IGpuVideoSource? gpuSource;
    private readonly Action<string>? log;
    private IGpuVideoEncoder? gpuEncoder;
    private GpuVideoUnit? gpuLast;
    private int gpuWidth, gpuHeight, gpuBitrate;
    // Viewer-drawn pointer (W7a type-5 records): only on the GPU path, whose frames carry no composited cursor.
    private readonly IPointerFeed? pointerFeed;
    private readonly Dictionary<string, PointerShape> pointerShapes = new(StringComparer.Ordinal);
    private readonly HashSet<string> epochShapes = new(StringComparer.Ordinal); // shapes the viewer knows since the last config
    internal const int MaxViewerShapes = 64; // docs/PROTOCOL.md type 5: the viewer's per-config shape cache
    // A GPU path that encodes slower than the frame budget loses to the CPU path (Windows on ARM measured ~66 ms a frame).
    // The verdict is kept per GPU source for a cooldown, so new streams start on the CPU path at once.
    internal const int SlowGpuSamples = GpuEncodeHealthWindow.MinimumSamples;
    internal static readonly TimeSpan SlowGpuCooldown = TimeSpan.FromMinutes(2);
    private static readonly ConditionalWeakTable<IGpuVideoSource, StrongBox<long>> slowGpuUntil = new();
    private readonly GpuEncodeHealthWindow gpuEncodeHealth = new();
    private readonly GpuReopenFailureWindow gpuReopenFailures = new();
    private volatile bool gpuRecovering;
    private int gpuRecoveryEpoch;
    private int pointerGpuProbeRequested;
    private long gpuHealthVersion;
    private long? lastGpuRecoveryAt;
    public double? SlowGpuMedianMilliseconds { get; private set; }
    public double? LastGpuMedianMilliseconds { get; private set; }
    // The CPU path on that ARM host does ~33 ms a frame, and a ~30 ms GPU encode still drew more frames than it (40 vs 30 fps),
    // so only a GPU path that is clearly slower than 25 fps (or than one frame interval) hands over.
    internal static double GpuBudgetMilliseconds(int maxFps) => Math.Max(40, 1000.0 / Math.Max(1, maxFps));
    private int shapeEpoch;
    private (int X, int Y, bool Visible, string ShapeId, int Epoch)? lastPointer;
    private (string Generation, long Version, int Epoch)? lastPointerVersion;
    private string? lastShapeId;
    private volatile bool pointerDisabled, compositeRequested;
    // Inputs an encoder still holds (inputs minus access units returned). When the screen goes idle with inputs held, the
    // last frame is re-encoded once, which pushes the held picture out (Qualcomm holds the first input), so the viewer is
    // never left without a picture. Flush is reserved for reconfiguration.
    private int heldInputs, gpuHeldInputs;
    private bool heldPushed, gpuHeldPushed;

    public VideoStreamTimings Timings { get; }
    public const int ControlRequestsPerSecond = 60;
    /// <summary>Re-encodes of the unchanged last frame after a content change (~0.5 s at 30 fps), sharpening still text.</summary>
    public const int RefreshTailFrames = 15;
    public SlidingWindowLimiter ControlLimiter { get; }
    public string? EndedCode { get; private set; }
    public int EncodeCount { get; private set; }
    public int TailEncodeCount { get; private set; }
    /// <summary>Profiling hook: when set, each loop stage records its duration.</summary>
    internal VideoStreamStageTimes? Stages { get; set; }
    public double LastDecodeMilliseconds { get; private set; }
    /// <summary>True while the stream encodes through the GPU source; false on the CPU path or after a GPU fallback.</summary>
    public bool UsingGpu => gpuSource is not null && GpuFallbackReason is null;
    public string? GpuFallbackReason { get; private set; }
    public int GpuEncodeCount { get; private set; }
    public int GpuRecoveryCount { get; private set; }
    public int CursorRecordCount { get; private set; }
    /// <summary>True while type-5 pointer records describe the pointer (GPU path with a pointer feed).</summary>
    public bool LocalCursorActive => pointerFeed is not null && !pointerDisabled && UsingGpu;
    public int InFlight { get { lock (sync) return unacked.Count; } }
    public long InFlightBytes { get { lock (sync) return unackedBytes; } }

    /// <summary>Byte bound of the in-flight window: about <see cref="VideoStreamTimings.InFlightSeconds"/> of the target bitrate.</summary>
    public static long InFlightByteBudget(int bitrateBps, double seconds) => Math.Max(1, (long)(bitrateBps / 8.0 * seconds));
    public VideoStreamSettings Settings { get { lock (sync) return settings; } }

    public VideoStreamRun(Stream output, Action abort, IVideoFrameSource source, MonitorInfo monitor, VideoEncoderFactory encoders,
        VideoStreamSettings settings, Func<VideoStreamDenial> authorize, CancellationToken connection, CancellationToken hostStopping,
        VideoStreamTimings? timings = null, Func<long>? clockMicroseconds = null, VideoSourceFrame? firstFrame = null,
        IVideoStreamEncoder? firstEncoder = null, uint firstSequence = 0, IGpuVideoSource? gpu = null, IGpuVideoEncoder? firstGpuEncoder = null,
        Action<string>? log = null, IPointerFeed? pointers = null, Func<CancellationToken, Task<bool>>? displayAsleep = null)
    {
        clock = clockMicroseconds ?? VideoStreamRecords.MonotonicMicroseconds;
        writer = new VideoRecordWriter(output, clock, firstSequence);
        this.abort = abort; this.source = source; this.monitor = monitor; this.encoders = encoders; this.settings = settings;
        this.authorize = authorize; this.connection = connection; this.hostStopping = hostStopping;
        this.displayAsleep = displayAsleep;
        Timings = timings ?? new VideoStreamTimings();
        ControlLimiter = new SlidingWindowLimiter(ControlRequestsPerSecond, 1_000_000, clock);
        pendingFrame = firstFrame; encoder = firstEncoder;
        gpuSource = gpu; this.log = log; gpuEncoder = firstGpuEncoder;
        pointerFeed = gpu is null ? null : pointers; // Composited CPU frames already draw the pointer.
        var gpuSize = GpuOutputSize(monitor, settings.Scale);
        if (firstGpuEncoder is not null) (gpuWidth, gpuHeight, gpuBitrate) = (gpuSize.Width, gpuSize.Height, settings.BitrateBps);
    }

    /// <summary>GPU encoder output size: the scaled size rounded down to even (within one pixel of physical × scale), at least 16.</summary>
    public static (int Width, int Height) GpuOutputSize(MonitorInfo monitor, double scale)
    {
        var (width, height) = VideoStreamSettings.ScaledSize(monitor.Width, monitor.Height, scale);
        return (Math.Max(16, width - (width & 1)), Math.Max(16, height - (height & 1)));
    }

    public static string TerminalCode(VideoStreamDenial denial) => denial switch
    {
        VideoStreamDenial.HostStopping => "host_stopping",
        VideoStreamDenial.IdentityUnavailable => "identity_rotated",
        VideoStreamDenial.Revoked => "access_revoked",
        VideoStreamDenial.EndedByHost or VideoStreamDenial.OwnerEnded => "session_ended_by_host",
        VideoStreamDenial.PermissionChanged => "permission_changed",
        _ => "session_ended",
    };

    private static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private void Nudge() { TaskCompletionSource old; lock (sync) { old = nudge; nudge = NewSignal(); } old.TrySetResult(); }

    public void RequestKeyframe()
    {
        // The viewer discards everything until a keyframe, so nothing in flight will be acknowledged: release the window.
        lock (sync) { keyframeRequested = true; unacked.Clear(); unackedBytes = 0; }
        Nudge();
    }

    /// <summary>Cumulative acknowledgement of every access unit up to <paramref name="sequence"/>. Unknown sequences are ignored.</summary>
    public void Ack(uint sequence, double? decodeMs)
    {
        lock (sync)
        {
            if (!anyAccessUnit || sequence > lastAccessUnit) return;
            unacked.RemoveAll(sent => sent.Sequence <= sequence);
            unackedBytes = unacked.Sum(sent => (long)sent.Bytes);
            if (decodeMs is { } ms) LastDecodeMilliseconds = ms;
        }
        Nudge();
    }

    public void UpdateSettings(int? bitrateBps, int? maxFps, double? scale)
    {
        lock (sync)
        {
            var next = VideoStreamSettings.Clamp(maxFps ?? settings.MaxFps, bitrateBps ?? settings.BitrateBps, scale ?? settings.Scale);
            refreshRequested |= next.Scale != settings.Scale;
            settings = next;
        }
        Nudge();
    }

    public void Apply(VideoControlRequest request)
    {
        if (request.Ack is { } ack) Ack(ack, request.DecodeMs);
        if (request.BitrateBps is not null || request.MaxFps is not null || request.Scale is not null) UpdateSettings(request.BitrateBps, request.MaxFps, request.Scale);
        if (request.Keyframe) RequestKeyframe();
    }

    /// <summary>Ends the stream once: best-effort terminal within the bounded wait, else abort the connection.</summary>
    public Task EndAsync(string code, string error)
    {
        lock (sync) { if (ending is not null) return ending; ending = EndCoreAsync(code, error); return ending; }
    }

    private async Task EndCoreAsync(string code, string error)
    {
        await Task.Yield();
        if (code is "host_stopping" or DisplayAvailability.AsleepCode)
        {
            // Resolve security again at the stop boundary, not only at the next
            // periodic poll. The access classifier checks device/epoch/grant
            // before shutdown, then ignores lifecycle-cleared session entries.
            try
            {
                var denial = authorize();
                if (denial != VideoStreamDenial.None && (code == DisplayAvailability.AsleepCode || denial != VideoStreamDenial.HostStopping))
                { code = TerminalCode(denial); error = denial == VideoStreamDenial.OwnerEnded ? OwnerEndedException.UserMessage : "The stream is no longer authorized."; }
            }
            catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException)
            { code = "stream_error"; error = "Authorization could not be verified."; }
        }
        EndedCode = code;
        try { await ended.CancelAsync(); } catch (ObjectDisposedException) { }
        if (!await writer.TryWriteTerminalAsync(code, error, Timings.TerminalMilliseconds)) abort();
    }

    /// <summary>Runs until the stream ends (terminal, client disconnect or failure).</summary>
    public async Task RunAsync()
    {
        using var timerResolution = TimerResolution.Acquire(); // 1 ms waits inside encoder/driver code while streaming
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(connection, hostStopping, ended.Token);
        using var stopping = hostStopping.Register(() => _ = EndAsync("host_stopping", "The host is stopping."));
        var watcher = WatchAuthorizationAsync(linked.Token);
        var pointers = pointerFeed is null ? Task.CompletedTask : PointerLoopAsync(linked.Token);
        try { await LoopAsync(linked.Token); }
        catch (OperationCanceledException) when (linked.IsCancellationRequested) { }
        catch (Exception ex) when (ex is PlatformUnavailableException or InvalidOperationException or ArgumentException or IOException or TimeoutException)
        {
            if (!connection.IsCancellationRequested)
                _ = ex is PlatformUnavailableException { Code: DisplayAvailability.AsleepCode }
                    ? EndAsync(DisplayAvailability.AsleepCode, DisplayAvailability.AsleepMessage)
                    : EndAsync("stream_error", ex is PlatformUnavailableException ? ex.Message : "The host video stream failed.");
        }
        finally
        {
            try { await linked.CancelAsync(); } catch (ObjectDisposedException) { }
            await watcher;
            await pointers;
        }
        // From here on EndAsync is a no-op: the connection may already be recycled, so it must never be aborted later.
        Task end; lock (sync) end = ending ??= Task.CompletedTask;
        await end;
    }

    private async Task WatchAuthorizationAsync(CancellationToken token)
    {
        try
        {
            while (true)
            {
                await Task.Delay(Timings.AuthorizationMilliseconds, token);
                var denial = hostStopping.IsCancellationRequested ? VideoStreamDenial.HostStopping : authorize();
                if (denial == VideoStreamDenial.None) continue;
                _ = EndAsync(TerminalCode(denial), denial switch
                {
                    VideoStreamDenial.Revoked => "This device's access was revoked.",
                    VideoStreamDenial.OwnerEnded => OwnerEndedException.UserMessage,
                    VideoStreamDenial.EndedByHost => "Session ended by host. Connect again explicitly.",
                    VideoStreamDenial.PermissionChanged => "Viewing permission changed.",
                    VideoStreamDenial.IdentityUnavailable => "The host identity is being rotated.",
                    VideoStreamDenial.HostStopping => "The host is stopping.",
                    _ => "The session ended.",
                });
                return;
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException)
        {
            // An authorization check that cannot complete is a denial, never a pass.
            _ = EndAsync("stream_error", "Authorization could not be verified.");
        }
    }

    private async Task LoopAsync(CancellationToken token)
    {
        VideoSourceFrame? lastEncoded = null;
        var appliedBitrate = encoder is null ? 0 : Settings.BitrateBps;
        streamStarted = clock(); lastRecordAt = clock();
        var failures = 0;
        byte[]? lastPixels = null;
        try
        {
            while (true)
            {
                token.ThrowIfCancellationRequested();
                bool full, keyRequested, refresh; VideoStreamSettings current; Task signal;
                lock (sync) { full = unacked.Count >= Timings.MaximumUnackedAccessUnits || unacked.Count > 0 && unackedBytes >= InFlightByteBudget(settings.BitrateBps, Timings.InFlightSeconds); keyRequested = keyframeRequested; refresh = refreshRequested; current = settings; signal = nudge.Task; }
                var heartbeatDue = lastRecordAt + Timings.HeartbeatMilliseconds * 1000L;
                var stageStart = Stopwatch.GetTimestamp();
                if (full && !keyRequested)
                {
                    // Backed up: skip capture and encode entirely until an ack, keyframe request or heartbeat.
                    await WaitAnyAsync(signal, null, null, Remaining(heartbeatDue), token);
                    Stages?.Add("window wait", stageStart);
                    lastRecordAt = await HeartbeatIfDueAsync(heartbeatDue, lastRecordAt, token);
                    continue;
                }
                var pace = nextFrameAt - clock();
                if (pace > 0 && !keyRequested) await PreciseDelay.WaitAsync(pace, token);
                var frameStart = clock();
                Stages?.Add("pace", stageStart);
                if (UsingGpu)
                {
                    if (!await GpuStepAsync(keyRequested, current, signal, heartbeatDue, frameStart, token)) return;
                    continue;
                }
                stageStart = Stopwatch.GetTimestamp();

                VideoSourceFrame? frame;
                var captureUnavailable = true;
                if (pendingFrame is not null) { frame = pendingFrame; pendingFrame = null; }
                else
                {
                    try { frame = await source.GetLatestAsync(monitor, token); }
                    catch (Exception ex) when (ex is PlatformUnavailableException or ArgumentException && !token.IsCancellationRequested)
                    { frame = null; captureUnavailable = ex is PlatformUnavailableException failure && DisplayAvailability.IsCaptureFailure(failure); }
                    Stages?.Add("source", stageStart);
                }
                if (frame is null)
                {
                    if (captureUnavailable && displayAsleep is not null && await displayAsleep(token))
                        throw new PlatformUnavailableException(DisplayAvailability.AsleepCode, DisplayAvailability.AsleepMessage);
                    if (++failures > Timings.MaximumConsecutiveSourceFailures) throw new PlatformUnavailableException("stream_unavailable", "The display is no longer available for streaming.");
                    await WaitAnyAsync(signal, null, null, Math.Min(Timings.RetryMilliseconds, Math.Max(1, Remaining(heartbeatDue))), token);
                    lastRecordAt = await HeartbeatIfDueAsync(heartbeatDue, lastRecordAt, token);
                    continue;
                }
                failures = 0;
                // Requests can arrive during the pacing delay or capture; never decide on a stale snapshot.
                lock (sync) { keyRequested |= keyframeRequested; refresh |= refreshRequested; current = settings; }
                var tail = false;
                var push = false;
                if (frame.SameContent(lastEncoded) && !keyRequested && !refresh)
                {
                    push = tailRemaining == 0 && heldInputs > 0 && !heldPushed;
                    if (tailRemaining == 0 && !push)
                    {
                        var remaining = Remaining(heartbeatDue);
                        var waitStart = Stopwatch.GetTimestamp();
                        if (remaining > 0) await WaitAnyAsync(signal, frame, source, remaining, token);
                        Stages?.Add("change wait", waitStart);
                        lastRecordAt = await HeartbeatIfDueAsync(heartbeatDue, lastRecordAt, token);
                        continue;
                    }
                    // Refresh tail: the source reports no change, so re-encode the retained immutable last frame
                    // (same pixels, no new capture) at the paced fps. A change or keyframe request takes the normal path.
                    frame = lastEncoded!; tail = true;
                    if (push) heldPushed = true;
                }
                var contentChanged = !tail && lastEncoded is not null && !frame.SameContent(lastEncoded);
                // A new native generation (recovery, idle restart, topology) is a source reset.
                if (lastEncoded is not null && frame.Generation != lastEncoded.Generation) forceKeyframe = true;

                var (width, height) = VideoStreamSettings.ScaledSize(frame.Width, frame.Height, current.Scale);
                if (encoder is null || encoder.EncodedWidth != width + (width & 1) || encoder.EncodedHeight != height + (height & 1))
                {
                    if (encoder is not null)
                    {
                        // Reconfiguration: pictures the old encoder still holds go out under the old config first.
                        var drained = encoder.Flush();
                        if (configKey is { } oldKey)
                            foreach (var held in drained)
                                if (await SendAsync(held, oldKey, _ => throw new InvalidOperationException("The old config is already sent.")) == SendResult.Ended) return;
                        encoder.Dispose(); encoder = null; heldInputs = 0;
                    }
                    encoder = encoders(width, height, current.MaxFps, current.BitrateBps)
                        ?? throw new PlatformUnavailableException("stream_unavailable", "The H.264 encoder is unavailable for this display size.");
                    appliedBitrate = current.BitrateBps; forceKeyframe = true;
                }
                if (appliedBitrate != current.BitrateBps) { encoder.SetBitrate(current.BitrateBps); appliedBitrate = current.BitrateBps; }
                var key = $"cpu:{width}x{height}/{encoder.EncodedWidth}x{encoder.EncodedHeight}/{frame.Left},{frame.Top},{frame.Width},{frame.Height}/{current.Scale:R}/{frame.MonitorId}";
                if (key != configKey) forceKeyframe = true;
                lock (sync)
                {
                    // Take the requests this encode serves; one arriving from here on stays set for the next frame.
                    keyRequested |= keyframeRequested; keyframeRequested = false;
                    if (settings.Scale == current.Scale) refreshRequested = false;
                }
                if (keyRequested) tail = false; // A keyframe request is served as a keyframe, never counted as a tail frame.
                stageStart = Stopwatch.GetTimestamp();
                var pixels = tail && lastPixels is not null && lastPixels.Length == width * height * 4 ? lastPixels
                    : width == frame.Width && height == frame.Height ? frame.Bgra : VideoFrameScaler.Resize(frame.Bgra, frame.Width, frame.Height, width, height);
                Stages?.Add("scale", stageStart);
                var capturedAt = clock();
                stageStart = Stopwatch.GetTimestamp();
                var units = encoder.Encode(pixels, (capturedAt - streamStarted) * 10, forceKeyframe || keyRequested);
                Stages?.Add("encode", stageStart);
                EncodedUnits.CheckBatch(units); // An oversized batch ends the stream (stream_error), never a partial send.
                heldInputs = Math.Max(0, heldInputs + 1 - units.Count);
                if (!tail) heldPushed = false;
                EncodeCount++;
                // Only a real content change starts a tail; join, keyframe and rescale encodes keep the current count.
                if (tail && !push) { tailRemaining--; TailEncodeCount++; }
                else if (contentChanged) tailRemaining = RefreshTailFrames;
                lastEncoded = frame; lastPixels = pixels;
                Advance(frameStart, current.MaxFps);
                // Zero units: the encoder is buffering (nothing to send, no stall); several: each is its own record.
                var sentFrame = frame; var sentEncoder = encoder;
                if (!await SendBatchAsync(units, key, codec => VideoStreamRecords.Config(codec, width, height, sentEncoder.EncodedWidth, sentEncoder.EncodedHeight, sentFrame, current.Scale, sentEncoder.FramesPerSecond), token)) return;
            }
        }
        finally { encoder?.Dispose(); encoder = null; DisposeGpuEncoder(); }
    }

    /// <summary>
    /// Absolute ticks: on schedule, the next frame is one interval after this tick, so capture, scale and encode overlap the
    /// interval instead of adding to it; after an idle gap (or a long stall) the cadence restarts now.
    /// </summary>
    private void Advance(long frameStart, int maxFps)
    {
        var interval = 1_000_000L / maxFps;
        nextFrameAt = frameStart - nextFrameAt < interval ? nextFrameAt + interval : frameStart + interval;
    }

    private enum SendResult { Sent, NeedKeyframe, Ended }

    /// <summary>
    /// Sends one encode's 0..n access units, one record each, never splitting the batch across captures: when the window
    /// fills mid-batch, the rest waits for acknowledgements (bounded by <see cref="VideoStreamTimings.BatchWaitMilliseconds"/>,
    /// then sent anyway) and no new capture or encode starts meanwhile. False = the stream ends.
    /// </summary>
    private async Task<bool> SendBatchAsync(IReadOnlyList<VideoEncodedUnit> units, string key, Func<string, byte[]> config, CancellationToken token)
    {
        for (var i = 0; i < units.Count; i++)
        {
            if (i > 0) await WaitForRoomAsync(token);
            if (await SendAsync(units[i], key, config) == SendResult.Ended) return false;
        }
        return true;
    }

    private async Task WaitForRoomAsync(CancellationToken token)
    {
        var deadline = clock() + Timings.BatchWaitMilliseconds * 1000L;
        while (true)
        {
            bool full; Task signal;
            lock (sync) { full = unacked.Count >= Timings.MaximumUnackedAccessUnits || unacked.Count > 0 && unackedBytes >= InFlightByteBudget(settings.BitrateBps, Timings.InFlightSeconds); signal = nudge.Task; }
            var remaining = Remaining(deadline);
            if (!full || remaining <= 0) return;
            var started = Stopwatch.GetTimestamp();
            await WaitAnyAsync(signal, null, null, remaining, token);
            Stages?.Add("batch wait", started);
        }
    }

    /// <summary>GPU output as stream units: the authoritative Units (host-monotonic timestamps), else a legacy concatenation split.</summary>
    private List<VideoEncodedUnit> GpuUnits(IReadOnlyList<GpuVideoAccessUnit> units, byte[] concatenated) =>
        units.Count > 0
            ? units.Select(unit => new VideoEncodedUnit(unit.AccessUnit, unit.IsKeyframe, unit.Timestamp100ns > 0 ? unit.Timestamp100ns - streamStarted * 10 : null)).ToList()
            : EncodedUnits.Split(concatenated).ToList();

    /// <summary>Writes a config when the stream geometry changed (only ahead of a keyframe), then the access unit.</summary>
    private async Task<SendResult> SendAsync(VideoEncodedUnit unit, string key, Func<string, byte[]> config)
    {
        if (unit.Data.Length > VideoStreamRecords.MaximumAccessUnitBytes || !VideoStreamRecords.IsAnnexB(unit.Data))
            throw new PlatformUnavailableException("encode-failed", "The encoder produced an invalid access unit.");
        if (key != configKey)
        {
            // A config is always followed by a keyframe; drop a late delta and keep forcing.
            if (!unit.IsKeyframe) { forceKeyframe = true; return SendResult.NeedKeyframe; }
            var codec = VideoStreamRecords.CodecFromAccessUnit(unit.Data)
                ?? throw new PlatformUnavailableException("encode-failed", "The keyframe carries no sequence parameter set.");
            if (await writer.WriteAsync(VideoRecordType.Config, false, config(codec), connection) is null) { await RestartAsync(); return SendResult.Ended; }
            configKey = key;
        }
        var stageStart = Stopwatch.GetTimestamp();
        long? timestamp = unit.Timestamp100ns is { } relative ? streamStarted + relative / 10 : null;
        // A peer can acknowledge receipt while FlushAsync is still pending. Publish
        // the exact serialized sequence before its first byte leaves this writer.
        var sequence = await writer.WriteAsync(VideoRecordType.AccessUnit, unit.IsKeyframe, unit.Data, connection, timestamp, sending =>
        {
            lock (sync) { unacked.Add((sending, unit.Data.Length)); unackedBytes += unit.Data.Length; lastAccessUnit = sending; anyAccessUnit = true; }
        });
        Stages?.Add("write", stageStart);
        if (sequence is null) { await RestartAsync(); return SendResult.Ended; }
        if (unit.IsKeyframe) forceKeyframe = false;
        lastRecordAt = clock();
        return SendResult.Sent;
    }

    /// <summary>
    /// One GPU iteration (the window and pacing were already applied): encode the next desktop image when there is one,
    /// otherwise re-encode the last image for a keyframe request or a refresh-tail frame, otherwise wait for a change until
    /// the heartbeat (a control nudge interrupts the wait). Any GPU failure falls back to the CPU path. False = stream ends.
    /// </summary>
    private async Task<bool> GpuStepAsync(bool keyRequested, VideoStreamSettings current, Task signal, long heartbeatDue, long frameStart, CancellationToken token)
    {
        var (width, height) = GpuOutputSize(monitor, current.Scale);
        GpuVideoUnit? unit;
        bool tail = false, changed = false;
        if (compositeRequested) { FallBack("The viewer-drawn pointer is unavailable; using composited video.", null); await HideLocalCursorAsync(); return true; }
        if (GpuMarkedSlow())
        {
            FallBack($"The GPU path encodes slower than the frame budget on this computer{(SlowGpuMedianMilliseconds is { } median ? $" (median {median:0} ms)" : "")}; using the CPU path.", null);
            await HideLocalCursorAsync(); return true;
        }
        try
        {
            if (gpuEncoder is null || gpuWidth != width || gpuHeight != height)
            {
                if (gpuEncoder is IGpuVideoEncoderFlush drain && configKey is { } oldKey)
                    // Reconfiguration: pictures the old encoder still holds go out under the old config first.
                    foreach (var held in GpuUnits(drain.Flush(), []))
                        if (await SendAsync(held, oldKey, _ => throw new InvalidOperationException("The old config is already sent.")) == SendResult.Ended)
                            return false;
                DisposeGpuEncoder(); gpuHeldInputs = 0;
                gpuEncoder = gpuSource!.TryOpenEncoder(monitor, width, height, current.MaxFps, current.BitrateBps);
                if (gpuEncoder is null) { FallBack("The GPU video encoder is unavailable; using the CPU path.", null); await HideLocalCursorAsync(); return true; }
                (gpuWidth, gpuHeight, gpuBitrate) = (width, height, current.BitrateBps);
                LastGpuMedianMilliseconds = null;
                forceKeyframe = true;
            }
            if (gpuBitrate != current.BitrateBps) { gpuEncoder.SetBitrate(current.BitrateBps); gpuBitrate = current.BitrateBps; }
            lock (sync) { keyRequested |= keyframeRequested; keyframeRequested = false; if (settings.Scale == current.Scale) refreshRequested = false; }
            var due = gpuLast is not null && (keyRequested || forceKeyframe || tailRemaining > 0 || gpuHeldInputs > 0 && !gpuHeldPushed);
            var stageStart = Stopwatch.GetTimestamp();
            var pointerProbe = Interlocked.Exchange(ref pointerGpuProbeRequested, 0) != 0;
            unit = await NextGpuAsync(pointerProbe || due ? 0 : Remaining(heartbeatDue), forceKeyframe || keyRequested, signal, token);
            if (pointerProbe) Interlocked.Increment(ref gpuHealthVersion); // A zero-timeout call completed its live GPU checks.
            Stages?.Add("gpu next", stageStart);
            if (unit is not null) changed = gpuLast is not null;
            else if (gpuLast is not null)
            {
                lock (sync) { keyRequested |= keyframeRequested; keyframeRequested = false; }
                if (keyRequested || forceKeyframe) unit = gpuEncoder.EncodeLast(true);
                else if (tailRemaining > 0) { unit = gpuEncoder.EncodeLast(false); tail = unit is not null; }
                else if (gpuHeldInputs > 0 && !gpuHeldPushed) { gpuHeldPushed = true; unit = gpuEncoder.EncodeLast(false); } // push a held picture out
            }
            // Never a delta across a source reset or a geometry change: re-encode that image as a keyframe.
            if (unit is { IsKeyframe: false, AccessUnit.Length: > 0 } && (GpuKey(unit, current.Scale) != configKey || gpuLast is not null && unit.Generation != gpuLast.Generation))
            { unit = gpuEncoder.EncodeLast(true) ?? unit; tail = false; }
        }
        catch (Exception ex) when (IsGpuFailure(ex) && !token.IsCancellationRequested)
        {
            if (IsRecoverableGpuFailure(ex)) return await ReopenGpuAsync(current, token);
            FallBack("The GPU video path failed; using the CPU path.", ex);
            await HideLocalCursorAsync();
            return true;
        }
        if (unit is null) { lastRecordAt = await HeartbeatIfDueAsync(heartbeatDue, lastRecordAt, token); return true; }
        EncodeCount++; GpuEncodeCount++;
        NoteGpuEncode(unit.EncodeMilliseconds, unit.IsKeyframe, current.MaxFps);
        if (tail) { tailRemaining--; TailEncodeCount++; }
        else if (changed) tailRemaining = RefreshTailFrames;
        gpuLast = unit;
        Advance(frameStart, current.MaxFps);
        var pictures = GpuUnits(unit.Units, unit.AccessUnit);
        try { EncodedUnits.CheckBatch(pictures); }
        catch (PlatformUnavailableException ex)
        {
            // An oversized GPU batch fails that encoder safely: nothing of it is sent; the stream continues on the CPU path.
            FallBack("The GPU encoder returned an oversized batch; using the CPU path.", ex);
            await HideLocalCursorAsync();
            return true;
        }
        gpuHeldInputs = Math.Max(0, gpuHeldInputs + 1 - pictures.Count);
        if (changed) gpuHeldPushed = false;
        var geometry = new VideoSourceFrame([], unit.PhysicalWidth, unit.PhysicalHeight, unit.PhysicalLeft, unit.PhysicalTop, monitor.Id, unit.CapturedUtc, unit.Generation, unit.Version);
        var (outputWidth, outputHeight, scale, fps) = (gpuWidth, gpuHeight, current.Scale, current.MaxFps);
        var sent = await SendBatchAsync(pictures, GpuKey(unit, current.Scale),
            codec => VideoStreamRecords.Config(codec, outputWidth, outputHeight, unit.CodedWidth, unit.CodedHeight, geometry, scale, fps), token);
        if (sent && configKey is not null && gpuRecovering) { lastGpuRecoveryAt = clock(); gpuRecovering = false; GpuRecoveryCount++; }
        return sent;
    }

    private static bool IsRecoverableGpuFailure(Exception failure) => failure is PlatformUnavailableException
        { Code: "capture-reset" or "capture-lost" or "device-lost" };

    private async Task<bool> ReopenGpuAsync(VideoStreamSettings current, CancellationToken token)
    {
        // If a just-reopened encoder fails before its first config/keyframe,
        // that reopen attempt failed too. The initial capture loss is not an attempt.
        var now = clock();
        var unstable = lastGpuRecoveryAt is { } recoveredAt && now - recoveredAt < 5_000_000;
        var exhausted = (gpuRecovering || unstable) && gpuReopenFailures.Record(now);
        gpuRecovering = true;
        Interlocked.Increment(ref gpuRecoveryEpoch);
        DisposeGpuEncoder();
        configKey = null; forceKeyframe = true; tailRemaining = 0; gpuHeldInputs = 0; gpuHeldPushed = false;
        // The fresh config discards the old decoder's pending pictures. Do not
        // let its old receipt window prevent the replacement keyframe being sent.
        lock (sync) { unacked.Clear(); unackedBytes = 0; }
        await RecoveryHeartbeatAsync(token);
        while (!exhausted)
        {
            token.ThrowIfCancellationRequested();
            var denial = authorize();
            if (denial != VideoStreamDenial.None)
            { await EndAsync(TerminalCode(denial), denial == VideoStreamDenial.OwnerEnded ? OwnerEndedException.UserMessage : "The stream is no longer authorized."); return false; }
            await RecoveryHeartbeatAsync(token);
            var (width, height) = GpuOutputSize(monitor, current.Scale);
            try
            {
                gpuEncoder = gpuSource!.TryOpenEncoder(monitor, width, height, current.MaxFps, current.BitrateBps);
                if (gpuEncoder is not null)
                {
                    (gpuWidth, gpuHeight, gpuBitrate) = (width, height, current.BitrateBps);
                    LastGpuMedianMilliseconds = null;
                    return true; // The next paced iteration forces a fresh config plus keyframe.
                }
            }
            catch (Exception ex) when (IsGpuFailure(ex) && !token.IsCancellationRequested) { }
            await RecoveryHeartbeatAsync(token);
            exhausted = gpuReopenFailures.Record(clock());
            if (!exhausted) await Task.Delay(Timings.RetryMilliseconds, token);
        }
        FallBack("The GPU path failed twice within ten seconds during recovery; using the CPU path.", null);
        gpuRecovering = false;
        await HideLocalCursorAsync();
        return true;
    }

    private async Task RecoveryHeartbeatAsync(CancellationToken token)
    {
        // Before the first config there is no legal heartbeat. Established streams
        // remain live while a synchronous native reopen consumes its bounded wait.
        if (writer.HasConfig) lastRecordAt = await HeartbeatIfDueAsync(lastRecordAt + Timings.HeartbeatMilliseconds * 1000L, lastRecordAt, token);
    }

    /// <summary>
    /// Polls the pointer at most at the stream fps and writes a type-5 record when it changed: only after the first config,
    /// only while the GPU path is active, with the grant re-checked before each write. A feed that cannot describe the
    /// pointer (null, invalid shape) switches the stream to composited video: hidden record first, then CPU frames.
    /// </summary>
    private async Task PointerLoopAsync(CancellationToken token)
    {
        long? nullAfterHealth = null;
        try
        {
            while (!pointerDisabled)
            {
                await PreciseDelay.WaitAsync(1_000_000L / Settings.MaxFps, token);
                var recoveryEpoch = Volatile.Read(ref gpuRecoveryEpoch);
                if (pointerDisabled || gpuRecovering || !UsingGpu || writer.ConfigCount == 0) continue;
                PointerSnapshot? snapshot;
                var known = lastShapeId is not null && pointerShapes.ContainsKey(lastShapeId) ? lastShapeId : null;
                try { snapshot = await pointerFeed!.GetPointerAsync(monitor, known, token); }
                catch (Exception ex) when (ex is PlatformUnavailableException or ArgumentException or InvalidOperationException && !token.IsCancellationRequested) { snapshot = null; }
                if (gpuRecovering || recoveryEpoch != Volatile.Read(ref gpuRecoveryEpoch)) { nullAfterHealth = null; continue; }
                if (snapshot is null)
                {
                    // A producer reset can reach this loop before the video loop
                    // notices it. Wait for a fresh live GPU check before deciding
                    // the pointer is unsupported; backpressure must remain bounded.
                    var health = Volatile.Read(ref gpuHealthVersion);
                    if (nullAfterHealth is null || health <= nullAfterHealth.Value)
                    {
                        nullAfterHealth ??= health;
                        Interlocked.Exchange(ref pointerGpuProbeRequested, 1); Nudge(); continue;
                    }
                }
                else nullAfterHealth = null;
                if (snapshot is null || snapshot.Shape is { } invalid && !PointerRecords.IsValidShape(invalid) || snapshot.ShapeId.Length is 0 or > 128)
                {
                    compositeRequested = true; await HideLocalCursorAsync(); Nudge();
                    return;
                }
                if (snapshot.Shape is { } shape)
                {
                    if (pointerShapes.Count >= 64) pointerShapes.Clear(); // Bounded; anything evicted is simply sent again.
                    pointerShapes[snapshot.ShapeId] = shape;
                }
                lastShapeId = snapshot.ShapeId;
                if (lastPointerVersion == (snapshot.Generation, snapshot.Version, writer.ConfigCount)) continue; // host-side dedup
                if (authorize() != VideoStreamDenial.None) continue; // The authorization timer ends the stream.
                await writer.WriteComposedAsync(VideoRecordType.Cursor, epoch => ComposePointer(snapshot, epoch, hide: false), connection);
                lastPointerVersion = (snapshot.Generation, snapshot.Version, writer.ConfigCount);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested || writer.IsTerminated) { }
        catch (IOException) { /* The video loop observes the broken connection. */ }
    }

    /// <summary>Runs inside the writer lock. Null = nothing to write (unchanged, before config, or not representable).</summary>
    private byte[]? ComposePointer(PointerSnapshot? snapshot, int epoch, bool hide)
    {
        if (epoch == 0 || pointerDisabled && !hide) return null;
        if (epoch != shapeEpoch) { shapeEpoch = epoch; epochShapes.Clear(); } // A config clears the viewer's shape cache.
        // Coordinates must lie on this monitor (negative origins included). A hidden pointer, or a visible one on another
        // monitor, is sent as hidden at its position clamped to this monitor.
        var x = snapshot?.X ?? lastPointer?.X ?? monitor.Left; var y = snapshot?.Y ?? lastPointer?.Y ?? monitor.Top;
        var onMonitor = x >= monitor.Left && x < (long)monitor.Left + monitor.Width && y >= monitor.Top && y < (long)monitor.Top + monitor.Height;
        var visible = !hide && snapshot is { Visible: true } && onMonitor;
        x = (int)Math.Clamp(x, monitor.Left, (long)monitor.Left + monitor.Width - 1);
        y = (int)Math.Clamp(y, monitor.Top, (long)monitor.Top + monitor.Height - 1);
        var shapeId = visible ? snapshot!.ShapeId : PointerRecords.HiddenShapeId;
        var state = (x, y, visible, shapeId, epoch);
        if (lastPointer == state) return null;
        PointerShape? shape = null;
        if (!epochShapes.Contains(shapeId))
        {
            if (epochShapes.Count >= MaxViewerShapes) epochShapes.Clear(); // The viewer caches at most this many per config; resend beyond.
            shape = shapeId == PointerRecords.HiddenShapeId ? PointerRecords.HiddenShape : pointerShapes.GetValueOrDefault(shapeId);
            if (shape is null) { lastShapeId = null; return null; } // Ask the feed for the shape again next poll.
        }
        var payload = PointerRecords.Build(x, y, visible, shapeId, shape, monitor);
        if (payload is null) return null;
        epochShapes.Add(shapeId); lastPointer = state; CursorRecordCount++;
        return payload;
    }

    /// <summary>Ends viewer-drawn pointer records for good; the viewer is told to hide its pointer before any composited frame.</summary>
    private async Task HideLocalCursorAsync()
    {
        if (pointerFeed is null || pointerDisabled) return;
        pointerDisabled = true;
        if (writer.ConfigCount == 0) return; // Nothing was ever drawn by the viewer.
        try { await writer.WriteComposedAsync(VideoRecordType.Cursor, epoch => ComposePointer(null, epoch, hide: true), connection); }
        catch (OperationCanceledException) { }
    }

    private string GpuKey(GpuVideoUnit unit, double scale) =>
        $"gpu:{gpuWidth}x{gpuHeight}/{unit.CodedWidth}x{unit.CodedHeight}/{unit.PhysicalLeft},{unit.PhysicalTop},{unit.PhysicalWidth},{unit.PhysicalHeight}/{scale:R}/{monitor.Id}";

    /// <summary>Next GPU image; a control nudge (ack, keyframe request, settings) interrupts the wait and yields null.</summary>
    private async Task<GpuVideoUnit?> NextGpuAsync(int timeoutMilliseconds, bool keyframe, Task signal, CancellationToken token)
    {
        if (timeoutMilliseconds <= 0) return await gpuEncoder!.EncodeNextAsync(0, keyframe, token);
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(token);
        var next = gpuEncoder!.EncodeNextAsync(timeoutMilliseconds, keyframe, wait.Token);
        if (await Task.WhenAny(next, signal) == next) return await next;
        await wait.CancelAsync();
        try { return await next; }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return null; }
    }

    private static bool IsGpuFailure(Exception ex) =>
        ex is PlatformUnavailableException or InvalidOperationException or System.Runtime.InteropServices.ExternalException or TimeoutException or ArgumentException;

    /// <summary>Switches this stream to the CPU path for good (logged once): a fresh config and keyframe follow.</summary>
    private bool GpuMarkedSlow() =>
        gpuSource is not null && slowGpuUntil.TryGetValue(gpuSource, out var until) && Environment.TickCount64 < Volatile.Read(ref until.Value);

    /// <summary>Only a sustained post-warm-up delta-frame median can mark the GPU path slow.</summary>
    private void NoteGpuEncode(double milliseconds, bool keyframe, int maxFps)
    {
        if (gpuEncodeHealth.Observe(milliseconds, keyframe, clock()) is not { } median || gpuSource is null) return;
        LastGpuMedianMilliseconds = median;
        if (median <= GpuBudgetMilliseconds(maxFps)) return;
        SlowGpuMedianMilliseconds = median;
        slowGpuUntil.AddOrUpdate(gpuSource, new StrongBox<long>(Environment.TickCount64 + (long)SlowGpuCooldown.TotalMilliseconds));
    }

    private void FallBack(string reason, Exception? failure)
    {
        gpuRecovering = false;
        GpuFallbackReason = reason;
        DisposeGpuEncoder();
        forceKeyframe = true; tailRemaining = 0;
        log?.Invoke(failure is null ? reason : $"{reason} ({failure.GetType().Name}: {failure.Message})");
    }

    private void DisposeGpuEncoder()
    {
        var current = gpuEncoder; gpuEncoder = null; gpuLast = null;
        gpuEncodeHealth.Reset();
        try { current?.Dispose(); }
        catch (Exception ex) when (IsGpuFailure(ex)) { /* A failed device cannot block the CPU fallback. */ }
    }

    private Task RestartAsync() => EndAsync("stream_restart", "The stream sequence space is exhausted; reconnect.");

    private int Remaining(long dueMicroseconds) => (int)Math.Clamp((dueMicroseconds - clock() + 999) / 1000, 0, int.MaxValue);

    private async Task<long> HeartbeatIfDueAsync(long dueMicroseconds, long lastRecordAt, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (clock() < dueMicroseconds) return lastRecordAt;
        if (await writer.WriteAsync(VideoRecordType.Heartbeat, false, ReadOnlyMemory<byte>.Empty, connection) is null) { await RestartAsync(); throw new OperationCanceledException(); }
        return clock();
    }

    /// <summary>Waits for a control nudge, a source change (when given) or the timeout, whichever is first.</summary>
    private static async Task WaitAnyAsync(Task signal, VideoSourceFrame? observed, IVideoFrameSource? changes, int timeoutMilliseconds, CancellationToken token)
    {
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(token);
        var delay = Task.Delay(Math.Max(0, timeoutMilliseconds), wait.Token);
        var change = observed is not null && changes is not null ? changes.WaitForChangeAsync(observed, Math.Max(0, timeoutMilliseconds), wait.Token) : null;
        await (change is null ? Task.WhenAny(signal, delay) : Task.WhenAny(signal, delay, change));
        await wait.CancelAsync();
        token.ThrowIfCancellationRequested();
        // A failed wait is transient: the next GetLatestAsync reports a persistent failure through the failure budget.
        if (change is { IsFaulted: true }) _ = change.Exception;
    }

    public async ValueTask DisposeAsync()
    {
        Task? end; lock (sync) end = ending;
        try
        {
            if (end is not null) { try { await end; } catch (Exception ex) when (ex is IOException or ObjectDisposedException) { } }
        }
        finally
        {
            try { encoder?.Dispose(); }
            finally
            {
                encoder = null;
                try { DisposeGpuEncoder(); }
                finally { ended.Dispose(); }
            }
        }
    }
}
