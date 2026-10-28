using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Agreement.Srp;
using Org.BouncyCastle.Crypto.Digests;
using Org.BouncyCastle.Crypto.Parameters;
using BigInteger = Org.BouncyCastle.Math.BigInteger;

namespace Orbit.Host;

/// <summary>
/// EXPERIMENTAL (F33, disabled by default) short-code pairing profile: SRP-6a
/// with the RFC 5054 3072-bit group and SHA-256 (Bouncy Castle C#), followed by
/// Orbit's mutual HMAC-SHA256 confirmations over a canonical transcript. Both SRP
/// roles run in the .NET host. docs/PROTOCOL.md defines the byte layout.
/// </summary>
internal static class ShortPairProtocol
{
    internal const string Protocol = "orbit-short-pair";
    internal const ushort Version = 1;
    internal const string Suite = "SRP6a-RFC5054-3072-SHA256/HMAC-SHA256";
    internal const string SrpIdentity = "orbit-short-pair-v1";
    internal const string HostConfirmationLabel = "orbit-short-pair v1 confirmation host-to-viewer";
    internal const string ViewerConfirmationLabel = "orbit-short-pair v1 confirmation viewer-to-host";
    internal const int GroupBytes = 384, HashBytes = 32, NonceBytes = 32, InstanceBytes = 16, AttemptBytes = 16, SaltBytes = 32, FingerprintBytes = 32;
    internal const byte RoleShared = 0x00, RoleHost = 0x01, RoleViewer = 0x02;
    internal const byte TagProtocol = 0x01, TagVersion = 0x02, TagSuite = 0x03, TagInstance = 0x04, TagAttempt = 0x05, TagNonce = 0x06,
        TagExpiry = 0x07, TagGrants = 0x08, TagSalt = 0x09, TagPublicValue = 0x0A, TagFingerprint = 0x0B;
    internal const string StartPath = "/api/short-pair/start", VerifyPath = "/api/short-pair/verify", ConfirmPath = "/api/short-pair/confirm";

    internal static Srp6GroupParameters Group => Srp6StandardGroups.rfc5054_3072;
    internal static Sha256Digest Digest() => new();
    internal static byte[] Identity() => Encoding.ASCII.GetBytes(SrpIdentity);

    internal sealed record TranscriptInput(byte[] InstanceId, byte[] AttemptId, byte[] ViewerNonce, byte[] HostNonce, long ExpiresAtUnixSeconds,
        DevicePermissions Grants, byte[] Salt, byte[] A, byte[] B, byte[] HostFingerprint, byte[] ViewerFingerprint);

    /// <summary>Canonical transcript: fixed-order [tag u8][role u8][length u16 BE][value] fields, all mandatory.</summary>
    internal static byte[] Transcript(TranscriptInput input)
    {
        RequireLength(input.InstanceId, InstanceBytes); RequireLength(input.AttemptId, AttemptBytes); RequireLength(input.ViewerNonce, NonceBytes);
        RequireLength(input.HostNonce, NonceBytes); RequireLength(input.Salt, SaltBytes); RequireLength(input.A, GroupBytes); RequireLength(input.B, GroupBytes);
        RequireLength(input.HostFingerprint, FingerprintBytes); RequireLength(input.ViewerFingerprint, FingerprintBytes);
        if (!input.Grants.IsValid) throw new ArgumentException("Short-code grants are invalid.");
        var output = new MemoryStream(1088);
        Span<byte> version = stackalloc byte[2]; BinaryPrimitives.WriteUInt16BigEndian(version, Version);
        Span<byte> expiry = stackalloc byte[8]; BinaryPrimitives.WriteInt64BigEndian(expiry, input.ExpiresAtUnixSeconds);
        Field(output, TagProtocol, RoleShared, Encoding.ASCII.GetBytes(Protocol));
        Field(output, TagVersion, RoleShared, version);
        Field(output, TagSuite, RoleShared, Encoding.ASCII.GetBytes(Suite));
        Field(output, TagInstance, RoleHost, input.InstanceId);
        Field(output, TagAttempt, RoleHost, input.AttemptId);
        Field(output, TagNonce, RoleViewer, input.ViewerNonce);
        Field(output, TagNonce, RoleHost, input.HostNonce);
        Field(output, TagExpiry, RoleHost, expiry);
        Field(output, TagGrants, RoleHost, [GrantBits(input.Grants)]);
        Field(output, TagSalt, RoleHost, input.Salt);
        Field(output, TagPublicValue, RoleViewer, input.A);
        Field(output, TagPublicValue, RoleHost, input.B);
        Field(output, TagFingerprint, RoleHost, input.HostFingerprint);
        Field(output, TagFingerprint, RoleViewer, input.ViewerFingerprint);
        return output.ToArray();
    }

    // Untrusted expiry must lie within an hour of now; ordered comparisons cannot overflow like a subtraction can.
    internal static bool IsPlausibleExpiry(long expiresAt, long now) => expiresAt >= now - 3600 && expiresAt <= now + 3600;

    /// <summary>Canonical SRP public value: exactly 384 bytes and 0 &lt; value &lt; N (rejects 0, N and every value at or above N).</summary>
    internal static bool IsCanonicalElement(byte[] value)
    {
        if (value.Length != GroupBytes) return false;
        var number = new BigInteger(1, value);
        return number.SignValue > 0 && number.CompareTo(Group.N) < 0;
    }

    internal static byte GrantBits(DevicePermissions grants) => (byte)((grants.View ? 0x01 : 0) | (grants.Control ? 0x02 : 0) |
        (grants.Clipboard ? 0x04 : 0) | (grants.Files ? 0x08 : 0) | (grants.Power ? 0x10 : 0));

    /// <summary>confirmation = HMAC-SHA256(HMAC-SHA256(K, direction label), transcript). Distinct keys per direction prevent reflection.</summary>
    internal static byte[] Confirmation(ReadOnlySpan<byte> sessionKey, bool hostToViewer, ReadOnlySpan<byte> transcript)
    {
        if (sessionKey.Length != HashBytes) throw new ArgumentException("The SRP session key has the wrong length.");
        var key = HMACSHA256.HashData(sessionKey, Encoding.ASCII.GetBytes(hostToViewer ? HostConfirmationLabel : ViewerConfirmationLabel));
        try { return HMACSHA256.HashData(key, transcript); }
        finally { CryptographicOperations.ZeroMemory(key); }
    }

    internal static BigInteger Verifier(byte[] salt, string canonicalCode)
    {
        RequireLength(salt, SaltBytes);
        var generator = new Srp6VerifierGenerator();
        generator.Init(Group, Digest());
        var password = Encoding.ASCII.GetBytes(canonicalCode);
        try { return generator.GenerateVerifier(salt, Identity(), password); }
        finally { CryptographicOperations.ZeroMemory(password); }
    }

    /// <summary>Fixed-length unsigned big-endian bytes: group elements use 384 bytes, SRP hashes and K use 32.</summary>
    internal static byte[] Unsigned(BigInteger value, int length)
    {
        var bytes = value.ToByteArrayUnsigned();
        if (value.SignValue < 0 || bytes.Length > length) throw new ArgumentException("SRP value exceeds its encoded length.");
        if (bytes.Length == length) return bytes;
        var padded = new byte[length];
        bytes.CopyTo(padded, length - bytes.Length);
        CryptographicOperations.ZeroMemory(bytes);
        return padded;
    }

    internal static byte[] FingerprintFromHex(string fingerprint)
    {
        if (fingerprint.Length != FingerprintBytes * 2) throw new ArgumentException("Certificate fingerprint must be SHA-256 hex.");
        return Convert.FromHexString(fingerprint);
    }

    internal static string Encode(ReadOnlySpan<byte> bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Strict unpadded base64url with an exact decoded length; any other spelling is rejected.</summary>
    internal static byte[]? Decode(string? value, int length)
    {
        if (value is null || value.Length != (length * 4 + 2) / 3 || value.Any(c => !(c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_'))) return null;
        var text = value.Replace('-', '+').Replace('_', '/');
        try
        {
            var bytes = Convert.FromBase64String(text.PadRight((text.Length + 3) / 4 * 4, '='));
            return bytes.Length == length && Encode(bytes) == value ? bytes : null;
        }
        catch (FormatException) { return null; }
    }

    /// <summary>Requires an object with exactly these properties: missing, duplicate or unknown fields are rejected.</summary>
    internal static bool HasExactly(JsonElement element, params string[] names)
    {
        if (element.ValueKind != JsonValueKind.Object) return false;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
            if (!names.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name)) return false;
        return seen.Count == names.Length;
    }

    internal static string? String(JsonElement element, string name) =>
        element.GetProperty(name).ValueKind == JsonValueKind.String ? element.GetProperty(name).GetString() : null;

    internal static DevicePermissions? Grants(JsonElement element)
    {
        if (!HasExactly(element, "view", "control", "clipboard", "files", "power")) return null;
        bool Flag(string name) => element.GetProperty(name).ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, _ => throw new FormatException() };
        try
        {
            var grants = new DevicePermissions(Flag("view"), Flag("control"), Flag("clipboard"), Flag("files"), Flag("power"));
            return grants.IsValid ? grants : null;
        }
        catch (FormatException) { return null; }
    }

    private static void Field(Stream output, byte tag, byte role, ReadOnlySpan<byte> value)
    {
        Span<byte> header = stackalloc byte[4];
        header[0] = tag; header[1] = role;
        BinaryPrimitives.WriteUInt16BigEndian(header[2..], checked((ushort)value.Length));
        output.Write(header); output.Write(value);
    }

    private static void RequireLength(byte[] value, int length)
    {
        if (value.Length != length) throw new ArgumentException("A short-code transcript field has the wrong length.");
    }
}
