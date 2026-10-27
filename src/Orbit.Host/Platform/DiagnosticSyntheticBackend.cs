#if ORBIT_DIAGNOSTICS
using System.Diagnostics;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>Generated images only. There is deliberately no ordinary desktop backend to fall back to.</summary>
internal sealed class DiagnosticSyntheticBackend : IPlatformBackend, IFrameChangeSource, IPointerFeed, IGpuVideoSource
{
    internal const int FramesPerSecond = 60;
    private readonly MonitorInfo monitor;
    private readonly SharedMonitorFrames frames;
    private long generatedFrames, producerOpens, gpuEncoderOpens, cpuReadbacks;
    private int disposed;
    internal int Width => monitor.Width;
    internal int Height => monitor.Height;
    internal long GeneratedFrames => Interlocked.Read(ref generatedFrames);
    internal long ProducerOpens => Interlocked.Read(ref producerOpens);
    internal long GpuEncoderOpens => Interlocked.Read(ref gpuEncoderOpens);
    internal long CpuReadbacks => Interlocked.Read(ref cpuReadbacks);
    internal string PatternName { get; }

    internal DiagnosticSyntheticBackend(int width, int height) : this(width, height, "low-entropy") { }
    internal DiagnosticSyntheticBackend(int width, int height, string pattern)
    {
        if (width is < 320 or > 3840 || height is < 240 or > 2160 || width % 2 != 0 || height % 2 != 0)
            throw new ArgumentException("Diagnostic source dimensions are outside the bounded even range.");
        PlatformLimits.CheckDimensions(width, height);
        PatternName = DiagnosticSource.ParsePattern(pattern);
        monitor = new("diagnostic-synthetic-1", "Diagnostic synthetic GPU source", 0, 0, width, height, true);
        frames = new(CreateCapture, Validate);
    }
    private IMonitorCapture CreateCapture(MonitorInfo requested)
    {
        Validate(requested);
        if (!OperatingSystem.IsWindows()) throw Disabled();
        var capture = new SyntheticCapture(width: Width, height: Height, PatternName,
            () => Interlocked.Increment(ref generatedFrames), count => Interlocked.Add(ref cpuReadbacks, count));
        Interlocked.Increment(ref producerOpens); return capture;
    }
    private void Validate(MonitorInfo requested)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        if (requested != monitor) throw new ArgumentException("Only the configured diagnostic monitor is available.");
    }
    public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested(); Validate(monitor);
        return Task.FromResult(new PlatformStatus("Windows Diagnostic", "synthetic-generated", true, false, false, false,
            [monitor], ["Generated GPU test pattern only. Does not measure or access a real desktop. Input, clipboard, files and power are unavailable."],
            CanScaleFrames: true, CanConditionalFrames: true, CanJpegFrames: WicJpegEncoder.IsSupported, CanWaitForFrames: true));
    }
    public async Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default)
    {
        if (monitorId is not null && monitorId != monitor.Id) throw new ArgumentException("Unknown diagnostic monitor.");
        Validate(monitor);
        return await frames.CaptureAsync(monitor, cancellationToken)
            ?? throw new PlatformUnavailableException("diagnostic-unavailable", "The generated GPU source is unavailable; real desktop capture is never used.");
    }
    public Task WaitForChangeAsync(ScreenFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken = default) =>
        frames.WaitForChangeAsync(observed, maximumWaitMilliseconds, cancellationToken);
    public Task<PointerSnapshot?> GetPointerAsync(MonitorInfo requested, string? knownShapeId, CancellationToken cancellationToken = default)
    { Validate(requested); return frames.GetPointerAsync(requested, knownShapeId, cancellationToken); }
    public IGpuVideoEncoder? TryOpenEncoder(MonitorInfo requested, int width, int height, int fps, int bitrateBps)
    {
        Validate(requested);
        if (width <= 0 || height <= 0 || width > Width || height > Height || width % 2 != 0 || height % 2 != 0) return null;
        var encoder = frames.TryOpenEncoder(requested, width, height, Math.Clamp(fps, 1, 60), Math.Clamp(bitrateBps, 100_000, 100_000_000));
        if (encoder is not null) Interlocked.Increment(ref gpuEncoderOpens);
        return encoder;
    }
    private static PlatformUnavailableException Disabled() => new("diagnostic-view-only", "Diagnostic sources permit generated screen viewing only.");
    public Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default) => Task.FromException(Disabled());
    public Task ReleaseInputsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    public Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default) => Task.FromException<string>(Disabled());
    public Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default) => Task.FromException(Disabled());
    public Task LockAsync(CancellationToken cancellationToken = default) => Task.FromException(Disabled());
    public async ValueTask DisposeAsync()
    { if (Interlocked.Exchange(ref disposed, 1) == 0) await frames.DisposeAsync(); }

    [SupportedOSPlatform("windows")]
    private sealed class SyntheticCapture : ILazyMonitorCapture
    {
        private readonly GpuMonitorCapture capture;
        private readonly SharedGpuMonitorCapture shared;
        private readonly Pattern pattern;
        private readonly Action generated;
        private readonly Action<long> readbacks;
        private readonly object readbackGate = new();
        private readonly long origin = Stopwatch.GetTimestamp();
        private long frame;
        internal SyntheticCapture(int width, int height, string patternName, Action generated, Action<long> readbacks)
        {
            capture = GpuMonitorCapture.CreateSynthetic(width, height, out _) ?? throw new PlatformUnavailableException("diagnostic-unavailable", "Cannot create the generated GPU source.");
            shared = new(capture); pattern = new(width, height, patternName); this.generated = generated; this.readbacks = readbacks;
        }
        public MonitorUpdate Read(int timeoutMilliseconds, byte[] destination) => throw new InvalidOperationException("The generated source publishes GPU leases.");
        public (MonitorUpdate Update, IDisposable? Frame) ReadTexture(int timeoutMilliseconds)
        {
            var target = origin + frame * Stopwatch.Frequency / FramesPerSecond;
            var deadline = Stopwatch.GetTimestamp() + Math.Max(0, timeoutMilliseconds) * Stopwatch.Frequency / 1000;
            while (Stopwatch.GetTimestamp() < target)
            {
                if (Stopwatch.GetTimestamp() >= deadline) return (new(false, false, false, null), null);
                Thread.Sleep(1);
            }
            frame = Math.Max(frame + 1, (Stopwatch.GetTimestamp() - origin) * FramesPerSecond / Stopwatch.Frequency + 1);
            try
            {
                var lease = capture.PushSynthetic(pattern.Next(frame)); generated();
                return (new(true, false, false, null), lease);
            }
            catch (PlatformUnavailableException ex) when (ex.Code == "capture-busy")
            { return (new(false, false, false, null), null); }
        }
        public byte[] ReadBgra(IDisposable image)
        {
            lock (readbackGate)
            {
                var before = capture.ReadbackCount; var pixels = shared.ReadBgra(image);
                readbacks(capture.ReadbackCount - before); return pixels;
            }
        }
        public IGpuVideoEncoder? OpenEncoder(MonitorInfo requested, int width, int height, int fps, int bitrate,
            Action validate, Action assertActive, Func<Task> nextChange, IDisposable consumer) =>
            shared.OpenEncoder(requested, width, height, fps, bitrate, validate, assertActive, nextChange, consumer);
        public void Dispose() => shared.Dispose();
    }

    /// <summary>Bounded reusable generated buffer; no screen or user content is read.</summary>
    internal sealed class Pattern
    {
        private readonly int width, height;
        private readonly byte[] pixels;
        private readonly bool highEntropy;
        private uint previousPhase;
        private int previous = -1;
        internal Pattern(int width, int height) : this(width, height, "low-entropy") { }
        internal Pattern(int width, int height, string patternName)
        {
            this.width = width; this.height = height; pixels = new byte[checked(width * height * 4)];
            highEntropy = DiagnosticSource.ParsePattern(patternName) == "high-entropy";
            if (highEntropy)
            {
                var words = MemoryMarshal.Cast<byte, uint>(pixels.AsSpan()); uint seed = 0xA341316Cu;
                for (var i = 0; i < words.Length; i++)
                {
                    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
                    words[i] = 0xFF000000u | (seed & 0x00FFFFFFu);
                }
            }
            else for (var y = 0; y < height; y++) for (var x = 0; x < width; x++) Background(x, y);
        }
        private void Background(int x, int y)
        {
            var at = (y * width + x) * 4; var shade = (byte)(32 + ((x / 32 + y / 32) % 2) * 32);
            pixels[at] = shade; pixels[at + 1] = shade; pixels[at + 2] = shade; pixels[at + 3] = 255;
        }
        internal byte[] Next(long frame)
        {
            if (highEntropy)
            {
                // One reusable buffer, no generated image is read back or retained elsewhere.
                // Odd multiplication gives a nonrepeating 24-bit phase for consecutive frames.
                var phase = unchecked((uint)frame * 0x9E3779B1u) & 0x00FFFFFFu;
                var delta = phase ^ previousPhase; previousPhase = phase;
                var words = MemoryMarshal.Cast<byte, uint>(pixels.AsSpan());
                var mask = new Vector<uint>(delta); var i = 0;
                for (; i <= words.Length - Vector<uint>.Count; i += Vector<uint>.Count)
                    (new Vector<uint>(words.Slice(i, Vector<uint>.Count)) ^ mask).CopyTo(words.Slice(i, Vector<uint>.Count));
                for (; i < words.Length; i++) words[i] ^= delta;
                return pixels;
            }
            if (previous >= 0) for (var y = 32; y < height; y++) for (var dx = 0; dx < 12; dx++) Background((previous + dx) % width, y);
            var bar = (int)(frame % width * 7 % width); previous = bar;
            for (var y = 32; y < height; y++) for (var dx = 0; dx < 12; dx++)
            {
                var at = (y * width + (bar + dx) % width) * 4;
                pixels[at] = 32; pixels[at + 1] = 220; pixels[at + 2] = 240;
            }
            for (var bit = 0; bit < 32; bit++) for (var y = 0; y < 16; y++) for (var x = 0; x < 8; x++)
            {
                var at = (y * width + bit * 8 + x) * 4; var value = (byte)(((frame >> bit) & 1) == 0 ? 16 : 240);
                pixels[at] = value; pixels[at + 1] = value; pixels[at + 2] = value;
            }
            return pixels;
        }
    }
}
#endif
