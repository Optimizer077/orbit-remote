using System.Net;
using System.Net.Security;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Orbit.Host;

public static class Security
{
    public static string Fingerprint(X509Certificate2 certificate) => certificate.GetCertHashString(HashAlgorithmName.SHA256);
    public static string RandomToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static string HashToken(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
    public static bool TokenEquals(string? a, string? b)
    {
        if (a is null || b is null || a.Length > 4096 || b.Length > 4096) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(a)), SHA256.HashData(Encoding.UTF8.GetBytes(b)));
    }
    /// <summary>
    /// Display names shown to people. Refuses control characters, every Unicode
    /// format character (category Cf: bidi embedding/override/isolate, zero-width
    /// space/joiners, word joiner U+2060, BOM U+FEFF, Arabic letter mark U+061C and
    /// others) except the plain direction marks LRM/RLM (U+200E/U+200F), the line
    /// and paragraph separators U+2028/U+2029, and invalid UTF-16.
    /// </summary>
    public static bool IsSafeDisplayText(string text)
    {
        var remaining = text.AsSpan();
        while (!remaining.IsEmpty)
        {
            if (Rune.DecodeFromUtf16(remaining, out var rune, out var consumed) != System.Buffers.OperationStatus.Done) return false;
            remaining = remaining[consumed..];
            var category = Rune.GetUnicodeCategory(rune);
            if (category is System.Globalization.UnicodeCategory.Control or System.Globalization.UnicodeCategory.LineSeparator or System.Globalization.UnicodeCategory.ParagraphSeparator) return false;
            if (category == System.Globalization.UnicodeCategory.Format && rune.Value is not (0x200C or 0x200D or 0x200E or 0x200F)) return false;
        }
        return true;
    }
    public static bool IsTailscaleAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        var bytes = address.GetAddressBytes();
        return bytes.Length == 4 ? bytes[0] == 100 && (bytes[1] & 0xc0) == 64 : bytes[0] == 0xfd && bytes[1] == 0x7a && bytes[2] == 0x11 && bytes[3] == 0x5c && bytes[4] == 0xa1 && bytes[5] == 0xe0;
    }
    public static bool IsClientCertificateUsable(X509Certificate2? certificate)
    {
        if (certificate is null || DateTime.UtcNow < certificate.NotBefore.ToUniversalTime() || DateTime.UtcNow > certificate.NotAfter.ToUniversalTime()) return false;
        using var rsa = certificate.GetRSAPublicKey();
        using var ec = certificate.GetECDsaPublicKey();
        if (rsa is null && ec is null || rsa is not null && rsa.KeySize < 2048 || ec is not null && ec.KeySize < 256) return false;
        var usages = certificate.Extensions.OfType<X509EnhancedKeyUsageExtension>().ToArray();
        return usages.Length > 0 && usages.Any(extension => extension.EnhancedKeyUsages.Cast<Oid>().Any(oid => oid.Value == "1.3.6.1.5.5.7.3.2"));
    }

    // Orbit's link policy: every accepted suite has ephemeral (forward-secret) key
    // exchange and authenticated encryption. TLS 1.3 suites all qualify. TLS 1.2 stays
    // available only with ECDHE + AES-GCM/ChaCha20-Poly1305 because some platform TLS
    // stacks (notably .NET on macOS) may not serve TLS 1.3.
    private static readonly HashSet<TlsCipherSuite> StrongTls13Suites =
    [
        TlsCipherSuite.TLS_AES_256_GCM_SHA384, TlsCipherSuite.TLS_CHACHA20_POLY1305_SHA256, TlsCipherSuite.TLS_AES_128_GCM_SHA256,
    ];
    private static readonly HashSet<TlsCipherSuite> StrongTls12Suites =
    [
        TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
        TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, TlsCipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
        TlsCipherSuite.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, TlsCipherSuite.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
    ];
    public static bool IsStrongTls(SslProtocols protocol, TlsCipherSuite? suite) => suite is { } value && protocol switch
    {
        SslProtocols.Tls13 => StrongTls13Suites.Contains(value),
        SslProtocols.Tls12 => StrongTls12Suites.Contains(value),
        _ => false,
    };

    public static string ValidateFileName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name.Length > 180 || name is "." or ".." || name.Contains('/') || name.Contains('\\') || name.Contains(':') || name.Any(c => c < 32) || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.EndsWith('.') || name.EndsWith(' '))
            throw new ArgumentException("Use a plain file name without directories.");
        // Legacy Win32 path parsing ignores trailing spaces and dots before the
        // extension, so "CON .txt" and "NUL. .log" still name a device there.
        var stem = name.Split('.')[0].TrimEnd(' ', '.').ToUpperInvariant();
        if (ReservedDeviceNames.Contains(stem)) throw new ArgumentException("Reserved file name.");
        return name;
    }

    // Windows device names, including COM0/LPT0 and the superscript-digit forms
    // (U+00B9, U+00B2, U+00B3) that Win32 also treats as COM/LPT ports.
    private static readonly HashSet<string> ReservedDeviceNames = new(StringComparer.Ordinal)
    {
        "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$",
        "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM¹", "COM²", "COM³",
        "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "LPT¹", "LPT²", "LPT³",
    };

    public static string? SelectFrameMonitor(string? requestedMonitorId, string? sessionMonitorId)
    {
        if (requestedMonitorId is null) return sessionMonitorId;
        if (requestedMonitorId.Length is 0 or > 128 || requestedMonitorId.Any(char.IsControl))
            throw new ArgumentException("monitorId must contain 1 to 128 printable characters.");
        return requestedMonitorId;
    }

    public static void RestrictFile(string path)
    {
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
    public static void RestrictDirectory(string path)
    {
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
    public static void CreatePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows()) Directory.CreateDirectory(path);
        else Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        RestrictDirectory(path);
    }
    public static void WritePrivateNewFile(string path, byte[] bytes)
    {
        var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using var output = new FileStream(path, options);
        output.Write(bytes); output.Flush(flushToDisk: true); RestrictFile(path);
    }
}

public sealed class HostIdentity : IDisposable
{
    // Windows Schannel needs a key container, and macOS rejects EphemeralKeySet.
    // Use a temporary user import on those platforms (no PersistKeySet); disposal
    // releases it. The durable profile identity remains protected separately.
    private static X509KeyStorageFlags KeyFlags => X509KeyStorageFlags.Exportable |
        (OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? X509KeyStorageFlags.UserKeySet : X509KeyStorageFlags.EphemeralKeySet);
    private readonly string identityPath;
    private readonly string hostId;
    private readonly IPAddress? address;
    public X509Certificate2 Certificate { get; }
    public string Fingerprint => Security.Fingerprint(Certificate);
    public IdentityHealth Health => IdentityHealth.FromCertificate(Certificate);
    public HostIdentity(string directory, string hostId, IPAddress? address, bool allowExpiredForLocalAdministration = false)
    {
        this.hostId = hostId; this.address = address;
        var path = identityPath = Path.Combine(directory, OperatingSystem.IsWindows() ? "identity.dpapi" : "identity.pfx");
        if (File.Exists(path))
        {
            var encoded = File.ReadAllBytes(path);
            var pfx = OperatingSystem.IsWindows() ? WindowsSecret.Unprotect(encoded) : encoded;
            try { Certificate = X509CertificateLoader.LoadPkcs12(pfx, null, KeyFlags); }
            finally { CryptographicOperations.ZeroMemory(pfx); }
        }
        else
        {
            var pfx = CreatePfx();
            try
            {
                Security.WritePrivateNewFile(path, OperatingSystem.IsWindows() ? WindowsSecret.Protect(pfx) : pfx);
                Certificate = X509CertificateLoader.LoadPkcs12(pfx, null, KeyFlags);
            }
            finally { CryptographicOperations.ZeroMemory(pfx); }
        }
        if (Health.Expired && !allowExpiredForLocalAdministration) { Certificate.Dispose(); throw new InvalidOperationException("Host identity expired. Rotate the identity and pair devices again."); }
    }
    public object ExportForLocalController()
    {
        if (Health.Expired) throw new InvalidOperationException("Host identity expired. Rotate it locally and pair devices again before connecting.");
        using var rsa = Certificate.GetRSAPrivateKey() ?? throw new InvalidOperationException("Host identity is missing its private key.");
        return new { certificatePem = Certificate.ExportCertificatePem(), privateKeyPem = rsa.ExportPkcs8PrivateKeyPem(), fingerprint = Fingerprint };
    }
    // The live listener retains the old certificate until graceful restart. Never
    // overwrite its object or silently update peers' certificate pins.
    public void Rotate(string? expectedFingerprint, Action invalidatePairings)
    {
        if (!Security.TokenEquals(expectedFingerprint, Fingerprint)) throw new ArgumentException("The current identity changed. Review its fingerprint and confirm again.");
        var temporary = identityPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var pfx = CreatePfx();
        try
        {
            Security.WritePrivateNewFile(temporary, OperatingSystem.IsWindows() ? WindowsSecret.Protect(pfx) : pfx);
            // Flush revoked pairing state before replacing the identity. File
            // flushing does not make both directory renames a crash transaction.
            // A failed replacement may require another local attempt.
            invalidatePairings();
            File.Move(temporary, identityPath, true);
        }
        finally { CryptographicOperations.ZeroMemory(pfx); if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private byte[] CreatePfx()
    {
        using var rsa = RSA.Create(3072);
        var request = new CertificateRequest($"CN=Orbit Remote {hostId}", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.1"), new("1.3.6.1.5.5.7.3.2") }, false));
        var san = new SubjectAlternativeNameBuilder(); san.AddIpAddress(IPAddress.Loopback); if (address is not null) san.AddIpAddress(address); request.CertificateExtensions.Add(san.Build());
        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-5), DateTimeOffset.UtcNow.AddYears(2));
        return created.Export(X509ContentType.Pfx);
    }
    public void Dispose() => Certificate.Dispose();
}

internal static class WindowsSecret
{
    [StructLayout(LayoutKind.Sequential)] private struct Blob { public int Length; public IntPtr Data; }
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CryptProtectData(ref Blob input, string? description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CryptUnprotectData(ref Blob input, IntPtr description, IntPtr entropy, IntPtr reserved, IntPtr prompt, int flags, out Blob output);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    public static byte[] Protect(byte[] data) => Transform(data, true);
    public static byte[] Unprotect(byte[] data) => Transform(data, false);
    private static byte[] Transform(byte[] data, bool protect)
    {
        var input = new Blob { Length = data.Length, Data = Marshal.AllocHGlobal(data.Length) };
        try
        {
            Marshal.Copy(data, 0, input.Data, data.Length);
            Blob output;
            var success = protect ? CryptProtectData(ref input, "Orbit Remote identity", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output) : CryptUnprotectData(ref input, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 1, out output);
            if (!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not protect the Orbit identity with your Windows account.");
            try { var result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result; }
            finally { LocalFree(output.Data); }
        }
        finally { Marshal.Copy(new byte[data.Length], 0, input.Data, data.Length); Marshal.FreeHGlobal(input.Data); }
    }
}
