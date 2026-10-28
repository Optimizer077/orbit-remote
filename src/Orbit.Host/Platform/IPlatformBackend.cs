namespace Orbit.Host.Platform;

/// <summary>All coordinates are physical desktop pixels, including negative monitor origins.</summary>
public interface IPlatformBackend : IAsyncDisposable
{
    Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default);
    Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default);
    Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default);
    Task ReleaseInputsAsync(CancellationToken cancellationToken = default);
    Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default);
    Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default);
    Task LockAsync(CancellationToken cancellationToken = default);
}

/// <summary>Optional fixed wake capability; unrelated backends default to unknown/unsupported.</summary>
public interface IDisplayAvailability
{
    string DisplayState { get; }
    bool CanWakeDisplay { get; }
    Task WakeDisplayAsync(CancellationToken cancellationToken = default);
}

public interface IFrameChangeSource
{
    Task WaitForChangeAsync(ScreenFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken = default);
}

public sealed record PlatformStatus(string OperatingSystem, string SessionState, bool CanCapture,
    bool CanInput, bool CanClipboard, bool CanLock, IReadOnlyList<MonitorInfo> Monitors,
    IReadOnlyList<string> Limitations, bool CanScaleFrames = false, bool CanConditionalFrames = false, bool CanJpegFrames = false, bool CanWaitForFrames = false, bool CanLocalCursor = false, string DisplayState = "unknown", bool CanWakeDisplay = false, bool CanInputBatch = false);
public sealed record MonitorInfo(string Id, string Name, int Left, int Top, int Width, int Height, bool Primary);
// Raw capture may leave Png empty to defer compression until after negotiation.
public sealed record ScreenFrame(byte[] Png, int Width, int Height, int Left, int Top, DateTimeOffset CapturedUtc,
    byte[]? RawBgra = null, string? MonitorId = null, string? NativeGeneration = null, long NativeVersion = 0);
public sealed record RemoteInput(string Kind, int X = 0, int Y = 0, string? Button = null,
    string? Key = null, bool? IsDown = null, int DeltaX = 0, int DeltaY = 0);

/// <summary>
/// <paramref name="message"/> is fixed host text that remote peers may see. Native or
/// tool output (stderr, Win32 messages) belongs in <paramref name="detail"/>, which is
/// only logged locally and never returned to a peer.
/// </summary>
public sealed class PlatformUnavailableException(string code, string message, string? detail = null) : InvalidOperationException(message)
{
    public string Code { get; } = code;
    public string? Detail { get; } = detail;
}

public static class PlatformBackendFactory
{
    public static IPlatformBackend Create() => OperatingSystem.IsWindows() ? new WindowsPlatformBackend()
        : OperatingSystem.IsMacOS() ? new MacPlatformBackend()
        : OperatingSystem.IsLinux() ? new LinuxPlatformBackend()
        : new UnsupportedPlatformBackend();
}

internal static class PlatformLimits
{
    public const int MaximumPixels = 33_554_432;
    public const int MaximumFrameBytes = 134_217_728;
    public const int MaximumClipboardCharacters = 262_144;

    public static void CheckDimensions(int width, int height)
    {
        if (width <= 0 || height <= 0 || (long)width * height > MaximumPixels)
            throw new PlatformUnavailableException("display-too-large", "Display exceeds the 32 megapixel capture limit.");
    }

    public static void CheckClipboard(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (text.Length > MaximumClipboardCharacters || text.Contains('\0'))
            throw new ArgumentException("Clipboard text must be at most 262144 characters and contain no null characters.", nameof(text));
    }

    public static MonitorInfo SelectMonitor(IReadOnlyList<MonitorInfo> monitors, string? id)
    {
        if (monitors.Count == 0) throw new PlatformUnavailableException("no-display", "No accessible display is available.");
        if (string.IsNullOrEmpty(id)) return monitors.FirstOrDefault(x => x.Primary) ?? monitors[0];
        return monitors.FirstOrDefault(x => x.Id == id)
            ?? throw new ArgumentException("The requested monitor is no longer connected.", nameof(id));
    }

    public static void CheckPointer(RemoteInput input, IReadOnlyList<MonitorInfo> monitors)
    {
        if (!monitors.Any(m => input.X >= m.Left && input.Y >= m.Top &&
            (long)input.X < (long)m.Left + m.Width && (long)input.Y < (long)m.Top + m.Height))
            throw new ArgumentException("Pointer coordinates must be inside a connected display.");
    }

    public static bool Down(RemoteInput input) => input.IsDown ?? throw new ArgumentException("isDown is required for key and button events.");
}

internal sealed class UnsupportedPlatformBackend : IPlatformBackend
{
    private static Exception Unavailable() => new PlatformUnavailableException("unsupported-os", "This operating system has no desktop backend.");
    public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(new PlatformStatus(
        System.Runtime.InteropServices.RuntimeInformation.OSDescription, "unsupported", false, false, false, false, [], ["No backend for this operating system."]));
    public Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default) => Task.FromException<ScreenFrame>(Unavailable());
    public Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default) => Task.FromException(Unavailable());
    public Task ReleaseInputsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    public Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default) => Task.FromException<string>(Unavailable());
    public Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default) => Task.FromException(Unavailable());
    public Task LockAsync(CancellationToken cancellationToken = default) => Task.FromException(Unavailable());
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
