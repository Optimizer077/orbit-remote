using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Orbit.Host.Platform;

public interface IPointerFeed
{
    Task<PointerSnapshot?> GetPointerAsync(MonitorInfo monitor, string? knownShapeId, CancellationToken cancellationToken = default);
}

public sealed record PointerSnapshot(int X, int Y, bool Visible, string ShapeId, PointerShape? Shape, string Generation, long Version);
public sealed record PointerShape(int Width, int Height, int HotX, int HotY, string Kind, string PngBase64, string? InvertPngBase64 = null);

/// <summary>Encodes pointer pixels only. An unsupported/budget-exceeding shape refuses local-cursor mode.</summary>
internal sealed class PointerPacketBuilder
{
    private static readonly PointerShape Hidden = new(1, 1, 0, 0, "color", Convert.ToBase64String(PngEncoder.EncodeBgraWithAlpha([0, 0, 0, 0], 1, 1, CancellationToken.None)));
    private CursorShape? cachedShape;
    private (string Id, PointerShape Shape)? cached;

    public PointerSnapshot? Build(FramePointer? pointer, MonitorInfo monitor, string? knownShapeId, string generation, long version, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var visible = pointer is { Visible: true, Shape: not null };
        var shape = pointer?.Shape;
        var x = (long)monitor.Left + (pointer?.X ?? 0) + (shape?.HotX ?? 0);
        var y = (long)monitor.Top + (pointer?.Y ?? 0) + (shape?.HotY ?? 0);
        visible &= x >= monitor.Left && x < (long)monitor.Left + monitor.Width && y >= monitor.Top && y < (long)monitor.Top + monitor.Height;
        x = Math.Clamp(x, monitor.Left, (long)monitor.Left + monitor.Width - 1);
        y = Math.Clamp(y, monitor.Top, (long)monitor.Top + monitor.Height - 1);
        if (x is < int.MinValue or > int.MaxValue || y is < int.MinValue or > int.MaxValue) return null;
        if (!visible) return new((int)x, (int)y, false, "hidden-1", knownShapeId == "hidden-1" ? null : Hidden, generation, Math.Max(1, version));
        if (!ReferenceEquals(shape, cachedShape)) { cached = Encode(shape!, cancellationToken); cachedShape = shape; }
        if (cached is not { } encoded) return null;
        return new((int)x, (int)y, true, encoded.Id, knownShapeId == encoded.Id ? null : encoded.Shape, generation, Math.Max(1, version));
    }

    internal static (string Id, PointerShape Shape)? Encode(CursorShape shape, CancellationToken cancellationToken)
    {
        try { CursorCompositor.Validate(shape); } catch (PlatformUnavailableException) { return null; }
        var height = shape.Type == 1 ? shape.Height / 2 : shape.Height;
        if (shape.Width > 256 || height > 256 || shape.HotX < 0 || shape.HotX >= shape.Width || shape.HotY < 0 || shape.HotY >= height) return null;
        var replace = new byte[shape.Width * height * 4]; var invert = new byte[replace.Length]; var hasInvert = false;
        for (var y = 0; y < height; y++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            for (var x = 0; x < shape.Width; x++)
            {
                var target = (y * shape.Width + x) * 4;
                if (shape.Type == 1)
                {
                    var bit = 0x80 >> (x & 7);
                    var and = (shape.Pixels[y * shape.Pitch + x / 8] & bit) != 0;
                    var xor = (shape.Pixels[(y + height) * shape.Pitch + x / 8] & bit) != 0;
                    if (and && xor) { Set(invert, target, 255, 255, 255, 255); hasInvert = true; }
                    else if (!and) Set(replace, target, xor ? (byte)255 : (byte)0, xor ? (byte)255 : (byte)0, xor ? (byte)255 : (byte)0, 255);
                }
                else
                {
                    var source = y * shape.Pitch + x * 4;
                    if (shape.Type == 2 || shape.Pixels[source + 3] == 0)
                        Set(replace, target, shape.Pixels[source], shape.Pixels[source + 1], shape.Pixels[source + 2], shape.Type == 2 ? shape.Pixels[source + 3] : (byte)255);
                    else if ((shape.Pixels[source] | shape.Pixels[source + 1] | shape.Pixels[source + 2]) != 0)
                    {
                        // The negotiated protocol approximates nonwhite masked XOR
                        // with a white difference layer; mono/white XOR are exact.
                        Set(invert, target, 255, 255, 255, 255); hasInvert = true;
                    }
                }
            }
        }
        var png = Convert.ToBase64String(PngEncoder.EncodeBgraWithAlpha(replace, shape.Width, height, cancellationToken));
        var mask = hasInvert ? Convert.ToBase64String(PngEncoder.EncodeBgraWithAlpha(invert, shape.Width, height, cancellationToken)) : null;
        if (png.Length + (mask?.Length ?? 0) > 60_000) return null; // Leave room for bounded metadata in the 64 KiB record.
        Span<byte> metadata = stackalloc byte[24];
        BinaryPrimitives.WriteInt32LittleEndian(metadata, shape.Type); BinaryPrimitives.WriteInt32LittleEndian(metadata[4..], shape.Width);
        BinaryPrimitives.WriteInt32LittleEndian(metadata[8..], shape.Height); BinaryPrimitives.WriteInt32LittleEndian(metadata[12..], shape.Pitch);
        BinaryPrimitives.WriteInt32LittleEndian(metadata[16..], shape.HotX); BinaryPrimitives.WriteInt32LittleEndian(metadata[20..], shape.HotY);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256); hash.AppendData(metadata); hash.AppendData(shape.Pixels.AsSpan(0, checked(shape.Pitch * shape.Height)));
        return (Convert.ToHexString(hash.GetHashAndReset()), new(shape.Width, height, shape.HotX, shape.HotY, shape.Type == 1 ? "mono" : shape.Type == 2 ? "color" : "masked", png, mask));
    }
    private static void Set(byte[] pixels, int offset, byte b, byte g, byte r, byte a) { pixels[offset] = b; pixels[offset + 1] = g; pixels[offset + 2] = r; pixels[offset + 3] = a; }
}
