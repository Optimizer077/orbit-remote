using System.Buffers.Binary;
using System.IO.Compression;
using Orbit.Host;
using Orbit.Host.Platform;

public static class FrameQualityChecks
{
    public static void Run(Action<bool, string> check, Action<Action, string> reject)
    {
        check(FrameQuality.ParseScale(null) == 1, "Absent scale preserves full-resolution default");
        check(FrameQuality.ParseScale("0.5") == 0.5, "Explicit fractional scale is accepted");
        check(FrameQuality.ParseScale("-100") == 0.33 && FrameQuality.ParseScale("10") == 1, "Finite scales clamp to agreed bounds");
        foreach (var value in new[] { "", "NaN", "Infinity", "1e999", "half", "0,5", new string('1', 33) })
            reject(() => FrameQuality.ParseScale(value), "Invalid scale rejected: " + value);
        check(FrameQuality.ParseConditionalTag(null) is null && FrameQuality.ParseConditionalTag("\"previous\"") == "\"previous\"", "Conditional validator is optional and opaque");
        foreach (var value in new[] { "", "*", "W/\"previous\"", "unquoted", "\"a\",\"b\"", "\"a\nb\"", "\"" + new string('x', 127) + "\"" })
            reject(() => FrameQuality.ParseConditionalTag(value), "Invalid or excessive conditional validator rejected");

        byte[] pixels = [0, 0, 10, 0, 0, 0, 30, 0, 0, 0, 50, 0, 0, 0, 70, 0,
                         0, 0, 90, 0, 0, 0, 110, 0, 0, 0, 130, 0, 0, 0, 150, 0];
        var frame = new ScreenFrame(PngEncoder.EncodeBgra(pixels, 4, 2, CancellationToken.None), 4, 2, -400, -20,
            DateTimeOffset.UtcNow, pixels, "synthetic-monitor");
        PreparedFrame Prepare(ScreenFrame value, string session = "session-a", string epoch = "epoch-a", double scale = 1, string? tag = null) =>
            FrameQuality.Prepare(value, session, epoch, null, scale, tag);
        var initial = Prepare(frame);
        check(initial.ETag is not null && initial.ETag.Length <= FrameQuality.MaximumValidatorLength && FrameQuality.ParseConditionalTag(initial.ETag) == initial.ETag, "Generated ETag is one bounded quoted validator");
        check(!initial.NotModified && initial.Body.SequenceEqual(frame.Png), "No conditional request always receives a PNG body");
        var same = Prepare(frame with { CapturedUtc = frame.CapturedUtc.AddSeconds(1) }, tag: initial.ETag);
        check(same.NotModified && same.Body.Length == 0 && same.ETag == initial.ETag, "Matching fresh pixels return no body while capture timestamp changes do not defeat304");
        check(!Prepare(frame, tag: "\"old\"").NotModified, "A different validator receives the current PNG body");
        var alphaPixels = pixels.ToArray(); for (var i = 3; i < alphaPixels.Length; i += 4) alphaPixels[i] = 255;
        check(Prepare(frame with { RawBgra = alphaPixels }, tag: initial.ETag).NotModified, "Undefined native alpha does not change visible RGB validator");
        var changed = pixels.ToArray(); changed[2]++;
        var changedFrame = frame with { RawBgra = changed, Png = PngEncoder.EncodeBgra(changed, 4, 2, CancellationToken.None) };
        check(!Prepare(changedFrame, tag: initial.ETag).NotModified, "Changed visible pixels cannot return304");
        check(Prepare(frame, session: "session-b").ETag != initial.ETag, "ETag is scoped to the actual session identity");
        check(Prepare(frame, epoch: "epoch-b").ETag != initial.ETag, "Host-stop resume generation changes the validator");
        check(Prepare(frame with { MonitorId = "other-monitor" }).ETag != initial.ETag, "Selected native monitor identity is part of the validator");
        check(Prepare(frame with { Left = -399 }).ETag != initial.ETag && Prepare(frame with { Top = -19 }).ETag != initial.ETag, "Physical monitor origin changes invalidate cached geometry");

        var half = Prepare(frame, scale: 0.5);
        check(half.EncodedWidth == 2 && half.EncodedHeight == 1 && half.Scale == 0.5, "Optional downscale reports encoded dimensions independently");
        check(frame.Width == 4 && frame.Height == 2 && frame.Left == -400 && frame.Top == -20, "Downscaling preserves original physical input coordinates");
        check(PngEncoder.ReadDimensions(half.Body) == (2, 1), "Scaled PNG header contains the encoded pixel dimensions");
        check(ReadRgbScanlines(half.Body).SequenceEqual(new byte[] { 0, 60, 0, 0, 100, 0, 0 }), "Box downscale encodes independently verified averaged RGB pixels");
        check(half.ETag != initial.ETag && !Prepare(frame, scale: 0.5, tag: initial.ETag).NotModified, "Changing requested scale forces a fresh image");
        check(Prepare(frame, scale: 0.5, tag: half.ETag).NotModified, "Scaled representation can be conditionally reused only with its own validator");
        check(Prepare(frame, scale: 0.33).EncodedHeight == 1, "Very small scaled dimensions remain at least one pixel");

        var fallback = Prepare(frame with { RawBgra = null }, scale: 0.5, tag: initial.ETag);
        check(!fallback.CanScale && !fallback.CanUseConditional && !fallback.NotModified && fallback.ETag is null, "Encoded-only backends explicitly decline raw-frame features");
        check(fallback.Scale == 1 && fallback.EncodedWidth == 4 && fallback.EncodedHeight == 2 && fallback.Body.SequenceEqual(frame.Png), "Encoded-only fallback sends the full-resolution original PNG");
        reject(() => Prepare(frame with { RawBgra = [] }), "Invalid raw buffer is rejected before hashing");
        reject(() => Prepare(frame with { Png = half.Body }), "Raw/encoded geometry mismatch is rejected");
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        var cancelledCapture = false;
        try { FrameQuality.Prepare(frame, "s", "e", null, 1, null, cancelled.Token); } catch (OperationCanceledException) { cancelledCapture = true; }
        check(cancelledCapture, "Cancelled frame work cannot publish a conditional result");
    }

    private static byte[] ReadRgbScanlines(byte[] png)
    {
        using var compressed = new MemoryStream();
        for (var offset = 8; offset < png.Length;)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(offset, 4));
            if (png.AsSpan(offset + 4, 4).SequenceEqual("IDAT"u8)) compressed.Write(png, offset + 8, length);
            offset += length + 12;
        }
        compressed.Position = 0; using var zlib = new ZLibStream(compressed, CompressionMode.Decompress);
        using var decoded = new MemoryStream(); zlib.CopyTo(decoded); return decoded.ToArray();
    }
}
