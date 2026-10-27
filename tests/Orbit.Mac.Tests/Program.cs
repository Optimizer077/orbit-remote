using System.Runtime.InteropServices;
using System.Net;
using System.Security.Cryptography;
using Orbit.Host;
using Orbit.Host.Platform;

if (!OperatingSystem.IsMacOS())
{
    Console.WriteLine("Mac-native checks require macOS.");
    return 2;
}

if (args.Contains("--keychain-counts"))
{
    Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(LoginKeychainCounts.Read()));
    return 0;
}

var checks = 0;
var failures = new List<string>();
void Check(bool condition, string message)
{
    checks++;
    if (!condition) failures.Add(message);
}

if (args.Contains("--imageio")) ImageIoJpegChecks.Run(Check);
if (args.Contains("--capture-pipe")) await MacCapturePipeChecks.RunAsync(Check);
MacInputFlagChecks.Run(Check);

await using var backend = PlatformBackendFactory.Create();
var identityDirectory = Path.Combine(Path.GetTempPath(), "orbit-mac-identity-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(identityDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
try
{
    using var original = new HostIdentity(identityDirectory, "mac-test", IPAddress.Loopback);
    using var restored = new HostIdentity(identityDirectory, "mac-test", IPAddress.Loopback);
    Check(original.Certificate.HasPrivateKey, "macOS can import its TLS private identity");
    Check(original.Fingerprint == restored.Fingerprint, "macOS identity survives profile reload");
    Check(original.ExportForLocalController() is not null, "Local controller can export its own TLS identity");
    Check(File.GetUnixFileMode(Path.Combine(identityDirectory, "identity.pfx")) == (UnixFileMode.UserRead | UnixFileMode.UserWrite),
        "Persisted Mac identity is user-readable/writable only");
}
finally { Directory.Delete(identityDirectory, recursive: true); }
var status = await backend.GetStatusAsync();
Check(status.OperatingSystem == "macOS", "Mac backend selected");
// This opt-in asserts real unlocked-session readiness, not capture permission.
// It catches a wrong native dictionary key without recording private screen data.
if (args.Contains("--expect-interactive"))
    Check(status.SessionState == "interactive", "Unlocked console session is detected as interactive");
Console.WriteLine($"Session: {status.SessionState}; capture permitted: {status.CanCapture}; input permitted: {status.CanInput}");

var retina = new MonitorInfo("test-retina", "Retina", 0, 0, 3024, 1964, true);
var external = new MonitorInfo("test-external", "External", 3024, 0, 2560, 1080, false);
var center = MacPlatformBackend.MapDisplayPoint(new("pointerMove", X: 1512, Y: 982), retina, 0, 0, 1512, 982);
Check(center == (756, 491), "Retina native pixels map to CoreGraphics points");
var negative = MacPlatformBackend.MapDisplayPoint(new("pointerMove", X: 4304, Y: 540), external, -2560, -100, 2560, 1080);
Check(negative == (-1280, 440), "External display preserves its negative CoreGraphics origin");
var first = MacPlatformBackend.MapDisplayPoint(new("pointerMove", X: 3024, Y: 0), external, -2560, 0, 2560, 1080);
Check(first == (-2560, 0), "Adjacent pixel ranges map to the correct display");
try
{
    MacPlatformBackend.MapDisplayPoint(new("pointerMove", X: 3024, Y: 0), retina, 0, 0, 1512, 982);
    Check(false, "Out-of-display pointer is rejected");
}
catch (ArgumentException) { Check(true, "Out-of-display pointer is rejected"); }

foreach (var monitor in status.Monitors)
{
    var display = uint.Parse(monitor.Id, System.Globalization.CultureInfo.InvariantCulture);
    var mode = Native.CGDisplayCopyDisplayMode(display);
    Check(mode != IntPtr.Zero, "Active display mode is available");
    if (mode == IntPtr.Zero) continue;
    try
    {
        Check(monitor.Width == checked((int)Native.CGDisplayModeGetPixelWidth(mode)), "Monitor width uses backing pixels");
        Check(monitor.Height == checked((int)Native.CGDisplayModeGetPixelHeight(mode)), "Monitor height uses backing pixels");
    }
    finally { Native.CGDisplayModeRelease(mode); }
}
Check(status.Monitors.Select((m, index) => status.Monitors.Take(index).All(previous =>
    (long)previous.Left + previous.Width <= m.Left)).All(x => x), "Mixed-DPI monitor ranges never overlap");
Check(!status.CanScaleFrames && !status.CanConditionalFrames, "Encoded Mac capture advertises no raw-frame scaling or conditional capability");

if (args.Contains("--frame-fallback"))
{
    if (status.CanCapture) await MacFrameFallbackChecks.RunAsync(Check);
    else Console.WriteLine("Mac frame-route fallback check skipped: local Screen Recording approval is required.");
}

if (args.Contains("--capture"))
{
    Check(status.CanCapture, "Local Screen Recording permission is granted");
    if (status.CanCapture)
    {
        foreach (var monitor in status.Monitors)
        {
            var frame = await backend.CaptureAsync(monitor.Id);
            Check(frame.Width == monitor.Width && frame.Height == monitor.Height, "Real captured frame agrees with input geometry");
            Check(frame.Left == monitor.Left && frame.Top == monitor.Top, "Real frame retains the selected monitor origin");
            // Never persist desktop pixels in test output or source control.
        }
    }
}

foreach (var failure in failures) Console.Error.WriteLine("FAIL: " + failure);
Console.WriteLine($"{checks - failures.Count}/{checks} Mac checks passed.");
return failures.Count == 0 ? 0 : 1;

internal static class Native
{
    private const string CoreGraphics = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
    [DllImport(CoreGraphics)] internal static extern IntPtr CGDisplayCopyDisplayMode(uint display);
    [DllImport(CoreGraphics)] internal static extern nuint CGDisplayModeGetPixelWidth(IntPtr mode);
    [DllImport(CoreGraphics)] internal static extern nuint CGDisplayModeGetPixelHeight(IntPtr mode);
    [DllImport(CoreGraphics)] internal static extern void CGDisplayModeRelease(IntPtr mode);
}
