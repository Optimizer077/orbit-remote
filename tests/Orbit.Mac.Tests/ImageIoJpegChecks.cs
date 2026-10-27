using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Orbit.Host.Platform;

[SupportedOSPlatform("macos")]
internal static class ImageIoJpegChecks
{
    internal static void Run(Action<bool, string> check)
    {
        check(ImageIoJpegEncoder.IsSupported, "Native ImageIO JPEG destination is available");
        check(ImageIoJpegEncoder.ClampQuality(int.MinValue) == 40, "ImageIO quality lower bound");
        check(ImageIoJpegEncoder.ClampQuality(int.MaxValue) == 90, "ImageIO quality upper bound");
        check(ImageIoJpegEncoder.ClampQuality(75) == 75, "ImageIO quality preserves supported values");
        const int width = 128, height = 96;
        var pixels = new byte[width * height * 4];
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var p = (y * width + x) * 4;
                var rgb = (x < width / 2, y < height / 2) switch
                { (true, true) => (240, 10, 10), (false, true) => (10, 240, 10), (true, false) => (10, 10, 240), _ => (240, 240, 240) };
                pixels[p] = (byte)rgb.Item3; pixels[p + 1] = (byte)rgb.Item2; pixels[p + 2] = (byte)rgb.Item1;
                pixels[p + 3] = (byte)((x + y) % 256);
            }
        var original = pixels.ToArray();
        var jpeg = ImageIoJpegEncoder.EncodeBgra(pixels, width, height, 75, default);
        check(jpeg.Length > 4 && jpeg[0] == 255 && jpeg[1] == 216 && jpeg[^2] == 255 && jpeg[^1] == 217, "ImageIO returns complete JPEG markers");
        check(original.SequenceEqual(pixels), "ImageIO does not modify source BGRA");
        var decoded = Decode(jpeg);
        check(decoded.Width == width && decoded.Height == height, "ImageIO JPEG round-trip retains dimensions");
        Color(width / 4, height / 4, 240, 10, 10, "top-left red");
        Color(width * 3 / 4, height / 4, 10, 240, 10, "top-right green");
        Color(width / 4, height * 3 / 4, 10, 10, 240, "bottom-left blue");
        Color(width * 3 / 4, height * 3 / 4, 240, 240, 240, "bottom-right white");
        for (var p = 3; p < pixels.Length; p += 4) pixels[p] ^= 255;
        check(jpeg.SequenceEqual(ImageIoJpegEncoder.EncodeBgra(pixels, width, height, 75, default)), "ImageIO ignores undefined source alpha");
        check(jpeg.SequenceEqual(ImageIoJpegEncoder.EncodeBgra(pixels, width, height, 75, default)), "ImageIO repeated encodes are independent");
        var concurrent = Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
            ImageIoJpegEncoder.EncodeBgra(pixels, width, height, 75, default)))).GetAwaiter().GetResult();
        check(concurrent.All(result => result.SequenceEqual(jpeg)), "ImageIO concurrent encodes isolate native resources");
        Reject<ArgumentException>(() => ImageIoJpegEncoder.EncodeBgra([], 1, 1, 75, default), "ImageIO rejects truncated BGRA");
        Reject<PlatformUnavailableException>(() => ImageIoJpegEncoder.EncodeBgra([], 0, 1, 75, default), "ImageIO rejects empty dimensions");
        Reject<PlatformUnavailableException>(() => ImageIoJpegEncoder.EncodeBgra([], int.MaxValue, 1, 75, default), "ImageIO rejects excessive dimensions before native allocation");
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        Reject<OperationCanceledException>(() => ImageIoJpegEncoder.EncodeBgra(pixels, width, height, 75, canceled.Token), "ImageIO honors pre-cancellation");
        var tiny = Decode(ImageIoJpegEncoder.EncodeBgra([30, 20, 10, 0], 1, 1, 40, default));
        check(tiny.Width == 1 && tiny.Height == 1, "ImageIO encodes minimum geometry");

        // Synthetic RGB content only; no capture, disk image, identity or screen hash.
        const int benchWidth = 1920, benchHeight = 1080;
        var synthetic = new byte[benchWidth * benchHeight * 4];
        var random = new Random(42);
        for (var y = 0; y < benchHeight; y++)
            for (var x = 0; x < benchWidth; x++)
            {
                var p = (y * benchWidth + x) * 4;
                synthetic[p] = (byte)Math.Clamp(x * 170 / benchWidth + random.Next(20), 0, 255);
                synthetic[p + 1] = (byte)Math.Clamp(y * 180 / benchHeight + random.Next(20), 0, 255);
                synthetic[p + 2] = (byte)Math.Clamp((x + y) * 160 / (benchWidth + benchHeight) + random.Next(20), 0, 255);
            }
        var pngStart = Stopwatch.GetTimestamp();
        var png = PngEncoder.EncodeBgra(synthetic, benchWidth, benchHeight, default);
        var pngMs = Stopwatch.GetElapsedTime(pngStart).TotalMilliseconds;
        byte[]? low = null, high = null;
        foreach (var quality in new[] { 40, 75, 90 })
        {
            _ = ImageIoJpegEncoder.EncodeBgra(synthetic, benchWidth, benchHeight, quality, default);
            var times = new List<double>(); byte[] encoded = [];
            for (var repeat = 0; repeat < 10; repeat++)
            {
                var started = Stopwatch.GetTimestamp();
                encoded = ImageIoJpegEncoder.EncodeBgra(synthetic, benchWidth, benchHeight, quality, default);
                times.Add(Stopwatch.GetElapsedTime(started).TotalMilliseconds);
            }
            times.Sort();
            Console.WriteLine($"Synthetic ImageIO 1920x1080 q{quality}: {encoded.Length} bytes, median {times[4]:F2} ms, p95 {times[9]:F2} ms; PNG {png.Length} bytes / {pngMs:F2} ms (one encode)");
            if (quality == 40) low = encoded; if (quality == 90) high = encoded;
            check(Decode(encoded).Width == benchWidth, $"ImageIO q{quality} synthetic large frame decodes");
        }
        check(low!.Length < high!.Length, "ImageIO quality changes synthetic output size");

        void Color(int x, int y, int red, int green, int blue, string name)
        {
            var p = (y * width + x) * 4;
            check(Math.Abs(decoded.Pixels[p] - red) < 25 && Math.Abs(decoded.Pixels[p + 1] - green) < 25 && Math.Abs(decoded.Pixels[p + 2] - blue) < 25,
                "ImageIO JPEG preserves BGRA channel order/orientation: " + name);
        }
        void Reject<T>(Action action, string message) where T : Exception
        { try { action(); check(false, message); } catch (T) { check(true, message); } }
    }

    private static (int Width, int Height, byte[] Pixels) Decode(byte[] jpeg)
    {
        nint data = 0, source = 0, image = 0, color = 0, context = 0;
        var pin = default(GCHandle);
        try
        {
            data = Native.CFDataCreate(0, jpeg, jpeg.Length);
            source = Native.CGImageSourceCreateWithData(data, 0);
            if (source == 0 || (image = Native.CGImageSourceCreateImageAtIndex(source, 0, 0)) == 0) throw new InvalidOperationException("ImageIO test decoder rejected JPEG.");
            var width = checked((int)Native.CGImageGetWidth(image)); var height = checked((int)Native.CGImageGetHeight(image));
            PlatformLimits.CheckDimensions(width, height);
            var pixels = new byte[checked(width * height * 4)];
            pin = GCHandle.Alloc(pixels, GCHandleType.Pinned);
            color = Native.CGColorSpaceCreateDeviceRGB();
            context = Native.CGBitmapContextCreate(pin.AddrOfPinnedObject(), (nuint)width, (nuint)height, 8, (nuint)(width * 4), color, 0x4000 | 5);
            if (context == 0) throw new InvalidOperationException("ImageIO test bitmap context failed.");
            Native.CGContextDrawImage(context, new Rect(0, 0, width, height), image);
            return (width, height, pixels);
        }
        finally
        {
            foreach (var value in new[] { context, color, image, source, data }) if (value != 0) Native.CFRelease(value);
            if (pin.IsAllocated) pin.Free();
        }
    }

    [StructLayout(LayoutKind.Sequential)] private readonly record struct Rect(double X, double Y, double Width, double Height);
    private static class Native
    {
        private const string CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
        private const string CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
        private const string IO = "/System/Library/Frameworks/ImageIO.framework/ImageIO";
        [DllImport(CF)] internal static extern nint CFDataCreate(nint allocator, byte[] bytes, nint length);
        [DllImport(CF)] internal static extern void CFRelease(nint value);
        [DllImport(IO)] internal static extern nint CGImageSourceCreateWithData(nint data, nint options);
        [DllImport(IO)] internal static extern nint CGImageSourceCreateImageAtIndex(nint source, nuint index, nint options);
        [DllImport(CG)] internal static extern nuint CGImageGetWidth(nint image);
        [DllImport(CG)] internal static extern nuint CGImageGetHeight(nint image);
        [DllImport(CG)] internal static extern nint CGColorSpaceCreateDeviceRGB();
        [DllImport(CG)] internal static extern nint CGBitmapContextCreate(nint data, nuint width, nuint height, nuint bits, nuint stride, nint colorSpace, uint bitmapInfo);
        [DllImport(CG)] internal static extern void CGContextDrawImage(nint context, Rect rect, nint image);
    }
}
