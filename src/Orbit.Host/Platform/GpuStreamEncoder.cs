using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>How BGRA desktop pixels become encoder input on the GPU.</summary>
internal enum GpuColourPath
{
    /// <summary>RGB to the encoder when no scaling is needed and the MFT accepts it, else the video processor.</summary>
    Auto,
    /// <summary>BGRA texture straight into the MFT as ARGB32; the encoder converts to YUV internally. No scaling.</summary>
    RgbToEncoder,
    /// <summary>ID3D11VideoProcessor: BGRA to BT.709 limited NV12 with optional scaling, then NV12 into the MFT.</summary>
    VideoProcessor,
}

/// <summary>
/// W8g/G2: one stream's H.264 encoder, a child of a shared <see cref="GpuMonitorCapture"/>. It uses the capture's D3D11
/// device and IMFDXGIDeviceManager and a hardware MFT on the capture adapter (LUID, else vendor), so frames go
/// texture → (video processor) → NVENC/AMF/QSV/Adreno without touching the CPU. Bound to one capture generation:
/// after a recovery every call throws "capture-reset" and the stream reopens it. Each encoder keeps its own hold on
/// the last encoded image for <see cref="EncodeLast"/> (refresh tail, keyframe on unchanged content). Thread-safe.
/// </summary>
internal sealed class GpuStreamEncoder : IDisposable
{
    private const int OutputPool = 3; // current picture + one the MFT may still hold when pipelining + the one being written
    private readonly object gate = new();
    private readonly GpuMonitorCapture capture;
    private readonly long started = Stopwatch.GetTimestamp();
    private MfH264Encoder? encoder;
    private IntPtr videoDevice, videoContext, enumerator, processor;
    private Gpu.ID3D11VideoContext? videoApi;
    private readonly Dictionary<IntPtr, IntPtr> inputViews = [];
    private readonly IntPtr[] nv12 = new IntPtr[OutputPool], outputViews = new IntPtr[OutputPool];
    private int next;
    private GpuFrameLease? last;
    private bool disposed;

    private GpuStreamEncoder(GpuMonitorCapture capture, string generation, int sourceWidth, int sourceHeight, int width, int height)
    {
        this.capture = capture; Generation = generation; SourceWidth = sourceWidth; SourceHeight = sourceHeight; EncodedWidth = width; EncodedHeight = height;
    }

    /// <summary>The capture generation this encoder is bound to.</summary>
    public string Generation { get; }
    public int SourceWidth { get; }
    public int SourceHeight { get; }
    public int EncodedWidth { get; }
    public int EncodedHeight { get; }
    public GpuColourPath Colour { get; private set; }
    public int FramesPerSecond => Inner.FramesPerSecond;
    public int BitrateBps => Inner.BitrateBps;
    public string EncoderName => Inner.EncoderName;
    /// <summary>
    /// Host Stopwatch time of this encoder's creation, in 100-ns ticks (<c>Stopwatch.GetElapsedTime(0, started).Ticks</c>).
    /// Unit timestamps (<see cref="H264AccessUnit.Timestamp100ns"/>) are relative to it: add this origin to get host-monotonic
    /// time comparable with <c>Stopwatch.GetElapsedTime(0, Stopwatch.GetTimestamp()).Ticks</c>.
    /// </summary>
    public long TimestampOrigin100ns => Stopwatch.GetElapsedTime(0, started).Ticks;
    /// <summary>(Generation, Version) of the last image this encoder encoded; null before the first.</summary>
    public (string Generation, long Version)? LastEncoded { get { lock (gate) return last is null ? null : (last.Generation, last.Version); } }
    internal MfH264Encoder Inner => encoder ?? throw new ObjectDisposedException(nameof(GpuStreamEncoder));

    [SupportedOSPlatform("windows")]
    internal static GpuStreamEncoder? Create(GpuMonitorCapture capture, int width, int height, int fps, int bitrate, GpuColourPath colour,
        H264EncoderOptions? options, out string reason)
    {
        // The binding holds device, context and manager until Initialize has its own references (QueryInterface, AddRef),
        // so a concurrent recovery or Dispose cannot free them under the open.
        using var bind = capture.Binding();
        if (bind.Generation.Length == 0) { reason = "capture-lost"; return null; }
        if (width <= 0 || height <= 0) { width = bind.Width & ~1; height = bind.Height & ~1; }
        if (width % 2 != 0 || height % 2 != 0 || width > bind.Width || height > bind.Height) { reason = "Output size must be even and at most the source size."; return null; }
        var sameSize = width == bind.Width && height == bind.Height;
        if (colour == GpuColourPath.RgbToEncoder && !sameSize) { reason = "rgb-input-cannot-scale"; return null; }
        var result = new GpuStreamEncoder(capture, bind.Generation, bind.Width, bind.Height, width, height);
        try
        {
            reason = result.Initialize(bind.Device, bind.Context, bind.Manager, bind.Luid, bind.Vendor, fps, bitrate, colour, sameSize, options);
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or InvalidOperationException)
        {
            reason = $"interop-failed-0x{ex.HResult:X8}: {ex.Message}";
        }
        catch { result.Dispose(); throw; } // any other failure must not keep its QueryInterface references (and the old device) alive
        // A recovery that won the race leaves an encoder on the old device: hand back a reset now, not on its first encode.
        if (reason.Length == 0 && !capture.IsCurrentGeneration(bind.Generation)) reason = "capture-reset";
        if (reason.Length == 0) return result;
        result.Dispose();
        return null;
    }

    [SupportedOSPlatform("windows")]
    private string Initialize(IntPtr device, IntPtr context, IntPtr manager, long luid, uint vendor, int fps, int bitrate, GpuColourPath colour, bool sameSize,
        H264EncoderOptions? options)
    {
        var failures = "";
        if (colour != GpuColourPath.VideoProcessor && sameSize)
        {
            encoder = MfH264Encoder.CreateForTextures(EncodedWidth, EncodedHeight, fps, bitrate, manager, rgbInput: true, luid, vendor, out var why, options);
            if (encoder is not null) { Colour = GpuColourPath.RgbToEncoder; return ""; }
            if (colour == GpuColourPath.RgbToEncoder) return "rgb-input-refused: " + why;
            failures = "rgb input refused (" + why + "); ";
        }
        var vp = CreateVideoProcessor(device, context, fps);
        if (vp.Length > 0) return failures + vp;
        encoder = MfH264Encoder.CreateForTextures(EncodedWidth, EncodedHeight, fps, bitrate, manager, rgbInput: false, luid, vendor, out var reason, options);
        if (encoder is null) return failures + "nv12-encoder-failed: " + reason;
        encoder.PipeliningAllowed = true; // rotating VideoProcessor targets; the RGB path hands over the capture texture itself
        Colour = GpuColourPath.VideoProcessor;
        return "";
    }

    [SupportedOSPlatform("windows")]
    private string CreateVideoProcessor(IntPtr device, IntPtr context, int fps)
    {
        videoDevice = Gpu.Query(device, Gpu.VideoDeviceIid);
        videoContext = Gpu.Query(context, Gpu.VideoContextIid);
        videoApi = Gpu.Wrap<Gpu.ID3D11VideoContext>(videoContext);
        var vd = Gpu.Wrap<Gpu.ID3D11VideoDevice>(videoDevice);
        var deviceApi = Gpu.Wrap<Gpu.ID3D11Device>(device);
        try
        {
            var content = new Gpu.ContentDesc
            {
                InputRateNumerator = (uint)fps, InputRateDenominator = 1, InputWidth = (uint)SourceWidth, InputHeight = (uint)SourceHeight,
                OutputRateNumerator = (uint)fps, OutputRateDenominator = 1, OutputWidth = (uint)EncodedWidth, OutputHeight = (uint)EncodedHeight,
                Usage = 0, // PLAYBACK_NORMAL: full-quality scaling for text
            };
            var hr = vd.CreateVideoProcessorEnumerator(ref content, out enumerator);
            if (hr < 0) return $"video-processor-enumerator-failed-0x{hr:X8}";
            var enumApi = Gpu.Wrap<Gpu.ID3D11VideoProcessorEnumerator>(enumerator);
            try
            {
                if (enumApi.CheckVideoProcessorFormat(Gpu.FormatBgra8, out var inFlags) < 0 || (inFlags & 1) == 0) return "video-processor-no-bgra-input";
                if (enumApi.CheckVideoProcessorFormat(Gpu.FormatNv12, out var outFlags) < 0 || (outFlags & 2) == 0) return "video-processor-no-nv12-output";
            }
            finally { Marshal.ReleaseComObject(enumApi); }
            hr = vd.CreateVideoProcessor(enumerator, 0, out processor);
            if (hr < 0) return $"video-processor-failed-0x{hr:X8}";
            for (var i = 0; i < OutputPool; i++)
            {
                var desc = GpuMonitorCapture.TextureDesc(EncodedWidth, EncodedHeight, Gpu.FormatNv12, Gpu.BindRenderTarget);
                hr = deviceApi.CreateTexture2D(ref desc, IntPtr.Zero, out nv12[i]);
                if (hr < 0) return $"nv12-texture-failed-0x{hr:X8}";
                var outDesc = new Gpu.OutputViewDesc { ViewDimension = 1 };
                hr = vd.CreateVideoProcessorOutputView(nv12[i], enumerator, ref outDesc, out outputViews[i]);
                if (hr < 0) return $"output-view-failed-0x{hr:X8}";
            }
        }
        finally { Marshal.ReleaseComObject(vd); Marshal.ReleaseComObject(deviceApi); }
        uint input = Gpu.ColourRgbFull, output = Gpu.ColourYuv709Limited;
        var source = new Gpu.Rect { Right = SourceWidth, Bottom = SourceHeight };
        var target = new Gpu.Rect { Right = EncodedWidth, Bottom = EncodedHeight };
        lock (capture.ContextGate)
        {
            videoApi.VideoProcessorSetStreamFrameFormat(processor, 0, 0); // progressive
            videoApi.VideoProcessorSetStreamAutoProcessingMode(processor, 0, false); // no driver "enhancements" on text
            videoApi.VideoProcessorSetStreamColorSpace(processor, 0, ref input);
            videoApi.VideoProcessorSetOutputColorSpace(processor, ref output);
            videoApi.VideoProcessorSetStreamSourceRect(processor, 0, true, ref source);
            videoApi.VideoProcessorSetStreamDestRect(processor, 0, true, ref target);
            videoApi.VideoProcessorSetOutputTargetRect(processor, true, ref target);
        }
        return "";
    }

    /// <summary>
    /// Encodes a leased image. Keeps its own hold on it for <see cref="EncodeLast"/>; the caller still disposes its lease.
    /// </summary>
    /// <exception cref="PlatformUnavailableException">"capture-reset" when the lease or this encoder belongs to an old generation.</exception>
    [SupportedOSPlatform("windows")]
    public H264EncodedFrame Encode(GpuFrameLease lease, bool forceKeyframe)
    {
        ArgumentNullException.ThrowIfNull(lease);
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var frame = EncodeLocked(lease, forceKeyframe);
            if (!ReferenceEquals(lease, last))
            {
                var hold = lease.Share();
                last?.Dispose();
                last = hold;
            }
            return frame;
        }
    }

    /// <summary>Re-encodes the last encoded image (refresh tail, keyframe request on unchanged content); null before the first.</summary>
    [SupportedOSPlatform("windows")]
    public H264EncodedFrame? EncodeLast(bool forceKeyframe)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return last is null ? null : EncodeLocked(last, forceKeyframe);
        }
    }

    /// <summary>Drains the hardware MFT and returns the access units it still held (stream end or reconfiguration).</summary>
    [SupportedOSPlatform("windows")]
    public IReadOnlyList<H264AccessUnit> Flush()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return Inner.Flush();
        }
    }

    public bool SetBitrate(int bitrateBps)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return OperatingSystem.IsWindows() && Inner.SetBitrate(bitrateBps);
        }
    }

    [SupportedOSPlatform("windows")]
    private H264EncodedFrame EncodeLocked(GpuFrameLease lease, bool forceKeyframe)
    {
        if (lease.Generation != Generation || !lease.IsCurrent)
            throw new PlatformUnavailableException("capture-reset", "The GPU capture was recreated; reopen the encoder.");
        IntPtr input;
        lock (capture.ContextGate) // the immediate context is shared with the capture's copies and readback
        {
            if (!capture.IsCurrentGeneration(Generation)) throw new PlatformUnavailableException("capture-reset", "The GPU capture was recreated; reopen the encoder.");
            if (Colour == GpuColourPath.VideoProcessor)
            {
                var stream = new Gpu.ProcessorStream { Enable = 1, InputSurface = InputView(lease.Texture) };
                var hr = videoApi!.VideoProcessorBlt(processor, outputViews[next], 0, 1, ref stream);
                if (hr < 0) throw new PlatformUnavailableException("encode-failed", $"VideoProcessorBlt failed (0x{hr:X8}).");
                input = nv12[next];
                next = (next + 1) % OutputPool;
            }
            else input = lease.Texture;
        }
        // Low-latency mode returns the access unit before EncodeTexture returns, so the input is free again afterwards.
        return encoder!.EncodeTexture(input, (Stopwatch.GetTimestamp() - started) * 10_000_000 / Stopwatch.Frequency, forceKeyframe);
    }

    [SupportedOSPlatform("windows")]
    private IntPtr InputView(IntPtr texture)
    {
        if (inputViews.TryGetValue(texture, out var view)) return view;
        var vd = Gpu.Wrap<Gpu.ID3D11VideoDevice>(videoDevice);
        try
        {
            var desc = new Gpu.InputViewDesc { ViewDimension = 1 };
            var hr = vd.CreateVideoProcessorInputView(texture, enumerator, ref desc, out view);
            if (hr < 0) throw new PlatformUnavailableException("encode-failed", $"Cannot create a video processor input view (0x{hr:X8}).");
        }
        finally { Marshal.ReleaseComObject(vd); }
        inputViews[texture] = view; // capture slot textures live for the generation, as does this encoder
        return view;
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            last?.Dispose(); last = null;
            if (!OperatingSystem.IsWindows()) return;
            encoder?.Dispose(); encoder = null;
            foreach (var view in inputViews.Values) Marshal.Release(view);
            inputViews.Clear();
            for (var i = 0; i < OutputPool; i++) { Gpu.Release(ref outputViews[i]); Gpu.Release(ref nv12[i]); }
            Gpu.Release(ref processor); Gpu.Release(ref enumerator);
            if (videoApi is not null) { Marshal.ReleaseComObject(videoApi); videoApi = null; }
            Gpu.Release(ref videoContext); Gpu.Release(ref videoDevice);
        }
    }
}
