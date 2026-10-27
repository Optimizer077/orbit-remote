using System.Globalization;
using System.Runtime.Versioning;
using Orbit.Host.Platform;
using Mf = Orbit.Host.Platform.MfH264Encoder.Mf;

/// <summary>
/// W8h text-sharpness spike (synthetic only). 1080p at 30 fps: frames 0-29 type on text card A (frame 0 is the IDR),
/// frame 30 jumps to card B (half a page further) and the screen then stays still to frame 90. Every frame is decoded
/// with the Windows H.264 decoder and compared with the encoder's own NV12 input (luma PSNR). Variants cover QP caps,
/// VBR modes, an idle refine frame and gradual intra refresh.
/// </summary>
internal static class TextSharpnessSpike
{
    private const int Width = 1920, Height = 1080, Fps = 30, Change = 30, Frames = 91;
    private const long Tick = 10_000_000 / Fps;

    /// <summary>A refine hook: called before frame <c>Change + RefineAfter</c>; returns the action that restores normal coding after it.</summary>
    internal sealed record Variant(string Name, H264EncoderOptions? Options = null, int RefineAfter = 0, Func<MfH264Encoder, Action<MfH264Encoder>>? Refine = null);

    [SupportedOSPlatform("windows")]
    internal static IReadOnlyList<Variant> DefaultVariants(int bitrate)
    {
        static Func<MfH264Encoder, Action<MfH264Encoder>> Cap(Guid api, object low, object restore, string name) =>
            e => { e.TrySetControl(api, low, $"{name}={low}"); return x => x.TrySetControl(api, restore, $"{name}={restore}"); };
        const ulong qp = 18;
        return
        [
            new("baseline (path defaults, CBR)"),
            new("MaxQP 30", new H264EncoderOptions { MaxQp = 30 }),
            new("MaxQP 26", new H264EncoderOptions { MaxQp = 26 }),
            new("PeakConstrainedVBR 4/8 Mbit/s", new H264EncoderOptions { RateControlMode = 1, MaxBitrate = (uint)bitrate * 2 }),
            new("UnconstrainedVBR", new H264EncoderOptions { RateControlMode = 2 }),
            new("Quality mode q=70", new H264EncoderOptions { RateControlMode = 3, Quality = 70 }),
            new("LowDelayVBR", new H264EncoderOptions { RateControlMode = 4 }),
            new("idle refine: EncodeQP 18 at +3", RefineAfter: 3, Refine: Cap(Mf.CodecEncodeQp, qp, 26ul, "AVEncVideoEncodeQP")),
            new("idle refine: FrameTypeQP 18 at +3", RefineAfter: 3, Refine: Cap(Mf.CodecEncodeFrameTypeQp, qp | qp << 16 | qp << 32, 26ul | 26ul << 16 | 26ul << 32, "AVEncVideoEncodeFrameTypeQP")),
            new("idle refine: MaxQP 18 at +3", RefineAfter: 3, Refine: Cap(Mf.CodecMaxQp, 18u, 51u, "AVEncVideoMaxQP")),
            new("idle refine: MaxQP 22 at +3", RefineAfter: 3, Refine: Cap(Mf.CodecMaxQp, 22u, 51u, "AVEncVideoMaxQP")),
            new("GradualIntraRefresh 1", new H264EncoderOptions { GradualIntraRefresh = 1 }),
            new("GradualIntraRefresh 2", new H264EncoderOptions { GradualIntraRefresh = 2 }),
        ];
    }

    [SupportedOSPlatform("windows")]
    internal static void Measure(TextWriter output, IReadOnlyList<Variant>? variants = null, H264EncoderPath[]? paths = null, int bitrate = 4_000_000)
    {
        output.WriteLine($"Text card, {Width}x{Height} @ {Fps} fps, target {bitrate / 1e6:0.#} Mbit/s; change at frame {Change}, still afterwards. " +
            "PSNR = decoded luma vs encoder input. 'max frame' = its transmit time at the target rate. Peak 1 s excludes the join IDR (frame 0).");
        output.WriteLine("| encoder | variant | applied | IDR KB | IDR PSNR | change KB | +0 | +3 | +5 | +15 | +30 | KB +0..+30 | max frame (ms at target) | peak 1 s / target | encode ms median | refine/change ms |");
        output.WriteLine("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
        var cardA = new H264EncoderChecks.SyntheticSource(Width, Height, photo: false);
        var basis = JpegEncoderChecks.TextLike(Width, Height * 2);
        var cardB = new byte[Width * Height * 4];
        Buffer.BlockCopy(basis, Height / 2 * Width * 4, cardB, 0, cardB.Length);
        foreach (var path in paths ?? [H264EncoderPath.Hardware, H264EncoderPath.Software])
            foreach (var variant in variants ?? DefaultVariants(bitrate))
                Run(output, path, variant, bitrate, cardA, cardB);
    }

    /// <summary>Bitrate guard for QP caps: 90 video-like frames (moving colour field + noise). A QP cap can override CBR here.</summary>
    [SupportedOSPlatform("windows")]
    internal static void MeasureVideoGuard(TextWriter output, int bitrate = 4_000_000)
    {
        output.WriteLine("| encoder | variant | achieved Mbit/s | peak 1 s / target | max frame (ms at target) | median frame KB |");
        output.WriteLine("|---|---|---|---|---|---|");
        foreach (var path in new[] { H264EncoderPath.Hardware, H264EncoderPath.Software })
            foreach (var (name, options) in new (string, H264EncoderOptions?)[] { ("baseline", null), ("MaxQP 30", new() { MaxQp = 30 }), ("MaxQP 26", new() { MaxQp = 26 }) })
            {
                using var encoder = MfH264Encoder.Create(Width, Height, Fps, bitrate, out var reason, path, options);
                if (encoder is null) { output.WriteLine($"| {path} | {name} | create failed: {reason} |"); continue; }
                var source = new H264EncoderChecks.SyntheticSource(Width, Height, photo: true);
                var sizes = Enumerable.Range(0, Frames).Select(i => (long)encoder.Encode(source.Next(i), i * Tick, false).Data.Length).Skip(1).ToArray();
                var peak = Enumerable.Range(0, sizes.Length - Fps + 1).Max(s => sizes.Skip(s).Take(Fps).Sum());
                output.WriteLine($"| {(encoder.IsHardware ? "hw" : "sw")} | {name} | {sizes.Sum() * 8.0 / (sizes.Length / (double)Fps) / 1e6:0.00} | {peak * 8.0 / bitrate:0.00} | " +
                    $"{sizes.Max() * 8 * 1000.0 / bitrate:0} | {sizes.Order().ElementAt(sizes.Length / 2) / 1024.0:0.0} |");
            }
    }

    [SupportedOSPlatform("windows")]
    private static void Run(TextWriter output, H264EncoderPath path, Variant variant, int bitrate, H264EncoderChecks.SyntheticSource cardA, byte[] cardB)
    {
        using var encoder = MfH264Encoder.Create(Width, Height, Fps, bitrate, out var reason, path, variant.Options);
        var tag = path == H264EncoderPath.Hardware ? "hw" : "sw";
        if (encoder is null) { output.WriteLine($"| {tag} | {variant.Name} | create failed: {reason} |"); return; }
        var sources = new Dictionary<long, byte[]>();
        var frames = new List<H264EncodedFrame>();
        var refineFrame = variant.Refine is null ? -1 : Change + variant.RefineAfter;
        Action<MfH264Encoder>? restore = null;
        for (var i = 0; i < Frames; i++)
        {
            var bgra = i < Change ? cardA.Next(i) : cardB;
            var nv12 = new byte[Width * Height * 3 / 2];
            MfH264Encoder.ConvertBgraToNv12(bgra, Width, Height, nv12, Width, Height);
            sources[i * Tick] = nv12;
            if (i == refineFrame) restore = variant.Refine!(encoder);
            var frame = encoder.Encode(bgra, i * Tick, false);
            if (restore is not null) { restore(encoder); restore = null; }
            if (!frame.IsEmpty) frames.Add(frame);
        }
        var psnr = new Dictionary<long, double>();
        using (var decoder = new H264EncoderChecks.MfDecoder(Width, Height))
        {
            var decoded = new List<byte[]>();
            foreach (var f in frames) decoded.AddRange(decoder.Decode(f.Data, f.Timestamp100ns));
            decoded.AddRange(decoder.Drain());
            for (var i = 0; i < Math.Min(decoded.Count, frames.Count); i++)
                psnr[frames[i].Timestamp100ns] = H264EncoderChecks.LumaPsnr(sources[frames[i].Timestamp100ns], decoded[i], Width, Height, decoder.FrameWidth);
        }
        H264EncodedFrame? At(int index) => frames.FirstOrDefault(f => f.Timestamp100ns == index * Tick);
        string P(int index) => psnr.TryGetValue(index * Tick, out var v) ? v.ToString("0.0", CultureInfo.InvariantCulture) : "-";
        string Kb(long bytes) => (bytes / 1024.0).ToString("0.0", CultureInfo.InvariantCulture);
        var after = frames.Where(f => f.Timestamp100ns >= Change * Tick && f.Timestamp100ns <= (Change + 30) * Tick).Sum(f => (long)f.Data.Length);
        var sizes = Enumerable.Range(1, Frames - 1).Select(i => (long)(At(i)?.Data.Length ?? 0)).ToArray();
        var peakWindow = Enumerable.Range(0, sizes.Length - Fps + 1).Max(start => sizes.Skip(start).Take(Fps).Sum());
        var maxFrame = sizes.Max();
        var encodeMs = frames.Select(f => f.EncodeMilliseconds).Order().ToList();
        var special = At(refineFrame >= 0 ? refineFrame : Change);
        // Codec settings the MFT refused (colour attributes, stream info and NVIDIA's known B-frame refusal excluded).
        var applied = encoder.ConfigurationLog.Where(l => !l.EndsWith(": ok", StringComparison.Ordinal) && !l.Contains("MF_", StringComparison.Ordinal)
            && !l.StartsWith("output stream", StringComparison.Ordinal) && !l.Contains("BPictureCount", StringComparison.Ordinal)).ToList();
        var appliedText = applied.Count == 0 ? "yes" : "REFUSED: " + string.Join("; ", applied.Select(l => l.Replace("CODECAPI_", "", StringComparison.Ordinal)).Distinct());
        output.WriteLine($"| {tag} | {variant.Name} | {appliedText} | {Kb(frames[0].Data.Length)} | {P(0)} | {Kb(At(Change)?.Data.Length ?? 0)} | {P(Change)} | {P(Change + 3)} | {P(Change + 5)} | " +
            $"{P(Change + 15)} | {P(Change + 30)} | {Kb(after)} | {maxFrame * 8 * 1000.0 / bitrate:0} | {peakWindow * 8.0 / bitrate:0.00} | " +
            $"{encodeMs[encodeMs.Count / 2]:0.00} | {special?.EncodeMilliseconds:0.00} |");
    }
}
