using System.Runtime.Versioning;
using Orbit.Host;
using Orbit.Host.Platform;
using Mf = Orbit.Host.Platform.MfH264Encoder.Mf;

/// <summary>
/// W8g/G2 checks for the shared GPU capture and its per-stream encoders. Synthetic images only (CreateSynthetic /
/// PushSynthetic): no desktop duplication, no screen pixels. Encodes are decoded with the Windows H.264 decoder and
/// compared with the CPU reference conversion; a pure-red patch checks matrix and range (BT.709 limited red is Y 63).
/// </summary>
public static class GpuPipelineChecks
{
    private const int Width = 1280, Height = 720;

    public static void Run(Action<bool, string> check)
    {
        RunPortable(check);
        if (!OperatingSystem.IsWindows() || !MfH264Encoder.IsSupported) { check(true, "GPU capture checks skipped (no Windows Media Foundation)"); return; }
        RunWindows(check);
    }

    public static int RunStandalone(TextWriter? output = null)
    {
        var total = 0; var failed = 0;
        Run((ok, message) => { total++; if (!ok) failed++; output?.WriteLine((ok ? "PASS  " : "FAIL  ") + message); });
        output?.WriteLine($"{total - failed}/{total} GPU capture checks passed");
        return failed == 0 ? 0 : 1;
    }

    /// <summary>Encoder-to-adapter selection with a fake enumeration (hybrid laptop: Intel iGPU + NVIDIA dGPU).</summary>
    private static void RunPortable(Action<bool, string> check)
    {
        if (!OperatingSystem.IsWindows()) return;
        string?[] hybrid = ["VEN_8086&DEV_A7A0", "VEN_10DE&DEV_2D04"];
        check(Mf.SelectForAdapter(hybrid, 0x10DE).SequenceEqual([1]), "LUID fallback: NVIDIA capture adapter picks only the NVIDIA MFT");
        check(Mf.SelectForAdapter(hybrid, 0x8086).SequenceEqual([0]), "LUID fallback: Intel capture adapter picks only the Intel MFT");
        check(Mf.SelectForAdapter(hybrid, 0x1002).Count == 0, "LUID fallback: an AMD adapter with only Intel/NVIDIA MFTs gets none (CPU path), never a foreign GPU");
        check(Mf.SelectForAdapter([null, ""], 0x5143).SequenceEqual([0, 1]), "LUID fallback: MFTs without a vendor id are all kept (cannot tell)");
        check(Mf.SelectForAdapter(["ven_5143&dev_0001"], 0x5143).SequenceEqual([0]), "LUID fallback: vendor match is case-insensitive (Qualcomm 0x5143)");
    }

    [SupportedOSPlatform("windows")]
    private static void RunWindows(Action<bool, string> check)
    {
        var image = Synthetic(Width, Height);
        using var capture = GpuMonitorCapture.CreateSynthetic(Width, Height, out var reason);
        check(capture is not null, "Synthetic GPU capture opens: " + reason);
        if (capture is null) return;
        check(capture.Generation.Length == 32 && capture.Generation.All(Uri.IsHexDigit), $"Generation is 128 random bits ({capture.Generation.Length} hex chars)");

        // Real enumeration: the capture adapter's LUID finds its MFT; a LUID no adapter has finds none (filter honoured).
        var byLuid = Mf.EnumerateRaw(capture.AdapterLuid); var bogus = Mf.EnumerateRaw(0x7FFF_0000_1234);
        check(byLuid.Count > 0 && bogus.Count == 0, $"MFTEnum2 with MFT_ENUM_ADAPTER_LUID: {byLuid.Count} MFT(s) on {capture.AdapterName}, {bogus.Count} for a bogus LUID");
        foreach (var c in byLuid.Concat(bogus)) Mf.Release(c.Activate);

        CheckLeases(check, capture, image);
        CheckReadback(check, capture, image);
        foreach (var (colour, w, h) in new[] { (GpuColourPath.RgbToEncoder, Width, Height), (GpuColourPath.VideoProcessor, Width, Height), (GpuColourPath.VideoProcessor, 640, 360) })
            CheckEncoder(check, capture, image, colour, w, h);
        CheckProducerDoesNotBlock(check, capture, image);
        CheckRecovery(check, capture, image);
    }

    /// <summary>codex-host-1 review: a producer blocked in AcquireNext must not hold the context gate.</summary>
    [SupportedOSPlatform("windows")]
    private static void CheckProducerDoesNotBlock(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        using var encoder = capture.CreateEncoder(0, 0, 30, 4_000_000, out _);
        using (var warm = capture.PushSynthetic(image)) encoder?.Encode(warm, true); // first-use costs out of the timing
        var other = image.ToArray(); other[0] ^= 0xFF;
        using var lease = capture.PushSynthetic(other); // new version, so ReadBgra really reads back
        var producer = Task.Run(() => capture.AcquireNext(600)); // a synthetic capture idles for the whole timeout
        Thread.Sleep(100);
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        using var newest = capture.Latest();
        var bytes = newest is null ? null : capture.ReadBgra(newest);
        var frame = newest is null ? null : encoder?.Encode(newest, false);
        var elapsed = System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        var stillBlocked = !producer.IsCompleted;
        producer.Wait();
        // The point is the gate split: consumers must not wait for the 600 ms producer wait. The absolute bound is
        // platform-aware (x64 10 ms; ARM64 20 ms: codex-arm-1 measured 12.4 ms on an Adreno X1-45).
        var limit = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? 20 : 10;
        check(bytes is not null && bytes[0] == other[0] && frame is not null && stillBlocked && elapsed < limit,
            $"While the producer waits 600 ms in AcquireNext, Latest + ReadBgra + an encode finish in {elapsed:0.0} ms (limit {limit} ms on {System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture})");
    }

    [SupportedOSPlatform("windows")]
    private static void CheckLeases(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        using var a = capture.PushSynthetic(image);
        using var b = capture.PushSynthetic(image);
        check(b.Version == a.Version + 1 && a.Generation == b.Generation && a.IsCurrent && b.FullFrame == false && a.Width == Width,
            $"Leases carry (generation, version): v{a.Version} then v{b.Version}, same generation");
        using (var newest = capture.Latest()) check(newest?.Version == b.Version, "Latest() is a new hold on the newest image");
        // Fill the pool: the capture holds the newest image, every other slot is leased here.
        var held = new List<GpuFrameLease>();
        try
        {
            for (var i = 0; i < GpuMonitorCapture.MaximumSlots; i++)
            {
                try { held.Add(capture.PushSynthetic(image)); }
                catch (PlatformUnavailableException ex) when (ex.Code == "capture-busy") { break; }
            }
            var busy = false;
            try { held.Add(capture.PushSynthetic(image)); } catch (PlatformUnavailableException ex) when (ex.Code == "capture-busy") { busy = true; }
            check(busy && capture.LiveTextureCount == GpuMonitorCapture.MaximumSlots, $"Pool is bounded: capture-busy when all {GpuMonitorCapture.MaximumSlots} textures are held");
            held[0].Dispose(); held.RemoveAt(0);
            using var again = capture.PushSynthetic(image);
            check(again.IsCurrent, "Releasing one lease frees a slot for the next image");
        }
        finally { foreach (var l in held) l.Dispose(); }
        var shared = b.Share();
        b.Dispose();
        check(shared.IsCurrent && !b.IsCurrent, "Share() is an independent hold; disposing the original does not end it");
        shared.Dispose();
        check(!Throws<Exception>(b.Dispose), "Lease Dispose is idempotent");
    }

    [SupportedOSPlatform("windows")]
    private static void CheckReadback(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        var before = capture.ReadbackCount;
        using var lease = capture.PushSynthetic(image);
        check(capture.ReadbackCount == before, "No CPU readback unless asked (pushes and leases do not read back)");
        var bytes = capture.ReadBgra(lease);
        check(bytes.AsSpan().SequenceEqual(image) && capture.ReadbackCount == before + 1, "ReadBgra returns the exact image through one staging readback");
        check(ReferenceEquals(capture.ReadBgra(lease), bytes) && capture.ReadbackCount == before + 1, "A second ReadBgra of the same version reuses the cached array (no second readback)");
        var other = image.ToArray(); Array.Reverse(other);
        using var next = capture.PushSynthetic(other);
        check(capture.ReadBgra(next).AsSpan().SequenceEqual(other) && capture.ReadbackCount == before + 2, "A new version is read back again");
        // The image path reads the lease it published, which need not be the newest image.
        check(capture.ReadBgra(lease).AsSpan().SequenceEqual(image) && lease.Version < capture.Version,
            $"ReadBgra works for any current lease, not only the newest (v{lease.Version} while the newest is v{capture.Version})");
    }

    [SupportedOSPlatform("windows")]
    private static void CheckEncoder(Action<bool, string> check, GpuMonitorCapture capture, byte[] image, GpuColourPath colour, int width, int height)
    {
        var tag = $"[{colour} {Width}x{Height}->{width}x{height}] ";
        using var encoder = capture.CreateEncoder(width, height, 30, 4_000_000, out var reason, colour);
        if (encoder is null) { check(colour == GpuColourPath.RgbToEncoder, tag + "encoder opens: " + reason); return; }
        check(encoder.Colour == colour && encoder.Generation == capture.Generation && encoder.Inner.IsHardware && encoder.Inner.UsesTextures,
            $"{tag}opens on {capture.AdapterName} with {encoder.EncoderName}");
        check(encoder.EncodeLast(false) is null && encoder.LastEncoded is null, tag + "EncodeLast before any Encode returns null");
        var before = capture.ReadbackCount;
        const int inputs = 8;
        var frames = new List<H264AccessUnit>(); var maxPending = 0;
        static long HostNow() => System.Diagnostics.Stopwatch.GetElapsedTime(0, System.Diagnostics.Stopwatch.GetTimestamp()).Ticks;
        var firstCall = HostNow();
        using (var lease = capture.PushSynthetic(image))
            for (var i = 0; i < 6; i++) { var f = encoder.Encode(lease, forceKeyframe: i == 0); frames.AddRange(f.Units); maxPending = Math.Max(maxPending, f.PendingFrames); }
        var lastCall = HostNow();
        var host = frames.Select(u => encoder.TimestampOrigin100ns + u.Timestamp100ns).ToList();
        check(host.Count > 0 && host.All(t => t >= firstCall && t <= lastCall) && host.Zip(host.Skip(1), (a, b) => a <= b).All(x => x),
            $"{tag}TimestampOrigin100ns + unit timestamp is host Stopwatch time at encode ({host.Count} units within the {(lastCall - firstCall) / 10_000.0:0.0} ms of Encode calls, in order)");
        for (var i = 0; i < 2; i++) { var f = encoder.EncodeLast(false)!; frames.AddRange(f.Units); maxPending = Math.Max(maxPending, f.PendingFrames); }
        check(encoder.LastEncoded?.Version == capture.Version, tag + "EncodeLast works after the caller disposed its lease (encoder keeps its own hold)");
        check(capture.ReadbackCount == before, tag + "encoding never reads back to the CPU");
        var drained = encoder.Flush();
        frames.AddRange(drained);
        check(frames.Count == inputs && maxPending <= 2 && frames.All(u => MfH264Encoder.SplitAccessUnits(u.Data).Count == 1),
            $"{tag}{inputs} inputs give {frames.Count} single-picture units (max pending {maxPending}, {drained.Count} drained by Flush)");
        if (frames.Count == 0) return;
        var resumed = new List<H264AccessUnit>();
        using (var again = capture.PushSynthetic(image))
            for (var i = 0; i < 2; i++) resumed.AddRange(encoder.Encode(again, false).Units);
        resumed.AddRange(encoder.Flush());
        check(resumed.Count == 2, $"{tag}encoding resumes after Flush: 2 inputs give {resumed.Count} units");
        var types = MfH264Encoder.EnumerateNalUnits(frames[0].Data).Select(n => n.Type).ToList();
        check(frames[0].IsKeyframe && types.Contains(7) && types.Contains(8), $"{tag}first access unit is an IDR with SPS+PPS ({string.Join(",", types)})");
        var spsNal = MfH264Encoder.EnumerateNalUnits(frames[0].Data).First(n => n.Type == 7);
        var sps = H264EncoderChecks.Sps.Parse(frames[0].Data.AsSpan(spsNal.Offset, spsNal.Length));
        check(sps?.Width == width && sps.Height == height, $"{tag}SPS codes {sps?.Width}x{sps?.Height}");

        var reference = width == Width && height == Height ? image : VideoFrameScaler.Resize(image, Width, Height, width, height);
        var expected = new byte[width * height * 3 / 2];
        MfH264Encoder.ConvertBgraToNv12(reference, width, height, expected, width, height);
        using var decoder = new H264EncoderChecks.MfDecoder(width, height);
        var decoded = new List<byte[]>();
        foreach (var f in frames) decoded.AddRange(decoder.Decode(f.Data, f.Timestamp100ns)); // one chunk per unit
        decoded.AddRange(decoder.Drain());
        check(decoded.Count == frames.Count, $"{tag}decoder returns every frame ({decoded.Count}/{frames.Count})");
        if (decoded.Count == 0) return;
        var last = decoded[^1];
        var psnr = H264EncoderChecks.LumaPsnr(expected, last, width, height, decoder.FrameWidth);
        var floor = width == Width ? 35 : 25; // a different scaling filter than the CPU reference is expected
        check(psnr >= floor, $"{tag}decoded luma matches the CPU reference: {psnr:0.0} dB (floor {floor})");
        var (px, py) = (width * 48 / Width, height * 48 / Height);
        int y = last[py * decoder.FrameWidth + px], cr = last[decoder.FrameWidth * decoder.FrameHeight + py / 2 * decoder.FrameWidth + (px & ~1) + 1];
        check(Math.Abs(y - 63) <= 5 && cr >= 225, $"{tag}pure red decodes as BT.709 limited (Y {y}, Cr {cr})");
        encoder.Dispose();
        check(!Throws<Exception>(encoder.Dispose) && Throws<ObjectDisposedException>(() => encoder.EncodeLast(false)), tag + "Dispose is idempotent; use after Dispose throws");
    }

    /// <summary>Simulated DXGI_ERROR_ACCESS_LOST: new generation, stale leases and encoders, old textures freed, new encoder works.</summary>
    [SupportedOSPlatform("windows")]
    private static void CheckRecovery(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        var oldLease = capture.PushSynthetic(image);
        var oldGeneration = capture.Generation;
        var oldEncoder = capture.CreateEncoder(0, 0, 30, 4_000_000, out var reason);
        check(oldEncoder is not null && oldEncoder.Encode(oldLease, true).Units.Count + oldEncoder.Inner.PendingFrames > 0, "Encoder works before recovery: " + reason);
        var texturesBefore = capture.LiveTextureCount;
        capture.SimulateAccessLost();
        using var fresh = capture.PushSynthetic(image);
        check(capture.Generation != oldGeneration && fresh.Generation == capture.Generation && capture.RecoveryCount == 1 && fresh.FullFrame,
            "Access loss recreates the capture with a new generation; the first image is a full frame");
        check(!oldLease.IsCurrent && Code(() => capture.ReadBgra(oldLease)) == "capture-reset", "Old leases are stale: IsCurrent false, ReadBgra refuses (capture-reset)");
        check(Code(() => oldEncoder!.Encode(fresh, false)) == "capture-reset" && Code(() => oldEncoder!.EncodeLast(false)) == "capture-reset",
            "Old-generation encoder refuses new and old images (capture-reset): the stream must reopen");
        oldEncoder?.Dispose();
        var withOld = capture.LiveTextureCount;
        oldLease.Dispose();
        check(capture.LiveTextureCount == withOld - 1 && texturesBefore > 0, $"Retired textures are freed when their last lease goes ({withOld} -> {capture.LiveTextureCount})");
        using var encoder = capture.CreateEncoder(0, 0, 30, 4_000_000, out reason);
        var produced = encoder is null ? [] : encoder.Encode(fresh, true).Units.Concat(encoder.Flush()).ToList();
        check(produced.Count == 1 && produced[0].IsKeyframe && encoder!.Generation == capture.Generation, "A reopened encoder encodes the new generation with a keyframe: " + reason);
    }

    /// <summary>Text-like page with saturated colour patches (red, green, blue, white, black) in the top-left corner.</summary>
    internal static byte[] Synthetic(int width, int height)
    {
        var image = JpegEncoderChecks.TextLike(width, height);
        for (var i = 3; i < image.Length; i += 4) image[i] = 255;
        void Patch(int x0, int y0, byte b, byte g, byte r)
        {
            for (var y = y0; y < y0 + 32 && y < height; y++)
                for (var x = x0; x < x0 + 32 && x < width; x++) { var i = (y * width + x) * 4; image[i] = b; image[i + 1] = g; image[i + 2] = r; image[i + 3] = 255; }
        }
        Patch(32, 32, 0, 0, 255); Patch(72, 32, 0, 255, 0); Patch(112, 32, 255, 0, 0); Patch(152, 32, 255, 255, 255); Patch(192, 32, 0, 0, 0);
        return image;
    }

    private static string? Code(Action action)
    {
        try { action(); return null; } catch (PlatformUnavailableException ex) { return ex.Code; } catch (Exception ex) { return ex.GetType().Name; }
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; } catch (Exception) { return false; }
    }
}
