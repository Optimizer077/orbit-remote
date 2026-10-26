using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

[SupportedOSPlatform("macos")]
internal sealed class MacPlatformBackend : IPlatformBackend
{
    private const string CoreGraphics = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    private readonly SemaphoreSlim _inputGate = new(1, 1);
    private readonly HashSet<ushort> _heldKeys = [];
    private readonly HashSet<string> _heldButtons = [];
    private static readonly IReadOnlyDictionary<string, ushort> Keys = BuildKeys();

    public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var state = SessionState();
        var ready = state == "interactive";
        var capture = Native.CGPreflightScreenCaptureAccess();
        var input = Native.AXIsProcessTrusted();
        return Task.FromResult(new PlatformStatus("macOS", state, ready && capture, ready && input,
            ready && File.Exists("/usr/bin/pbcopy") && File.Exists("/usr/bin/pbpaste"), false,
            ready ? GetMonitors() : [],
            ["Screen Recording permission is required for capture. Accessibility permission is required for keyboard and mouse.",
             "Locked screens, loginwindow, FileVault preboot and remote locking are not implemented. A local user must sign in and approve OS permissions.",
             "The macOS backend is implemented but requires validation on a physical Mac. Display coordinates are mapped from native pixels to CoreGraphics points."]));
    }

    public async Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default)
    {
        RequireInteractive();
        if (!Native.CGPreflightScreenCaptureAccess()) throw new PlatformUnavailableException("screen-permission-required", "Grant Screen Recording permission to the host application in System Settings.");
        var monitor = PlatformLimits.SelectMonitor(GetMonitors(), monitorId);
        PlatformLimits.CheckDimensions(monitor.Width, monitor.Height);
        var folder = Path.Combine(Path.GetTempPath(), "orbit-capture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var path = Path.Combine(folder, "frame.png");
        try
        {
            // -D is a 1-based display index in screencapture's display list, not a CGDirectDisplayID.
            var monitors = GetMonitors();
            var index = monitors.FindIndex(x => x.Id == monitor.Id) + 1;
            if (index == 0) throw new PlatformUnavailableException("display-changed", "The display configuration changed during capture.");
            await NativeProcess.RunAsync("/usr/sbin/screencapture", ["-x", "-C", "-t", "png", "-D", index.ToString(CultureInfo.InvariantCulture), path], cancellationToken, 16_384);
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > PlatformLimits.MaximumFrameBytes) throw new PlatformUnavailableException("capture-failed", "Screen capture produced no image or exceeded its limit.");
            var png = await File.ReadAllBytesAsync(path, cancellationToken);
            var (width, height) = PngEncoder.ReadDimensions(png);
            RequireInteractive();
            return new ScreenFrame(png, width, height, monitor.Left, monitor.Top, DateTimeOffset.UtcNow);
        }
        finally { try { File.Delete(path); Directory.Delete(folder); } catch (IOException) { } }
    }

    public async Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default)
    {
        await _inputGate.WaitAsync(cancellationToken);
        try
        {
            RequireInteractive();
            if (!Native.AXIsProcessTrusted()) throw new PlatformUnavailableException("accessibility-permission-required", "Grant Accessibility permission to the host application in System Settings.");
            switch (input.Kind)
            {
                case "pointerMove":
                {
                    var type = _heldButtons.Contains("left") ? 6u : _heldButtons.Contains("right") ? 7u : _heldButtons.Contains("middle") ? 27u : 5u;
                    Post(Native.CGEventCreateMouseEvent(IntPtr.Zero, type, MapPoint(input), 0)); break;
                }
                case "pointerButton":
                {
                    var down = PlatformLimits.Down(input);
                    var (button, downType, upType) = input.Button switch {
                        "left" => (0u, 1u, 2u), "right" => (1u, 3u, 4u), "middle" => (2u, 25u, 26u),
                        _ => throw new ArgumentException("Unsupported pointer button.") };
                    Post(Native.CGEventCreateMouseEvent(IntPtr.Zero, down ? downType : upType, MapPoint(input), button));
                    if (down) _heldButtons.Add(input.Button!); else _heldButtons.Remove(input.Button!);
                    break;
                }
                case "key":
                {
                    if (input.Key is null || !Keys.TryGetValue(input.Key, out var key)) throw new ArgumentException("Unsupported keyboard code.");
                    var down = PlatformLimits.Down(input);
                    Post(Native.CGEventCreateKeyboardEvent(IntPtr.Zero, key, down));
                    if (down) _heldKeys.Add(key); else _heldKeys.Remove(key);
                    break;
                }
                case "wheel":
                    if (Math.Abs((long)input.DeltaX) > 1200 || Math.Abs((long)input.DeltaY) > 1200)
                        throw new ArgumentException("Wheel deltas must be between -1200 and 1200.");
                    // Fixed-signature Event2 avoids variadic ABI differences on Apple Silicon.
                    Post(Native.CGEventCreateScrollWheelEvent2(IntPtr.Zero, 0, 2, -input.DeltaY, -input.DeltaX, 0)); break;
                default: throw new ArgumentException("Unsupported input kind.");
            }
        }
        finally { _inputGate.Release(); }
    }

    public async Task ReleaseInputsAsync(CancellationToken cancellationToken = default)
    {
        await _inputGate.WaitAsync(cancellationToken);
        try
        {
            if (SessionState() == "interactive" && Native.AXIsProcessTrusted())
            {
                foreach (var key in _heldKeys) Post(Native.CGEventCreateKeyboardEvent(IntPtr.Zero, key, false));
                var sample = Native.CGEventCreate(IntPtr.Zero);
                var point = sample != IntPtr.Zero ? Native.CGEventGetLocation(sample) : new Native.Point();
                if (sample != IntPtr.Zero) Native.CFRelease(sample);
                foreach (var button in _heldButtons) Post(Native.CGEventCreateMouseEvent(IntPtr.Zero,
                    button == "left" ? 2u : button == "right" ? 4u : 26u, point, button == "left" ? 0u : button == "right" ? 1u : 2u));
            }
            _heldKeys.Clear(); _heldButtons.Clear();
        }
        finally { _inputGate.Release(); }
    }

    private static Native.Point MapPoint(RemoteInput input)
    {
        var monitors = GetMonitors();
        PlatformLimits.CheckPointer(input, monitors);
        var monitor = monitors.First(m => input.X >= m.Left && input.Y >= m.Top && (long)input.X < (long)m.Left + m.Width && (long)input.Y < (long)m.Top + m.Height);
        var bounds = Native.CGDisplayBounds(uint.Parse(monitor.Id, CultureInfo.InvariantCulture));
        return new Native.Point { X = bounds.Origin.X + (input.X - monitor.Left) * bounds.Size.Width / monitor.Width,
            Y = bounds.Origin.Y + (input.Y - monitor.Top) * bounds.Size.Height / monitor.Height };
    }

    public async Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default)
    {
        RequireInteractive();
        var data = await NativeProcess.RunAsync("/usr/bin/pbpaste", ["-Prefer", "txt"], cancellationToken, PlatformLimits.MaximumClipboardCharacters * 4);
        var text = System.Text.Encoding.UTF8.GetString(data); PlatformLimits.CheckClipboard(text); return text;
    }

    public async Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default)
    {
        PlatformLimits.CheckClipboard(text); RequireInteractive();
        await NativeProcess.RunAsync("/usr/bin/pbcopy", [], cancellationToken, 1024, text);
    }

    public Task LockAsync(CancellationToken cancellationToken = default) => Task.FromException(new PlatformUnavailableException(
        "lock-unsupported", "Remote locking is not implemented on macOS in this version."));

    public async ValueTask DisposeAsync() { await ReleaseInputsAsync(); _inputGate.Dispose(); }

    private static void Post(IntPtr value)
    {
        if (value == IntPtr.Zero) throw new PlatformUnavailableException("input-failed", "CoreGraphics could not create the input event.");
        try { Native.CGEventPost(0, value); } finally { Native.CFRelease(value); }
    }

    private static void RequireInteractive()
    {
        var state = SessionState();
        if (state != "interactive") throw new PlatformUnavailableException("desktop-unavailable", $"macOS desktop is {state}; a local user must unlock the session.");
    }

    private static string SessionState()
    {
        var session = Native.CGSessionCopyCurrentDictionary();
        if (session == IntPtr.Zero) return "non-interactive";
        try
        {
            if (DictionaryBoolean(session, "CGSSessionScreenIsLocked") == true) return "locked";
            if (DictionaryBoolean(session, "kCGSessionOnConsoleKey") != true || DictionaryBoolean(session, "kCGSessionLoginDoneKey") != true)
                return "non-interactive";
            return "interactive";
        }
        finally { Native.CFRelease(session); }
    }

    private static bool? DictionaryBoolean(IntPtr dictionary, string name)
    {
        var key = Native.CFStringCreateWithCString(IntPtr.Zero, name, 0x08000100);
        try
        {
            var value = Native.CFDictionaryGetValue(dictionary, key);
            return value == IntPtr.Zero ? null : Native.CFBooleanGetValue(value);
        }
        finally { Native.CFRelease(key); }
    }

    private static List<MonitorInfo> GetMonitors()
    {
        var displays = new uint[32];
        if (Native.CGGetActiveDisplayList((uint)displays.Length, displays, out var count) != 0)
            throw new PlatformUnavailableException("monitors-unavailable", "CoreGraphics could not enumerate active displays.");
        var primary = Native.CGMainDisplayID();
        var result = new List<MonitorInfo>();
        foreach (var display in displays.Take(checked((int)count)))
        {
            // Give each native-pixel display an unambiguous horizontal coordinate range. Mixed Retina
            // scales cannot share CG point origins without overlapping pixel rectangles.
            result.Add(new MonitorInfo(display.ToString(CultureInfo.InvariantCulture), $"Display {display}",
                result.Sum(x => x.Width), 0, checked((int)Native.CGDisplayPixelsWide(display)),
                checked((int)Native.CGDisplayPixelsHigh(display)), display == primary));
        }
        return result;
    }

    private static IReadOnlyDictionary<string, ushort> BuildKeys() => new Dictionary<string, ushort>(StringComparer.Ordinal) {
        ["KeyA"]=0,["KeyS"]=1,["KeyD"]=2,["KeyF"]=3,["KeyH"]=4,["KeyG"]=5,["KeyZ"]=6,["KeyX"]=7,["KeyC"]=8,["KeyV"]=9,
        ["KeyB"]=11,["KeyQ"]=12,["KeyW"]=13,["KeyE"]=14,["KeyR"]=15,["KeyY"]=16,["KeyT"]=17,["Digit1"]=18,["Digit2"]=19,
        ["Digit3"]=20,["Digit4"]=21,["Digit6"]=22,["Digit5"]=23,["Equal"]=24,["Digit9"]=25,["Digit7"]=26,["Minus"]=27,
        ["Digit8"]=28,["Digit0"]=29,["BracketRight"]=30,["KeyO"]=31,["KeyU"]=32,["BracketLeft"]=33,["KeyI"]=34,["KeyP"]=35,
        ["Enter"]=36,["KeyL"]=37,["KeyJ"]=38,["Quote"]=39,["KeyK"]=40,["Semicolon"]=41,["Backslash"]=42,["Comma"]=43,
        ["Slash"]=44,["KeyN"]=45,["KeyM"]=46,["Period"]=47,["Tab"]=48,["Space"]=49,["Backquote"]=50,["Backspace"]=51,
        ["Escape"]=53,["MetaRight"]=54,["MetaLeft"]=55,["ShiftLeft"]=56,["CapsLock"]=57,["AltLeft"]=58,["ControlLeft"]=59,
        ["ShiftRight"]=60,["AltRight"]=61,["ControlRight"]=62,["F17"]=64,["NumpadDecimal"]=65,["NumpadMultiply"]=67,
        ["NumpadAdd"]=69,["NumLock"]=71,["NumpadDivide"]=75,["NumpadEnter"]=76,["NumpadSubtract"]=78,["F18"]=79,["F19"]=80,
        ["NumpadEqual"]=81,["Numpad0"]=82,["Numpad1"]=83,["Numpad2"]=84,["Numpad3"]=85,["Numpad4"]=86,["Numpad5"]=87,
        ["Numpad6"]=88,["Numpad7"]=89,["F20"]=90,["Numpad8"]=91,["Numpad9"]=92,["F5"]=96,["F6"]=97,["F7"]=98,["F3"]=99,
        ["F8"]=100,["F9"]=101,["F11"]=103,["F13"]=105,["F16"]=106,["F14"]=107,["F10"]=109,["F12"]=111,["F15"]=113,
        ["Home"]=115,["PageUp"]=116,["Delete"]=117,["F4"]=118,["End"]=119,["F2"]=120,["PageDown"]=121,["F1"]=122,
        ["ArrowLeft"]=123,["ArrowRight"]=124,["ArrowDown"]=125,["ArrowUp"]=126 };

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct Point { public double X, Y; }
        [StructLayout(LayoutKind.Sequential)] internal struct Size { public double Width, Height; }
        [StructLayout(LayoutKind.Sequential)] internal struct Rect { public Point Origin; public Size Size; }
        [DllImport(CoreGraphics)] [return: MarshalAs(UnmanagedType.I1)] internal static extern bool CGPreflightScreenCaptureAccess();
        [DllImport("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")] [return: MarshalAs(UnmanagedType.I1)] internal static extern bool AXIsProcessTrusted();
        [DllImport(CoreGraphics)] internal static extern uint CGGetActiveDisplayList(uint maximum, [Out] uint[] displays, out uint count);
        [DllImport(CoreGraphics)] internal static extern uint CGMainDisplayID();
        [DllImport(CoreGraphics)] internal static extern Rect CGDisplayBounds(uint display);
        [DllImport(CoreGraphics)] internal static extern nuint CGDisplayPixelsWide(uint display);
        [DllImport(CoreGraphics)] internal static extern nuint CGDisplayPixelsHigh(uint display);
        [DllImport(CoreGraphics)] internal static extern IntPtr CGSessionCopyCurrentDictionary();
        [DllImport(CoreGraphics)] internal static extern IntPtr CGEventCreateKeyboardEvent(IntPtr source, ushort key, [MarshalAs(UnmanagedType.I1)] bool down);
        [DllImport(CoreGraphics)] internal static extern IntPtr CGEventCreateMouseEvent(IntPtr source, uint type, Point position, uint button);
        [DllImport(CoreGraphics)] internal static extern IntPtr CGEventCreateScrollWheelEvent2(IntPtr source, uint units, uint wheelCount, int wheel1, int wheel2, int wheel3);
        [DllImport(CoreGraphics)] internal static extern IntPtr CGEventCreate(IntPtr source);
        [DllImport(CoreGraphics)] internal static extern Point CGEventGetLocation(IntPtr value);
        [DllImport(CoreGraphics)] internal static extern void CGEventPost(uint tap, IntPtr value);
        [DllImport(CoreFoundation)] internal static extern void CFRelease(IntPtr value);
        [DllImport(CoreFoundation)] internal static extern IntPtr CFStringCreateWithCString(IntPtr allocator, [MarshalAs(UnmanagedType.LPUTF8Str)] string value, uint encoding);
        [DllImport(CoreFoundation)] internal static extern IntPtr CFDictionaryGetValue(IntPtr dictionary, IntPtr key);
        [DllImport(CoreFoundation)] [return: MarshalAs(UnmanagedType.I1)] internal static extern bool CFBooleanGetValue(IntPtr value);
    }
}
