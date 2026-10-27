using System.Collections.Concurrent;
using Orbit.Host;
using Orbit.Host.Platform;

public static class GpuSharedMonitorChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var monitor = new MonitorInfo("synthetic", "Synthetic", -5, 7, 2, 1, true);
        var batch = new H264EncodedFrame([9, 7, 8, 5, 9, 1], true, 100, 0, 0, 3, 1)
        { Units = [new([9, 7], true, 100), new([8, 5], false, 200), new([9, 1], false, 300)] };
        var mapped = GpuUnitMapping.Create(batch, 2, 1, monitor, "generation", 1, DateTimeOffset.UnixEpoch);
        check(mapped.Units.Count == 3 && mapped.Units.SelectMany(unit => unit.AccessUnit).SequenceEqual(batch.Data) && mapped.AccessUnit.Length == 0,
            "Batched GPU output preserves every picture boundary and never exposes concatenation as a single legacy unit");
        check(mapped.Units.Select(unit => unit.Timestamp100ns).SequenceEqual(new long[] { 100, 200, 300 }) && mapped.Units[0].IsKeyframe && !mapped.Units[1].IsKeyframe,
            "Each GPU access unit retains its own timestamp and keyframe flag");
        check(GpuUnitMapping.Create(batch, 2, 1, monitor, "generation", 1, DateTimeOffset.UnixEpoch, 500).Units.Select(unit => unit.Timestamp100ns).SequenceEqual(new long[] { 600, 700, 800 }),
            "Encoder-relative access-unit times are rebased onto the exact host monotonic clock");
        var invalidTime = false;
        try { GpuUnitMapping.Units([new([1], false, long.MaxValue)], 1); } catch (PlatformUnavailableException) { invalidTime = true; }
        check(invalidTime, "Invalid access-unit timestamp arithmetic fails closed instead of wrapping");
        var empty = GpuUnitMapping.Create(batch with { Units = [] }, 2, 1, monitor, "generation", 1, DateTimeOffset.UnixEpoch);
        check(empty.Units.Count == 0 && empty.AccessUnit.Length == 0, "Zero native output units remain zero; aggregate legacy bytes are never substituted");
        var overCount = false;
        try { GpuUnitMapping.Create(batch with { Units = Enumerable.Repeat(new H264AccessUnit([1], false, 0), 65).ToArray() }, 2, 1, monitor, "generation", 1, DateTimeOffset.UnixEpoch); }
        catch (PlatformUnavailableException) { overCount = true; }
        check(overCount, "GPU output batches have a hard access-unit count bound");
        var large = new byte[8 * 1024 * 1024]; var overBytes = false;
        try { GpuUnitMapping.Create(batch with { Units = [new(large, true, 0), new(large, false, 1), new([1], false, 2)] }, 2, 1, monitor, "generation", 1, DateTimeOffset.UnixEpoch); }
        catch (PlatformUnavailableException) { overBytes = true; }
        check(overBytes, "GPU batches cannot retain more than the total encoded-byte budget");
        var texture = new FakeTextureCapture(); var created = 0;
        await using var source = new SharedMonitorFrames(_ => { created++; return texture; }, _ => { }, 30);
        var pointerRequest = source.GetPointerAsync(monitor, null, CancellationToken.None);
        var first = texture.Emit(10); await pointerRequest;
        check(created == 1 && texture.Readbacks == 0 && source.SnapshotCopies == 0,
            "GPU producer and pointer feed advance without CPU readback or desktop allocation");
        var frame = (await source.CaptureAsync(monitor, CancellationToken.None))!;
        check(texture.Readbacks == 1 && frame.RawBgra![0] == 10 && source.SnapshotCopies == 1,
            "The first image consumer reads back only its published texture");
        var repeat = await source.CaptureAsync(monitor, CancellationToken.None);
        check(texture.Readbacks == 1 && ReferenceEquals(frame.RawBgra, repeat!.RawBgra), "Repeated image consumers reuse one immutable readback snapshot");
        using var encoder = source.TryOpenEncoder(monitor, 2, 1, 60, 1_000_000);
        check(encoder is not null && texture.EncoderOpens == 1 && created == 1, "GPU encoder is a child of the same shared monitor producer");
        var nextSignal = source.WaitForChangeAsync(frame, 1000, CancellationToken.None); var second = texture.Emit(20); await nextSignal;
        check(first.Disposals == 1 && second.Disposals == 0 && texture.Readbacks == 1,
            "Publishing a new GPU texture retires the prior pool lease without eager readback");
        var next = (await source.CaptureAsync(monitor, CancellationToken.None))!;
        check(next.RawBgra![0] == 20 && frame.RawBgra![0] == 10 && texture.Readbacks == 2,
            "Readback stays tied to the exact published version and never mutates earlier image bytes");
        await Task.Delay(80);
        check(texture.Disposed == 0, "A stream encoder lease keeps its shared producer alive beyond the image idle lease");
        encoder!.Dispose();
        await WaitUntil(() => texture.Disposed == 1);
        check(second.Disposals == 1, "Idle retirement releases the final published GPU lease exactly once");

        var allowed = true; var denied = new FakeTextureCapture();
        await using var guarded = new SharedMonitorFrames(_ => denied, _ => { if (!allowed) throw new PlatformUnavailableException("desktop-unavailable", "Synthetic denied desktop"); });
        var deniedRequest = guarded.GetPointerAsync(monitor, null, CancellationToken.None); denied.Emit(30); await deniedRequest;
        allowed = false; var rejected = false;
        try { await guarded.CaptureAsync(monitor, CancellationToken.None); } catch (PlatformUnavailableException) { rejected = true; }
        check(rejected && denied.Readbacks == 0, "Denied desktop validation prevents lazy GPU readback as well as image delivery");

        var recoverable = new FakeTextureCapture();
        await using var recovering = new SharedMonitorFrames(_ => recoverable, _ => { });
        var initialRequest = recovering.CaptureAsync(monitor, CancellationToken.None); var oldTexture = recoverable.Emit(40);
        var beforeRecovery = (await initialRequest)!;
        var recoverySignal = recovering.WaitForChangeAsync(beforeRecovery, 1000, CancellationToken.None);
        recoverable.EmitRecovery(); await recoverySignal;
        var afterRecoveryRequest = recovering.CaptureAsync(monitor, CancellationToken.None);
        await Task.Delay(15);
        check(oldTexture.Disposals == 1 && !afterRecoveryRequest.IsCompleted && recoverable.Readbacks == 1,
            "GPU recovery retires the exact old lease and cannot relabel or read back its previous image");
        recoverable.Emit(50); var afterRecovery = (await afterRecoveryRequest)!;
        check(afterRecovery.NativeGeneration != beforeRecovery.NativeGeneration && afterRecovery.NativeVersion == 1 && afterRecovery.RawBgra![0] == 50 && beforeRecovery.RawBgra![0] == 40,
            "Recovered GPU publication starts a new generation and preserves earlier immutable snapshots");
    }

    private static async Task WaitUntil(Func<bool> done)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!done()) await Task.Delay(5, timeout.Token);
    }
    private sealed class FakeTexture(byte value) : IDisposable
    {
        public byte[] Pixels { get; } = [value, value, value, 0, value, value, value, 0];
        public int Disposals;
        public void Dispose() => Interlocked.Increment(ref Disposals);
    }
    private sealed class FakeTextureCapture : ILazyMonitorCapture
    {
        private readonly BlockingCollection<(MonitorUpdate Update, IDisposable? Frame)> updates = new();
        public int Readbacks, EncoderOpens, Disposed;
        public FakeTexture Emit(byte value) { var texture = new FakeTexture(value); updates.Add((new(true, false, false, null), texture)); return texture; }
        public void EmitRecovery() => updates.Add((new(false, false, true, null), null));
        public MonitorUpdate Read(int timeoutMilliseconds, byte[] destination) => throw new InvalidOperationException("Eager CPU capture is forbidden for this fixture.");
        public (MonitorUpdate Update, IDisposable? Frame) ReadTexture(int timeoutMilliseconds) => updates.TryTake(out var update, Math.Min(5, timeoutMilliseconds))
            ? update : (new(false, false, false, null), null);
        public byte[] ReadBgra(IDisposable frame) { Interlocked.Increment(ref Readbacks); return ((FakeTexture)frame).Pixels; }
        public IGpuVideoEncoder? OpenEncoder(MonitorInfo monitor, int width, int height, int fps, int bitrate, Action validate, Action assertActive, Func<Task> nextChange, IDisposable consumer)
        { Interlocked.Increment(ref EncoderOpens); return new FakeEncoder(consumer, validate, assertActive); }
        public void Dispose() { Interlocked.Increment(ref Disposed); updates.Dispose(); }
    }
    private sealed class FakeEncoder(IDisposable consumer, Action validate, Action assertActive) : IGpuVideoEncoder
    {
        public Task<GpuVideoUnit?> EncodeNextAsync(int timeoutMilliseconds, bool forceKeyframe, CancellationToken cancellationToken) { cancellationToken.ThrowIfCancellationRequested(); assertActive(); validate(); return Task.FromResult<GpuVideoUnit?>(null); }
        public GpuVideoUnit? EncodeLast(bool forceKeyframe) { assertActive(); validate(); return null; }
        public bool SetBitrate(int bitrateBps) { assertActive(); validate(); return true; }
        public void Dispose() => consumer.Dispose();
    }
}
