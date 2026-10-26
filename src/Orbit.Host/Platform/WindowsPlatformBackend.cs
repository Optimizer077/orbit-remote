using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Orbit.Host.Platform;

internal sealed class WindowsPlatformBackend : IPlatformBackend
{
    private readonly object _inputLock = new();
    private readonly HashSet<ushort> _heldKeys = [];
    private readonly HashSet<string> _heldButtons = [];
    private static readonly IReadOnlyDictionary<string, ushort> Keys = BuildKeys();

    public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var dpi = new DpiScope();
        var state = SessionState();
        var ready = state == "interactive";
        var monitors = ready ? GetMonitors() : [];
        return Task.FromResult(new PlatformStatus("Windows", state, ready && monitors.Count > 0, ready,
            ready, ready, monitors,
            ["Logged-in interactive desktops only. Lock screens, sign-in, UAC secure desktop and session 0 are not supported by this backend.",
             "Windows integrity isolation prevents input to elevated applications. Launch the desktop agent at the same integrity level as the application you intend to control.",
             "PNG snapshot transport is a baseline; hardware video encoding and audio are not implemented."],
             CanScaleFrames: ready && monitors.Count > 0, CanConditionalFrames: ready && monitors.Count > 0));
    }

    public Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default) =>
        Task.Run(() => Capture(monitorId, cancellationToken), cancellationToken);

    private static ScreenFrame Capture(string? monitorId, CancellationToken cancellationToken)
    {
        RequireInteractive();
        using var dpi = new DpiScope();
        var monitor = PlatformLimits.SelectMonitor(GetMonitors(), monitorId);
        PlatformLimits.CheckDimensions(monitor.Width, monitor.Height);
        var source = Native.GetDC(IntPtr.Zero);
        if (source == IntPtr.Zero) throw Failure("capture-failed", "Cannot open the desktop device context.");
        var destination = IntPtr.Zero; var bitmap = IntPtr.Zero; var previous = IntPtr.Zero;
        try
        {
            destination = Native.CreateCompatibleDC(source);
            if (destination == IntPtr.Zero) throw Failure("capture-failed", "Cannot create capture device context.");
            var info = new Native.BitmapInfo { Header = new Native.BitmapInfoHeader {
                Size = (uint)Marshal.SizeOf<Native.BitmapInfoHeader>(), Width = monitor.Width, Height = -monitor.Height,
                Planes = 1, BitCount = 32, Compression = 0 } };
            bitmap = Native.CreateDIBSection(destination, ref info, 0, out var pixels, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || pixels == IntPtr.Zero) throw Failure("capture-failed", "Cannot allocate capture bitmap.");
            previous = Native.SelectObject(destination, bitmap);
            if (previous == IntPtr.Zero || previous == new IntPtr(-1)) throw Failure("capture-failed", "Cannot select capture bitmap.");
            cancellationToken.ThrowIfCancellationRequested();
            if (!Native.BitBlt(destination, 0, 0, monitor.Width, monitor.Height, source, monitor.Left, monitor.Top, 0x40CC0020))
                throw Failure("capture-failed", "Desktop capture failed.");
            DrawCursor(destination, monitor);
            RequireInteractive(); // Drop a frame if the user locked or changed secure desktop during capture.
            var data = new byte[checked(monitor.Width * monitor.Height * 4)];
            Marshal.Copy(pixels, data, 0, data.Length);
            return new ScreenFrame(PngEncoder.EncodeBgra(data, monitor.Width, monitor.Height, cancellationToken),
                monitor.Width, monitor.Height, monitor.Left, monitor.Top, DateTimeOffset.UtcNow, data, monitor.Id);
        }
        finally
        {
            if (destination != IntPtr.Zero && previous != IntPtr.Zero && previous != new IntPtr(-1)) Native.SelectObject(destination, previous);
            if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
            if (destination != IntPtr.Zero) Native.DeleteDC(destination);
            Native.ReleaseDC(IntPtr.Zero, source);
        }
    }

    private static void DrawCursor(IntPtr dc, MonitorInfo monitor)
    {
        var cursor = new Native.CursorInfo { Size = Marshal.SizeOf<Native.CursorInfo>() };
        if (!Native.GetCursorInfo(ref cursor) || (cursor.Flags & 1) == 0 || !Native.GetIconInfo(cursor.Cursor, out var icon)) return;
        try { Native.DrawIconEx(dc, cursor.Position.X - monitor.Left - (int)icon.HotspotX,
            cursor.Position.Y - monitor.Top - (int)icon.HotspotY, cursor.Cursor, 0, 0, 0, IntPtr.Zero, 3); }
        finally
        {
            if (icon.Mask != IntPtr.Zero) Native.DeleteObject(icon.Mask);
            if (icon.Color != IntPtr.Zero) Native.DeleteObject(icon.Color);
        }
    }

    public Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        lock (_inputLock)
        {
            RequireInteractive();
            using var dpi = new DpiScope();
            switch (input.Kind)
            {
                case "pointerMove": Move(input); break;
                case "pointerButton":
                {
                    var button = input.Button ?? throw new ArgumentException("button is required.");
                    var down = PlatformLimits.Down(input);
                    var flag = ButtonFlag(button, down);
                    Move(input);
                    Send(new Native.Input { Type = 0, Union = new Native.InputUnion { Mouse = new Native.MouseInput { Flags = flag } } });
                    if (down) _heldButtons.Add(button); else _heldButtons.Remove(button);
                    break;
                }
                case "key":
                {
                    if (input.Key is null || !Keys.TryGetValue(input.Key, out var key)) throw new ArgumentException("Unsupported keyboard code.");
                    var down = PlatformLimits.Down(input);
                    Send(KeyInput(key, down));
                    if (down) _heldKeys.Add(key); else _heldKeys.Remove(key);
                    break;
                }
                case "wheel":
                {
                    if (Math.Abs((long)input.DeltaX) > 1200 || Math.Abs((long)input.DeltaY) > 1200)
                        throw new ArgumentException("Wheel deltas must be between -1200 and 1200.");
                    if (input.DeltaY != 0) Send(new Native.Input { Union = new Native.InputUnion { Mouse = new Native.MouseInput {
                        Flags = 0x0800, MouseData = unchecked((uint)-input.DeltaY) } } });
                    if (input.DeltaX != 0) Send(new Native.Input { Union = new Native.InputUnion { Mouse = new Native.MouseInput {
                        Flags = 0x1000, MouseData = unchecked((uint)input.DeltaX) } } });
                    break;
                }
                default: throw new ArgumentException("Unsupported input kind.");
            }
        }
        return Task.CompletedTask;
    }

    private static void Move(RemoteInput input)
    {
        var monitors = GetMonitors();
        PlatformLimits.CheckPointer(input, monitors);
        var left = monitors.Min(m => m.Left); var top = monitors.Min(m => m.Top);
        var width = monitors.Max(m => (long)m.Left + m.Width) - left;
        var height = monitors.Max(m => (long)m.Top + m.Height) - top;
        // SendInput divides the 65536-coordinate range into pixel cells. Aim at each cell's
        // center, otherwise flooring normalized edge coordinates can move one pixel short.
        var x = checked((int)(((input.X - (long)left) * 2 + 1) * 65536 / (width * 2)));
        var y = checked((int)(((input.Y - (long)top) * 2 + 1) * 65536 / (height * 2)));
        Send(new Native.Input { Union = new Native.InputUnion { Mouse = new Native.MouseInput { X = x, Y = y, Flags = 0xC001 } } });
    }

    public Task ReleaseInputsAsync(CancellationToken cancellationToken = default)
    {
        lock (_inputLock)
        {
            // Never switch into the secure desktop; only best-effort release in our current input desktop.
            foreach (var key in _heldKeys) Native.SendInput(1, [KeyInput(key, false)], Marshal.SizeOf<Native.Input>());
            foreach (var button in _heldButtons) Native.SendInput(1, [new Native.Input {
                Union = new Native.InputUnion { Mouse = new Native.MouseInput { Flags = ButtonFlag(button, false) } } }], Marshal.SizeOf<Native.Input>());
            _heldKeys.Clear(); _heldButtons.Clear();
        }
        return Task.CompletedTask;
    }

    private static Native.Input KeyInput(ushort key, bool down) => new() { Type = 1, Union = new Native.InputUnion {
        Keyboard = new Native.KeyboardInput { VirtualKey = key, Flags = (down ? 0u : 2u) | (IsExtended(key) ? 1u : 0u) } } };
    private static bool IsExtended(ushort key) => key is >= 0x21 and <= 0x2E or 0x5B or 0x5C or 0x6F or 0xA3 or 0xA5;
    private static uint ButtonFlag(string button, bool down) => (button, down) switch {
        ("left", true) => 2, ("left", false) => 4, ("right", true) => 8, ("right", false) => 16,
        ("middle", true) => 32, ("middle", false) => 64, _ => throw new ArgumentException("Unsupported pointer button.") };
    private static void Send(Native.Input input)
    {
        if (Native.SendInput(1, [input], Marshal.SizeOf<Native.Input>()) != 1)
            throw Failure("input-blocked", "Windows rejected input; the target may have a higher integrity level or use a secure desktop.");
    }

    public Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested(); RequireInteractive();
        using var clipboard = new ClipboardScope();
        if (!Native.IsClipboardFormatAvailable(13)) return Task.FromResult(string.Empty);
        var handle = Native.GetClipboardData(13);
        if (handle == IntPtr.Zero) throw Failure("clipboard-unavailable", "Cannot read clipboard data.");
        var size = Native.GlobalSize(handle).ToUInt64();
        if (size > (ulong)(PlatformLimits.MaximumClipboardCharacters + 1) * 2)
            throw new PlatformUnavailableException("clipboard-too-large", "Clipboard text exceeds the permitted size.");
        var pointer = Native.GlobalLock(handle);
        if (pointer == IntPtr.Zero) throw Failure("clipboard-unavailable", "Cannot access clipboard memory.");
        try
        {
            var chars = new char[checked((int)(size / 2))];
            Marshal.Copy(pointer, chars, 0, chars.Length);
            var length = Array.IndexOf(chars, '\0');
            return Task.FromResult(new string(chars, 0, length < 0 ? chars.Length : length));
        }
        finally { Native.GlobalUnlock(handle); }
    }

    public Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested(); PlatformLimits.CheckClipboard(text); RequireInteractive();
        using var clipboard = new ClipboardScope();
        var bytes = Encoding.Unicode.GetBytes(text + '\0');
        var handle = Native.GlobalAlloc(0x42, (UIntPtr)bytes.Length);
        if (handle == IntPtr.Zero) throw Failure("clipboard-unavailable", "Cannot allocate clipboard memory.");
        try
        {
            var pointer = Native.GlobalLock(handle);
            if (pointer == IntPtr.Zero) throw Failure("clipboard-unavailable", "Cannot access clipboard memory.");
            try { Marshal.Copy(bytes, 0, pointer, bytes.Length); } finally { Native.GlobalUnlock(handle); }
            if (!Native.EmptyClipboard() || Native.SetClipboardData(13, handle) == IntPtr.Zero)
                throw Failure("clipboard-unavailable", "Cannot update clipboard.");
            handle = IntPtr.Zero; // Ownership transferred to Windows.
        }
        finally { if (handle != IntPtr.Zero) Native.GlobalFree(handle); }
        return Task.CompletedTask;
    }

    public Task LockAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested(); RequireInteractive();
        if (!Native.LockWorkStation()) throw Failure("lock-failed", "Windows rejected the lock request.");
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync() => await ReleaseInputsAsync();

    private static string SessionState()
    {
        if (!Environment.UserInteractive || Process.GetCurrentProcess().SessionId == 0) return "non-interactive";
        if (Native.WTSQuerySessionInformation(IntPtr.Zero, Process.GetCurrentProcess().SessionId, 8, out var buffer, out var bytes))
        {
            try { if (bytes >= 4 && Marshal.ReadInt32(buffer) != 0) return "disconnected"; }
            finally { Native.WTSFreeMemory(buffer); }
        }
        else return "session-state-unavailable";
        var desktop = Native.OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return "locked-or-secure-desktop";
        try
        {
            var active = DesktopName(desktop);
            var own = DesktopName(Native.GetThreadDesktop(Native.GetCurrentThreadId()));
            return active == "Default" && own == "Default" ? "interactive" : "locked-or-secure-desktop";
        }
        finally { Native.CloseDesktop(desktop); }
    }

    private static string? DesktopName(IntPtr desktop)
    {
        var name = new StringBuilder(256);
        return desktop != IntPtr.Zero && Native.GetUserObjectInformation(desktop, 2, name, name.Capacity * 2, out _) ? name.ToString() : null;
    }

    private static void RequireInteractive()
    {
        var state = SessionState();
        if (state != "interactive") throw new PlatformUnavailableException("desktop-unavailable",
            $"Desktop is {state}. Sign-in, locked screens and secure desktops require a future privileged session broker.");
    }

    private static List<MonitorInfo> GetMonitors()
    {
        var monitors = new List<MonitorInfo>();
        Native.MonitorCallback callback = (IntPtr handle, IntPtr dc, ref Native.Rect bounds, IntPtr data) => {
            var info = new Native.MonitorInfoEx { Size = Marshal.SizeOf<Native.MonitorInfoEx>(), Device = string.Empty };
            if (Native.GetMonitorInfo(handle, ref info)) monitors.Add(new MonitorInfo(info.Device, info.Device,
                info.Monitor.Left, info.Monitor.Top, info.Monitor.Right - info.Monitor.Left,
                info.Monitor.Bottom - info.Monitor.Top, (info.Flags & 1) != 0));
            return true;
        };
        if (!Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero))
            throw Failure("monitors-unavailable", "Cannot enumerate displays.");
        return monitors;
    }

    private static PlatformUnavailableException Failure(string code, string message) => new(code,
        $"{message} ({new Win32Exception(Marshal.GetLastWin32Error()).Message})");

    private static IReadOnlyDictionary<string, ushort> BuildKeys()
    {
        var keys = new Dictionary<string, ushort>(StringComparer.Ordinal) {
            ["Backspace"] = 8, ["Tab"] = 9, ["Enter"] = 13, ["Pause"] = 19, ["CapsLock"] = 20,
            ["Escape"] = 27, ["Space"] = 32, ["PageUp"] = 33, ["PageDown"] = 34, ["End"] = 35,
            ["Home"] = 36, ["ArrowLeft"] = 37, ["ArrowUp"] = 38, ["ArrowRight"] = 39, ["ArrowDown"] = 40,
            ["Insert"] = 45, ["Delete"] = 46, ["MetaLeft"] = 91, ["MetaRight"] = 92,
            ["ContextMenu"] = 93, ["NumpadMultiply"] = 106, ["NumpadAdd"] = 107, ["NumpadSubtract"] = 109,
            ["NumpadDecimal"] = 110, ["NumpadDivide"] = 111, ["NumLock"] = 144, ["ScrollLock"] = 145,
            ["ShiftLeft"] = 160, ["ShiftRight"] = 161, ["ControlLeft"] = 162, ["ControlRight"] = 163,
            ["AltLeft"] = 164, ["AltRight"] = 165, ["Semicolon"] = 186, ["Equal"] = 187, ["Comma"] = 188,
            ["Minus"] = 189, ["Period"] = 190, ["Slash"] = 191, ["Backquote"] = 192, ["BracketLeft"] = 219,
            ["Backslash"] = 220, ["BracketRight"] = 221, ["Quote"] = 222 };
        for (var i = 0; i < 26; i++) keys[$"Key{(char)('A' + i)}"] = (ushort)('A' + i);
        for (var i = 0; i < 10; i++) { keys[$"Digit{i}"] = (ushort)('0' + i); keys[$"Numpad{i}"] = (ushort)(96 + i); }
        for (var i = 1; i <= 24; i++) keys[$"F{i}"] = (ushort)(111 + i);
        return keys;
    }

    private readonly struct DpiScope : IDisposable
    {
        private readonly IntPtr _previous;
        public DpiScope()
        {
            _previous = Native.SetThreadDpiAwarenessContext(new IntPtr(-4));
            if (_previous == IntPtr.Zero) throw Failure("dpi-awareness-unavailable", "Cannot establish physical desktop coordinates.");
        }
        public void Dispose() { if (_previous != IntPtr.Zero) Native.SetThreadDpiAwarenessContext(_previous); }
    }

    private sealed class ClipboardScope : IDisposable
    {
        private readonly IntPtr _window;
        public ClipboardScope()
        {
            _window = Native.CreateWindowEx(0, "STATIC", "Orbit clipboard", 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (_window == IntPtr.Zero) throw Failure("clipboard-unavailable", "Cannot create clipboard owner.");
            if (Native.OpenClipboard(_window)) return;
            Native.DestroyWindow(_window);
            throw Failure("clipboard-busy", "Another application currently owns the clipboard. Try again.");
        }
        public void Dispose() { Native.CloseClipboard(); Native.DestroyWindow(_window); }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct MonitorInfoEx {
            public int Size; public Rect Monitor, Work; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device; }
        [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfoHeader { public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, ImageSize; public int XPelsPerMeter, YPelsPerMeter; public uint ColorsUsed, ColorsImportant; }
        [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfo { public BitmapInfoHeader Header; public uint Colors; }
        [StructLayout(LayoutKind.Sequential)] internal struct CursorInfo { public int Size; public uint Flags; public IntPtr Cursor; public Point Position; }
        [StructLayout(LayoutKind.Sequential)] internal struct IconInfo { [MarshalAs(UnmanagedType.Bool)] public bool Icon; public uint HotspotX, HotspotY; public IntPtr Mask, Color; }
        [StructLayout(LayoutKind.Sequential)] internal struct Input { public uint Type; public InputUnion Union; }
        [StructLayout(LayoutKind.Explicit)] internal struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
        [StructLayout(LayoutKind.Sequential)] internal struct MouseInput { public int X, Y; public uint MouseData, Flags, Time; public UIntPtr ExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] internal struct KeyboardInput { public ushort VirtualKey, Scan; public uint Flags, Time; public UIntPtr ExtraInfo; }
        internal delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect rectangle, IntPtr data);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);
        [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", CharSet = CharSet.Unicode)] internal static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfoEx info);
        [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll", SetLastError = true)] internal static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport("gdi32.dll", SetLastError = true)] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll", SetLastError = true)] internal static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rasterOperation);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
        [DllImport("user32.dll")] internal static extern bool GetCursorInfo(ref CursorInfo cursor);
        [DllImport("user32.dll")] internal static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
        [DllImport("user32.dll")] internal static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);
        [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool LockWorkStation();
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] internal static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("kernel32.dll")] internal static extern uint GetCurrentThreadId();
        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode)] internal static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder value, int length, out int needed);
        [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", SetLastError = true)] internal static extern bool WTSQuerySessionInformation(IntPtr server, int session, int info, out IntPtr buffer, out int bytes);
        [DllImport("wtsapi32.dll")] internal static extern void WTSFreeMemory(IntPtr memory);
        [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateWindowEx(uint exStyle, string className, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
        [DllImport("user32.dll")] internal static extern bool DestroyWindow(IntPtr window);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool OpenClipboard(IntPtr window);
        [DllImport("user32.dll")] internal static extern bool CloseClipboard();
        [DllImport("user32.dll")] internal static extern bool IsClipboardFormatAvailable(uint format);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr GetClipboardData(uint format);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetClipboardData(uint format, IntPtr memory);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool EmptyClipboard();
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GlobalLock(IntPtr memory);
        [DllImport("kernel32.dll")] internal static extern bool GlobalUnlock(IntPtr memory);
        [DllImport("kernel32.dll")] internal static extern UIntPtr GlobalSize(IntPtr memory);
        [DllImport("kernel32.dll")] internal static extern IntPtr GlobalFree(IntPtr memory);
    }
}
