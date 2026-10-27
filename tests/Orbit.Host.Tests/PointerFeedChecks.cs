using System.Buffers.Binary;
using System.IO.Compression;
using Orbit.Host.Platform;

public static class PointerFeedChecks
{
    public static void Run(Action<bool, string> check)
    {
        var color = PointerPacketBuilder.Encode(new(2, 1, 1, 4, [10, 20, 30, 128]), CancellationToken.None)!.Value;
        check(Decode(color.Shape.PngBase64).SequenceEqual(new byte[] { 0, 30, 20, 10, 128 }), "Pointer PNG preserves RGBA alpha and channel order");
        check(color.Shape.Kind == "color" && color.Shape.InvertPngBase64 is null, "Color pointer uses only the normal layer");
        var mono = PointerPacketBuilder.Encode(new(1, 4, 2, 1, [0x30, 0x50]), CancellationToken.None)!.Value;
        var monoReplace = Decode(mono.Shape.PngBase64); var monoInvert = Decode(mono.Shape.InvertPngBase64!);
        check(mono.Shape.Height == 1 && mono.Shape.Kind == "mono" && monoReplace[4] == 255 && monoReplace[5] == 255 && monoReplace[8] == 255 && monoReplace[12] == 0 && monoReplace[16] == 0,
            "Monochrome pointer normal layer distinguishes black white and transparent pixels");
        check(monoInvert[4] == 0 && monoInvert[8] == 0 && monoInvert[12] == 0 && monoInvert[13] == 255 && monoInvert[16] == 255,
            "Monochrome invert pixel is an opaque white difference layer");
        var masked = PointerPacketBuilder.Encode(new(4, 3, 1, 12, [1, 2, 3, 0, 255, 255, 255, 1, 0, 0, 0, 255]), CancellationToken.None)!.Value;
        var maskedReplace = Decode(masked.Shape.PngBase64); var maskedInvert = Decode(masked.Shape.InvertPngBase64!);
        check(maskedReplace[1] == 3 && maskedReplace[4] == 255 && maskedReplace[8] == 0 && maskedInvert[8] == 255 && maskedInvert[12] == 0,
            "Masked pointer replacement and nonzero-alpha XOR use separate layers; XOR zero leaves pixels unchanged");
        check(PointerPacketBuilder.Encode(new(2, 257, 1, 1028, new byte[1028]), CancellationToken.None) is null,
            "Oversized native cursor refuses local mode instead of allocating an unbounded record");
        check(PointerPacketBuilder.Encode(new(2, 1, 1, 4, [0, 0, 0, 255], 1, 0), CancellationToken.None) is null,
            "Hotspots outside the shape are rejected");
        var random = new byte[256 * 256 * 4]; new Random(42).NextBytes(random);
        check(PointerPacketBuilder.Encode(new(2, 256, 256, 1024, random), CancellationToken.None) is null,
            "Incompressible cursor shapes cannot exceed the negotiated record budget");
        var monitor = new MonitorInfo("synthetic", "Synthetic", -100, -50, 100, 100, true);
        var shape = new CursorShape(2, 2, 3, 8, new byte[24], 1, 2); var builder = new PointerPacketBuilder();
        var packet = builder.Build(new(true, -1, 2, shape), monitor, null, "generation", 3, CancellationToken.None)!;
        check(packet.X == -100 && packet.Y == -46 && packet.Visible && packet.Shape is not null && packet.Version == 3,
            "Local pointer coordinates use the global physical hotspot including negative monitor origins");
        var known = builder.Build(new(true, 0, 3, shape), monitor, packet.ShapeId, "generation", 4, CancellationToken.None)!;
        check(known.Shape is null && known.ShapeId == packet.ShapeId && known.X == -99, "Known pointer shapes are omitted while authoritative positions continue");
        var hidden = builder.Build(new(false, -500, 500, null), monitor, null, "generation", 5, CancellationToken.None)!;
        check(!hidden.Visible && hidden.X == -100 && hidden.Y == 49 && hidden.Shape is { Width: 1, Height: 1 },
            "Hidden pointers still carry valid bounded coordinates and an initially defined transparent shape");
        check(builder.Build(new(false, 0, 0, null), monitor, hidden.ShapeId, "generation", 6, CancellationToken.None)!.Shape is null,
            "A known hidden pointer does not resend its transparent layer");
        var same = PointerPacketBuilder.Encode(new(2, 1, 1, 4, [10, 20, 30, 128, 99]), CancellationToken.None)!.Value;
        check(same.Id == color.Id, "Pointer shape identity excludes unused native trailing bytes");
        using var canceled = new CancellationTokenSource(); canceled.Cancel(); var interrupted = false;
        try { builder.Build(null, monitor, null, "generation", 1, canceled.Token); } catch (OperationCanceledException) { interrupted = true; }
        check(interrupted, "Canceled pointer work stops before encoding or delivery");
    }

    private static byte[] Decode(string base64)
    {
        var png = Convert.FromBase64String(base64);
        if (png[24] != 8 || png[25] != 6) throw new InvalidOperationException("Pointer PNG must be RGBA8.");
        using var compressed = new MemoryStream();
        for (var offset = 8; offset < png.Length;)
        {
            var length = BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(offset));
            if (png.AsSpan(offset + 4, 4).SequenceEqual("IDAT"u8)) compressed.Write(png.AsSpan(offset + 8, length));
            offset += length + 12;
        }
        compressed.Position = 0; using var zlib = new ZLibStream(compressed, CompressionMode.Decompress); using var raw = new MemoryStream(); zlib.CopyTo(raw); return raw.ToArray();
    }
}
