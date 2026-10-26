using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Orbit.Host.Platform;

/// <summary>X11 baseline using distribution-provided tools. No shell, root helper, or Wayland bypass.</summary>
internal sealed partial class LinuxPlatformBackend : IPlatformBackend
{
    private readonly string? _ffmpeg = NativeProcess.Find("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg");
    private readonly string? _xdotool = NativeProcess.Find("/usr/bin/xdotool", "/usr/local/bin/xdotool");
    private readonly string? _xrandr = NativeProcess.Find("/usr/bin/xrandr");
    private readonly string? _xclip = NativeProcess.Find("/usr/bin/xclip");
    private readonly string? _loginctl = NativeProcess.Find("/usr/bin/loginctl");
    private readonly SemaphoreSlim _inputGate = new(1, 1);
    private readonly HashSet<string> _heldKeys = [];
    private readonly HashSet<string> _heldButtons = [];
    private static readonly IReadOnlyDictionary<string, string> Keys = BuildKeys();

    public async Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var (state, _) = await SessionAsync(cancellationToken);
        var limitations = new List<string> {
            "Only local X11 sessions with systemd-logind session-state reporting are supported. Wayland needs a future portal/PipeWire backend.",
            "Locked screens, display manager login and remote locking are not implemented.",
            "The Linux backend is implemented but requires validation on a Linux desktop; x11grab support must be present in ffmpeg." };
        if (_ffmpeg is null) limitations.Add("Capture requires ffmpeg from the distribution package manager.");
        if (_xdotool is null) limitations.Add("Keyboard and pointer control require xdotool.");
        if (_xrandr is null) limitations.Add("Monitor enumeration requires xrandr.");
        if (_xclip is null) limitations.Add("Clipboard requires xclip.");
        var monitors = new List<MonitorInfo>();
        if (state == "interactive" && _xrandr is not null)
        {
            try { monitors = await MonitorsAsync(cancellationToken); }
            catch (PlatformUnavailableException ex) { limitations.Add(ex.Message); }
        }
        var ready = state == "interactive" && monitors.Count > 0;
        return new PlatformStatus("Linux", state, ready && _ffmpeg is not null, ready && _xdotool is not null,
            ready && _xclip is not null, false, monitors, limitations);
    }

    public async Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default)
    {
        await RequireInteractiveAsync(cancellationToken);
        var executable = _ffmpeg ?? throw Missing("ffmpeg");
        var monitor = PlatformLimits.SelectMonitor(await MonitorsAsync(cancellationToken), monitorId);
        PlatformLimits.CheckDimensions(monitor.Width, monitor.Height);
        var display = LocalDisplay();
        var source = display + "+" + monitor.Left.ToString(CultureInfo.InvariantCulture) + "," + monitor.Top.ToString(CultureInfo.InvariantCulture);
        var png = await NativeProcess.RunAsync(executable, ["-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "x11grab", "-draw_mouse", "1", "-video_size", $"{monitor.Width}x{monitor.Height}", "-i", source,
            "-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"], cancellationToken);
        var (width, height) = PngEncoder.ReadDimensions(png);
        await RequireInteractiveAsync(cancellationToken);
        return new ScreenFrame(png, width, height, monitor.Left, monitor.Top, DateTimeOffset.UtcNow);
    }

    public async Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default)
    {
        await _inputGate.WaitAsync(cancellationToken);
        try
        {
            await RequireInteractiveAsync(cancellationToken);
            var executable = _xdotool ?? throw Missing("xdotool");
            switch (input.Kind)
            {
                case "pointerMove":
                    await MoveAsync(input, executable, cancellationToken); break;
                case "pointerButton":
                {
                    var button = Button(input.Button);
                    var down = PlatformLimits.Down(input);
                    await MoveAsync(input, executable, cancellationToken);
                    await NativeProcess.RunAsync(executable, [down ? "mousedown" : "mouseup", button], cancellationToken, 1024);
                    if (down) _heldButtons.Add(button); else _heldButtons.Remove(button);
                    break;
                }
                case "key":
                {
                    if (input.Key is null || !Keys.TryGetValue(input.Key, out var key)) throw new ArgumentException("Unsupported keyboard code.");
                    var down = PlatformLimits.Down(input);
                    await NativeProcess.RunAsync(executable, [down ? "keydown" : "keyup", key], cancellationToken, 1024);
                    if (down) _heldKeys.Add(key); else _heldKeys.Remove(key);
                    break;
                }
                case "wheel":
                {
                    if (Math.Abs((long)input.DeltaX) > 1200 || Math.Abs((long)input.DeltaY) > 1200)
                        throw new ArgumentException("Wheel deltas must be between -1200 and 1200.");
                    var commands = new List<string>();
                    AddWheel(commands, input.DeltaY, "5", "4"); AddWheel(commands, input.DeltaX, "7", "6");
                    if (commands.Count > 0) await NativeProcess.RunAsync(executable, commands, cancellationToken, 1024);
                    break;
                }
                default: throw new ArgumentException("Unsupported input kind.");
            }
        }
        finally { _inputGate.Release(); }
    }

    private async Task MoveAsync(RemoteInput input, string executable, CancellationToken cancellationToken)
    {
        PlatformLimits.CheckPointer(input, await MonitorsAsync(cancellationToken));
        await NativeProcess.RunAsync(executable, ["mousemove", "--", input.X.ToString(CultureInfo.InvariantCulture),
            input.Y.ToString(CultureInfo.InvariantCulture)], cancellationToken, 1024);
    }

    private static void AddWheel(List<string> commands, int delta, string positive, string negative)
    {
        if (delta == 0) return;
        commands.AddRange(["click", "--repeat", Math.Clamp((Math.Abs(delta) + 119) / 120, 1, 10).ToString(CultureInfo.InvariantCulture),
            "--delay", "0", delta > 0 ? positive : negative]);
    }

    public async Task ReleaseInputsAsync(CancellationToken cancellationToken = default)
    {
        await _inputGate.WaitAsync(cancellationToken);
        try
        {
            if (_xdotool is not null && (await SessionAsync(cancellationToken)).State == "interactive")
            {
                var commands = new List<string>();
                foreach (var key in _heldKeys) commands.AddRange(["keyup", key]);
                foreach (var button in _heldButtons) commands.AddRange(["mouseup", button]);
                if (commands.Count > 0)
                    try { await NativeProcess.RunAsync(_xdotool, commands, cancellationToken, 1024); }
                    catch (PlatformUnavailableException) { /* A disconnected desktop must not strand the session cleanup. */ }
            }
            _heldKeys.Clear(); _heldButtons.Clear();
        }
        finally { _inputGate.Release(); }
    }

    public async Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default)
    {
        await RequireInteractiveAsync(cancellationToken);
        var text = Encoding.UTF8.GetString(await NativeProcess.RunAsync(_xclip ?? throw Missing("xclip"),
            ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"], cancellationToken, PlatformLimits.MaximumClipboardCharacters * 4));
        PlatformLimits.CheckClipboard(text); return text;
    }

    public async Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default)
    {
        PlatformLimits.CheckClipboard(text); await RequireInteractiveAsync(cancellationToken);
        // xclip becomes the clipboard owner. Its standard silent mode forks and returns after receiving stdin.
        await NativeProcess.RunAsync(_xclip ?? throw Missing("xclip"), ["-selection", "clipboard", "-in", "-target", "UTF8_STRING"], cancellationToken, 1024, text);
    }

    public Task LockAsync(CancellationToken cancellationToken = default) => Task.FromException(new PlatformUnavailableException(
        "lock-unsupported", "Remote locking is not implemented on Linux in this version."));
    public async ValueTask DisposeAsync() { await ReleaseInputsAsync(); _inputGate.Dispose(); }

    private async Task RequireInteractiveAsync(CancellationToken cancellationToken)
    {
        var (state, _) = await SessionAsync(cancellationToken);
        if (state != "interactive") throw new PlatformUnavailableException("desktop-unavailable", $"Linux desktop is {state}. An unlocked local X11 session with logind state reporting is required.");
    }

    private async Task<(string State, string? Session)> SessionAsync(CancellationToken cancellationToken)
    {
        if (string.Equals(Environment.GetEnvironmentVariable("XDG_SESSION_TYPE"), "wayland", StringComparison.OrdinalIgnoreCase) ||
            !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("WAYLAND_DISPLAY"))) return ("wayland-unsupported", null);
        if (!DisplayPattern().IsMatch(Environment.GetEnvironmentVariable("DISPLAY") ?? string.Empty)) return ("local-x11-required", null);
        var session = Environment.GetEnvironmentVariable("XDG_SESSION_ID");
        if (_loginctl is null || session is null || !SessionPattern().IsMatch(session)) return ("session-state-unavailable", null);
        try
        {
            var text = Encoding.UTF8.GetString(await NativeProcess.RunAsync(_loginctl,
                ["show-session", session, "--property=LockedHint", "--property=Active", "--property=Type", "--no-pager"], cancellationToken, 4096, timeoutSeconds: 3));
            var properties = text.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Split('=', 2))
                .Where(x => x.Length == 2).ToDictionary(x => x[0].Trim(), x => x[1].Trim(), StringComparer.Ordinal);
            if (!properties.TryGetValue("LockedHint", out var locked) || !properties.TryGetValue("Active", out var active) ||
                !properties.TryGetValue("Type", out var type)) return ("session-state-unavailable", session);
            if (type != "x11") return ("x11-session-required", session);
            if (locked == "yes") return ("locked", session);
            if (locked != "no" || active != "yes") return ("inactive", session);
            return ("interactive", session);
        }
        catch (PlatformUnavailableException) { return ("session-state-unavailable", session); }
    }

    private async Task<List<MonitorInfo>> MonitorsAsync(CancellationToken cancellationToken)
    {
        var text = Encoding.UTF8.GetString(await NativeProcess.RunAsync(_xrandr ?? throw Missing("xrandr"),
            ["--listmonitors"], cancellationToken, 65_536));
        var monitors = new List<MonitorInfo>();
        foreach (var line in text.Split('\n'))
        {
            var match = MonitorPattern().Match(line);
            if (!match.Success) continue;
            int Number(string name) => int.Parse(match.Groups[name].Value, CultureInfo.InvariantCulture);
            monitors.Add(new MonitorInfo(match.Groups["name"].Value, match.Groups["name"].Value,
                Number("left"), Number("top"), Number("width"), Number("height"), match.Groups["flags"].Value.Contains('*')));
        }
        return monitors;
    }

    private static string LocalDisplay()
    {
        var display = Environment.GetEnvironmentVariable("DISPLAY") ?? string.Empty;
        if (!DisplayPattern().IsMatch(display)) throw new PlatformUnavailableException("local-x11-required", "A local X11 display such as :0 is required.");
        return display;
    }

    private static string Button(string? button) => button switch { "left" => "1", "middle" => "2", "right" => "3", _ => throw new ArgumentException("Unsupported pointer button.") };
    private static PlatformUnavailableException Missing(string name) => new("dependency-missing", $"Install {name} using the distribution package manager.");

    [GeneratedRegex(@"^:[0-9]{1,5}(\.[0-9]{1,3})?$", RegexOptions.CultureInvariant)] private static partial Regex DisplayPattern();
    [GeneratedRegex(@"^[A-Za-z0-9_-]{1,64}$", RegexOptions.CultureInvariant)] private static partial Regex SessionPattern();
    [GeneratedRegex(@"^\s*\d+:\s+(?<flags>[+*]*)(?<name>\S+)\s+(?<width>\d+)/(?:\d+)x(?<height>\d+)/(?:\d+)(?<left>[+-]\d+)(?<top>[+-]\d+)", RegexOptions.CultureInvariant)]
    private static partial Regex MonitorPattern();

    private static IReadOnlyDictionary<string, string> BuildKeys()
    {
        var keys = new Dictionary<string, string>(StringComparer.Ordinal) {
            ["Backspace"]="BackSpace",["Tab"]="Tab",["Enter"]="Return",["Escape"]="Escape",["Space"]="space",
            ["PageUp"]="Prior",["PageDown"]="Next",["End"]="End",["Home"]="Home",["ArrowLeft"]="Left",["ArrowUp"]="Up",
            ["ArrowRight"]="Right",["ArrowDown"]="Down",["Insert"]="Insert",["Delete"]="Delete",["MetaLeft"]="Super_L",["MetaRight"]="Super_R",
            ["ShiftLeft"]="Shift_L",["ShiftRight"]="Shift_R",["ControlLeft"]="Control_L",["ControlRight"]="Control_R",
            ["AltLeft"]="Alt_L",["AltRight"]="Alt_R",["CapsLock"]="Caps_Lock",["NumLock"]="Num_Lock",["ScrollLock"]="Scroll_Lock",
            ["Semicolon"]="semicolon",["Equal"]="equal",["Comma"]="comma",["Minus"]="minus",["Period"]="period",
            ["Slash"]="slash",["Backquote"]="grave",["BracketLeft"]="bracketleft",["Backslash"]="backslash",["BracketRight"]="bracketright",
            ["Quote"]="apostrophe",["NumpadEnter"]="KP_Enter",["NumpadAdd"]="KP_Add",["NumpadSubtract"]="KP_Subtract",
            ["NumpadMultiply"]="KP_Multiply",["NumpadDivide"]="KP_Divide",["NumpadDecimal"]="KP_Decimal" };
        for (var i = 0; i < 26; i++) keys[$"Key{(char)('A' + i)}"] = ((char)('a' + i)).ToString();
        for (var i = 0; i < 10; i++) { keys[$"Digit{i}"] = i.ToString(CultureInfo.InvariantCulture); keys[$"Numpad{i}"] = $"KP_{i}"; }
        for (var i = 1; i <= 24; i++) keys[$"F{i}"] = $"F{i}";
        return keys;
    }
}
