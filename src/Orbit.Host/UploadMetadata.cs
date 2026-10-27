using System.Runtime.InteropServices;
using System.Text;

namespace Orbit.Host;

internal interface IUploadMetadata
{
    void MarkAndVerify(string path);
}

internal enum UploadMetadataPlatform { Windows, Mac, Linux }

internal sealed class UploadMarkingException : IOException
{
    internal const string Code = "upload_marking_unavailable";
    internal const string UserMessage = "The upload could not be marked as downloaded. The transfer folder may not support download marking; choose another transfer folder.";
    internal UploadMarkingException() : base(UserMessage) { }
}

/// <summary>Fixed provenance only; this is neither a scan nor a safety verdict.</summary>
internal sealed class UploadMetadata(UploadMetadataPlatform platform, Action? unsupportedWarning = null,
    IMacUploadAttributes? macAttributes = null, IWindowsUploadAttributes? windowsAttributes = null,
    Action? markingWarning = null) : IUploadMetadata
{
    internal const string WindowsZone = "[ZoneTransfer]\r\nZoneId=3\r\n";
    internal const string MacAttribute = "com.apple.quarantine";
    internal const int MacNotSupported = 45; // Darwin ENOTSUP, not Linux's errno.
    private int warned;
    private int warnedMarking;

    internal static UploadMetadata Create(ILogger logger) => new(
        OperatingSystem.IsWindows() ? UploadMetadataPlatform.Windows : OperatingSystem.IsMacOS() ? UploadMetadataPlatform.Mac : UploadMetadataPlatform.Linux,
        () => logger.LogWarning("This transfer volume does not support macOS quarantine metadata; the uploaded file was preserved without it."),
        markingWarning: () => logger.LogWarning("Download marking is unavailable in the transfer folder; the upload was refused."));

    public void MarkAndVerify(string path)
    {
        if (platform == UploadMetadataPlatform.Linux) return; // No standard Linux quarantine claim.
        if (platform == UploadMetadataPlatform.Windows)
        {
            try { (windowsAttributes ?? NativeWindowsUploadAttributes.Instance).WriteAndVerify(path, Encoding.ASCII.GetBytes(WindowsZone)); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException)
            {
                if (Interlocked.Exchange(ref warnedMarking, 1) == 0)
                { try { markingWarning?.Invoke(); } catch (Exception) { /* Preserve the typed refusal if logging fails. */ } }
                throw new UploadMarkingException();
            }
            return;
        }

        var attributes = macAttributes ?? NativeMacUploadAttributes.Instance;
        // No source URL, device identity, address, invitation or content is stored.
        var value = Encoding.ASCII.GetBytes($"0081;{DateTimeOffset.UtcNow.ToUnixTimeSeconds():x};Orbit Remote;");
        var error = attributes.Set(path, value);
        if (Unsupported(error)) return;
        if (error != 0) throw new IOException("Upload quarantine metadata could not be written.");
        var readback = new byte[256];
        var (lengthRead, readError) = attributes.Read(path, readback);
        if (Unsupported(readError)) return;
        if (readError != 0 || lengthRead != value.Length || !readback.AsSpan(0, value.Length).SequenceEqual(value))
            throw new IOException("Upload quarantine metadata could not be verified.");
    }

    private bool Unsupported(int error)
    {
        if (error != MacNotSupported) return false;
        if (Interlocked.Exchange(ref warned, 1) == 0)
        { try { unsupportedWarning?.Invoke(); } catch (Exception) { /* Unsupported-volume policy still preserves the file. */ } }
        return true;
    }
}

internal interface IWindowsUploadAttributes
{
    void WriteAndVerify(string path, byte[] expected);
}

internal sealed class NativeWindowsUploadAttributes : IWindowsUploadAttributes
{
    internal static readonly NativeWindowsUploadAttributes Instance = new();
    public void WriteAndVerify(string path, byte[] expected)
    {
        var streamPath = path + ":Zone.Identifier";
        using (var output = new FileStream(streamPath, FileMode.Create, FileAccess.Write, FileShare.None))
        { output.Write(expected); output.Flush(flushToDisk: true); }
        using var input = new FileStream(streamPath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
        Span<byte> actual = stackalloc byte[expected.Length + 1];
        var length = 0; int count;
        while (length < actual.Length && (count = input.Read(actual[length..])) > 0) length += count;
        if (length != expected.Length || !actual[..length].SequenceEqual(expected))
            throw new IOException("Upload provenance metadata could not be verified.");
    }
}

internal interface IMacUploadAttributes
{
    int Set(string path, byte[] value);
    (long Length, int Error) Read(string path, byte[] value);
}

internal sealed class NativeMacUploadAttributes : IMacUploadAttributes
{
    internal static readonly NativeMacUploadAttributes Instance = new();
    public int Set(string path, byte[] value) =>
        SetAttribute(path, UploadMetadata.MacAttribute, value, (nuint)value.Length, 0, 1) == 0 ? 0 : Marshal.GetLastPInvokeError();
    public (long Length, int Error) Read(string path, byte[] value)
    {
        var length = GetAttribute(path, UploadMetadata.MacAttribute, value, (nuint)value.Length, 0, 1);
        return length >= 0 ? ((long)length, 0) : (-1, Marshal.GetLastPInvokeError());
    }
    // Darwin XATTR_NOFOLLOW=1; never follow a substituted final component.
    [DllImport("/usr/lib/libSystem.B.dylib", EntryPoint = "setxattr", SetLastError = true)]
    private static extern int SetAttribute([MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string name, byte[] value, nuint size, uint position, int options);
    [DllImport("/usr/lib/libSystem.B.dylib", EntryPoint = "getxattr", SetLastError = true)]
    private static extern nint GetAttribute([MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string name, [Out] byte[] value, nuint size, uint position, int options);
}
