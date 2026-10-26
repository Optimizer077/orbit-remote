using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Orbit.Host.Platform;

namespace Orbit.Host;

public sealed record PreparedFrame(byte[] Png, int EncodedWidth, int EncodedHeight, double Scale,
    string? ETag, bool NotModified, bool CanScale, bool CanUseConditional);

/// <summary>Optional PNG downscaling and stateless, session-scoped conditional responses.</summary>
public static class FrameQuality
{
    public const int MaximumValidatorLength = 128;
    public const double MinimumScale = 0.33;

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
        string? requestedMonitorId, double scale, string? ifNoneMatch, CancellationToken cancellationToken = default)
    {
        PlatformLimits.CheckDimensions(frame.Width, frame.Height);
        if (!double.IsFinite(scale) || scale is < MinimumScale or > 1) throw new ArgumentException("Invalid frame scale.");
        if (frame.RawBgra is null)
        {
            // Native Mac/Linux backends still return encoded PNG only. Advertise
            // no raw-frame features and preserve full-scale behavior explicitly.
            var dimensions = PngEncoder.ReadDimensions(frame.Png);
            return new(frame.Png, dimensions.Width, dimensions.Height, 1, null, false, false, false);
        }
        if (frame.RawBgra.Length != checked(frame.Width * frame.Height * 4))
            throw new PlatformUnavailableException("invalid-frame", "Native capture returned an invalid raw pixel buffer.");
        var originalDimensions = PngEncoder.ReadDimensions(frame.Png);
        if (originalDimensions.Width != frame.Width || originalDimensions.Height != frame.Height)
            throw new PlatformUnavailableException("invalid-frame", "Native raw pixels and PNG geometry do not agree.");
        var width = Math.Max(1, (int)Math.Round(frame.Width * scale, MidpointRounding.AwayFromZero));
        var height = Math.Max(1, (int)Math.Round(frame.Height * scale, MidpointRounding.AwayFromZero));
        var tag = CreateTag(frame, sessionId, resumeEpoch, requestedMonitorId, scale, width, height, cancellationToken);
        if (ifNoneMatch is not null && string.Equals(tag, ifNoneMatch, StringComparison.Ordinal))
            return new([], width, height, scale, tag, true, true, true);
        if (width == frame.Width && height == frame.Height)
            return new(frame.Png, width, height, scale, tag, false, true, true);
        var resized = Resize(frame.RawBgra, frame.Width, frame.Height, width, height, cancellationToken);
        return new(PngEncoder.EncodeBgra(resized, width, height, cancellationToken), width, height, scale, tag, false, true, true);
    }

    private static string CreateTag(ScreenFrame frame, string sessionId, string? resumeEpoch, string? requestedMonitorId,
        double scale, int encodedWidth, int encodedHeight, CancellationToken cancellationToken)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AddText("orbit-frame-v1"); AddText(sessionId); AddText(resumeEpoch ?? ""); AddText(frame.MonitorId ?? requestedMonitorId ?? "");
        Span<byte> geometry = stackalloc byte[32];
        BinaryPrimitives.WriteInt32LittleEndian(geometry, frame.Width);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[4..], frame.Height);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[8..], frame.Left);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[12..], frame.Top);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[16..], encodedWidth);
        BinaryPrimitives.WriteInt32LittleEndian(geometry[20..], encodedHeight);
        BinaryPrimitives.WriteInt64LittleEndian(geometry[24..], BitConverter.DoubleToInt64Bits(scale));
        hash.AppendData(geometry);
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
        return '"' + "orbit-frame-v1-" + Convert.ToHexString(hash.GetHashAndReset()) + '"';

        void AddText(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[4]; BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
            hash.AppendData(length); hash.AppendData(bytes);
        }
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
