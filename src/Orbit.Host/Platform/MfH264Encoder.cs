using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>Which Media Foundation H.264 encoder <see cref="MfH264Encoder.Create"/> may use.</summary>
internal enum H264EncoderPath
{
    /// <summary>First hardware encoder that opens, else the Microsoft software encoder.</summary>
    Auto,
    Hardware,
    Software,
}

/// <summary>
/// One encoded access unit in Annex-B form (start codes). Keyframes are IDR access units that always carry SPS and PPS,
/// so a decoder can join at any keyframe. <see cref="Data"/> is empty when the encoder has not produced output yet.
/// </summary>
internal sealed record H264EncodedFrame(byte[] Data, bool IsKeyframe, long Timestamp100ns, double EncodeMilliseconds,
    double ConvertMilliseconds, int AccessUnits, int PendingFrames)
{
    public bool IsEmpty => Data.Length == 0;
    /// <summary>
    /// The output split into single-picture access units, in decode order, each with its own keyframe flag and input
    /// timestamp. Send these one chunk each: some MFTs (Qualcomm Adreno, W8g ARM run) buffer the first input and then
    /// return two pictures in one sample, which <see cref="Data"/> (the concatenation) would hand a decoder as one chunk.
    /// </summary>
    public IReadOnlyList<H264AccessUnit> Units { get; init; } = [];
}

/// <summary>One picture's Annex-B access unit; keyframes carry SPS and PPS.</summary>
internal sealed record H264AccessUnit(byte[] Data, bool IsKeyframe, long Timestamp100ns);

/// <summary>
/// Optional encoder controls (all CODECAPI_* via ICodecAPI). A null field takes the path default described on
/// <see cref="MfH264Encoder.Create"/>; 0 for <see cref="VbvBufferBits"/> means "do not set, keep the encoder's own".
/// </summary>
internal sealed record H264EncoderOptions
{
    public int? VbvBufferBits { get; init; } // CODECAPI_AVEncCommonBufferSize (bits): caps how far one frame may exceed bitrate/fps
    public int? QualityVsSpeed { get; init; } // CODECAPI_AVEncCommonQualityVsSpeed, 0 (fastest)..100
    public uint RateControlMode { get; init; } // 0 CBR, 1 PeakConstrainedVBR, 2 UnconstrainedVBR, 3 Quality, 4 LowDelayVBR
    public uint? Quality { get; init; } // CODECAPI_AVEncCommonQuality 0..100 (Quality mode)
    public uint? MaxBitrate { get; init; } // CODECAPI_AVEncCommonMaxBitRate (PeakConstrainedVBR peak)
    public uint? MinQp { get; init; } // CODECAPI_AVEncVideoMinQP 0..51
    public uint? MaxQp { get; init; } // CODECAPI_AVEncVideoMaxQP 0..51
    public uint? GradualIntraRefresh { get; init; } // CODECAPI_AVEncVideoGradualIntraRefresh (both MFTs list 0, 1, 2)
}

/// <summary>
/// D11 spike: low-latency H.264 encoder over the Media Foundation transforms that ship with Windows (decision D10:
/// OS encoders only, hand-written COM interop, no packages). Input is the same top-down BGRA buffer, stride = width*4,
/// that <see cref="PngEncoder"/> and <see cref="WicJpegEncoder"/> take. It is converted on the CPU to BT.709
/// limited-range NV12. H.264 4:2:0 needs even dimensions: an odd width or height is padded by one replicated
/// column or row (<see cref="EncodedWidth"/>/<see cref="EncodedHeight"/>), so the viewer crops to <see cref="Width"/>x<see cref="Height"/>.
/// Hardware MFTs are asynchronous (METransformNeedInput/METransformHaveOutput); the Microsoft software MFT
/// (CLSID_CMSH264EncoderMFT) is synchronous. Both sit behind the same <see cref="Encode"/> call.
/// An instance is not meant for concurrent use, but every public member takes a lock so misuse cannot corrupt COM state.
/// </summary>
internal sealed partial class MfH264Encoder : IDisposable
{
    public const int MinimumBitrate = 100_000;
    public const int MaximumBitrate = 200_000_000;
    public const int MinimumDimension = 16;
    public const int MaximumDimension = 8192;
    private const int AsyncInputTimeoutMs = 2000;
    private const int EventThreadJoinMs = 2000;

    private static readonly Lazy<bool> Supported = new(() => OperatingSystem.IsWindows() && Probe());

    /// <summary>True only on Windows when Media Foundation starts and the Microsoft H.264 encoder MFT can be created. Safe to query on any OS.</summary>
    public static bool IsSupported => OperatingSystem.IsWindows() && Supported.Value;

    private readonly object gate = new();
    private readonly List<string> log;
    private object? transform; // Mf.IMFTransform
    private object? activate; // Mf.IMFActivate (hardware only; ShutdownObject is required on release)
    private object? codecApi; // Mf.ICodecAPI
    private object? events; // Mf.IMFMediaEventGenerator (async MFTs only)
    private BlockingCollection<(uint Type, int Status)>? eventQueue; // filled by eventThread
    private Thread? eventThread;
    private object? outputSample; // Mf.IMFSample, caller-allocated output when the MFT does not provide samples
    private object? outputBuffer; // Mf.IMFMediaBuffer
    private readonly uint inputStream;
    private readonly uint outputStream;
    private bool mftProvidesSamples;
    private int outputBufferSize;
    private int needInput;
    private long inputs;
    private long outputs;
    private byte[]? parameterSets; // last seen SPS+PPS NAL units with 4-byte start codes
    private readonly byte[] nv12;
    private readonly Queue<long> inputTimes = new();
    private bool drainComplete;
    private readonly (object Sample, object Buffer)?[] inputRing = new (object, object)?[3];
    private int ringNext;
    // One frame in flight when the hardware MFT cannot keep up with the frame rate (median output wait above 1.1 frame
    // intervals): Encode returns the previous picture while this one encodes, raising throughput for one frame of latency.
    // The Qualcomm MFT on Windows on ARM waits ~17 ms at 60 fps, just under that, so it stays serial (lower latency).
    // Only where this encoder owns its input until the MFT releases it: memory samples (pooled by a ring of three) or
    // rotating VideoProcessor textures. Decided once from the measured output wait.
    private readonly double[] outputWaits = new double[8];
    private int outputWaitCount;
    private int submissions; // the decision skips encoder warm-up: the first PipelineWarmup submissions and every keyframe
    private bool submittingKeyframe;
    internal const int PipelineWarmup = 30;
    private int pipelineDepth;
    internal bool PipeliningAllowed { get; set; } = true;
    /// <summary>Pictures this encoder may keep in flight beyond the current input (0 or 1).</summary>
    public int PipelineDepth { get { lock (gate) return pipelineDepth; } }
    private bool disposed;

    public int Width { get; }
    public int Height { get; }
    public int EncodedWidth { get; }
    public int EncodedHeight { get; }
    public int FramesPerSecond { get; }
    public int BitrateBps { get; private set; }
    public bool IsHardware { get; }
    /// <summary>Effective CODECAPI_AVEncCommonBufferSize request in bits (0 = encoder default); <see cref="ConfigurationLog"/> shows whether it applied.</summary>
    public int VbvBufferBits { get; private set; }
    /// <summary>Effective CODECAPI_AVEncCommonQualityVsSpeed request.</summary>
    public int QualityVsSpeed { get; private init; }
    public H264EncoderOptions Options { get; private init; } = new();
    public string EncoderName { get; }
    /// <summary>RFC 6381 codec string (for example <c>avc1.4D4028</c>) from the first SPS seen; null before the first keyframe.</summary>
    public string? CodecString { get; private set; }
    /// <summary>Frames submitted but not yet returned: the encoder's output latency in frames.</summary>
    public int PendingFrames { get { lock (gate) return (int)(inputs - outputs); } }
    /// <summary>HRESULT of each configuration step, for diagnostics. Contains no pixel data.</summary>
    public IReadOnlyList<string> ConfigurationLog => log;

    [SupportedOSPlatform("windows")]
    private MfH264Encoder(object transform, object? activate, string name, bool hardware, int width, int height, int fps, int bitrate, List<string> log)
    {
        this.transform = transform; this.activate = activate; this.log = log;
        EncoderName = name; IsHardware = hardware; Width = width; Height = height; FramesPerSecond = fps; BitrateBps = bitrate;
        EncodedWidth = width + (width & 1); EncodedHeight = height + (height & 1);
        nv12 = new byte[checked(EncodedWidth * EncodedHeight * 3 / 2)];
        var ins = new uint[1]; var outs = new uint[1];
        if (((Mf.IMFTransform)transform).GetStreamIDs(1, ins, 1, outs) == 0) { inputStream = ins[0]; outputStream = outs[0]; }
    }

    /// <summary>
    /// Creates and starts an encoder, or returns null with a reason; never throws for an unavailable codec. Hardware
    /// defaults to VBV = bitrate/4 and quality-vs-speed 33: NVIDIA ships a 3.9 s buffer (244 KB 1080p keyframes; 0.25 s
    /// gives ~95 KB for ~3 dB) and 33 gains ~2 dB for &lt;1 ms (W8b). Software keeps its own buffer (it ignores the
    /// setting) and quality-vs-speed 0 because it is CPU-bound.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static MfH264Encoder? Create(int width, int height, int fps, int bitrateBps, out string reason, H264EncoderPath path = H264EncoderPath.Auto,
        H264EncoderOptions? options = null) => CreateCore(width, height, fps, bitrateBps, out reason, path, options, prepare: null);

    /// <param name="prepare">Runs on the new instance before Configure (MfH264Encoder.Gpu.cs sets D3D11 texture input).</param>
    /// <param name="adapterLuid">Non-zero: only hardware MFTs on that adapter (or of <paramref name="adapterVendorId"/>), see Mf.EnumerateHardwareEncoders.</param>
    [SupportedOSPlatform("windows")]
    private static MfH264Encoder? CreateCore(int width, int height, int fps, int bitrateBps, out string reason, H264EncoderPath path,
        H264EncoderOptions? options, Action<MfH264Encoder>? prepare, long adapterLuid = 0, uint adapterVendorId = 0)
    {
        options ??= new H264EncoderOptions();
        reason = "";
        if (width is < MinimumDimension or > MaximumDimension || height is < MinimumDimension or > MaximumDimension)
        { reason = $"Dimensions must be {MinimumDimension}..{MaximumDimension} pixels per side."; return null; }
        if (fps is < 1 or > 240) { reason = "Frame rate must be 1..240."; return null; }
        if (options.VbvBufferBits < 0) { reason = "The VBV buffer size cannot be negative."; return null; }
        if (options.QualityVsSpeed is < 0 or > 100) { reason = "Quality-vs-speed must be 0..100."; return null; }
        if (!IsSupported) { reason = "The Media Foundation H.264 encoder is unavailable on this system."; return null; }
        var bitrate = ClampBitrate(bitrateBps);
        var failures = new List<string>();
        if (path != H264EncoderPath.Software)
        {
            var candidates = Mf.EnumerateHardwareEncoders(adapterLuid, adapterVendorId);
            var next = 0;
            try
            {
                while (next < candidates.Count)
                {
                    var (activate, name) = candidates[next++]; // ownership moves to TryOpen
                    var encoder = TryOpen(activate, name, hardware: true, width, height, fps, bitrate, options, prepare, failures);
                    if (encoder is not null) return encoder;
                }
            }
            finally { for (var i = next; i < candidates.Count; i++) Mf.Release(candidates[i].Activate); }
            if (candidates.Count == 0) failures.Add("no hardware H.264 encoder MFT is registered for NV12 input");
        }
        if (path != H264EncoderPath.Hardware)
        {
            var encoder = TryOpen(null, "Microsoft H.264 Video Encoder MFT (software)", hardware: false, width, height, fps, bitrate, options, prepare, failures);
            if (encoder is not null) return encoder;
        }
        reason = string.Join("; ", failures);
        return null;
    }

    public static int ClampBitrate(int bps) => Math.Clamp(bps, MinimumBitrate, MaximumBitrate);

    /// <summary>Takes ownership of <paramref name="activate"/>; on failure everything is shut down and released.</summary>
    [SupportedOSPlatform("windows")]
    private static MfH264Encoder? TryOpen(object? activate, string name, bool hardware, int width, int height, int fps, int bitrate,
        H264EncoderOptions options, Action<MfH264Encoder>? prepare, List<string> failures)
    {
        MfH264Encoder? encoder = null;
        try
        {
            Mf.Runtime.AddRef();
        }
        catch (Exception ex) when (ex is COMException or DllNotFoundException or EntryPointNotFoundException)
        {
            failures.Add($"{name}: MFStartup 0x{ex.HResult:X8}");
            Mf.Release(activate);
            return null;
        }
        object? transform = null; string? firstFailure = null;
        for (var attempt = 0; ; attempt++)
        try
        {
            transform = activate is null ? Mf.CreateSoftwareEncoder() : Mf.Activate(activate);
            encoder = new MfH264Encoder(transform, activate, name, hardware, width, height, fps, bitrate, [])
            {
                // W8h: hardware MaxQP 30 sharpens still text to 50.6 dB at +15 frames (46.3 without); peak 1 s 0.94x target on text, 1.12x on video.
                Options = hardware && options.MaxQp is null ? options with { MaxQp = 30 } : options,
                VbvBufferBits = options.VbvBufferBits ?? (hardware ? bitrate / 4 : 0),
                QualityVsSpeed = options.QualityVsSpeed ?? (hardware ? 33 : 0),
                minimal = attempt > 0,
            };
            prepare?.Invoke(encoder);
            encoder.Configure((Mf.IMFTransform)transform);
            if (firstFailure is not null) encoder.log.Insert(0, "retried without optional settings after: " + firstFailure);
            return encoder;
        }
        catch (Exception ex) when (attempt == 0 && ex is COMException or InvalidCastException or ArgumentException or InvalidOperationException)
        {
            // Vendor neutrality: an MFT may accept a tuning value and then refuse the media types (the Microsoft MFT does
            // with MaxQP 99). Retry once on a fresh instance with only the settings the stream needs.
            firstFailure = $"0x{ex.HResult:X8} {ex.Message}";
            if (encoder is not null) encoder.ReleaseAttempt();
            else { if (activate is Mf.IMFActivate a) { try { a.ShutdownObject(); } catch (COMException) { } } Mf.Release(transform); }
            encoder = null; transform = null;
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or ArgumentException or InvalidOperationException or TimeoutException)
        {
            failures.Add($"{name}: 0x{ex.HResult:X8} {ex.Message}{(firstFailure is null ? "" : " (first attempt: " + firstFailure + ")")}".Trim());
            if (encoder is not null) encoder.Dispose(); // releases transform, activate and the MFStartup reference
            else
            {
                if (activate is Mf.IMFActivate a) { try { a.ShutdownObject(); } catch (COMException) { } }
                Mf.Release(transform); Mf.Release(activate);
                Mf.Runtime.Release();
            }
            return null;
        }
    }

    /// <summary>Second attempt: only CBR, mean bitrate, low latency, GOP and no B-frames (no tuning properties).</summary>
    private bool minimal;

    /// <summary>Releases a failed attempt's MFT, keeping the activation object and the MFStartup reference for the retry.</summary>
    [SupportedOSPlatform("windows")]
    private void ReleaseAttempt()
    {
        if (activate is Mf.IMFActivate a) { try { a.ShutdownObject(); } catch (COMException) { } }
        Mf.Release(outputSample); Mf.Release(outputBuffer); Mf.Release(transform);
        outputSample = outputBuffer = transform = codecApi = events = activate = null;
        if (d3dManager != IntPtr.Zero) { Marshal.Release(d3dManager); d3dManager = IntPtr.Zero; } // the retry's prepare AddRefs again
        disposed = true;
    }

    [SupportedOSPlatform("windows")]
    private void Configure(Mf.IMFTransform t)
    {
        if (t.GetAttributes(out var attributes) == 0 && attributes is not null)
        {
            try
            {
                var isAsync = attributes.GetUINT32(Mf.TransformAsync, out var asyncValue) == 0 && asyncValue != 0;
                if (IsHardware && !isAsync) throw new InvalidOperationException("The hardware MFT is not asynchronous.");
                if (isAsync) Mf.Check(attributes.SetUINT32(Mf.TransformAsyncUnlock, 1), "MF_TRANSFORM_ASYNC_UNLOCK");
                Log("MF_LOW_LATENCY (attribute)", attributes.SetUINT32(Mf.LowLatency, 1));
                if (d3dManager != IntPtr.Zero) ConfigureD3D(t, attributes);
            }
            finally { Mf.Release(attributes); }
        }
        else if (IsHardware) throw new InvalidOperationException("The hardware MFT exposes no attributes.");

        codecApi = t as Mf.ICodecAPI;
        if (codecApi is not null)
        {
            // Rate control and GOP structure are fixed before the media types are set (H.264 Video Encoder docs).
            var rateControl = minimal ? 0u : Options.RateControlMode;
            SetCodecValue(Mf.CodecRateControlMode, rateControl, "CODECAPI_AVEncCommonRateControlMode=" + rateControl);
            SetCodecValue(Mf.CodecMeanBitRate, (uint)BitrateBps, "CODECAPI_AVEncCommonMeanBitRate");
            SetCodecValue(Mf.CodecLowLatencyMode, true, "CODECAPI_AVLowLatencyMode");
            SetCodecValue(Mf.CodecBPictureCount, 0u, "CODECAPI_AVEncMPVDefaultBPictureCount=0");
            SetCodecValue(Mf.CodecGopSize, (uint)Math.Min(FramesPerSecond * 60, 0xFFFF), "CODECAPI_AVEncMPVGOPSize");
            if (minimal) log.Add("optional codec settings skipped (retry)");
            else SetCodecValue(Mf.CodecQualityVsSpeed, (uint)QualityVsSpeed, "CODECAPI_AVEncCommonQualityVsSpeed=" + QualityVsSpeed);
            if (!minimal && VbvBufferBits > 0) SetCodecValue(Mf.CodecBufferSize, (uint)VbvBufferBits, "CODECAPI_AVEncCommonBufferSize=" + VbvBufferBits);
            foreach (var (api, value, name) in new[] { (Mf.CodecQuality, Options.Quality, "AVEncCommonQuality"), (Mf.CodecMaxBitRate, Options.MaxBitrate, "AVEncCommonMaxBitRate"),
                (Mf.CodecMinQp, Options.MinQp, "AVEncVideoMinQP"), (Mf.CodecMaxQp, Options.MaxQp, "AVEncVideoMaxQP"),
                (Mf.CodecGradualIntraRefresh, Options.GradualIntraRefresh, "AVEncVideoGradualIntraRefresh") })
                if (minimal || value is not uint v) continue;
                // W8h: the Microsoft software MFT accepts GradualIntraRefresh, then faults (integer divide by zero) in ProcessInput.
                else if (!IsHardware && api == Mf.CodecGradualIntraRefresh) log.Add($"CODECAPI_{name}={v}: skipped on the software MFT (faults in ProcessInput)");
                else SetCodecValue(api, v, $"CODECAPI_{name}={v}");
        }
        else log.Add("ICodecAPI: not exposed");

        var output = Mf.CreateMediaType();
        try
        {
            var a = (Mf.IMFAttributes)output;
            Mf.Check(a.SetGUID(Mf.MajorType, Mf.MediaTypeVideo), "major type");
            Mf.Check(a.SetGUID(Mf.SubType, Mf.VideoFormatH264), "subtype");
            Mf.Check(a.SetUINT32(Mf.AvgBitrate, (uint)BitrateBps), "MF_MT_AVG_BITRATE");
            SetVideoGeometry(a);
            Mf.Check(a.SetUINT32(Mf.Mpeg2Profile, 77), "MF_MT_MPEG2_PROFILE=Main");
            SetColour(a, "output");
            Mf.Check(t.SetOutputType(outputStream, output, 0), "SetOutputType(H.264 Main)");
        }
        finally { Mf.Release(output); }

        var input = Mf.CreateMediaType();
        try
        {
            var a = (Mf.IMFAttributes)input;
            Mf.Check(a.SetGUID(Mf.MajorType, Mf.MediaTypeVideo), "major type");
            Mf.Check(a.SetGUID(Mf.SubType, inputSubtype), "subtype");
            SetVideoGeometry(a);
            Mf.Check(a.SetUINT32(Mf.DefaultStride, (uint)(inputSubtype == Mf.VideoFormatNv12 ? EncodedWidth : EncodedWidth * 4)), "MF_MT_DEFAULT_STRIDE");
            SetColour(a, "input");
            Mf.Check(t.SetInputType(inputStream, input, 0), inputSubtype == Mf.VideoFormatNv12 ? "SetInputType(NV12)" : "SetInputType(ARGB32)");
        }
        finally { Mf.Release(input); }

        ReadOutputStreamInfo(t);
        Mf.Check(t.ProcessMessage(Mf.MessageNotifyBeginStreaming, IntPtr.Zero), "MFT_MESSAGE_NOTIFY_BEGIN_STREAMING");
        Mf.Check(t.ProcessMessage(Mf.MessageNotifyStartOfStream, IntPtr.Zero), "MFT_MESSAGE_NOTIFY_START_OF_STREAM");
        if (IsHardware)
        {
            var generator = (Mf.IMFMediaEventGenerator)t;
            events = generator;
            eventQueue = new BlockingCollection<(uint, int)>();
            eventThread = new Thread(EventLoop) { IsBackground = true, Name = "Orbit H.264 MFT events" };
            eventThread.Start((generator, eventQueue));
        }
    }

    [SupportedOSPlatform("windows")]
    private void SetVideoGeometry(Mf.IMFAttributes a)
    {
        Mf.Check(a.SetUINT64(Mf.FrameSize, ((ulong)(uint)EncodedWidth << 32) | (uint)EncodedHeight), "MF_MT_FRAME_SIZE");
        Mf.Check(a.SetUINT64(Mf.FrameRate, ((ulong)(uint)FramesPerSecond << 32) | 1u), "MF_MT_FRAME_RATE");
        Mf.Check(a.SetUINT64(Mf.PixelAspectRatio, (1ul << 32) | 1u), "MF_MT_PIXEL_ASPECT_RATIO");
        Mf.Check(a.SetUINT32(Mf.InterlaceMode, 2), "MF_MT_INTERLACE_MODE=Progressive");
    }

    /// <summary>Describes the NV12 this class produces: BT.709 matrix, primaries and transfer, limited (16-235) range.</summary>
    [SupportedOSPlatform("windows")]
    private void SetColour(Mf.IMFAttributes a, string which)
    {
        Log(which + " MF_MT_YUV_MATRIX=BT709", a.SetUINT32(Mf.YuvMatrix, 1));
        Log(which + " MF_MT_VIDEO_NOMINAL_RANGE=16_235", a.SetUINT32(Mf.NominalRange, 2));
        Log(which + " MF_MT_VIDEO_PRIMARIES=BT709", a.SetUINT32(Mf.VideoPrimaries, 2));
        Log(which + " MF_MT_TRANSFER_FUNCTION=709", a.SetUINT32(Mf.TransferFunction, 5));
    }

    [SupportedOSPlatform("windows")]
    private void ReadOutputStreamInfo(Mf.IMFTransform t)
    {
        t.GetOutputStreamInfo(outputStream, out var info);
        mftProvidesSamples = (info.Flags & (Mf.OutputStreamProvidesSamples | Mf.OutputStreamCanProvideSamples)) != 0;
        var size = (int)Math.Max(info.Size, (uint)(EncodedWidth * EncodedHeight * 3 / 2));
        if (!mftProvidesSamples && (outputSample is null || size > outputBufferSize))
        {
            Mf.Release(outputSample); Mf.Release(outputBuffer); outputSample = null; outputBuffer = null;
            var buffer = Mf.CreateMemoryBuffer(size);
            var sample = Mf.CreateSample();
            sample.AddBuffer(buffer);
            outputBuffer = buffer; outputSample = sample; outputBufferSize = size;
        }
        log.Add($"output stream: flags=0x{info.Flags:X}, cbSize={info.Size}, mftProvidesSamples={mftProvidesSamples}");
    }

    /// <summary>
    /// Encodes one top-down BGRA frame (stride = width*4). Returns the access unit(s) the encoder produced for it,
    /// which can be empty while the MFT is still buffering (see <see cref="H264EncodedFrame.PendingFrames"/>).
    /// </summary>
    [SupportedOSPlatform("windows")]
    public H264EncodedFrame Encode(ReadOnlyMemory<byte> bgra, long timestamp100ns, bool forceKeyframe)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (bgra.Length != checked(Width * Height * 4)) throw new ArgumentException("Invalid pixel buffer.", nameof(bgra));
            var started = Stopwatch.GetTimestamp();
            ConvertBgraToNv12(bgra, Width, Height, nv12, EncodedWidth, EncodedHeight);
            var convertMs = Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            Mf.IMFSample sample; var pooled = false;
            try { sample = GetInputSample(timestamp100ns, out pooled); }
            catch (COMException ex) { throw new PlatformUnavailableException("encode-failed", "The Media Foundation H.264 encoder failed: 0x" + ex.HResult.ToString("X8")); }
            return Submit(sample, pooled, timestamp100ns, forceKeyframe, started, convertMs);
        }
    }

    /// <summary>Runs one input sample through the MFT and builds the result. Caller holds the lock; the sample is released unless pooled.</summary>
    [SupportedOSPlatform("windows")]
    private H264EncodedFrame Submit(Mf.IMFSample sample, bool pooled, long timestamp100ns, bool forceKeyframe, long started, double convertMs)
    {
        var units = new List<(byte[] Data, long Time)>(1);
        inputTimes.Enqueue(timestamp100ns); // outputs take input timestamps in order (no B-frames)
        try
        {
            if (forceKeyframe) SetCodecValue(Mf.CodecForceKeyFrame, 1u, null);
            submittingKeyframe = forceKeyframe || inputs == 0;
            var t = (Mf.IMFTransform)transform!;
            if (events is null) SubmitSync(t, sample, units); else SubmitAsync(t, sample, units);
        }
        catch (COMException ex)
        {
            throw new PlatformUnavailableException("encode-failed", "The Media Foundation H.264 encoder failed: 0x" + ex.HResult.ToString("X8"));
        }
        finally { if (!pooled) Mf.Release(sample); }
        inputs++;
        outputs += units.Count;
        var data = units.Count switch { 0 => [], 1 => units[0].Data, _ => units.SelectMany(u => u.Data).ToArray() };
        var keyframe = units.Count > 0 && ContainsNal(data, 5);
        return new H264EncodedFrame(data, keyframe, units.Count > 0 ? units[0].Time : timestamp100ns,
            Stopwatch.GetElapsedTime(started).TotalMilliseconds, convertMs, units.Count, (int)(inputs - outputs))
        {
            Units = units.Select(u => new H264AccessUnit(u.Data, ContainsNal(u.Data, 5), u.Time)).ToList(),
        };
    }

    /// <summary>
    /// Drains the MFT (MFT_MESSAGE_COMMAND_DRAIN) and returns every access unit it still held, for stream end or
    /// reconfiguration. Encoders may buffer (<see cref="PendingFrames"/> &gt; 0: the Qualcomm MFT holds the first input);
    /// encoding may continue afterwards.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public IReadOnlyList<H264AccessUnit> Flush()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var units = new List<(byte[] Data, long Time)>();
            var t = (Mf.IMFTransform)transform!;
            try
            {
                Mf.Check(t.ProcessMessage(Mf.MessageCommandDrain, IntPtr.Zero), "MFT_MESSAGE_COMMAND_DRAIN");
                if (events is null) DrainSync(t, units);
                else
                {
                    drainComplete = false;
                    var deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * AsyncInputTimeoutMs / 1000;
                    while (!drainComplete && NextEvent(t, units, deadline)) { }
                    if (!drainComplete) throw new TimeoutException("The hardware encoder did not finish draining.");
                }
                // A drained MFT starts a new stream before it takes input again (the Qualcomm MFT refused input otherwise).
                Log("MFT_MESSAGE_NOTIFY_START_OF_STREAM (after drain)", t.ProcessMessage(Mf.MessageNotifyStartOfStream, IntPtr.Zero));
            }
            catch (COMException ex) { throw new PlatformUnavailableException("encode-failed", "The Media Foundation H.264 encoder failed to drain: 0x" + ex.HResult.ToString("X8")); }
            outputs += units.Count;
            if (inputs == outputs) inputTimes.Clear();
            return units.Select(u => new H264AccessUnit(u.Data, ContainsNal(u.Data, 5), u.Time)).ToList();
        }
    }

    /// <summary>Changes the target bitrate while streaming. Returns false when the codec refuses a runtime change.</summary>
    [SupportedOSPlatform("windows")]
    public bool SetBitrate(int bitrateBps)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var bitrate = ClampBitrate(bitrateBps);
            if (codecApi is null) return false;
            var ok = SetCodecValue(Mf.CodecMeanBitRate, (uint)bitrate, "runtime CODECAPI_AVEncCommonMeanBitRate=" + bitrate);
            if (ok) BitrateBps = bitrate;
            // Keep the hardware default buffer at a quarter second of the new bitrate (best effort; logged).
            if (ok && IsHardware && Options.VbvBufferBits is null && SetCodecValue(Mf.CodecBufferSize, (uint)(bitrate / 4), "runtime CODECAPI_AVEncCommonBufferSize=" + bitrate / 4))
                VbvBufferBits = bitrate / 4;
            return ok;
        }
    }

    /// <summary>
    /// Sets one ICodecAPI property between frames (for example a temporary QP cap for an idle refine frame).
    /// Returns false when the codec refuses it. The change is logged in <see cref="ConfigurationLog"/>.
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal bool TrySetControl(Guid api, object value, string label)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return SetCodecValue(api, value, "runtime " + label);
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (!OperatingSystem.IsWindows()) return;
            try { (transform as Mf.IMFTransform)?.ProcessMessage(Mf.MessageNotifyEndStreaming, IntPtr.Zero); } catch (COMException) { }
            var shutDown = false;
            if (eventThread is not null)
            {
                // Shutting the MFT down makes the event thread's blocking GetEvent return MF_E_SHUTDOWN.
                if (transform is Mf.IMFShutdown mftShutdown) { try { shutDown = mftShutdown.Shutdown() >= 0; } catch (COMException) { } }
                if (!shutDown && activate is Mf.IMFActivate first) { try { first.ShutdownObject(); shutDown = true; } catch (COMException) { } }
                if (!eventThread.Join(EventThreadJoinMs))
                {
                    // Never release COM objects that a blocked thread may still be using; leak them instead.
                    log.Add("event thread did not stop; MFT left unreleased");
                    return;
                }
                eventQueue?.Dispose();
                eventThread = null; eventQueue = null;
            }
            if (activate is Mf.IMFActivate a) { try { a.ShutdownObject(); } catch (COMException) { } }
            // codecApi and events are casts of the transform's RCW, so only the transform itself is released.
            foreach (var slot in inputRing) if (slot is { } s) { Mf.Release(s.Sample); Mf.Release(s.Buffer); }
            Array.Clear(inputRing);
            Mf.Release(outputSample); Mf.Release(outputBuffer); Mf.Release(transform); Mf.Release(activate);
            outputSample = outputBuffer = events = codecApi = transform = activate = null;
            if (d3dManager != IntPtr.Zero) { Marshal.Release(d3dManager); d3dManager = IntPtr.Zero; } // AddRef'd in CreateForTextures
            Mf.Runtime.Release();
        }
    }

    /// <summary>
    /// Returns an input sample holding the current NV12 frame. While no frame is pending (every earlier input already
    /// produced its access unit, so the MFT no longer needs those pixels) one of three pooled samples is reused; this
    /// avoids allocating and page-faulting a multi-megabyte buffer per frame. Otherwise a fresh sample is created.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private Mf.IMFSample GetInputSample(long timestamp100ns, out bool pooled)
    {
        pooled = inputs - outputs <= 1; // the ring slot reused here held the input three submissions ago
        Mf.IMFSample sample; Mf.IMFMediaBuffer buffer;
        if (pooled && inputRing[ringNext] is { } slot) { sample = (Mf.IMFSample)slot.Sample; buffer = (Mf.IMFMediaBuffer)slot.Buffer; }
        else
        {
            buffer = Mf.CreateMemoryBuffer(nv12.Length);
            try { sample = Mf.CreateSample(); sample.AddBuffer(buffer); }
            catch { Mf.Release(buffer); throw; }
            if (pooled) inputRing[ringNext] = (sample, buffer);
        }
        if (pooled) ringNext = (ringNext + 1) % inputRing.Length;
        try
        {
            buffer.Lock(out var pointer, out _, out _);
            try { Marshal.Copy(nv12, 0, pointer, nv12.Length); }
            finally { buffer.Unlock(); }
            buffer.SetCurrentLength((uint)nv12.Length);
            sample.SetSampleTime(timestamp100ns);
            sample.SetSampleDuration(10_000_000L / FramesPerSecond);
            return sample;
        }
        finally { if (!pooled) Mf.Release(buffer); } // the sample keeps its own reference to the buffer
    }

    [SupportedOSPlatform("windows")]
    private void SubmitSync(Mf.IMFTransform t, Mf.IMFSample sample, List<(byte[], long)> units)
    {
        var hr = t.ProcessInput(inputStream, sample, 0);
        if (hr == Mf.NotAccepting) { DrainSync(t, units); hr = t.ProcessInput(inputStream, sample, 0); }
        Mf.Check(hr, "ProcessInput");
        DrainSync(t, units);
    }

    [SupportedOSPlatform("windows")]
    private void DrainSync(Mf.IMFTransform t, List<(byte[], long)> units)
    {
        for (var i = 0; i < 64; i++)
        {
            var hr = ProcessOneOutput(t, units);
            if (hr == Mf.TransformNeedMoreInput) return;
            if (hr == Mf.TransformStreamChange) continue;
            Mf.Check(hr, "ProcessOutput");
        }
        throw new InvalidOperationException("The H.264 encoder produced output without end.");
    }

    /// <summary>
    /// Async MFT protocol (Microsoft Learn, "Asynchronous MFTs"): ProcessInput only after METransformNeedInput,
    /// ProcessOutput only after METransformHaveOutput. The events come from <see cref="EventLoop"/>; this thread blocks
    /// on the queue (no spinning) and makes every MFT data call itself.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private void SubmitAsync(Mf.IMFTransform t, Mf.IMFSample sample, List<(byte[], long)> units)
    {
        var deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * AsyncInputTimeoutMs / 1000;
        while (needInput == 0)
            if (!NextEvent(t, units, deadline)) throw new TimeoutException("The hardware encoder never requested input.");
        var hr = t.ProcessInput(inputStream, sample, 0);
        if (hr == Mf.NotAccepting)
        {
            // Our count of METransformNeedInput was stale (requests issued before a drain): wait for a fresh request, retry once.
            needInput = 0;
            while (needInput == 0)
                if (!NextEvent(t, units, deadline)) throw new TimeoutException("The hardware encoder never requested input after refusing it.");
            hr = t.ProcessInput(inputStream, sample, 0);
        }
        Mf.Check(hr, "ProcessInput");
        needInput--;
        // Low-latency mode should return this frame's access unit before it asks for more input. Wait up to two frame
        // intervals (at least 50 ms) for it; anything later is reported through PendingFrames.
        var waitMs = Math.Max(50, 2000 / FramesPerSecond);
        deadline = Stopwatch.GetTimestamp() + Stopwatch.Frequency * waitMs / 1000;
        var expected = OutputsToAwait(inputs - outputs, pipelineDepth);
        var waitStarted = Stopwatch.GetTimestamp();
        while (units.Count < expected && NextEvent(t, units, deadline)) { }
        NoteOutputWait(Stopwatch.GetElapsedTime(waitStarted).TotalMilliseconds);
        while (NextEvent(t, units, 0)) { }
    }

    /// <summary>
    /// Outputs to wait for after submitting one input with <paramref name="pending"/> pictures already inside the MFT.
    /// Never more than one: the Qualcomm MFT on Windows on ARM settles holding two pictures, and waiting to drain that
    /// backlog made every submit sit out the 50 ms timeout (~50 ms a frame instead of ~17). Taking the oldest picture
    /// as soon as it is ready keeps the MFT's own latency without adding a timeout per frame.
    /// </summary>
    internal static int OutputsToAwait(long pending, int pipelineDepth) => (int)Math.Clamp(pending + 1 - pipelineDepth, 0, 1);

    /// <summary>Checks only: one frame in flight from the start, on any encoder (the decision normally needs a slow MFT).</summary>
    internal void ForcePipeliningForChecks() { lock (gate) { PipeliningAllowed = true; pipelineDepth = 1; } }
    /// <summary>Checks only: feeds one measured output wait into the pipelining decision.</summary>
    internal void ObserveOutputWaitForChecks(double milliseconds, bool keyframe) { lock (gate) { submittingKeyframe = keyframe; NoteOutputWait(milliseconds); } }

    private void NoteOutputWait(double milliseconds)
    {
        if (pipelineDepth > 0 || !PipeliningAllowed) return;
        // Startup encodes and keyframes are slow on every MFT; judging them engaged pipelining on a healthy Qualcomm MFT.
        if (++submissions <= PipelineWarmup || submittingKeyframe) return;
        outputWaits[outputWaitCount++ % outputWaits.Length] = milliseconds;
        if (outputWaitCount < outputWaits.Length) return;
        var median = outputWaits.Order().ElementAt(outputWaits.Length / 2);
        if (median <= 1100.0 / FramesPerSecond) return; // only when the MFT cannot hold the frame rate: costs one frame of latency
        pipelineDepth = 1;
        log.Add($"pipelining: one frame in flight (median output wait {median:0.0} ms at {FramesPerSecond} fps)");
    }

    /// <summary>Blocks until one event is handled or <paramref name="deadline"/> passes; 0 means do not wait.</summary>
    [SupportedOSPlatform("windows")]
    private bool NextEvent(Mf.IMFTransform t, List<(byte[], long)> units, long deadline)
    {
        var remaining = deadline == 0 ? 0 : (int)Math.Max(0, (deadline - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency);
        if (!eventQueue!.TryTake(out var evt, remaining)) return false;
        if (evt.Type == 0) throw new COMException("The hardware encoder's event queue stopped", evt.Status);
        Mf.Check(evt.Status, "MFT event " + evt.Type);
        if (evt.Type == Mf.TransformNeedInput) needInput++;
        else if (evt.Type == Mf.TransformDrainComplete) drainComplete = true;
        else if (evt.Type == Mf.TransformHaveOutput)
        {
            var outHr = ProcessOneOutput(t, units);
            if (outHr != Mf.TransformStreamChange) Mf.Check(outHr, "ProcessOutput");
        }
        return true;
    }

    /// <summary>
    /// Dedicated thread: blocks in IMFMediaEventGenerator::GetEvent (flags 0) and forwards each event's type and status.
    /// It ends when GetEvent fails, which Dispose causes by shutting the MFT down (MF_E_SHUTDOWN).
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void EventLoop(object? state)
    {
        var (generator, queue) = ((Mf.IMFMediaEventGenerator, BlockingCollection<(uint, int)>))state!;
        try
        {
            while (true)
            {
                var hr = generator.GetEvent(0, out var evt);
                if (hr < 0) { queue.Add((0u, hr)); return; }
                try
                {
                    evt!.GetEventType(out var type);
                    evt.GetStatus(out var status);
                    queue.Add((type, status));
                }
                finally { Mf.Release(evt); }
            }
        }
        catch (Exception ex) when (ex is COMException or InvalidComObjectException)
        {
            queue.Add((0u, ex.HResult));
        }
        finally { queue.CompleteAdding(); }
    }

    /// <summary>Runs a read-only ICodecAPI query under the encoder lock (capability probe). Returns default when there is no ICodecAPI.</summary>
    [SupportedOSPlatform("windows")]
    internal T? QueryCodecApi<T>(Func<Mf.ICodecAPI, T> query)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return codecApi is Mf.ICodecAPI codec ? query(codec) : default;
        }
    }

    /// <summary>True while the async event thread runs (hardware encoders only). For checks.</summary>
    internal bool EventThreadAlive => eventThread?.IsAlive == true;

    [SupportedOSPlatform("windows")]
    private int ProcessOneOutput(Mf.IMFTransform t, List<(byte[], long)> units)
    {
        var buffer = new Mf.OutputDataBuffer { StreamId = outputStream };
        var given = IntPtr.Zero;
        if (!mftProvidesSamples)
        {
            ((Mf.IMFMediaBuffer)outputBuffer!).SetCurrentLength(0);
            given = Marshal.GetComInterfaceForObject<Mf.IMFSample, Mf.IMFSample>((Mf.IMFSample)outputSample!);
            buffer.Sample = given;
        }
        int hr;
        try { hr = t.ProcessOutput(0, 1, ref buffer, out _); }
        finally
        {
            if (given != IntPtr.Zero) Marshal.Release(given);
            if (buffer.Events != IntPtr.Zero) Marshal.Release(buffer.Events);
        }
        Mf.IMFSample? produced = null;
        if (mftProvidesSamples && buffer.Sample != IntPtr.Zero)
        {
            produced = (Mf.IMFSample)Marshal.GetObjectForIUnknown(buffer.Sample);
            Marshal.Release(buffer.Sample);
        }
        try
        {
            if (hr == Mf.TransformStreamChange)
            {
                Mf.Check(t.GetOutputAvailableType(outputStream, 0, out var type), "GetOutputAvailableType");
                try { Mf.Check(t.SetOutputType(outputStream, type, 0), "SetOutputType after stream change"); }
                finally { Mf.Release(type); }
                ReadOutputStreamInfo(t);
                return hr;
            }
            if (hr != 0) return hr;
            var sample = produced ?? (Mf.IMFSample)outputSample!;
            var data = Mf.ReadSample(sample);
            var time = sample.GetSampleTime(out var sampleTime) == 0 ? sampleTime : 0;
            foreach (var au in data.Length > 0 ? SplitAccessUnits(data) : [])
                units.Add((NormalizeAccessUnit(au, t), inputTimes.Count > 0 ? inputTimes.Dequeue() : time));
            return 0;
        }
        finally { Mf.Release(produced); }
    }

    /// <summary>Caches SPS/PPS and makes sure every IDR access unit carries them (after an access unit delimiter, if any).</summary>
    [SupportedOSPlatform("windows")]
    private byte[] NormalizeAccessUnit(byte[] au, Mf.IMFTransform t)
    {
        var nals = EnumerateNalUnits(au);
        var sps = nals.FirstOrDefault(n => n.Type == 7); var pps = nals.FirstOrDefault(n => n.Type == 8);
        if (sps.Length > 0 && pps.Length > 0)
        {
            parameterSets = [.. WithStartCode(au.AsSpan(sps.Offset, sps.Length)), .. WithStartCode(au.AsSpan(pps.Offset, pps.Length))];
        }
        if (nals.Any(n => n.Type == 5) && (sps.Length == 0 || pps.Length == 0))
        {
            parameterSets ??= ReadSequenceHeader(t);
            if (parameterSets is not null)
            {
                var insertAt = nals.Count > 0 && nals[0].Type == 9 ? nals.Count > 1 ? nals[1].StartCodeOffset : au.Length : 0;
                au = [.. au.AsSpan(0, insertAt), .. parameterSets, .. au.AsSpan(insertAt)];
                nals = EnumerateNalUnits(au);
            }
        }
        if (CodecString is null)
        {
            var first = nals.FirstOrDefault(n => n.Type == 7);
            if (first.Length >= 4) CodecString = CodecStringFromSps(au.AsSpan(first.Offset, first.Length));
        }
        return au;
    }

    [SupportedOSPlatform("windows")]
    private byte[]? ReadSequenceHeader(Mf.IMFTransform t)
    {
        if (t.GetOutputCurrentType(outputStream, out var type) != 0 || type is null) return null;
        try
        {
            var a = (Mf.IMFAttributes)type;
            if (a.GetBlobSize(Mf.MpegSequenceHeader, out var size) != 0 || size == 0) return null;
            var blob = new byte[size];
            if (a.GetBlob(Mf.MpegSequenceHeader, blob, size, out var actual) != 0) return null;
            log.Add("SPS/PPS taken from MF_MT_MPEG_SEQUENCE_HEADER");
            return blob.AsSpan(0, (int)actual).ToArray();
        }
        finally { Mf.Release(type); }
    }

    private static byte[] WithStartCode(ReadOnlySpan<byte> nal) => [0, 0, 0, 1, .. nal];

    [SupportedOSPlatform("windows")]
    private bool SetCodecValue(Guid api, object value, string? label)
    {
        if (codecApi is not Mf.ICodecAPI codec) return false;
        var key = api;
        var hr = codec.SetValue(ref key, ref value);
        if (label is not null) Log(label, hr);
        return hr >= 0;
    }

    private void Log(string label, int hr) => log.Add($"{label}: {(hr >= 0 ? "ok" : "0x" + hr.ToString("X8"))}");

    [SupportedOSPlatform("windows")]
    private static bool Probe()
    {
        var started = false; object? encoder = null;
        try
        {
            Mf.Runtime.AddRef(); started = true;
            encoder = Mf.CreateSoftwareEncoder();
            return true;
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or DllNotFoundException or EntryPointNotFoundException
            or TypeLoadException or NotSupportedException or PlatformNotSupportedException) { return false; }
        finally { Mf.Release(encoder); if (started) Mf.Runtime.Release(); }
    }
}
