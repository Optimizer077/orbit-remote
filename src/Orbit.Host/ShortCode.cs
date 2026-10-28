using System.Security.Cryptography;

namespace Orbit.Host;

/// <summary>
/// EXPERIMENTAL (F33, disabled by default): the short pairing code. Exactly 40
/// CSPRNG bits (five bytes) encoded as eight Crockford base32 symbols, shown as
/// XXXX-XXXX. Every 5-bit group maps to one symbol, so there is no modulo bias.
/// </summary>
internal static class ShortCode
{
    internal const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    internal const int Length = 8;
    private const int MaximumInputLength = 32;

    internal static string Generate()
    {
        Span<byte> bytes = stackalloc byte[5];
        RandomNumberGenerator.Fill(bytes);
        try { return Encode(bytes); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal static string Encode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != 5) throw new ArgumentException("A short code encodes exactly five bytes.");
        ulong value = 0;
        foreach (var item in bytes) value = value << 8 | item;
        Span<char> symbols = stackalloc char[Length];
        for (var index = Length - 1; index >= 0; index--) { symbols[index] = Alphabet[(int)(value & 31)]; value >>= 5; }
        return new string(symbols);
    }

    internal static string Format(string canonical) =>
        canonical.Length == Length ? canonical[..4] + "-" + canonical[4..] : throw new ArgumentException("A short code has eight symbols.");

    /// <summary>
    /// The only normalisation rule. ASCII only; spaces and hyphens are ignored
    /// anywhere; case-insensitive; Crockford decoding maps O to 0 and I/L to 1.
    /// U and every other character are invalid. Returns null unless exactly
    /// eight symbols remain.
    /// </summary>
    internal static string? Normalize(string? input)
    {
        if (input is null || input.Length > MaximumInputLength) return null;
        Span<char> symbols = stackalloc char[Length];
        var count = 0;
        foreach (var raw in input)
        {
            if (raw is ' ' or '-') continue;
            if (raw > 127) return null;
            var symbol = raw is >= 'a' and <= 'z' ? (char)(raw - 32) : raw;
            symbol = symbol switch { 'O' => '0', 'I' or 'L' => '1', _ => symbol };
            if (count == Length || Alphabet.IndexOf(symbol) < 0) return null;
            symbols[count++] = symbol;
        }
        return count == Length ? new string(symbols) : null;
    }
}
