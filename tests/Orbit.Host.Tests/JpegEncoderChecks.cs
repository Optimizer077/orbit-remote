using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Orbit.Host.Platform;
using ComStream = System.Runtime.InteropServices.ComTypes.IStream;
using Wic = Orbit.Host.Platform.WicJpegEncoder.Wic;

/// <summary>Focused checks for the built-in Windows (WIC) JPEG frame encoder. Synthetic images only; never captures the screen.</summary>
public static class JpegEncoderChecks
{
    public static void Run(Action<bool, string> check)
    {
        if (!OperatingSystem.IsWindows())
        {
            check(!WicJpegEncoder.IsSupported, "WIC JPEG encoder reports unsupported off Windows");
            return;
        }
        check(WicJpegEncoder.IsSupported, "WIC JPEG encoder is supported on Windows");
        if (WicJpegEncoder.IsSupported) RunWindows(check);
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
        output?.WriteLine($"{total - failed}/{total} JPEG encoder checks passed");
        return failed == 0 ? 0 : 1;
    }

    [SupportedOSPlatform("windows")]
    private static void RunWindows(Action<bool, string> check)
    {
        var none = CancellationToken.None;
        byte[] Encode(byte[] pixels, int width, int height, int quality) => WicJpegEncoder.EncodeBgra(pixels, width, height, quality, none);

        foreach (var (name, pixels, width, height) in new[]
        {
            ("1x1", Flat(1, 1, 10, 200, 30), 1, 1), ("odd 17x9 gradient", Gradient(17, 9), 17, 9),
            ("flat 64x48", Flat(64, 48, 40, 120, 220), 64, 48), ("text-like 320x200", TextLike(320, 200), 320, 200),
            ("strip-boundary 33x130", Gradient(33, 130), 33, 130),
        })
        {
            var jpeg = Encode(pixels, width, height, 75);
            check(jpeg.Length > 4 && jpeg[0] == 0xFF && jpeg[1] == 0xD8 && jpeg[^2] == 0xFF && jpeg[^1] == 0xD9, "JPEG has SOI/EOI markers: " + name);
            check(ReadSofDimensions(jpeg) == (width, height), "JPEG SOF header carries encoded dimensions: " + name);
            var decoded = Decode(jpeg);
            check(decoded.Width == width && decoded.Height == height, "WIC decodes JPEG back to the right dimensions: " + name);
        }

        var flat = Flat(64, 48, 40, 120, 220);
        var flatDecoded = Decode(Encode(flat, 64, 48, 90));
        check(MaxError(flat, flatDecoded.Bgr) <= 4, "Flat color survives q90 round trip within 4 levels");
        var gradient = Gradient(256, 128);
        var gradientError90 = MeanError(gradient, Decode(Encode(gradient, 256, 128, 90)).Bgr);
        var gradientError40 = MeanError(gradient, Decode(Encode(gradient, 256, 128, 40)).Bgr);
        check(gradientError90 <= 2.5, $"Gradient q90 mean abs error is small ({gradientError90:0.00})");
        check(gradientError40 <= 6 && gradientError40 >= gradientError90, $"Gradient q40 error is bounded and not better than q90 ({gradientError40:0.00})");
        var swapped = TextLike(96, 64);
        var swappedDecoded = Decode(Encode(swapped, 96, 64, 90)).Bgr;
        check(MeanError(swapped, swappedDecoded) <= 12, "Channel order is BGR (no red/blue swap) on a text-like image");
        var blue = Decode(Encode(Flat(16, 16, 255, 0, 0), 16, 16, 90)).Bgr;
        check(blue[0] > 200 && blue[2] < 60, "Pure blue BGRA input decodes as blue, not red");

        var opaque = Gradient(48, 32); var transparent = opaque.ToArray();
        for (var i = 3; i < opaque.Length; i += 4) { opaque[i] = 255; transparent[i] = 0; }
        check(Encode(opaque, 48, 32, 75).AsSpan().SequenceEqual(Encode(transparent, 48, 32, 75)), "Undefined GDI alpha does not change the JPEG");

        var busy = PhotoLike(640, 360, 7);
        var sizes = new[] { 40, 50, 75, 90 }.Select(q => Encode(busy, 640, 360, q).Length).ToArray();
        check(sizes[0] <= sizes[1] && sizes[1] <= sizes[2] && sizes[2] <= sizes[3], $"Higher quality is larger-or-equal on a busy image ({string.Join(" <= ", sizes)})");
        var q40 = Encode(busy, 640, 360, 40); var q90 = Encode(busy, 640, 360, 90);
        check(Encode(busy, 640, 360, 0).AsSpan().SequenceEqual(q40) && Encode(busy, 640, 360, int.MinValue).AsSpan().SequenceEqual(q40), "Quality below 40 clamps to 40");
        check(Encode(busy, 640, 360, 100).AsSpan().SequenceEqual(q90) && Encode(busy, 640, 360, int.MaxValue).AsSpan().SequenceEqual(q90), "Quality above 90 clamps to 90");
        check(WicJpegEncoder.ClampQuality(65) == 65 && !q40.AsSpan().SequenceEqual(q90), "In-range quality is used as given");

        check(Throws<ArgumentException>(() => Encode(new byte[10], 4, 4, 75)), "Short pixel buffer throws ArgumentException");
        check(Throws<ArgumentException>(() => Encode(new byte[4 * 4 * 4 + 4], 4, 4, 75)), "Long pixel buffer throws ArgumentException");
        check(Throws<ArgumentException>(() => Encode(null!, 4, 4, 75)), "Null pixel buffer throws ArgumentException");
        check(Throws<PlatformUnavailableException>(() => Encode([], 0, 0, 75)), "Zero dimensions are rejected like PngEncoder");
        check(Throws<PlatformUnavailableException>(() => Encode([], 8193, 4097, 75)), "Over-limit dimensions are rejected like PngEncoder");
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            check(Throws<OperationCanceledException>(() => WicJpegEncoder.EncodeBgra(Gradient(8, 8), 8, 8, 75, cancelled.Token)), "Cancellation is honored before encoding");
        }

        var expected = Encode(busy, 640, 360, 75);
        var parallel = new byte[8][];
        Parallel.For(0, parallel.Length, new ParallelOptions { MaxDegreeOfParallelism = 8 }, i => parallel[i] = Encode(busy, 640, 360, 75));
        check(parallel.All(x => x.AsSpan().SequenceEqual(expected)), "Concurrent encodes are thread-safe and deterministic");

        var photo = PhotoLike(1920, 1080, 42);
        var png = PngEncoder.EncodeBgra(photo, 1920, 1080, none).Length;
        var jpeg75 = Encode(photo, 1920, 1080, 75).Length;
        check(jpeg75 * 3 < png, $"Photo-like 1920x1080: PNG {png} B vs JPEG q75 {jpeg75} B (ratio {(double)png / jpeg75:0.0}x)");
        var text = TextLike(1920, 1080);
        var textPng = PngEncoder.EncodeBgra(text, 1920, 1080, none).Length;
        var textJpeg = Encode(text, 1920, 1080, 75).Length;
        check(textJpeg > 0 && textPng > 0, $"Text-like 1920x1080 (reported): PNG {textPng} B vs JPEG q75 {textJpeg} B (ratio {(double)textPng / textJpeg:0.0}x)");
    }

    internal static byte[] Flat(int width, int height, byte b, byte g, byte r)
    {
        var data = new byte[width * height * 4];
        for (var i = 0; i < data.Length; i += 4) { data[i] = b; data[i + 1] = g; data[i + 2] = r; }
        return data;
    }

    internal static byte[] Gradient(int width, int height)
    {
        var data = new byte[width * height * 4];
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var i = (y * width + x) * 4;
                data[i] = (byte)(x * 255 / Math.Max(1, width - 1)); data[i + 1] = (byte)(y * 255 / Math.Max(1, height - 1)); data[i + 2] = (byte)((x + y) * 127 / Math.Max(1, width + height - 2));
            }
        return data;
    }

    /// <summary>White page with dark, glyph-like strokes in 16-pixel text lines.</summary>
    internal static byte[] TextLike(int width, int height)
    {
        var data = Flat(width, height, 250, 250, 250);
        for (var y = 0; y < height; y++)
        {
            var line = y % 16;
            if (line is < 3 or > 12) continue;
            for (var x = 8; x < width - 8; x++)
            {
                var glyph = x / 7; var column = x % 7;
                if (glyph % 9 == 8 || column == 6) continue; // word and letter gaps
                var hash = (uint)(glyph * 2654435761u ^ (uint)(y / 16) * 40503u ^ (uint)column * 97u ^ (uint)line * 131u);
                if ((hash >> 13) % 3 != 0) continue;
                var i = (y * width + x) * 4;
                data[i] = (byte)(glyph % 5 == 0 ? 160 : 30); data[i + 1] = 30; data[i + 2] = (byte)(glyph % 7 == 0 ? 170 : 30);
            }
        }
        return data;
    }

    /// <summary>Smooth color fields plus deterministic sensor-like noise, roughly matching a photo or video frame.</summary>
    internal static byte[] PhotoLike(int width, int height, uint seed)
    {
        var data = new byte[width * height * 4];
        var state = seed | 1;
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                state ^= state << 13; state ^= state >> 17; state ^= state << 5;
                var noise = (int)(state % 17) - 8;
                double u = x / (double)width, v = y / (double)height;
                var i = (y * width + x) * 4;
                data[i] = Clamp(110 + 90 * Math.Sin(u * 7 + v * 3) + noise);
                data[i + 1] = Clamp(120 + 80 * Math.Cos(u * 4 - v * 9) + 30 * Math.Sin(u * v * 40) + noise);
                data[i + 2] = Clamp(130 + 100 * Math.Sin((u - 0.5) * (v - 0.5) * 25) + noise);
            }
        return data;
    }

    private static byte Clamp(double value) => (byte)Math.Clamp((int)Math.Round(value), 0, 255);

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; } catch (Exception) { return false; }
    }

    private static int MaxError(byte[] bgra, byte[] bgr)
    {
        var max = 0;
        for (int s = 0, t = 0; s < bgra.Length; s += 4, t += 3)
            for (var c = 0; c < 3; c++) max = Math.Max(max, Math.Abs(bgra[s + c] - bgr[t + c]));
        return max;
    }

    private static double MeanError(byte[] bgra, byte[] bgr)
    {
        long sum = 0;
        for (int s = 0, t = 0; s < bgra.Length; s += 4, t += 3)
            for (var c = 0; c < 3; c++) sum += Math.Abs(bgra[s + c] - bgr[t + c]);
        return sum / (bgra.Length / 4 * 3.0);
    }

    /// <summary>Reads width/height from the first SOF0/SOF1/SOF2 segment.</summary>
    internal static (int Width, int Height) ReadSofDimensions(ReadOnlySpan<byte> jpeg)
    {
        for (var offset = 2; offset + 9 <= jpeg.Length;)
        {
            if (jpeg[offset] != 0xFF) return (-1, -1);
            var marker = jpeg[offset + 1];
            if (marker == 0xDA) return (-1, -1); // start of scan before any frame header
            var length = BinaryPrimitives.ReadUInt16BigEndian(jpeg.Slice(offset + 2, 2));
            if (marker is 0xC0 or 0xC1 or 0xC2)
                return (BinaryPrimitives.ReadUInt16BigEndian(jpeg.Slice(offset + 7, 2)), BinaryPrimitives.ReadUInt16BigEndian(jpeg.Slice(offset + 5, 2)));
            offset += 2 + length;
        }
        return (-1, -1);
    }

    [SupportedOSPlatform("windows")]
    private static (int Width, int Height, byte[] Bgr) Decode(byte[] jpeg)
    {
        Wic.IWICImagingFactory? factory = null; ComStream? stream = null; object? decoder = null; IWICBitmapFrameDecode? frame = null;
        try
        {
            factory = Wic.CreateFactory();
            stream = Wic.CreateStream();
            stream.Write(jpeg, jpeg.Length, IntPtr.Zero);
            stream.Seek(0, 0, IntPtr.Zero);
            factory.CreateDecoderFromStream(stream, IntPtr.Zero, 0, out decoder);
            ((IWICBitmapDecoder)decoder).GetFrame(0, out frame);
            frame.GetSize(out var width, out var height);
            frame.GetPixelFormat(out var format);
            if (format != Wic.PixelFormat24bppBgr) return (-1, -1, []);
            var bgr = new byte[checked((int)(width * height * 3))];
            frame.CopyPixels(IntPtr.Zero, width * 3, (uint)bgr.Length, bgr);
            return ((int)width, (int)height, bgr);
        }
        finally { Wic.Release(frame); Wic.Release(decoder); Wic.Release(stream); Wic.Release(factory); }
    }

    [ComImport, Guid("9edde9e7-8dee-47ea-99df-e6faf2ed44bf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICBitmapDecoder
    {
        void QueryCapability(); void Initialize(); void GetContainerFormat(); void GetDecoderInfo(); void CopyPalette();
        void GetMetadataQueryReader(); void GetPreview(); void GetColorContexts(); void GetThumbnail(); void GetFrameCount();
        void GetFrame(uint index, out IWICBitmapFrameDecode frame);
    }

    [ComImport, Guid("3b16811b-6a43-4ec9-a813-3d930c13b940"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IWICBitmapFrameDecode
    {
        void GetSize(out uint width, out uint height);
        void GetPixelFormat(out Guid format);
        void GetResolution(out double dpiX, out double dpiY);
        void CopyPalette();
        void CopyPixels(IntPtr rect, uint stride, uint bufferSize, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer);
    }
}
