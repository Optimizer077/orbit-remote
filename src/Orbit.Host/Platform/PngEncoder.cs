using System.Buffers.Binary;
using System.IO.Compression;

namespace Orbit.Host.Platform;

/// <summary>A bounded, dependency-free PNG encoder for GDI's top-down BGRA pixel buffers.</summary>
internal static class PngEncoder
{
    private static readonly uint[] CrcTable = BuildCrcTable();
    public static byte[] EncodeBgra(byte[] pixels, int width, int height, CancellationToken cancellationToken) =>
        Encode(pixels, width, height, null, cancellationToken)!;
    // Pointer layers have defined alpha, unlike desktop GDI buffers.
    internal static byte[] EncodeBgraWithAlpha(byte[] pixels, int width, int height, CancellationToken cancellationToken) =>
        Encode(pixels, width, height, null, cancellationToken, preserveAlpha: true)!;

    // PNG has 57 bytes of fixed signature/chunk overhead. Stop compression as
    // soon as it cannot beat an already encoded JPEG; never publish a partial PNG.
    public static byte[]? EncodeBgraWithinBudget(byte[] pixels, int width, int height, int maximumBytes, CancellationToken cancellationToken) =>
        Encode(pixels, width, height, maximumBytes, cancellationToken);

    private static byte[]? Encode(byte[] pixels, int width, int height, int? maximumBytes, CancellationToken cancellationToken, bool preserveAlpha = false)
    {
        ArgumentNullException.ThrowIfNull(pixels);
        PlatformLimits.CheckDimensions(width, height);
        if (pixels.Length != checked(width * height * 4)) throw new ArgumentException("Invalid pixel buffer.", nameof(pixels));
        cancellationToken.ThrowIfCancellationRequested();
        if (maximumBytes is < 57) return null;
        using var png = new MemoryStream();
        png.Write([137, 80, 78, 71, 13, 10, 26, 10]);
        Span<byte> header = stackalloc byte[13];
        header.Clear();
        BinaryPrimitives.WriteInt32BigEndian(header, width);
        BinaryPrimitives.WriteInt32BigEndian(header[4..], height);
        header[8] = 8; header[9] = preserveAlpha ? (byte)6 : (byte)2; // Desktop GDI alpha is undefined; only pointer layers preserve it.
        WriteChunk(png, "IHDR"u8, header);
        using var compressed = maximumBytes is { } budget ? new BudgetMemoryStream(budget - 57) : new MemoryStream();
        try
        {
            using var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, leaveOpen: true);
            var channels = preserveAlpha ? 4 : 3;
            var row = new byte[checked(width * channels + 1)];
            for (var y = 0; y < height; y++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                for (int x = 0, source = y * width * 4, target = 1; x < width; x++, source += 4, target += channels)
                {
                    row[target] = pixels[source + 2]; row[target + 1] = pixels[source + 1]; row[target + 2] = pixels[source];
                    if (preserveAlpha) row[target + 3] = pixels[source + 3];
                }
                zlib.Write(row);
            }
        }
        catch (PngBudgetExceededException) { cancellationToken.ThrowIfCancellationRequested(); return null; }
        cancellationToken.ThrowIfCancellationRequested();
        WriteChunk(png, "IDAT"u8, compressed.GetBuffer().AsSpan(0, checked((int)compressed.Length)));
        WriteChunk(png, "IEND"u8, []);
        return png.ToArray();
    }

    private sealed class PngBudgetExceededException : Exception;
    private sealed class BudgetMemoryStream(int maximumBytes) : MemoryStream
    {
        private void Check(int count) { if (Length + count > maximumBytes) throw new PngBudgetExceededException(); }
        public override void Write(byte[] buffer, int offset, int count) { Check(count); base.Write(buffer, offset, count); }
        public override void Write(ReadOnlySpan<byte> buffer) { Check(buffer.Length); base.Write(buffer); }
        public override void WriteByte(byte value) { Check(1); base.WriteByte(value); }
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
