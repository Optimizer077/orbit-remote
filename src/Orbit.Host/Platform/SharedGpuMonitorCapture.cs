using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

internal interface ILazyMonitorCapture : IMonitorCapture
{
    (MonitorUpdate Update, IDisposable? Frame) ReadTexture(int timeoutMilliseconds);
    byte[] ReadBgra(IDisposable frame);
    IGpuVideoEncoder? OpenEncoder(MonitorInfo monitor, int width, int height, int fps, int bitrate,
        Action validate, Action assertActive, Func<Task> nextChange, IDisposable consumer);
}

internal static class GpuUnitMapping
{
    internal static GpuVideoUnit Create(H264EncodedFrame frame, int codedWidth, int codedHeight, MonitorInfo monitor,
        string generation, long version, DateTimeOffset capturedUtc, long timestampOrigin100ns = 0)
    {
        var units = Units(frame.Units, timestampOrigin100ns);
        return new(frame.Units.Count == 1 ? frame.Units[0].Data : [], frame.IsKeyframe, codedWidth, codedHeight,
            monitor.Left, monitor.Top, monitor.Width, monitor.Height, generation, version, capturedUtc)
        {
            Units = units,
        };
    }
    internal static IReadOnlyList<GpuVideoAccessUnit> Units(IReadOnlyList<H264AccessUnit> units, long timestampOrigin100ns)
    {
        if (units.Count > 64 || units.Any(unit => unit.Data.Length is 0 or > 8 * 1024 * 1024) || units.Sum(unit => (long)unit.Data.Length) > 16 * 1024 * 1024)
            throw new PlatformUnavailableException("encode-batch-too-large", "The GPU encoder exceeded its bounded access-unit batch.");
        if (timestampOrigin100ns < 0 || units.Any(unit => unit.Timestamp100ns < 0 || unit.Timestamp100ns > long.MaxValue - timestampOrigin100ns))
            throw new PlatformUnavailableException("encode-failed", "The GPU encoder returned an invalid access-unit clock.");
        return units.Select(unit => new GpuVideoAccessUnit(unit.Data, unit.IsKeyframe, timestampOrigin100ns + unit.Timestamp100ns)).ToArray();
    }
}

/// <summary>Pool adapter only: capture advances on its producer; consumers hold immutable texture leases.</summary>
[SupportedOSPlatform("windows")]
internal sealed class SharedGpuMonitorCapture(GpuMonitorCapture capture) : ILazyMonitorCapture
{
    private string generation = capture.Generation;
    private long pointerVersion = capture.PointerVersion;

    public MonitorUpdate Read(int timeoutMilliseconds, byte[] destination) => throw new InvalidOperationException("GPU capture uses ReadTexture, with CPU readback only when requested.");
    public (MonitorUpdate Update, IDisposable? Frame) ReadTexture(int timeoutMilliseconds)
    {
        GpuFrameLease? frame;
        try { frame = capture.AcquireNext(timeoutMilliseconds); }
        catch (PlatformUnavailableException ex) when (ex.Code == "capture-busy") { frame = null; }
        var recovered = generation != capture.Generation; generation = capture.Generation;
        var moved = pointerVersion != capture.PointerVersion; pointerVersion = capture.PointerVersion;
        return (new(frame is not null, moved, recovered, capture.Pointer), frame);
    }
    public byte[] ReadBgra(IDisposable frame) => capture.ReadBgra(frame as GpuFrameLease ?? throw new ArgumentException("The published GPU lease is missing."));
    public IGpuVideoEncoder? OpenEncoder(MonitorInfo monitor, int width, int height, int fps, int bitrate,
        Action validate, Action assertActive, Func<Task> nextChange, IDisposable consumer)
    {
        var encoder = capture.CreateEncoder(width, height, fps, bitrate, out _);
        return encoder is null ? null : new Encoder(capture, encoder, monitor, validate, assertActive, nextChange, consumer);
    }
    public void Dispose() => capture.Dispose();

    private sealed class Encoder(GpuMonitorCapture capture, GpuStreamEncoder encoder, MonitorInfo monitor,
        Action validate, Action assertActive, Func<Task> nextChange, IDisposable consumer) : IGpuVideoEncoder, IGpuVideoEncoderFlush
    {
        private int disposed;
        private GpuVideoUnit? last;
        private void Check()
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
            assertActive(); validate();
            if (capture.Generation != encoder.Generation) throw new PlatformUnavailableException("capture-reset", "GPU capture recovered; the stream encoder must reopen.");
        }
        public async Task<GpuVideoUnit?> EncodeNextAsync(int timeoutMilliseconds, bool forceKeyframe, CancellationToken cancellationToken)
        {
            ArgumentOutOfRangeException.ThrowIfNegative(timeoutMilliseconds);
            var deadline = Environment.TickCount64 + Math.Min(timeoutMilliseconds, 10000);
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested(); Check();
                var signal = nextChange(); // Snapshot before Latest, so publication cannot be missed.
                using var frame = capture.Latest();
                if (frame is not null)
                {
                    if (frame.Generation != encoder.Generation) throw new PlatformUnavailableException("capture-reset", "The GPU image belongs to a new capture generation.");
                    var previous = encoder.LastEncoded;
                    if (previous is null || previous.Value.Generation != frame.Generation || previous.Value.Version != frame.Version || forceKeyframe)
                    {
                        var started = System.Diagnostics.Stopwatch.GetTimestamp();
                        var encoded = encoder.Encode(frame, forceKeyframe); cancellationToken.ThrowIfCancellationRequested(); Check();
                        return last = Unit(encoded, frame.Generation, frame.Version, frame.CapturedUtc) with { EncodeMilliseconds = Elapsed(started) };
                    }
                }
                var remaining = deadline - Environment.TickCount64; if (remaining <= 0) return null;
                try { await signal.WaitAsync(TimeSpan.FromMilliseconds(remaining), cancellationToken); } catch (TimeoutException) { return null; }
            }
        }
        public GpuVideoUnit? EncodeLast(bool forceKeyframe)
        {
            Check(); if (last is null) return null;
            var started = System.Diagnostics.Stopwatch.GetTimestamp();
            var encoded = encoder.EncodeLast(forceKeyframe); Check();
            return encoded is null ? null : last = Unit(encoded, last.Generation, last.Version, last.CapturedUtc) with { EncodeMilliseconds = Elapsed(started) };
        }
        public bool SetBitrate(int bitrateBps) { Check(); var accepted = encoder.SetBitrate(bitrateBps); Check(); return accepted; }
        public IReadOnlyList<GpuVideoAccessUnit> Flush() { Check(); var units = encoder.Flush(); Check(); return GpuUnitMapping.Units(units, encoder.TimestampOrigin100ns); }
        private static double Elapsed(long started) => System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        private GpuVideoUnit Unit(H264EncodedFrame frame, string generation, long version, DateTimeOffset capturedUtc) =>
            GpuUnitMapping.Create(frame, encoder.EncodedWidth, encoder.EncodedHeight, monitor, generation, version, capturedUtc, encoder.TimestampOrigin100ns);
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            try { encoder.Dispose(); } finally { consumer.Dispose(); }
        }
    }
}
