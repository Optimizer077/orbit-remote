namespace Orbit.Host.Platform;

internal sealed record CursorShape(int Type, int Width, int Height, int Pitch, byte[] Pixels, int HotX = 0, int HotY = 0);
internal sealed record FramePointer(bool Visible, int X, int Y, CursorShape? Shape);

internal static class CursorCompositor
{
    public const int MaximumShapeBytes = 4 * 1024 * 1024;
    public static void Validate(CursorShape shape)
    {
        if (shape.Type is not (1 or 2 or 4) || shape.Width is <= 0 or > 2048 || shape.Height is <= 0 or > 4096 ||
            shape.Type == 1 && shape.Height % 2 != 0 || shape.Pitch <= 0 || shape.Pixels.Length > MaximumShapeBytes ||
            (long)shape.Pitch * shape.Height > shape.Pixels.Length || shape.Pitch < (shape.Type == 1 ? (shape.Width + 7) / 8 : shape.Width * 4))
            throw new PlatformUnavailableException("cursor-unavailable", "The desktop cursor shape is unsupported; native fallback is required.");
    }

    public static bool SameDrawnState(FramePointer? a, FramePointer? b)
    {
        var visibleA = a is { Visible: true, Shape: not null }; var visibleB = b is { Visible: true, Shape: not null };
        if (!visibleA || !visibleB) return visibleA == visibleB;
        var first = a!.Shape!; var second = b!.Shape!;
        return a.X == b.X && a.Y == b.Y && (ReferenceEquals(first, second) || first.Type == second.Type && first.Width == second.Width && first.Height == second.Height &&
            first.Pitch == second.Pitch && first.HotX == second.HotX && first.HotY == second.HotY && first.Pixels.AsSpan(0, checked(first.Pitch * first.Height)).SequenceEqual(second.Pixels.AsSpan(0, checked(second.Pitch * second.Height))));
    }

    // DXGI gives the pointer's top-left, independent of its informational hotspot.
    // The original desktop buffer stays cursor-free for pointer-only updates.
    public static void Draw(byte[] desktop, int width, int height, FramePointer? pointer)
    {
        if (desktop.Length != checked(width * height * 4)) throw new ArgumentException("Invalid desktop pixel buffer.");
        if (pointer is not { Visible: true, Shape: { } shape }) return;
        Validate(shape);
        var cursorHeight = shape.Type == 1 ? shape.Height / 2 : shape.Height;
        var firstY = (int)Math.Clamp(-(long)pointer.Y, 0, cursorHeight); var lastY = (int)Math.Clamp((long)height - pointer.Y, 0, cursorHeight);
        var firstX = (int)Math.Clamp(-(long)pointer.X, 0, shape.Width); var lastX = (int)Math.Clamp((long)width - pointer.X, 0, shape.Width);
        for (var cy = firstY; cy < lastY; cy++)
        {
            var y = (long)pointer.Y + cy; if (y < 0 || y >= height) continue;
            for (var cx = firstX; cx < lastX; cx++)
            {
                var x = (long)pointer.X + cx; if (x < 0 || x >= width) continue;
                var target = checked(((int)y * width + (int)x) * 4);
                if (shape.Type == 1)
                {
                    var bit = 0x80 >> (cx & 7);
                    var and = (shape.Pixels[cy * shape.Pitch + cx / 8] & bit) != 0 ? 255 : 0;
                    var xor = (shape.Pixels[(cy + cursorHeight) * shape.Pitch + cx / 8] & bit) != 0 ? 255 : 0;
                    for (var channel = 0; channel < 3; channel++) desktop[target + channel] = (byte)((desktop[target + channel] & and) ^ xor);
                }
                else
                {
                    var source = cy * shape.Pitch + cx * 4; var alpha = shape.Pixels[source + 3];
                    for (var channel = 0; channel < 3; channel++)
                        desktop[target + channel] = shape.Type == 4
                            ? alpha != 0 ? (byte)(desktop[target + channel] ^ shape.Pixels[source + channel]) : shape.Pixels[source + channel]
                            : (byte)((shape.Pixels[source + channel] * alpha + desktop[target + channel] * (255 - alpha) + 127) / 255);
                }
            }
        }
    }
}
