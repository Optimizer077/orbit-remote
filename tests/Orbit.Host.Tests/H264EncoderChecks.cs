using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Orbit.Host.Platform;
using Mf = Orbit.Host.Platform.MfH264Encoder.Mf;

/// <summary>
/// D11 spike checks for the Media Foundation H.264 encoder. Synthetic frames only: never captures, reads, stores or
/// posts the real screen. Decoded output is compared against the encoder's own synthetic input.
/// </summary>
public static class H264EncoderChecks
{
    private const long FrameTicks30 = 10_000_000 / 30;

    public static void Run(Action<bool, string> check)
    {
        RunPortable(check);
        if (!OperatingSystem.IsWindows())
        {
            check(!MfH264Encoder.IsSupported, "MF H.264 encoder reports unsupported off Windows");
            return;
        }
        check(MfH264Encoder.IsSupported, "MF H.264 encoder is supported on Windows");
        if (MfH264Encoder.IsSupported) RunWindows(check);
    }

    /// <summary>Standalone entry so the checks can run without the full harness. Returns a process exit code.</summary>
    public static int RunStandalone(TextWriter? output = null)
    {
        var total = 0; var failed = 0;
        Run((ok, message) =>
        {
            total++; if (!ok) failed++;
            output?.WriteLine((ok ? "PASS  " : "FAIL  ") + message);
        });
        output?.WriteLine($"{total - failed}/{total} H.264 encoder checks passed");
        return failed == 0 ? 0 : 1;
    }

    /// <summary>Pure managed parts (NV12 conversion, NAL and SPS parsing) that run on every OS.</summary>
    private static void RunPortable(Action<bool, string> check)
    {
        // An MFT that holds pictures (Qualcomm: two) is never waited on for more than one output per submit.
        check(MfH264Encoder.OutputsToAwait(0, 0) == 1 && MfH264Encoder.OutputsToAwait(1, 0) == 1 && MfH264Encoder.OutputsToAwait(2, 0) == 1
            && MfH264Encoder.OutputsToAwait(0, 1) == 0 && MfH264Encoder.OutputsToAwait(1, 1) == 1 && MfH264Encoder.OutputsToAwait(2, 1) == 1,
            "Encoder waits for at most one output per submit, whatever the MFT holds (no 50 ms timeout with a 2-picture backlog)");
        var nv12 = new byte[2 * 2 * 3 / 2];
        void Solid(byte b, byte g, byte r) => MfH264Encoder.ConvertBgraToNv12(Enumerable.Range(0, 16).Select(i => (i % 4) switch { 0 => b, 1 => g, 2 => r, _ => (byte)255 }).ToArray(), 2, 2, nv12, 2, 2);
        bool Near(int value, int expected) => Math.Abs(value - expected) <= 1;
        Solid(255, 255, 255); check(Near(nv12[0], 235) && Near(nv12[4], 128) && Near(nv12[5], 128), $"NV12: white is Y235 U128 V128 (got {nv12[0]} {nv12[4]} {nv12[5]})");
        Solid(0, 0, 0); check(Near(nv12[0], 16) && Near(nv12[4], 128) && Near(nv12[5], 128), $"NV12: black is Y16 U128 V128 (got {nv12[0]} {nv12[4]} {nv12[5]})");
        Solid(0, 0, 255); check(Near(nv12[0], 63) && Near(nv12[4], 102) && Near(nv12[5], 240), $"NV12: BT.709 red is Y63 U102 V240 (got {nv12[0]} {nv12[4]} {nv12[5]})");
        Solid(255, 0, 0); check(Near(nv12[0], 32) && Near(nv12[4], 240) && Near(nv12[5], 118), $"NV12: BT.709 blue is Y32 U240 V118, BGRA order honoured (got {nv12[0]} {nv12[4]} {nv12[5]})");

        // Odd source: 3x3 pads to 4x4 by replicating the last column and row.
        var odd = new byte[3 * 3 * 4];
        for (var i = 0; i < 9; i++) { var v = (byte)(i % 3 == 2 || i / 3 == 2 ? 255 : 0); odd[i * 4] = odd[i * 4 + 1] = odd[i * 4 + 2] = v; }
        var padded = new byte[4 * 4 * 3 / 2];
        MfH264Encoder.ConvertBgraToNv12(odd, 3, 3, padded, 4, 4);
        check(padded[3] == padded[2] && padded[3 * 4 + 0] == padded[2 * 4 + 0] && padded[3] >= 234, "NV12: odd 3x3 source pads to 4x4 by edge replication");

        // The banded (parallel) conversion must equal converting each row pair on its own.
        const int bigWidth = 1001, bigHeight = 777;
        var big = JpegEncoderChecks.PhotoLike(bigWidth, bigHeight, 3);
        var parallel = new byte[1002 * 778 * 3 / 2];
        MfH264Encoder.ConvertBgraToNv12(big, bigWidth, bigHeight, parallel, 1002, 778, maxBands: 8);
        var pairOk = true; var pairNv12 = new byte[1002 * 2 * 3 / 2];
        for (var pair = 0; pair < 778 / 2; pair++)
        {
            var rows = Math.Min(2, bigHeight - pair * 2);
            MfH264Encoder.ConvertBgraToNv12(big.AsMemory(pair * 2 * bigWidth * 4, rows * bigWidth * 4), bigWidth, rows, pairNv12, 1002, 2, maxBands: 1);
            pairOk &= pairNv12.AsSpan(0, 2004).SequenceEqual(parallel.AsSpan(pair * 2 * 1002, 2004))
                && pairNv12.AsSpan(2004, 1002).SequenceEqual(parallel.AsSpan(1002 * 778 + pair * 1002, 1002));
        }
        check(pairOk, "NV12: banded parallel conversion equals per-row-pair conversion (1001x777, odd)");

        // Every vector path must be bit-identical to the scalar reference, including odd widths and the right-edge tail.
        // Vector128 is the Windows-on-ARM (NEON) path; forcing it on x64 runs the same code on SSE.
        foreach (var (vw, vh) in new[] { (1920, 1080), (1001, 777), (17, 5), (33, 34) })
        {
            var frame = JpegEncoderChecks.PhotoLike(vw, vh, 11);
            int ew = vw + (vw & 1), eh = vh + (vh & 1);
            var scalar = new byte[ew * eh * 3 / 2];
            MfH264Encoder.ConvertBgraToNv12(frame, vw, vh, scalar, ew, eh, maxBands: 1, kernel: Nv12Kernel.Scalar);
            foreach (var kernel in new[] { Nv12Kernel.Vector128, Nv12Kernel.Vector256, Nv12Kernel.Auto })
            {
                var output = new byte[scalar.Length];
                MfH264Encoder.ConvertBgraToNv12(frame, vw, vh, output, ew, eh, kernel: kernel);
                check(output.AsSpan().SequenceEqual(scalar), $"NV12: {kernel} conversion equals scalar reference at {vw}x{vh} (Auto = {MfH264Encoder.AutoKernel})");
            }
        }

        byte[] stream = [0, 0, 0, 1, 0x67, 0x4D, 0x40, 0x28, 0, 0, 1, 0x68, 0xEE, 0, 0, 0, 1, 0x65, 0x88, 0x84];
        var nals = MfH264Encoder.EnumerateNalUnits(stream);
        check(nals.Select(n => n.Type).SequenceEqual([7, 8, 5]) && nals[0].Length == 4 && nals[1].StartCodeOffset == 8 && nals[2].Length == 3,
            "Annex-B parser splits 3- and 4-byte start codes");
        check(MfH264Encoder.CodecStringFromSps(stream.AsSpan(4, 4)) == "avc1.4D4028", "Codec string is avc1 + profile/constraints/level hex");

        // Access-unit split (Qualcomm MFT: one sample with IDR+SPS/PPS and the next picture, NAL types 9,7,8,5,9,1).
        byte[] withAud = [0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x67, 0x4D, 0x40, 0x28, 0, 0, 0, 1, 0x68, 0xEE, 0, 0, 0, 1, 0x65, 0x88, 0x84,
            0, 0, 0, 1, 0x09, 0x30, 0, 0, 0, 1, 0x41, 0x9A, 0x02];
        var split = MfH264Encoder.SplitAccessUnits(withAud);
        check(split.Count == 2 && split[0].Length == 27 && MfH264Encoder.ContainsNal(split[0], 5) && MfH264Encoder.ContainsNal(split[1], 1) && !MfH264Encoder.ContainsNal(split[1], 5),
            $"Access-unit split at delimiters: IDR+SPS/PPS and the next P-picture become 2 units ({split.Count})");
        byte[] noAud = [0, 0, 0, 1, 0x67, 0x4D, 0x40, 0x28, 0, 0, 0, 1, 0x68, 0xEE, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0, 0, 0, 1, 0x41, 0x9A, 0x02, 0, 0, 0, 1, 0x41, 0x9B, 0x02];
        check(MfH264Encoder.SplitAccessUnits(noAud).Count == 3, "Access-unit split without delimiters: each slice with first_mb_in_slice 0 starts a picture");
        byte[] twoSlices = [0, 0, 0, 1, 0x65, 0x88, 0x84, 0, 0, 0, 1, 0x65, 0x40, 0x84]; // second slice: first_mb_in_slice != 0
        check(MfH264Encoder.SplitAccessUnits(twoSlices).Count == 1, "Access-unit split keeps the slices of one picture together");
        check(MfH264Encoder.SplitAccessUnits(stream).Count == 1, "Access-unit split leaves a single picture unchanged");
    }

    [SupportedOSPlatform("windows")]
    private static void RunWindows(Action<bool, string> check)
    {
        check(MfH264Encoder.Create(0, 360, 30, 2_000_000, out var reason, H264EncoderPath.Software) is null && reason.Length > 0, "Zero width is refused with a reason");
        check(MfH264Encoder.Create(640, 360, 0, 2_000_000, out reason, H264EncoderPath.Software) is null && reason.Length > 0, "Zero frame rate is refused with a reason");
        check(MfH264Encoder.Create(9000, 360, 30, 2_000_000, out reason, H264EncoderPath.Software) is null, "Over-limit width is refused");

        CheckRefusedSettings(check, H264EncoderPath.Software);
        CheckRefusedSettings(check, H264EncoderPath.Hardware);
        RunPath(check, H264EncoderPath.Software);
        using var probe = MfH264Encoder.Create(640, 360, 30, 2_000_000, out reason, H264EncoderPath.Hardware);
        if (probe is null) check(true, "No hardware H.264 MFT opened (reported, not a failure): " + reason);
        else
        {
            check(probe.IsHardware, "Hardware path opened: " + probe.EncoderName);
            probe.Dispose();
            RunPath(check, H264EncoderPath.Hardware);
            CheckPipelining(check);
            CheckPipeliningWarmup(check);
        }
        check(MfH264Encoder.Create(640, 360, 30, 2_000_000, out reason, H264EncoderPath.Software, new H264EncoderOptions { VbvBufferBits = -1 }) is null, "Negative VBV buffer size is refused");
        check(MfH264Encoder.Create(640, 360, 30, 2_000_000, out reason, H264EncoderPath.Software, new H264EncoderOptions { QualityVsSpeed = 101 }) is null, "Quality-vs-speed above 100 is refused");
        var adapters = EncoderCapabilities.ProbeD3D12VideoEncode(out reason);
        check(adapters is not null && reason.Length == 0, $"D3D12 Video Encode probe runs ({adapters?.Count ?? 0} hardware adapters) {reason}");
        using (var auto = MfH264Encoder.Create(640, 360, 30, 2_000_000, out reason))
            check(auto is not null, $"Auto path opens an encoder ({auto?.EncoderName ?? reason})");
    }

    /// <summary>
    /// One frame in flight (forced here; automatic on a slow MFT such as Qualcomm's): every input still comes out exactly
    /// once, in order, with at most one picture plus the MFT's own startup hold outstanding, and Flush returns the rest.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void CheckPipelining(Action<bool, string> check)
    {
        using var encoder = MfH264Encoder.Create(640, 360, 30, 2_000_000, out var reason, H264EncoderPath.Hardware);
        if (encoder is null) { check(true, "Pipelining check skipped: " + reason); return; }
        encoder.ForcePipeliningForChecks();
        var source = new SyntheticSource(640, 360, photo: false);
        var times = new List<long>(); var maxPending = 0; var lagging = 0;
        for (var i = 0; i < 12; i++)
        {
            var frame = encoder.Encode(source.Next(i), i * FrameTicks30, i == 0);
            times.AddRange(frame.Units.Select(u => u.Timestamp100ns));
            maxPending = Math.Max(maxPending, frame.PendingFrames); if (frame.PendingFrames > 0) lagging++;
        }
        times.AddRange(encoder.Flush().Select(u => u.Timestamp100ns));
        check(encoder.PipelineDepth == 1 && times.Count == 12 && times.SequenceEqual(Enumerable.Range(0, 12).Select(i => i * FrameTicks30)) && maxPending <= 2,
            $"Pipelining: 12 inputs give 12 pictures in order (max {maxPending} pending, {lagging} of 12 returned one behind, {encoder.EncoderName})");
    }

    /// <summary>Slow startup encodes and keyframes never engage pipelining; slow steady-state output waits still do.</summary>
    [SupportedOSPlatform("windows")]
    private static void CheckPipeliningWarmup(Action<bool, string> check)
    {
        using var encoder = MfH264Encoder.Create(640, 360, 30, 2_000_000, out var reason, H264EncoderPath.Hardware);
        if (encoder is null) { check(true, "Pipelining warm-up check skipped: " + reason); return; }
        for (var i = 0; i < MfH264Encoder.PipelineWarmup; i++) encoder.ObserveOutputWaitForChecks(60, keyframe: false);
        var afterWarmup = encoder.PipelineDepth;
        for (var i = 0; i < 20; i++) encoder.ObserveOutputWaitForChecks(60, keyframe: true);
        var afterKeyframes = encoder.PipelineDepth;
        for (var i = 0; i < 8; i++) encoder.ObserveOutputWaitForChecks(60, keyframe: false);
        check(afterWarmup == 0 && afterKeyframes == 0 && encoder.PipelineDepth == 1,
            $"Pipelining: {MfH264Encoder.PipelineWarmup} slow warm-up waits and slow keyframes do not engage it; 8 slow steady waits do (60 ms at 30 fps)");
    }

    /// <summary>
    /// Vendor neutrality (ARM: Qualcomm/Adreno MFTs): a property the MFT refuses is logged and skipped, never fatal.
    /// MaxQP 99 is out of range everywhere; LowDelayVBR is refused by the software MFT (W8h).
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void CheckRefusedSettings(Action<bool, string> check, H264EncoderPath path)
    {
        var options = new H264EncoderOptions { MaxQp = 99, QualityVsSpeed = 33, VbvBufferBits = 500_000, RateControlMode = path == H264EncoderPath.Software ? 4u : 0u };
        using var encoder = MfH264Encoder.Create(640, 360, 30, 2_000_000, out var reason, path, options);
        if (encoder is null && path == H264EncoderPath.Hardware) { check(true, "No hardware MFT for the refused-settings check (reported): " + reason); return; }
        var refused = encoder?.ConfigurationLog.Where(l => l.StartsWith("CODECAPI_", StringComparison.Ordinal) && !l.EndsWith(": ok", StringComparison.Ordinal)).ToList() ?? [];
        var produced = new List<H264AccessUnit>();
        if (encoder is not null)
        {
            var source = new SyntheticSource(640, 360, photo: false);
            for (var i = 0; i < 3; i++) produced.AddRange(encoder.Encode(source.Next(i), i * FrameTicks30, false).Units); // may buffer at start
            produced.AddRange(encoder.Flush());
        }
        var retried = encoder?.ConfigurationLog.FirstOrDefault(l => l.StartsWith("retried without optional settings", StringComparison.Ordinal));
        if (retried is not null) refused.Add(retried);
        check(encoder is not null && (retried is not null || refused.Any(l => l.Contains("MaxQP=99", StringComparison.Ordinal))) && produced.Count == 3 && produced[0].IsKeyframe,
            $"[{path}] refused settings are logged and skipped; the encoder still opens and encodes ({(encoder is null ? "create failed: " + reason : string.Join("; ", refused))})");
    }

    [SupportedOSPlatform("windows")]
    private static void RunPath(Action<bool, string> check, H264EncoderPath path)
    {
        var tag = path == H264EncoderPath.Hardware ? "[hw] " : "[sw] ";
        const int width = 640, height = 360, frames = 40, forcedAt = 25;
        var encoder = MfH264Encoder.Create(width, height, 30, 2_000_000, out var reason, path);
        check(encoder is not null, tag + "encoder opens at 640x360: " + reason);
        if (encoder is null) return;
        var source = new SyntheticSource(width, height, photo: false);
        var outputs = new List<H264AccessUnit>();
        var inputsNv12 = new List<byte[]>();
        var maxPending = 0; var firstOutputAt = -1;
        for (var i = 0; i < frames; i++)
        {
            var bgra = source.Next(i);
            var nv12 = new byte[width * height * 3 / 2];
            MfH264Encoder.ConvertBgraToNv12(bgra, width, height, nv12, width, height);
            inputsNv12.Add(nv12);
            var frame = encoder.Encode(bgra, i * FrameTicks30, forceKeyframe: i == forcedAt);
            maxPending = Math.Max(maxPending, frame.PendingFrames);
            if (frame.Units.Count > 0 && firstOutputAt < 0) firstOutputAt = i;
            outputs.AddRange(frame.Units);
        }
        // Bounded verification: encoders may buffer (the Qualcomm MFT holds its first input), so drain before counting.
        var flushed = encoder.Flush();
        outputs.AddRange(flushed);
        check(firstOutputAt is >= 0 and <= 2 && maxPending <= 2, $"{tag}output latency is bounded (first output at input {firstOutputAt}, max pending {maxPending}, {flushed.Count} drained by Flush)");
        check(outputs.Count == frames && encoder.PendingFrames == 0, $"{tag}exactly one access unit per input after Flush ({outputs.Count}/{frames})");
        check(outputs.All(u => MfH264Encoder.SplitAccessUnits(u.Data).Count == 1), tag + "every unit holds exactly one picture");
        if (outputs.Count == 0) { encoder.Dispose(); return; }

        var first = outputs[0];
        var types = MfH264Encoder.EnumerateNalUnits(first.Data).Select(n => n.Type).ToList();
        check(first.Data.Length > 4 && first.Data[0] == 0 && first.Data[1] == 0 && (first.Data[2] == 1 || first.Data[2] == 0 && first.Data[3] == 1),
            tag + "output is Annex-B (starts with a start code)");
        check(first.IsKeyframe && types.Contains(7) && types.Contains(8) && types.Contains(5), $"{tag}first frame is an IDR with SPS+PPS (NAL types {string.Join(",", types)})");
        var deltas = outputs.Skip(1).Where(o => !o.IsKeyframe).ToList();
        check(deltas.Count >= frames / 2 && deltas.All(d => MfH264Encoder.ContainsNal(d.Data, 1)), $"{tag}later frames are P-frames (non-IDR slices: {deltas.Count})");
        var keyframes = outputs.Where(o => o.IsKeyframe).ToList();
        check(keyframes.All(k => MfH264Encoder.ContainsNal(k.Data, 7) && MfH264Encoder.ContainsNal(k.Data, 8)), $"{tag}every keyframe carries SPS+PPS ({keyframes.Count} keyframes)");
        var forced = outputs.FirstOrDefault(o => o.Timestamp100ns == forcedAt * FrameTicks30);
        check(forced is not null && forced.IsKeyframe, $"{tag}forced keyframe at frame {forcedAt} is an IDR");
        check(keyframes.Count == 2, $"{tag}no unrequested keyframes inside the long GOP ({keyframes.Count} keyframes in {frames} frames)");
        check(outputs.Select(o => o.Timestamp100ns).SequenceEqual(outputs.Select((_, i) => (long)i * FrameTicks30)), tag + "every unit carries its own input timestamp, in order");

        var spsNal = MfH264Encoder.EnumerateNalUnits(first.Data).First(n => n.Type == 7);
        var sps = Sps.Parse(first.Data.AsSpan(spsNal.Offset, spsNal.Length));
        check(sps is not null && sps.Width == width && sps.Height == height, $"{tag}SPS codes {sps?.Width}x{sps?.Height} (profile {sps?.Profile}, level {sps?.Level}, VUI {sps?.ColorDescription ?? "none"})");
        check(encoder.CodecString is { Length: 11 } codec && codec.StartsWith("avc1.", StringComparison.Ordinal) && codec == MfH264Encoder.CodecStringFromSps(first.Data.AsSpan(spsNal.Offset, 4)),
            $"{tag}codec string from SPS: {encoder.CodecString}");

        // Round trip through the Windows H.264 decoder MFT: proves the stream decodes and the colours/geometry survive.
        using (var decoder = new MfDecoder(width, height))
        {
            var decoded = new List<byte[]>();
            foreach (var o in outputs) decoded.AddRange(decoder.Decode(o.Data, o.Timestamp100ns));
            decoded.AddRange(decoder.Drain());
            check(decoded.Count == outputs.Count, $"{tag}MF decoder returns every frame ({decoded.Count}/{outputs.Count}, decoded size {decoder.FrameWidth}x{decoder.FrameHeight})");
            if (decoded.Count > 0)
            {
                var index = decoded.Count - 1;
                var psnr = LumaPsnr(inputsNv12[index], decoded[^1], width, height, decoder.FrameWidth);
                check(psnr >= 30, $"{tag}decoded text-like frame matches its source (luma PSNR {psnr:0.0} dB at 2 Mbit/s)");
            }
        }

        check(encoder.IsHardware ? encoder.VbvBufferBits == 2_000_000 / 4 && encoder.QualityVsSpeed == 33
                && encoder.ConfigurationLog.Contains("CODECAPI_AVEncCommonBufferSize=500000: ok")
            : encoder.VbvBufferBits == 0 && encoder.QualityVsSpeed == 0 && !encoder.ConfigurationLog.Any(l => l.StartsWith("CODECAPI_AVEncCommonBufferSize", StringComparison.Ordinal)),
            $"{tag}path defaults: VBV {encoder.VbvBufferBits} bits, quality-vs-speed {encoder.QualityVsSpeed}");
        if (encoder.IsHardware)
            check(encoder.Options.MaxQp == 30 && encoder.ConfigurationLog.Contains("CODECAPI_AVEncVideoMaxQP=30: ok"), $"{tag}hardware default MaxQP is 30 and applied (W8h)");
        var properties = EncoderCapabilities.ProbeCodecApi(encoder);
        check(properties.Count == EncoderCapabilities.Properties.Count, $"{tag}ICodecAPI probe answers every property ({properties.Count})");
        check(properties.Any(p => p.Name == "AVEncCommonMeanBitRate" && p.Supported) && properties.Any(p => p.Name == "AVEncVideoForceKeyFrame" && p.Supported),
            tag + "probe reports the controls this encoder already uses (mean bitrate, force keyframe) as supported");

        var accepted = encoder.SetBitrate(1_000_000);
        var resumed = new List<H264AccessUnit>();
        for (var i = 0; i < 3; i++) resumed.AddRange(encoder.Encode(source.Next(frames + i), (frames + i) * FrameTicks30, false).Units);
        resumed.AddRange(encoder.Flush());
        check(resumed.Count == 3 && resumed.All(u => MfH264Encoder.SplitAccessUnits(u.Data).Count == 1),
            $"{tag}encoding resumes after Flush and SetBitrate: 3 inputs give {resumed.Count} units (runtime change accepted: {accepted})");
        check(Throws<ArgumentException>(() => encoder.Encode(new byte[10], 0, false)), tag + "short pixel buffer throws ArgumentException");
        check(Throws<ArgumentException>(() => encoder.Encode(new byte[width * height * 4 + 4], 0, false)), tag + "long pixel buffer throws ArgumentException");
        var threadWasAlive = encoder.EventThreadAlive;
        var disposeStarted = Stopwatch.GetTimestamp();
        encoder.Dispose();
        var disposeMs = Stopwatch.GetElapsedTime(disposeStarted).TotalMilliseconds;
        if (path == H264EncoderPath.Hardware)
            check(threadWasAlive && !encoder.EventThreadAlive && disposeMs < 1000 && !encoder.ConfigurationLog.Any(l => l.Contains("did not stop", StringComparison.Ordinal)),
                $"{tag}event thread ran while open and stopped on Dispose ({disposeMs:0} ms)");
        else check(!threadWasAlive, tag + "synchronous MFT uses no event thread");
        check(!Throws<Exception>(encoder.Dispose), tag + "Dispose is idempotent");
        check(Throws<ObjectDisposedException>(() => encoder.Encode(source.Next(0), 0, false)), tag + "Encode after Dispose throws ObjectDisposedException");

        // Odd dimensions: padded to even, coded size reports the padded size.
        using var odd = MfH264Encoder.Create(641, 361, 30, 1_000_000, out reason, path);
        check(odd is not null, $"{tag}odd 641x361 opens: {reason}");
        if (odd is not null)
        {
            var oddSource = new SyntheticSource(641, 361, photo: true);
            H264EncodedFrame? oddFrame = null;
            for (var i = 0; i < 3 && (oddFrame is null || oddFrame.IsEmpty); i++) oddFrame = odd.Encode(oddSource.Next(i), i * FrameTicks30, false);
            var nal = oddFrame is null ? default : MfH264Encoder.EnumerateNalUnits(oddFrame.Data).FirstOrDefault(n => n.Type == 7);
            var oddSps = nal.Length > 0 ? Sps.Parse(oddFrame!.Data.AsSpan(nal.Offset, nal.Length)) : null;
            check(odd.EncodedWidth == 642 && odd.EncodedHeight == 362 && oddSps?.Width == 642 && oddSps?.Height == 362,
                $"{tag}odd 641x361 is padded to 642x362 (SPS {oddSps?.Width}x{oddSps?.Height}); the viewer crops 1 px");
        }
    }

    /// <summary>
    /// Encodes 120 synthetic frames per configuration and prints a Markdown table: encode ms (median/p95, BGRA to NV12
    /// included), conversion ms, keyframe and delta bytes, latency in frames and the achieved bitrate.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static void Measure(TextWriter output, int frames = 120)
    {
        output.WriteLine("| encoder | size | content | target | encode ms median | p95 | max | convert ms median | MFT+copy ms median | key bytes | delta bytes median | delta p95 | latency frames | achieved Mbit/s |");
        output.WriteLine("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var path in new[] { H264EncoderPath.Software, H264EncoderPath.Hardware })
            foreach (var (w, h) in new[] { (1920, 1080), (3024, 1898) })
                foreach (var photo in new[] { false, true })
                    foreach (var bitrate in new[] { 4_000_000, 8_000_000 })
                    {
                        using var encoder = MfH264Encoder.Create(w, h, 30, bitrate, out var reason, path);
                        if (encoder is null) { output.WriteLine($"| {path} | {w}x{h} | - | - | unavailable: {reason} |"); continue; }
                        var source = new SyntheticSource(w, h, photo);
                        var encodeMs = new List<double>(); var convertMs = new List<double>();
                        var keyBytes = new List<int>(); var deltaBytes = new List<int>(); var maxPending = 0; long total = 0;
                        for (var i = 0; i < frames; i++)
                        {
                            var bgra = source.Next(i);
                            var started = Stopwatch.GetTimestamp();
                            var frame = encoder.Encode(bgra, i * FrameTicks30, false);
                            encodeMs.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
                            convertMs.Add(frame.ConvertMilliseconds);
                            maxPending = Math.Max(maxPending, frame.PendingFrames);
                            total += frame.Data.Length;
                            if (frame.IsEmpty) continue;
                            (frame.IsKeyframe ? keyBytes : deltaBytes).Add(frame.Data.Length);
                        }
                        var mbps = total * 8.0 / (frames / 30.0) / 1e6;
                        var name = encoder.IsHardware ? "hw: " + encoder.EncoderName : "sw: MS H.264";
                        output.WriteLine($"| {name} | {w}x{h} | {(photo ? "video-like" : "text-like")} | {bitrate / 1_000_000} Mbit/s | " +
                            $"{Percentile(encodeMs, 50):0.00} | {Percentile(encodeMs, 95):0.00} | {encodeMs.Max():0.00} | {Percentile(convertMs, 50):0.00} | " +
                            $"{Percentile(encodeMs.Zip(convertMs, (e, c) => e - c).ToList(), 50):0.00} | " +
                            $"{(keyBytes.Count > 0 ? keyBytes[0] : 0)} | {Percentile(deltaBytes.Select(x => (double)x).ToList(), 50):0} | " +
                            $"{Percentile(deltaBytes.Select(x => (double)x).ToList(), 95):0} | {maxPending} | {mbps:0.00} |");
                    }
    }

    /// <summary>
    /// Process CPU per frame over <paramref name="frames"/> text-like frames, from three passes: generate only (A),
    /// generate + BGRA-to-NV12 (C), generate + Encode (B). Conversion CPU = C - A, MFT/copy/wait CPU = B - C.
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal static void MeasureCpu(TextWriter output, H264EncoderPath path, int width, int height, int frames = 120, int bitrate = 4_000_000)
    {
        using var process = Process.GetCurrentProcess();
        TimeSpan Cpu() { process.Refresh(); return process.TotalProcessorTime; }
        using var encoder = MfH264Encoder.Create(width, height, 30, bitrate, out var reason, path);
        if (encoder is null) { output.WriteLine($"| {path} | {width}x{height} | unavailable: {reason} |"); return; }
        var source = new SyntheticSource(width, height, photo: false);
        var start = Cpu();
        for (var i = 0; i < frames; i++) source.Next(i);
        var generate = Cpu() - start;
        var nv12 = new byte[encoder.EncodedWidth * encoder.EncodedHeight * 3 / 2];
        source = new SyntheticSource(width, height, photo: false);
        start = Cpu();
        for (var i = 0; i < frames; i++) MfH264Encoder.ConvertBgraToNv12(source.Next(i), width, height, nv12, encoder.EncodedWidth, encoder.EncodedHeight);
        var convert = Cpu() - start;
        source = new SyntheticSource(width, height, photo: false);
        var wall = 0.0;
        start = Cpu();
        for (var i = 0; i < frames; i++)
        {
            var bgra = source.Next(i);
            var t0 = Stopwatch.GetTimestamp();
            encoder.Encode(bgra, i * FrameTicks30, false);
            wall += Stopwatch.GetElapsedTime(t0).TotalMilliseconds;
        }
        var encode = Cpu() - start;
        double PerFrame(TimeSpan t) => t.TotalMilliseconds / frames;
        output.WriteLine($"| {(encoder.IsHardware ? "hw: " + encoder.EncoderName : "sw: MS H.264")} | {width}x{height} | {wall / frames:0.00} | " +
            $"{PerFrame(encode - generate):0.00} | {PerFrame(convert - generate):0.00} | {PerFrame(encode - convert):0.00} |");
    }

    /// <summary>Prints the ICodecAPI property table for each encoder path and the D3D12 Video Encode table (report only).</summary>
    [SupportedOSPlatform("windows")]
    internal static void ReportCapabilities(TextWriter output)
    {
        foreach (var path in new[] { H264EncoderPath.Software, H264EncoderPath.Hardware })
        {
            using var encoder = MfH264Encoder.Create(1920, 1080, 30, 4_000_000, out var reason, path);
            if (encoder is null) { output.WriteLine($"{path}: unavailable: {reason}"); continue; }
            output.WriteLine($"\n### {encoder.EncoderName} (1920x1080, 30 fps, CBR 4 Mbit/s, low latency)\n");
            output.WriteLine("| property | supported | modifiable | current | default | range | values |");
            output.WriteLine("|---|---|---|---|---|---|---|");
            foreach (var p in EncoderCapabilities.ProbeCodecApi(encoder))
                output.WriteLine($"| {p.Name} | {(p.Supported ? "yes" : "no")} | {(p.Supported ? p.Modifiable ? "yes" : $"no (0x{p.ModifiableHr:X8})" : "")} | {p.Current} | {p.Default} | {p.Range} | {p.Values} |");
        }
        var adapters = EncoderCapabilities.ProbeD3D12VideoEncode(out var why);
        output.WriteLine("\n### D3D12 Video Encode (main profile; row-based intra refresh at the highest level)\n");
        if (adapters is null) { output.WriteLine("unavailable: " + why); return; }
        output.WriteLine("| adapter | codec | supported | max level | intra refresh (row-based) | rate control |");
        output.WriteLine("|---|---|---|---|---|---|");
        foreach (var adapter in adapters)
            foreach (var c in adapter.Codecs)
                output.WriteLine($"| {adapter.Adapter} (vendor 0x{adapter.VendorId:X4} device 0x{adapter.DeviceId:X4}, LUID 0x{adapter.Luid:X}) | {c.Codec} | {(c.Supported ? "yes" : "no")} | {c.MaxLevel} | " +
                    $"{(c.IntraRefreshRowBased is null ? "n/a" : c.IntraRefreshRowBased.Value ? "yes" : "no")} | {string.Join(", ", c.RateControlModes)} |");
        if (adapters.Count == 0 || adapters.All(a => a.Codecs.Count == 0)) output.WriteLine("(no adapter exposed ID3D12VideoDevice) " + why);
    }

    /// <summary>
    /// Keyframe-size cap: 1080p text-like, 4 Mbit/s, 60 frames with a forced IDR at frame 30, for several
    /// CODECAPI_AVEncCommonBufferSize values. Decodes each stream with the MF decoder and reports luma PSNR of the IDR
    /// and of the frames 5 and 15 after it, against the encoder's own NV12 input.
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal static void MeasureKeyframeCap(TextWriter output, int bitrate = 4_000_000, int[]? qualities = null, H264EncoderPath[]? paths = null)
    {
        const int width = 1920, height = 1080, frames = 60, forced = 30;
        output.WriteLine("| encoder | quality vs speed | VBV buffer | first IDR bytes | forced IDR bytes | IDR encode ms | IDR PSNR dB | +5 PSNR | +15 PSNR | delta bytes median | achieved Mbit/s |");
        output.WriteLine("|---|---|---|---|---|---|---|---|---|---|---|");
        foreach (var path in paths ?? [H264EncoderPath.Software, H264EncoderPath.Hardware])
            foreach (var quality in qualities ?? [0])
            foreach (var vbv in new[] { 0, bitrate, bitrate / 2, bitrate / 4, bitrate / 8 })
            {
                using var encoder = MfH264Encoder.Create(width, height, 30, bitrate, out var reason, path, new H264EncoderOptions { VbvBufferBits = vbv, QualityVsSpeed = quality });
                if (encoder is null) { output.WriteLine($"| {path} | {vbv} | unavailable: {reason} |"); continue; }
                var applied = vbv == 0 || encoder.ConfigurationLog.Any(l => l.StartsWith("CODECAPI_AVEncCommonBufferSize", StringComparison.Ordinal) && l.EndsWith(": ok", StringComparison.Ordinal));
                var source = new SyntheticSource(width, height, photo: false);
                var outputs = new List<H264EncodedFrame>(); var sources = new Dictionary<long, byte[]>();
                for (var i = 0; i < frames; i++)
                {
                    var bgra = source.Next(i);
                    var nv12 = new byte[width * height * 3 / 2];
                    MfH264Encoder.ConvertBgraToNv12(bgra, width, height, nv12, width, height);
                    sources[i * FrameTicks30] = nv12;
                    var frame = encoder.Encode(bgra, i * FrameTicks30, forceKeyframe: i == forced);
                    if (!frame.IsEmpty) outputs.Add(frame);
                }
                var psnr = new Dictionary<long, double>();
                using (var decoder = new MfDecoder(width, height))
                {
                    var decoded = new List<byte[]>();
                    foreach (var o in outputs) decoded.AddRange(decoder.Decode(o.Data, o.Timestamp100ns));
                    decoded.AddRange(decoder.Drain());
                    for (var i = 0; i < Math.Min(decoded.Count, outputs.Count); i++)
                        psnr[outputs[i].Timestamp100ns] = LumaPsnr(sources[outputs[i].Timestamp100ns], decoded[i], width, height, decoder.FrameWidth);
                }
                var forcedFrame = outputs.First(o => o.Timestamp100ns == forced * FrameTicks30);
                string P(int frame) => psnr.TryGetValue(frame * FrameTicks30, out var v) ? v.ToString("0.0", CultureInfo.InvariantCulture) : "-";
                var deltas = outputs.Where(o => !o.IsKeyframe).Select(o => (double)o.Data.Length).ToList();
                var mbps = outputs.Sum(o => (long)o.Data.Length) * 8.0 / (frames / 30.0) / 1e6;
                var label = vbv == 0 ? "encoder default" : $"{vbv / 1000} kbit ({(double)vbv / bitrate:0.###} s){(applied ? "" : " NOT APPLIED")}";
                output.WriteLine($"| {(encoder.IsHardware ? "hw" : "sw")} | {quality} | {label} | {outputs[0].Data.Length} | {forcedFrame.Data.Length} (key={forcedFrame.IsKeyframe}) | " +
                    $"{forcedFrame.EncodeMilliseconds:0.00} | {P(forced)} | {P(forced + 5)} | {P(forced + 15)} | {Percentile(deltas, 50):0} | {mbps:0.00} |");
            }
    }

    /// <summary>Writes a synthetic 1080p text-like Annex-B stream plus a JSON index for the viewer-side WebCodecs benchmark.</summary>
    [SupportedOSPlatform("windows")]
    internal static string? WriteSampleStream(string directory, TextWriter output, H264EncoderPath path = H264EncoderPath.Auto, int frames = 120, int bitrate = 4_000_000)
    {
        const int width = 1920, height = 1080, fps = 30;
        using var encoder = MfH264Encoder.Create(width, height, fps, bitrate, out var reason, path);
        if (encoder is null) { output.WriteLine("sample stream not written: " + reason); return null; }
        Directory.CreateDirectory(directory);
        var streamPath = Path.Combine(directory, "synthetic-1080p.h264");
        var source = new SyntheticSource(width, height, photo: false);
        var index = new List<object>();
        long offset = 0;
        using (var file = File.Create(streamPath))
        {
            for (var i = 0; i < frames; i++)
            {
                var frame = encoder.Encode(source.Next(i), i * (10_000_000L / fps), forceKeyframe: i == 60);
                if (frame.IsEmpty) continue;
                file.Write(frame.Data);
                index.Add(new { offset, length = frame.Data.Length, key = frame.IsKeyframe, timestampUs = frame.Timestamp100ns / 10 });
                offset += frame.Data.Length;
            }
        }
        var meta = new
        {
            file = "synthetic-1080p.h264", format = "annexb", width, height, fps, codec = encoder.CodecString, bitrateBps = bitrate,
            encoder = encoder.EncoderName, hardware = encoder.IsHardware, content = "synthetic text-like: typing caret frames 0-59, 4 px/frame scroll 60-119; forced IDR at frame 60",
            colour = "BT.709 limited range (NV12 converted on the host)", frames = index,
        };
        File.WriteAllText(Path.Combine(directory, "synthetic-1080p.json"), JsonSerializer.Serialize(meta, new JsonSerializerOptions { WriteIndented = true }));
        output.WriteLine($"sample stream: {streamPath} ({offset} bytes, {index.Count} access units, {encoder.CodecString}, {encoder.EncoderName})");
        return streamPath;
    }

    private static double Percentile(List<double> values, double percentile)
    {
        if (values.Count == 0) return 0;
        var sorted = values.Order().ToList();
        return sorted[(int)Math.Clamp(Math.Ceiling(percentile / 100 * sorted.Count) - 1, 0, sorted.Count - 1)];
    }

    internal static double LumaPsnr(byte[] source, byte[] decoded, int width, int height, int decodedStride)
    {
        double sum = 0;
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++) { var d = source[y * width + x] - decoded[y * decodedStride + x]; sum += d * d; }
        var mse = sum / (width * height);
        return mse == 0 ? 99 : 10 * Math.Log10(255.0 * 255.0 / mse);
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; } catch (Exception) { return false; }
    }

    /// <summary>
    /// Deterministic synthetic frames. Text-like: a document page with a blinking caret and new glyphs typed for 60 frames,
    /// then a 4 px/frame scroll. Video-like: a drifting smooth colour field with fresh per-frame sensor noise.
    /// One frame buffer is reused, which is safe because <see cref="MfH264Encoder.Encode"/> copies synchronously.
    /// </summary>
    internal sealed class SyntheticSource
    {
        private readonly int width, height; private readonly bool photo;
        private readonly byte[] basis; private readonly int basisWidth, basisHeight; private readonly byte[] frame;
        private uint noise = 0x9E3779B9;

        public SyntheticSource(int width, int height, bool photo)
        {
            this.width = width; this.height = height; this.photo = photo;
            basisWidth = photo ? width + 256 : width; basisHeight = photo ? height + 256 : height * 2;
            basis = photo ? JpegEncoderChecks.PhotoLike(basisWidth, basisHeight, 42) : JpegEncoderChecks.TextLike(basisWidth, basisHeight);
            frame = new byte[width * height * 4];
        }

        public byte[] Next(int index)
        {
            var stride = width * 4;
            if (photo)
            {
                var dx = index * 3 % 256; var dy = index * 2 % 256;
                for (var y = 0; y < height; y++) Buffer.BlockCopy(basis, ((y + dy) * basisWidth + dx) * 4, frame, y * stride, stride);
                for (var i = 0; i < frame.Length; i += 4)
                {
                    noise ^= noise << 13; noise ^= noise >> 17; noise ^= noise << 5;
                    var n = (int)(noise & 7) - 3;
                    frame[i] = (byte)Math.Clamp(frame[i] + n, 0, 255); frame[i + 1] = (byte)Math.Clamp(frame[i + 1] + n, 0, 255);
                }
                return frame;
            }
            var scroll = index < 60 ? 0 : (index - 60) * 4 % height;
            Buffer.BlockCopy(basis, scroll * stride, frame, 0, height * stride);
            if (index < 60)
            {
                // Typing on the 5th text line: glyph blocks appear left to right; a caret blinks every 8 frames.
                var lineTop = 4 * 16 + 3; var x0 = 8 + index * 7;
                for (var t = 0; t <= index && 8 + t * 7 + 6 < width; t++) Fill(8 + t * 7, lineTop, 5, 9, 20, 20, 20);
                if (index / 8 % 2 == 0 && x0 + 9 < width) Fill(x0 + 7, lineTop - 1, 2, 12, 0, 0, 0);
            }
            return frame;
        }

        private void Fill(int x, int y, int w, int h, byte b, byte g, byte r)
        {
            for (var row = y; row < Math.Min(height, y + h); row++)
                for (var col = x; col < Math.Min(width, x + w); col++)
                {
                    var i = (row * width + col) * 4; frame[i] = b; frame[i + 1] = g; frame[i + 2] = r;
                }
        }
    }

    /// <summary>Just enough of an H.264 SPS parser (7.3.2.1.1) to read coded size, profile, level and VUI colour.</summary>
    internal sealed record Sps(int Profile, int Level, int Width, int Height, string? ColorDescription)
    {
        public static Sps? Parse(ReadOnlySpan<byte> nal)
        {
            var rbsp = new List<byte>(nal.Length);
            for (var i = 1; i < nal.Length; i++)
            {
                if (i >= 3 && nal[i] == 3 && nal[i - 1] == 0 && nal[i - 2] == 0 && rbsp.Count >= 2 && rbsp[^1] == 0 && rbsp[^2] == 0) continue;
                rbsp.Add(nal[i]);
            }
            var r = new BitReader(rbsp.ToArray());
            try
            {
                var profile = r.Bits(8); r.Bits(8); var level = r.Bits(8); r.Ue();
                if (profile is 100 or 110 or 122 or 244 or 44 or 83 or 86 or 118 or 128 or 138 or 139 or 134 or 135)
                {
                    if (r.Ue() == 3) r.Bits(1);
                    r.Ue(); r.Ue(); r.Bits(1);
                    if (r.Bits(1) == 1) return null; // scaling matrices are not needed for this spike
                }
                r.Ue();
                var pocType = r.Ue();
                if (pocType == 0) r.Ue();
                else if (pocType == 1) { r.Bits(1); r.Se(); r.Se(); var n = r.Ue(); for (var i = 0; i < n; i++) r.Se(); }
                r.Ue(); r.Bits(1);
                var widthMbs = r.Ue() + 1; var heightUnits = r.Ue() + 1;
                var frameMbsOnly = r.Bits(1);
                if (frameMbsOnly == 0) r.Bits(1);
                r.Bits(1);
                int left = 0, right = 0, top = 0, bottom = 0;
                if (r.Bits(1) == 1) { left = r.Ue(); right = r.Ue(); top = r.Ue(); bottom = r.Ue(); }
                var heightFactor = 2 - frameMbsOnly;
                var width = widthMbs * 16 - 2 * (left + right);
                var height = heightFactor * heightUnits * 16 - 2 * heightFactor * (top + bottom);
                string? colour = null;
                if (r.Bits(1) == 1)
                {
                    if (r.Bits(1) == 1 && r.Bits(8) == 255) { r.Bits(16); r.Bits(16); }
                    if (r.Bits(1) == 1) r.Bits(1);
                    if (r.Bits(1) == 1)
                    {
                        r.Bits(3); var full = r.Bits(1);
                        colour = r.Bits(1) == 1 ? $"primaries {r.Bits(8)} transfer {r.Bits(8)} matrix {r.Bits(8)} full_range {full}" : $"no colour description, full_range {full}";
                    }
                    else colour = "VUI without video_signal_type";
                }
                return new Sps(profile, level, width, height, colour);
            }
            catch (IndexOutOfRangeException) { return null; }
        }

        private sealed class BitReader(byte[] data)
        {
            private int position;
            public int Bits(int count)
            {
                var value = 0;
                for (var i = 0; i < count; i++, position++) value = value << 1 | data[position >> 3] >> 7 - (position & 7) & 1;
                return value;
            }
            public int Ue() { var zeros = 0; while (Bits(1) == 0) zeros++; return (1 << zeros) - 1 + Bits(zeros); }
            public int Se() { var k = Ue(); return k % 2 == 1 ? (k + 1) / 2 : -(k / 2); }
        }
    }

    /// <summary>Test-only wrapper over the Microsoft H.264 decoder MFT (CLSID_CMSH264DecoderMFT), NV12 output, low latency.</summary>
    [SupportedOSPlatform("windows")]
    internal sealed class MfDecoder : IDisposable
    {
        private static readonly Guid DecoderClsid = new("62ce7e72-4c71-4d20-b15d-452831a87d9d");
        private object? transform; private object? sample; private object? buffer; private int bufferSize;
        public int FrameWidth { get; private set; }
        public int FrameHeight { get; private set; }

        public MfDecoder(int width, int height)
        {
            Mf.Runtime.AddRef();
            transform = Activator.CreateInstance(Type.GetTypeFromCLSID(DecoderClsid, throwOnError: true)!)!;
            var t = (Mf.IMFTransform)transform;
            if (t.GetAttributes(out var attributes) == 0 && attributes is not null)
            {
                attributes.SetUINT32(Mf.LowLatency, 1);
                Mf.Release(attributes);
            }
            var type = Mf.CreateMediaType();
            try
            {
                var a = (Mf.IMFAttributes)type;
                a.SetGUID(Mf.MajorType, Mf.MediaTypeVideo); a.SetGUID(Mf.SubType, Mf.VideoFormatH264);
                a.SetUINT64(Mf.FrameSize, (ulong)width << 32 | (uint)height);
                a.SetUINT64(Mf.FrameRate, 30ul << 32 | 1);
                Mf.Check(t.SetInputType(0, type, 0), "decoder SetInputType");
            }
            finally { Mf.Release(type); }
            SelectNv12Output(t);
            Mf.Check(t.ProcessMessage(Mf.MessageNotifyBeginStreaming, IntPtr.Zero), "decoder begin streaming");
        }

        private void SelectNv12Output(Mf.IMFTransform t)
        {
            for (uint i = 0; ; i++)
            {
                Mf.Check(t.GetOutputAvailableType(0, i, out var type), "decoder GetOutputAvailableType");
                try
                {
                    var a = (Mf.IMFAttributes)type!;
                    if (a.GetGUID(Mf.SubType, out var subtype) != 0 || subtype != Mf.VideoFormatNv12) continue;
                    Mf.Check(t.SetOutputType(0, type, 0), "decoder SetOutputType");
                    a.GetUINT64(Mf.FrameSize, out var size);
                    FrameWidth = (int)(size >> 32); FrameHeight = (int)(size & 0xFFFFFFFF);
                    t.GetOutputStreamInfo(0, out var info);
                    var needed = (int)Math.Max(info.Size, (uint)(FrameWidth * FrameHeight * 3 / 2));
                    if (buffer is null || needed > bufferSize)
                    {
                        Mf.Release(sample); Mf.Release(buffer);
                        var b = Mf.CreateMemoryBuffer(needed); var s = Mf.CreateSample(); s.AddBuffer(b);
                        buffer = b; sample = s; bufferSize = needed;
                    }
                    return;
                }
                finally { Mf.Release(type); }
            }
        }

        public List<byte[]> Decode(byte[] accessUnit, long timestamp)
        {
            var t = (Mf.IMFTransform)transform!;
            var input = Mf.CreateSample(); var data = Mf.CreateMemoryBuffer(accessUnit.Length);
            try
            {
                data.Lock(out var pointer, out _, out _); Marshal.Copy(accessUnit, 0, pointer, accessUnit.Length); data.Unlock();
                data.SetCurrentLength((uint)accessUnit.Length);
                input.AddBuffer(data); input.SetSampleTime(timestamp); input.SetSampleDuration(FrameTicks30);
                var frames = new List<byte[]>();
                var hr = t.ProcessInput(0, input, 0);
                if (hr == Mf.NotAccepting) { frames.AddRange(Pull(t)); hr = t.ProcessInput(0, input, 0); }
                Mf.Check(hr, "decoder ProcessInput");
                frames.AddRange(Pull(t));
                return frames;
            }
            finally { Mf.Release(data); Mf.Release(input); }
        }

        public List<byte[]> Drain()
        {
            var t = (Mf.IMFTransform)transform!;
            Mf.Check(t.ProcessMessage(Mf.MessageCommandDrain, IntPtr.Zero), "decoder drain");
            return Pull(t);
        }

        private List<byte[]> Pull(Mf.IMFTransform t)
        {
            var frames = new List<byte[]>();
            while (true)
            {
                ((Mf.IMFMediaBuffer)buffer!).SetCurrentLength(0);
                var pointer = Marshal.GetComInterfaceForObject<Mf.IMFSample, Mf.IMFSample>((Mf.IMFSample)sample!);
                var output = new Mf.OutputDataBuffer { StreamId = 0, Sample = pointer };
                int hr;
                try { hr = t.ProcessOutput(0, 1, ref output, out _); }
                finally { Marshal.Release(pointer); if (output.Events != IntPtr.Zero) Marshal.Release(output.Events); }
                if (hr == Mf.TransformNeedMoreInput) return frames;
                if (hr == Mf.TransformStreamChange) { SelectNv12Output(t); continue; }
                Mf.Check(hr, "decoder ProcessOutput");
                frames.Add(Mf.ReadSample((Mf.IMFSample)sample!));
            }
        }

        public void Dispose()
        {
            if (transform is null) return;
            Mf.Release(sample); Mf.Release(buffer); Mf.Release(transform);
            transform = sample = buffer = null;
            Mf.Runtime.Release();
        }
    }
}
