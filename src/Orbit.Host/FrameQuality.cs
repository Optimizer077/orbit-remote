using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Orbit.Host.Platform;

namespace Orbit.Host;

public sealed record PreparedFrame(byte[] Body, int EncodedWidth, int EncodedHeight, double Scale,
    string? ETag, bool NotModified, bool CanScale, bool CanUseConditional, string Format = "png", int? Quality = null, int EncodeMilliseconds = 0)
{
    public string ContentType => Format == "jpeg" ? "image/jpeg" : "image/png";
}

/// <summary>Raw-first downscaling, negotiated encoding and stateless session-scoped conditional responses.</summary>
public static class FrameQuality
{
    public const int MaximumValidatorLength = 128;
    public const double MinimumScale = 0.33;

    public static string ParseFormat(string? value) => value switch
    {
        null or "png" => "png", "jpeg" => "jpeg",
        _ => throw new ArgumentException("format must be png or jpeg."),
    };

    public static int ParseQuality(string? value)
    {
        if (value is null) return 75;
        if (value.Length is 0 or > 12 || !int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var quality))
            throw new ArgumentException("quality must be one integer; supported values clamp to 40 through 90.");
        return Math.Clamp(quality, 40, 90);
    }

    public static double ParseScale(string? value)
    {
        if (value is null) return 1;
        if (value.Length is 0 or > 32 || !double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var scale) || !double.IsFinite(scale))
            throw new ArgumentException("scale must be one finite number; supported values are clamped to 0.33 through 1.");
        return Math.Clamp(scale, MinimumScale, 1);
    }

    public static string? ParseConditionalTag(string? value)
    {
        if (value is null) return null;
        // Only a single quoted validator is accepted. No wildcard, weak/list
        // validators or unbounded attacker-controlled strings are retained.
        if (value.Length is < 2 or > MaximumValidatorLength || value[0] != '"' || value[^1] != '"' ||
            value.AsSpan(1, value.Length - 2).ContainsAny('"', ',', '\\') || value.Any(c => c < 0x21 || c > 0x7e))
            throw new ArgumentException("If-None-Match must contain one quoted ETag of at most 128 characters.");
        return value;
    }

    public static PreparedFrame Prepare(ScreenFrame frame, string sessionId, string? resumeEpoch,
        string? requestedMonitorId, double scale, string? ifNoneMatch, CancellationToken cancellationToken = default,
        string format = "png", int quality = 75)
    {
        PlatformLimits.CheckDimensions(frame.Width, frame.Height);
        if (!double.IsFinite(scale) || scale is < MinimumScale or > 1) throw new ArgumentException("Invalid frame scale.");
        format = ParseFormat(format); quality = Math.Clamp(quality, 40, 90);
        cancellationToken.ThrowIfCancellationRequested();
        if (frame.RawBgra is null)
        {
            // Native Mac/Linux backends still return encoded PNG only. Advertise
            // no raw-frame features and preserve full-scale behavior explicitly.
            var dimensions = PngEncoder.ReadDimensions(frame.Png);
            return new(frame.Png, dimensions.Width, dimensions.Height, 1, null, false, false, false);
        }
        if (frame.RawBgra.Length != checked(frame.Width * frame.Height * 4))
            throw new PlatformUnavailableException("invalid-frame", "Native capture returned an invalid raw pixel buffer.");
        if (frame.Png.Length > 0)
        {
            var originalDimensions = PngEncoder.ReadDimensions(frame.Png);
            if (originalDimensions.Width != frame.Width || originalDimensions.Height != frame.Height)
                throw new PlatformUnavailableException("invalid-frame", "Native raw pixels and PNG geometry do not agree.");
        }
        var width = Math.Max(1, (int)Math.Round(frame.Width * scale, MidpointRounding.AwayFromZero));
        var height = Math.Max(1, (int)Math.Round(frame.Height * scale, MidpointRounding.AwayFromZero));
        var tagBase = CreateTagBase(frame, sessionId, resumeEpoch, requestedMonitorId, scale, width, height, format, quality, cancellationToken);
        var pngTag = RepresentationTag(tagBase, "png");
        var canJpeg = format == "jpeg" && OperatingSystem.IsWindows() && WicJpegEncoder.IsSupported;
        var jpegTag = canJpeg ? RepresentationTag(tagBase, "jpeg") : null;
        if (ifNoneMatch is not null)
        {
            // The actual format is authenticated by a candidate derived from the
            // same raw content and complete negotiation context. No encoding or
            // mutable decision cache is needed to revalidate the existing body.
            if (string.Equals(pngTag, ifNoneMatch, StringComparison.Ordinal))
                return new([], width, height, scale, pngTag, true, true, true);
            if (jpegTag is not null && string.Equals(jpegTag, ifNoneMatch, StringComparison.Ordinal))
                return new([], width, height, scale, jpegTag, true, true, true, "jpeg", quality);
        }
        var started = Stopwatch.GetTimestamp();
        var pixels = width == frame.Width && height == frame.Height ? frame.RawBgra : Resize(frame.RawBgra, frame.Width, frame.Height, width, height, cancellationToken);
        var png = width == frame.Width && height == frame.Height && frame.Png.Length > 0 ? frame.Png : null;
        byte[]? jpeg = null;
        if (canJpeg && OperatingSystem.IsWindows())
        {
            try { jpeg = WicJpegEncoder.EncodeBgra(pixels, width, height, quality, cancellationToken); }
            catch (PlatformUnavailableException ex) when (ex.Code == "encode-failed") { /* Preserve the PNG fallback if the OS encoder fails. */ }
        }
        png ??= jpeg is not null ? PngEncoder.EncodeBgraWithinBudget(pixels, width, height, jpeg.Length, cancellationToken)
            : PngEncoder.EncodeBgra(pixels, width, height, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        var encodeMilliseconds = (int)Math.Min(int.MaxValue, Math.Ceiling(Stopwatch.GetElapsedTime(started).TotalMilliseconds));
        if (jpeg is not null && (png is null || jpeg.Length < png.Length))
            return new(jpeg, width, height, scale, jpegTag, false, true, true, "jpeg", quality, encodeMilliseconds);
        return new(png!, width, height, scale, pngTag, false, true, true, EncodeMilliseconds: encodeMilliseconds);
    }

    private static byte[] CreateTagBase(ScreenFrame frame, string sessionId, string? resumeEpoch, string? requestedMonitorId,
        double scale, int encodedWidth, int encodedHeight, string format, int quality, CancellationToken cancellationToken)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AddText("orbit-frame-v2"); AddText(sessionId); AddText(resumeEpoch ?? ""); AddText(frame.MonitorId ?? requestedMonitorId ?? "");
        AddText(format); AddText(quality.ToString(CultureInfo.InvariantCulture));
        Span<byte> geometry = stackalloc byte[32];
        BinaryPrimitives.WriteInt32LittleEndian(geometry, frame.Width);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[4..], frame.Height);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[8..], frame.Left);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[12..], frame.Top);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[16..], encodedWidth);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[20..], encodedHeight);
        BinaryPrimitives.WriteInt64LittleEndian(geometry[24..], BitConverter.DoubleToInt64Bits(scale));
        hash.AppendData(geometry);
        if (frame.NativeGeneration is { Length: >= 22 and <= 128 } generation && frame.NativeVersion > 0)
        {
            // Only trusted native producers set this metadata. A fresh random
            // generation invalidates prior pixels after idle disposal/recovery.
            AddText("native-version-v1"); AddText(generation); AddText(frame.NativeVersion.ToString(CultureInfo.InvariantCulture));
            return hash.GetHashAndReset();
        }
        AddText("visible-rgb-v1");
        // GDI's alpha byte is undefined. Hash exactly the visible RGB values
        // used by PngEncoder so unrelated alpha changes cannot prevent a304.
        var row = new byte[checked(frame.Width * 3)];
        for (var y = 0; y < frame.Height; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (int x = 0, source = y * frame.Width * 4, target = 0; x < frame.Width; x++, source += 4, target += 3)
            {
                row[target] = frame.RawBgra![source + 2]; row[target + 1] = frame.RawBgra[source + 1]; row[target + 2] = frame.RawBgra[source];
            }
            hash.AppendData(row);
        }
        return hash.GetHashAndReset();

        void AddText(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[4]; BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
            hash.AppendData(length); hash.AppendData(bytes);
        }
    }

    private static string RepresentationTag(byte[] contentContext, string actualFormat)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(contentContext); hash.AppendData(Encoding.ASCII.GetBytes(actualFormat));
        return '"' + "orbit-frame-v2-" + Convert.ToHexString(hash.GetHashAndReset()) + '"';
    }

    private static byte[] Resize(byte[] pixels, int sourceWidth, int sourceHeight, int width, int height, CancellationToken cancellationToken)
    {
        // Bounded box averaging preserves small UI features better than selecting
        // just one source pixel. Encoding remains the existing lossless PNG path.
        var output = new byte[checked(width * height * 4)];
        for (var y = 0; y < height; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var top = (int)((long)y * sourceHeight / height);
            var bottom = Math.Max(top + 1, (int)((long)(y + 1) * sourceHeight / height));
            for (var x = 0; x < width; x++)
            {
                var left = (int)((long)x * sourceWidth / width);
                var right = Math.Max(left + 1, (int)((long)(x + 1) * sourceWidth / width));
                long b = 0, g = 0, r = 0;
                for (var sy = top; sy < bottom; sy++)
                    for (var sx = left; sx < right; sx++)
                    {
                        var source = checked((sy * sourceWidth + sx) * 4);
                        b += pixels[source]; g += pixels[source + 1]; r += pixels[source + 2];
                    }
                var count = (long)(bottom - top) * (right - left); var target = checked((y * width + x) * 4);
                output[target] = (byte)(b / count); output[target + 1] = (byte)(g / count); output[target + 2] = (byte)(r / count);
            }
        }
        return output;
    }
}
