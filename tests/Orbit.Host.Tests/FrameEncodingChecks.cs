using Orbit.Host;
using Orbit.Host.Platform;

public static class FrameEncodingChecks
{
    public static void Run(Action<bool, string> check, Action<Action, string> reject)
    {
        check(FrameQuality.ParseFormat(null) == "png" && FrameQuality.ParseFormat("jpeg") == "jpeg", "Frame codec defaults to PNG and permits explicit JPEG");
        foreach (var value in new[] { "", "jpg", "PNG", "webp", " jpeg", new string('x', 1000) }) reject(() => FrameQuality.ParseFormat(value), "Unknown or ambiguous frame codec is rejected");
        check(FrameQuality.ParseQuality(null) == 75 && FrameQuality.ParseQuality("55") == 55, "JPEG quality uses the agreed integer default");
        check(FrameQuality.ParseQuality("-100") == 40 && FrameQuality.ParseQuality("100") == 90, "Integer JPEG quality clamps to40..90");
        foreach (var value in new[] { "", "NaN", "55.5", "5e1", " 55", "55 ", "2147483648", new string('0', 13) }) reject(() => FrameQuality.ParseQuality(value), "Malformed or oversized quality is rejected");

        var pixels = JpegEncoderChecks.TextLike(128, 64);
        var encoded = PngEncoder.EncodeBgra(pixels, 128, 64, CancellationToken.None);
        check(PngEncoder.EncodeBgraWithinBudget(pixels, 128, 64, encoded.Length, CancellationToken.None)!.SequenceEqual(encoded), "Budgeted PNG is byte-identical at its exact output limit");
        check(PngEncoder.EncodeBgraWithinBudget(pixels, 128, 64, encoded.Length - 1, CancellationToken.None) is null, "Budgeted PNG never returns partial or oversized output");
        check(PngEncoder.EncodeBgraWithinBudget(pixels, 128, 64, 56, CancellationToken.None) is null, "A budget below PNG overhead aborts before compression");
        reject(() => PngEncoder.EncodeBgraWithinBudget([], 128, 64, 56, CancellationToken.None), "PNG byte budget never bypasses raw-buffer validation");
        using var cancellation = new CancellationTokenSource(); cancellation.Cancel();
        var cancelled = false;
        try { PngEncoder.EncodeBgraWithinBudget(pixels, 128, 64, 56, cancellation.Token); } catch (OperationCanceledException) { cancelled = true; }
        check(cancelled, "PNG budget path preserves cancellation even before writing output");

        var raw = new ScreenFrame([], 128, 64, -128, 20, DateTimeOffset.UtcNow, pixels, "synthetic-monitor");
        PreparedFrame Prepare(ScreenFrame frame, string format = "png", int quality = 75, double scale = 1, string? tag = null) =>
            FrameQuality.Prepare(frame, "synthetic-session", "synthetic-epoch", null, scale, tag, format: format, quality: quality);
        var png = Prepare(raw);
        check(png.Format == "png" && png.ContentType == "image/png" && png.Quality is null && png.Body.SequenceEqual(encoded), "Raw-only capture encodes full PNG lazily without an eager source PNG");
        check(png.ETag!.StartsWith("\"orbit-frame-v2-") && png.ETag.Length <= FrameQuality.MaximumValidatorLength, "Negotiated ETag uses the bounded v2 representation namespace");
        var unchanged = Prepare(raw, tag: png.ETag);
        check(unchanged.NotModified && unchanged.Body.Length == 0 && unchanged.EncodeMilliseconds == 0 && unchanged.Format == "png", "Raw-only conditional match returns304 before resizing or encoding");
        var half = Prepare(raw, scale: 0.5);
        check(half.EncodedWidth == 64 && half.EncodedHeight == 32 && PngEncoder.ReadDimensions(half.Body) == (64, 32), "Raw-only capture scales before its sole PNG encode");
        check(raw.Width == 128 && raw.Left == -128 && raw.Top == 20, "Negotiation preserves physical input geometry and origin");
        var allowed = Prepare(raw, "jpeg");
        check(allowed.ETag != png.ETag && !Prepare(raw, "jpeg", tag: png.ETag).NotModified, "Enabling JPEG invalidates a PNG-only negotiation cache");
        check(Prepare(raw, "jpeg", 50).ETag != allowed.ETag && Prepare(raw, "jpeg", 90).ETag != allowed.ETag, "Quality is in validators even when PNG is the smaller representation");
        var encodedOnly = Prepare(raw with { RawBgra = null, Png = encoded }, "jpeg", 40, 0.5, png.ETag);
        check(encodedOnly.Format == "png" && encodedOnly.Scale == 1 && !encodedOnly.NotModified && encodedOnly.ETag is null && encodedOnly.Body.SequenceEqual(encoded), "Encoded-only platforms preserve PNG fallback without advertising raw or JPEG features");

        if (OperatingSystem.IsWindows() && WicJpegEncoder.IsSupported)
        {
            var photo = raw with { Width = 640, Height = 360, RawBgra = JpegEncoderChecks.PhotoLike(640, 360, 7) };
            var jpeg = Prepare(photo, "jpeg");
            check(jpeg.Format == "jpeg" && jpeg.ContentType == "image/jpeg" && jpeg.Quality == 75 && jpeg.Body[0] == 0xff && jpeg.Body[1] == 0xd8, "Photo-like raw frame selects the smaller built-in JPEG with accurate MIME and quality");
            var jpegSame = Prepare(photo, "jpeg", tag: jpeg.ETag);
            check(jpegSame.NotModified && jpegSame.Format == "jpeg" && jpegSame.Quality == 75 && jpegSame.EncodeMilliseconds == 0, "JPEG candidate304 retains actual format metadata without invoking either encoder");
            var text = raw with { Width = 640, Height = 360, RawBgra = JpegEncoderChecks.TextLike(640, 360) };
            var textResult = Prepare(text, "jpeg");
            check(textResult.Format == "png" && textResult.ContentType == "image/png" && textResult.Quality is null, "Text-like content chooses smaller lossless PNG even when JPEG is permitted");
            check(Prepare(text, "jpeg", tag: textResult.ETag).NotModified, "Actual PNG candidate can revalidate a JPEG-permitted request");
            check(!Prepare(photo, "jpeg", 50, tag: jpeg.ETag).NotModified && !Prepare(photo, "png", tag: jpeg.ETag).NotModified, "Changed format or quality cannot reuse a prior JPEG validator");
            check(Prepare(photo, "jpeg", 0).Body.SequenceEqual(Prepare(photo, "jpeg", 40).Body), "Host preparation clamps low quality before encoding");
            var pngLength = PngEncoder.EncodeBgra(photo.RawBgra!, 640, 360, CancellationToken.None).Length;
            check(jpeg.Body.Length < pngLength, "Smaller-format selection reduces photo-like bytes against the exact PNG candidate");
        }
        else check(allowed.Format == "png", "Unsupported OS JPEG falls back to PNG");
    }
}
