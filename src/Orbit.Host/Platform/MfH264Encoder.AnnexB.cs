namespace Orbit.Host.Platform;

// Annex-B parsing for MfH264Encoder (split for the file-size limit). Pure managed code, safe on every OS.
internal sealed partial class MfH264Encoder
{
    /// <summary>A NAL unit inside an Annex-B buffer: start-code offset, payload offset (header byte) and payload length.</summary>
    internal readonly record struct NalUnit(int StartCodeOffset, int Offset, int Length, int Type);

    /// <summary>Splits an Annex-B byte stream on 3- or 4-byte start codes.</summary>
    internal static List<NalUnit> EnumerateNalUnits(ReadOnlySpan<byte> stream)
    {
        var result = new List<NalUnit>();
        var starts = new List<(int StartCode, int Payload)>();
        for (var i = 0; i + 3 <= stream.Length; i++)
        {
            if (stream[i] != 0 || stream[i + 1] != 0 || stream[i + 2] != 1) continue;
            var startCode = i > 0 && stream[i - 1] == 0 ? i - 1 : i;
            starts.Add((startCode, i + 3));
            i += 2;
        }
        for (var n = 0; n < starts.Count; n++)
        {
            var end = n + 1 < starts.Count ? starts[n + 1].StartCode : stream.Length;
            var length = end - starts[n].Payload;
            if (length > 0) result.Add(new NalUnit(starts[n].StartCode, starts[n].Payload, length, stream[starts[n].Payload] & 0x1F));
        }
        return result;
    }

    internal static bool ContainsNal(ReadOnlySpan<byte> stream, int type) => EnumerateNalUnits(stream).Any(n => n.Type == type);

    /// <summary>
    /// Splits Annex-B output into access units (simplified H.264 7.4.1.2.3): a new unit starts at an access unit
    /// delimiter, or, once the current unit has a picture, at SEI/SPS/PPS or at a slice with first_mb_in_slice == 0.
    /// Further slices of the same picture stay in its unit.
    /// </summary>
    internal static List<byte[]> SplitAccessUnits(byte[] stream)
    {
        var nals = EnumerateNalUnits(stream);
        var starts = new List<int> { 0 };
        var hasPicture = false;
        for (var i = 0; i < nals.Count; i++)
        {
            var n = nals[i];
            var picture = n.Type is 1 or 5;
            var firstSlice = picture && n.Length > 1 && (stream[n.Offset + 1] & 0x80) != 0; // ue(v) first_mb_in_slice == 0 is a single 1 bit
            if (i > 0 && (n.Type == 9 && starts[^1] != n.StartCodeOffset || hasPicture && (n.Type is 6 or 7 or 8 || firstSlice)))
            {
                if (starts[^1] != n.StartCodeOffset) starts.Add(n.StartCodeOffset);
                hasPicture = false;
            }
            hasPicture |= picture;
        }
        var result = new List<byte[]>(starts.Count);
        for (var i = 0; i < starts.Count; i++)
            result.Add(stream.AsSpan(starts[i], (i + 1 < starts.Count ? starts[i + 1] : stream.Length) - starts[i]).ToArray());
        return result;
    }

    /// <summary>RFC 6381 "avc1.PPCCLL" from SPS bytes 1..3 (profile_idc, constraint flags, level_idc).</summary>
    internal static string CodecStringFromSps(ReadOnlySpan<byte> sps) => $"avc1.{sps[1]:X2}{sps[2]:X2}{sps[3]:X2}";
}
