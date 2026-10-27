using System.Runtime.InteropServices;
using System.Runtime.Intrinsics;

namespace Orbit.Host.Platform;

/// <summary>Which BGRA-to-NV12 loop to run. All produce bit-identical output; Auto picks the widest accelerated one.</summary>
internal enum Nv12Kernel { Auto, Scalar, Vector128, Vector256 }

// BGRA to NV12 conversion, split from MfH264Encoder.cs (file-size limit). Pure managed code, safe on every OS.
internal sealed partial class MfH264Encoder
{
    /// <summary>
    /// BGRA (stride = width*4) to NV12 with BT.709 limited-range coefficients (10-bit fixed point). The destination is
    /// encodedWidth x encodedHeight (each at most one larger than the source); missing edge pixels replicate the last
    /// column/row. Uses the fastest accelerated vector width (<see cref="AutoKernel"/>; all paths are bit-identical) and splits row
    /// pairs into at most <paramref name="maxBands"/> thread-pool bands (0 = <see cref="DefaultConversionBands"/>).
    /// </summary>
    internal static void ConvertBgraToNv12(ReadOnlyMemory<byte> bgra, int width, int height, byte[] nv12, int encodedWidth, int encodedHeight,
        int maxBands = 0, Nv12Kernel kernel = Nv12Kernel.Auto)
    {
        var pairs = encodedHeight / 2;
        var vector = Resolve(kernel);
        var bands = Math.Clamp(maxBands > 0 ? maxBands : DefaultConversionBands, 1, Math.Max(1, pairs / 16));
        if (bands == 1) { ConvertRows(bgra.Span, width, height, nv12, encodedWidth, encodedHeight, 0, pairs, vector); return; }
        Parallel.For(0, bands, band =>
        {
            var first = (int)((long)pairs * band / bands); var last = (int)((long)pairs * (band + 1) / bands);
            ConvertRows(bgra.Span, width, height, nv12, encodedWidth, encodedHeight, first, last, vector);
        });
    }

    /// <summary>Thread-pool bands per conversion: enough to keep large displays fast without occupying every core.</summary>
    internal static int DefaultConversionBands => Math.Clamp(Environment.ProcessorCount / 4, 1, 4);

    private static void ConvertRows(ReadOnlySpan<byte> bgra, int width, int height, Span<byte> nv12, int encodedWidth, int encodedHeight,
        int firstPair, int endPair, Nv12Kernel vector)
    {
        var stride = width * 4;
        var chromaBase = encodedWidth * encodedHeight;
        for (var pair = firstPair; pair < endPair; pair++)
        {
            var y0 = pair * 2;
            var row0 = bgra.Slice(Math.Min(y0, height - 1) * stride, stride);
            var row1 = bgra.Slice(Math.Min(y0 + 1, height - 1) * stride, stride);
            var luma0 = nv12.Slice(y0 * encodedWidth, encodedWidth);
            var luma1 = nv12.Slice((y0 + 1) * encodedWidth, encodedWidth);
            var chroma = nv12.Slice(chromaBase + pair * encodedWidth, encodedWidth);
            var x = 0;
            if (vector == Nv12Kernel.Vector256) for (; x + 16 <= width; x += 16) ConvertBlock16(row0, row1, luma0, luma1, chroma, x);
            else if (vector == Nv12Kernel.Vector128) for (; x + 16 <= width; x += 16) ConvertBlock16x128(row0, row1, luma0, luma1, chroma, x);
            for (; x < encodedWidth; x += 2)
            {
                var a = Math.Min(x, width - 1) * 4; var b = Math.Min(x + 1, width - 1) * 4;
                int b0 = row0[a], g0 = row0[a + 1], r0 = row0[a + 2];
                int b1 = row0[b], g1 = row0[b + 1], r1 = row0[b + 2];
                int b2 = row1[a], g2 = row1[a + 1], r2 = row1[a + 2];
                int b3 = row1[b], g3 = row1[b + 1], r3 = row1[b + 2];
                luma0[x] = Luma(r0, g0, b0); luma0[x + 1] = Luma(r1, g1, b1);
                luma1[x] = Luma(r2, g2, b2); luma1[x + 1] = Luma(r3, g3, b3);
                int r = r0 + r1 + r2 + r3, g = g0 + g1 + g2 + g3, bl = b0 + b1 + b2 + b3; // 4x sums
                chroma[x] = (byte)((-103 * r - 347 * g + 450 * bl + (128 << 12) + 2048) >> 12);
                chroma[x + 1] = (byte)((450 * r - 409 * g - 41 * bl + (128 << 12) + 2048) >> 12);
            }
        }
    }

    /// <summary>16 pixels of two rows: 32 luma bytes and 8 interleaved Cb/Cr pairs, same integer maths as the scalar loop.</summary>
    private static void ConvertBlock16(ReadOnlySpan<byte> row0, ReadOnlySpan<byte> row1, Span<byte> luma0, Span<byte> luma1, Span<byte> chroma, int x)
    {
        ref var s0 = ref MemoryMarshal.GetReference(row0);
        ref var s1 = ref MemoryMarshal.GetReference(row1);
        var offset = (nuint)(x * 4);
        var a0 = Vector256.LoadUnsafe(ref s0, offset); var b0 = Vector256.LoadUnsafe(ref s0, offset + 32);
        var a1 = Vector256.LoadUnsafe(ref s1, offset); var b1 = Vector256.LoadUnsafe(ref s1, offset + 32);
        LumaBlock(a0, b0).StoreUnsafe(ref MemoryMarshal.GetReference(luma0), (nuint)x);
        LumaBlock(a1, b1).StoreUnsafe(ref MemoryMarshal.GetReference(luma1), (nuint)x);

        var (ba0, ga0, ra0) = PairSums(a0.AsUInt64()); var (ba1, ga1, ra1) = PairSums(a1.AsUInt64());
        var (bb0, gb0, rb0) = PairSums(b0.AsUInt64()); var (bb1, gb1, rb1) = PairSums(b1.AsUInt64());
        var bSum = Vector256.Narrow(ba0 + ba1, bb0 + bb1).AsInt32();
        var gSum = Vector256.Narrow(ga0 + ga1, gb0 + gb1).AsInt32();
        var rSum = Vector256.Narrow(ra0 + ra1, rb0 + rb1).AsInt32();
        var bias = Vector256.Create((128 << 12) + 2048);
        var cb = (rSum * -103 + gSum * -347 + bSum * 450 + bias) >> 12;
        var cr = (rSum * 450 + gSum * -409 + bSum * -41 + bias) >> 12;
        var packed = (cb | (cr << 8)).AsUInt32();
        Vector256.Narrow(packed, packed).AsByte().GetLower().StoreUnsafe(ref MemoryMarshal.GetReference(chroma), (nuint)x);
    }

    private static Vector128<byte> LumaBlock(Vector256<byte> first8, Vector256<byte> next8)
    {
        var words = Vector256.Narrow(LumaLanes(first8.AsUInt32()).AsUInt32(), LumaLanes(next8.AsUInt32()).AsUInt32());
        return Vector256.Narrow(words, words).GetLower();
    }

    private static Vector256<int> LumaLanes(Vector256<uint> pixels)
    {
        var mask = Vector256.Create(0xFFu);
        var b = (pixels & mask).AsInt32(); var g = ((pixels >> 8) & mask).AsInt32(); var r = ((pixels >> 16) & mask).AsInt32();
        return (r * 187 + g * 629 + b * 63 + Vector256.Create((16 << 10) + 512)) >> 10;
    }

    /// <summary>Per 64-bit lane (two BGRA pixels): the pair's B, G and R sums.</summary>
    private static (Vector256<ulong> B, Vector256<ulong> G, Vector256<ulong> R) PairSums(Vector256<ulong> q)
    {
        var mask = Vector256.Create(0xFFul);
        return ((q & mask) + ((q >> 32) & mask), ((q >> 8) & mask) + ((q >> 40) & mask), ((q >> 16) & mask) + ((q >> 48) & mask));
    }

    // BT.709 limited range: Y = 16 + 0.1826 R + 0.6142 G + 0.0620 B; Cb/Cr rows above, all scaled by 1024.
    private static byte Luma(int r, int g, int b) => (byte)((187 * r + 629 * g + 63 * b + (16 << 10) + 512) >> 10);

    /// <summary>
    /// The same 16-pixel block with 128-bit vectors: AdvSimd (NEON) on ARM64, SSE on x64. Windows on ARM has no 256-bit
    /// vectors, so before this path it fell back to the scalar loop.
    /// </summary>
    private static void ConvertBlock16x128(ReadOnlySpan<byte> row0, ReadOnlySpan<byte> row1, Span<byte> luma0, Span<byte> luma1, Span<byte> chroma, int x)
    {
        ref var s0 = ref MemoryMarshal.GetReference(row0);
        ref var s1 = ref MemoryMarshal.GetReference(row1);
        var offset = (nuint)(x * 4);
        Vector128<byte> a0 = Vector128.LoadUnsafe(ref s0, offset), b0 = Vector128.LoadUnsafe(ref s0, offset + 16),
            c0 = Vector128.LoadUnsafe(ref s0, offset + 32), d0 = Vector128.LoadUnsafe(ref s0, offset + 48);
        Vector128<byte> a1 = Vector128.LoadUnsafe(ref s1, offset), b1 = Vector128.LoadUnsafe(ref s1, offset + 16),
            c1 = Vector128.LoadUnsafe(ref s1, offset + 32), d1 = Vector128.LoadUnsafe(ref s1, offset + 48);
        LumaBlock128(a0, b0, c0, d0).StoreUnsafe(ref MemoryMarshal.GetReference(luma0), (nuint)x);
        LumaBlock128(a1, b1, c1, d1).StoreUnsafe(ref MemoryMarshal.GetReference(luma1), (nuint)x);

        var low = Chroma4(a0, a1, b0, b1); // chroma samples 0-3 (pixels x..x+7)
        var high = Chroma4(c0, c1, d0, d1); // samples 4-7 (pixels x+8..x+15)
        Vector128.Narrow(low, high).AsByte().StoreUnsafe(ref MemoryMarshal.GetReference(chroma), (nuint)x);
    }

    /// <summary>Four interleaved Cb|Cr&lt;&lt;8 values from two 4-pixel loads of each row.</summary>
    private static Vector128<uint> Chroma4(Vector128<byte> first0, Vector128<byte> first1, Vector128<byte> next0, Vector128<byte> next1)
    {
        var (bf0, gf0, rf0) = PairSums128(first0.AsUInt64()); var (bf1, gf1, rf1) = PairSums128(first1.AsUInt64());
        var (bn0, gn0, rn0) = PairSums128(next0.AsUInt64()); var (bn1, gn1, rn1) = PairSums128(next1.AsUInt64());
        var bSum = Vector128.Narrow(bf0 + bf1, bn0 + bn1).AsInt32();
        var gSum = Vector128.Narrow(gf0 + gf1, gn0 + gn1).AsInt32();
        var rSum = Vector128.Narrow(rf0 + rf1, rn0 + rn1).AsInt32();
        var bias = Vector128.Create((128 << 12) + 2048);
        var cb = (rSum * -103 + gSum * -347 + bSum * 450 + bias) >> 12;
        var cr = (rSum * 450 + gSum * -409 + bSum * -41 + bias) >> 12;
        return (cb | (cr << 8)).AsUInt32();
    }

    private static Vector128<byte> LumaBlock128(Vector128<byte> p0, Vector128<byte> p1, Vector128<byte> p2, Vector128<byte> p3)
    {
        var w01 = Vector128.Narrow(LumaLanes128(p0.AsUInt32()).AsUInt32(), LumaLanes128(p1.AsUInt32()).AsUInt32());
        var w23 = Vector128.Narrow(LumaLanes128(p2.AsUInt32()).AsUInt32(), LumaLanes128(p3.AsUInt32()).AsUInt32());
        return Vector128.Narrow(w01, w23);
    }

    private static Vector128<int> LumaLanes128(Vector128<uint> pixels)
    {
        var mask = Vector128.Create(0xFFu);
        var b = (pixels & mask).AsInt32(); var g = ((pixels >> 8) & mask).AsInt32(); var r = ((pixels >> 16) & mask).AsInt32();
        return (r * 187 + g * 629 + b * 63 + Vector128.Create((16 << 10) + 512)) >> 10;
    }

    private static (Vector128<ulong> B, Vector128<ulong> G, Vector128<ulong> R) PairSums128(Vector128<ulong> q)
    {
        var mask = Vector128.Create(0xFFul);
        return ((q & mask) + ((q >> 32) & mask), ((q >> 8) & mask) + ((q >> 40) & mask), ((q >> 16) & mask) + ((q >> 48) & mask));
    }

    /// <summary>The kernel <see cref="Nv12Kernel.Auto"/> uses on this CPU.</summary>
    internal static Nv12Kernel AutoKernel => Resolve(Nv12Kernel.Auto);

    private static Nv12Kernel Resolve(Nv12Kernel kernel) => kernel != Nv12Kernel.Auto ? kernel
        : Vector256.IsHardwareAccelerated ? Nv12Kernel.Vector256 : Vector128.IsHardwareAccelerated ? Nv12Kernel.Vector128 : Nv12Kernel.Scalar;
}
