using System.Buffers.Binary;
using System.IO.Compression;

namespace Orbit.Host.Platform;

/// <summary>A bounded, dependency-free PNG encoder for GDI's top-down BGRA pixel buffers.</summary>
internal static class PngEncoder
{
    private static readonly uint[] CrcTable = BuildCrcTable();
    public static byte[] EncodeBgra(byte[] pixels, int width, int height, CancellationToken cancellationToken)
    {
        PlatformLimits.CheckDimensions(width, height);
        if (pixels.Length != checked(width * height * 4)) throw new ArgumentException("Invalid pixel buffer.", nameof(pixels));
        using var png = new MemoryStream();
        png.Write([137, 80, 78, 71, 13, 10, 26, 10]);
        Span<byte> header = stackalloc byte[13];
        header.Clear();
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header[4..], height);
        header[8] = 8; header[9] = 2; // 8-bit RGB. GDI alpha is undefined, so never encode it.
        WriteChunk(png, "IHDR"u8, header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true))
        {
            var row = new byte[checked(width * 3 + 1)];
            for (var y = 0; y < height; y++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                for (int x = 0, source = y * width * 4, target = 1; x < width; x++, source += 4, target += 3)
                {
                    row[target] = pixels[source + 2]; row[target + 1] = pixels[source + 1]; row[target + 2] = pixels[source];
                }
                zlib.Write(row);
            }
        }
        WriteChunk(png, "IDAT"u8, compressed.GetBuffer().AsSpan(0, checked((int)compressed.Length)));
        WriteChunk(png, "IEND"u8, []);
        return png.ToArray();
    }

    internal static (int Width, int Height) ReadDimensions(ReadOnlySpan<byte> data)
    {
        if (data.Length < 33 || !data[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) ||
            !data.Slice(12, 4).SequenceEqual("IHDR"u8))
            throw new PlatformUnavailableException("invalid-frame", "The capture tool did not return a PNG image.");
        var width = BinaryPrimitives.ReadInt32BigEndian(data.Slice(16, 4));
        var height = BinaryPrimitives.ReadInt32BigEndian(data.Slice(20, 4));
        PlatformLimits.CheckDimensions(width, height);
        return (width, height);
    }

    private static void WriteChunk(Stream output, ReadOnlySpan<byte> type, ReadOnlySpan<byte> data)
    {
        Span<byte> value = stackalloc byte[4];
        BinaryPrimitives.WriteInt32BigEndian(value, data.Length); output.Write(value); output.Write(type); output.Write(data);
        var crc = UpdateCrc(UpdateCrc(0xFFFFFFFF, type), data) ^ 0xFFFFFFFF;
        BinaryPrimitives.WriteUInt32BigEndian(value, crc); output.Write(value);
    }

    private static uint UpdateCrc(uint crc, ReadOnlySpan<byte> bytes)
    {
        foreach (var b in bytes)
        {
            crc = (crc >> 8) ^ CrcTable[(byte)(crc ^ b)];
        }
        return crc;
    }

    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (var i = 0; i < table.Length; i++)
        {
            var crc = (uint)i;
            for (var bit = 0; bit < 8; bit++) crc = (crc >> 1) ^ ((crc & 1) == 1 ? 0xEDB88320u : 0);
            table[i] = crc;
        }
        return table;
    }
}
