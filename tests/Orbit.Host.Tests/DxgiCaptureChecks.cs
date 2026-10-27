using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Orbit.Host.Platform;

/// <summary>
/// Checks for the DXGI Desktop Duplication capturer. They run against the real desktop, so pixel buffers are only
/// inspected in memory: nothing here writes, logs, hashes or sends screen content. Output is dimensions, counts and timings.
/// </summary>
public static class DxgiCaptureChecks
{
    /// <param name="timings">When given, also measures DXGI vs GDI BitBlt capture and prints timings only (takes a few seconds).</param>
    public static void Run(Action<bool, string> check, TextWriter? timings = null)
    {
        var bogus = new MonitorInfo(@"\\.\ORBIT-NO-SUCH-DISPLAY", "none", -100_000, -100_000, 640, 480, false);
        if (!OperatingSystem.IsWindows())
        {
            check(!DxgiCapture.IsSupported, "DXGI capture reports unsupported off Windows");
            check(DxgiCapture.TryCreate(bogus, out var reason) is null && reason == "unsupported-os", "DXGI TryCreate returns null off Windows (BitBlt-free platforms keep their own capture)");
            return;
        }
        RunWindows(check, timings, bogus);
    }

    /// <summary>Standalone entry so the checks can run without the full harness. Returns a process exit code.</summary>
    public static int RunStandalone(TextWriter? output = null)
    {
        var total = 0; var failed = 0;
        Run((ok, message) =>
        {
            total++; if (!ok) failed++;
            output?.WriteLine((ok ? "PASS  " : "FAIL  ") + message);
        }, output);
        output?.WriteLine($"{total - failed}/{total} DXGI capture checks passed");
        return failed == 0 ? 0 : 1;
    }

    [SupportedOSPlatform("windows")]
    private static void RunWindows(Action<bool, string> check, TextWriter? timings, MonitorInfo bogus)
    {
        if (!DxgiCapture.IsSupported)
        {
            check(DxgiCapture.TryCreate(bogus, out var off) is null && off.Length > 0, $"DXGI unavailable on this machine; TryCreate falls back ({off})");
            return;
        }
        check(DxgiCapture.TryCreate(bogus, out var missing) is null && missing == "output-not-found", $"Unknown monitor falls back cleanly ({missing})");

        var backend = new WindowsPlatformBackend();
        var status = backend.GetStatusAsync().GetAwaiter().GetResult();
        if (!status.CanCapture || status.Monitors.Count == 0) { check(true, $"Desktop is {status.SessionState}; live DXGI checks skipped"); return; }
        var primary = status.Monitors.FirstOrDefault(m => m.Primary) ?? status.Monitors[0];
        var wrongSize = primary with { Width = primary.Width + 1 };
        check(DxgiCapture.TryCreate(wrongSize, out var mismatch) is null && mismatch == "size-mismatch", $"Size disagreement with the backend falls back ({mismatch})");

        var opened = 0;
        foreach (var monitor in status.Monitors)
        {
            using var each = DxgiCapture.TryCreate(monitor, out var why);
            if (each is null) { check(Environmental(why), $"Monitor {monitor.Width}x{monitor.Height} not duplicable for an environmental reason ({why})"); continue; }
            opened++;
            check(each.Width == monitor.Width && each.Height == monitor.Height && each.Rotation is 0 or 1,
                $"DXGI dimensions match the backend for monitor {opened} ({each.Width}x{each.Height}, rotation {each.Rotation})");
        }

        using var capture = DxgiCapture.TryCreate(primary, out var reason);
        if (capture is null) { check(Environmental(reason), $"Primary monitor not duplicable here ({reason}); BitBlt fallback applies"); return; }
        var buffer = new byte[capture.RequiredBytes];
        check(capture.RequiredBytes == checked(primary.Width * primary.Height * 4), "RequiredBytes is width * height * 4 (encoder contract)");
        check(Throws<ArgumentException>(() => capture.Acquire(0, new byte[capture.RequiredBytes - 1])), "Too-small destination is rejected");
        check(Throws<ArgumentNullException>(() => capture.Acquire(0, null!)), "Null destination is rejected");
        check(Throws<ArgumentOutOfRangeException>(() => capture.Acquire(-1, buffer)) &&
              Throws<ArgumentOutOfRangeException>(() => capture.Acquire(DxgiCapture.MaximumTimeoutMs + 1, buffer)), "Out-of-range timeouts are rejected");

        var first = FirstImage(capture, buffer, out var attempts);
        check(first is { Changed: true, FullFrame: true } && first.Width == primary.Width && first.Height == primary.Height,
            $"First acquire returns a full {first?.Width}x{first?.Height} frame (attempts {attempts})");
        check(first is not null && first.DirtyRects.Count == 1 && first.DirtyRects[0] == new DxgiRect(0, 0, primary.Width, primary.Height),
            "A full frame reports one whole-surface rect");
        check(first is not null && HasContent(buffer), "Full frame buffer is not all zeros (checked in memory only)");

        // A tight timeout-0 loop outpaces even a 60-144 Hz animating desktop, so the timeout path is always exercised.
        var sentinel = new byte[capture.RequiredBytes];
        int unchanged = 0, changed = 0, pointerOnly = 0, rects = 0; var untouched = true; var threw = false; var rectsOk = true;
        for (var i = 0; i < 60; i++)
        {
            Array.Fill(sentinel, (byte)0xA5);
            try
            {
                var frame = capture.Acquire(i % 3 == 0 ? 15 : 0, sentinel);
                if (frame.Changed) { changed++; rects += frame.DirtyRects.Count; rectsOk &= frame.DirtyRects.Count > 0; continue; }
                unchanged++; if (frame.PointerMoved) pointerOnly++;
                untouched &= frame.DirtyRects.Count == 0 && sentinel.AsSpan().IndexOfAnyExcept((byte)0xA5) < 0;
            }
            catch (Exception) { threw = true; break; }
        }
        check(!threw && unchanged > 0, $"Repeated short acquires report unchanged without throwing ({unchanged} unchanged, {changed} changed, {pointerOnly} pointer-only, {rects} rects)");
        check(untouched, "Unchanged results leave the destination untouched and carry no rects");
        check(rectsOk, "Every changed frame carries at least one dirty rect");

        capture.SimulateAccessLost();
        var recovered = TryAcquire(capture, 1000, buffer);
        check(recovered is { Recovered: true, Changed: true, FullFrame: true } && capture.Width == primary.Width,
            $"Access-lost path recreates the duplication and returns a full frame (recovered {recovered?.Recovered}, changed {recovered?.Changed})");
        check(TryAcquire(capture, 0, buffer) is { Recovered: false }, "Capture continues normally after recovery");

        using (var second = DxgiCapture.TryCreate(primary, out var secondReason))
        {
            var works = second is not null && FirstImage(second, new byte[second.RequiredBytes], out _) is { Changed: true };
            check(works || second is null && secondReason.Length > 0, $"A second concurrent duplication works or falls back cleanly ({(works ? "works" : secondReason)})");
        }

        capture.Dispose();
        check(!Throws<Exception>(capture.Dispose), "Dispose is idempotent");
        check(Throws<ObjectDisposedException>(() => capture.Acquire(0, buffer)), "Acquire after dispose throws ObjectDisposedException");
        using (var reopened = DxgiCapture.TryCreate(primary, out var reopenReason))
            check(reopened is not null && FirstImage(reopened, buffer, out _) is { FullFrame: true }, $"Disposing frees the output for a new instance ({(reopened is null ? reopenReason : "ok")})");

        if (timings is not null) Measure(primary, timings);
    }

    [SupportedOSPlatform("windows")]
    private static DxgiFrame? FirstImage(DxgiCapture capture, byte[] buffer, out int attempts)
    {
        for (attempts = 1; attempts <= 5; attempts++)
            if (TryAcquire(capture, 1000, buffer) is { Changed: true } frame) return frame;
        return null;
    }

    [SupportedOSPlatform("windows")]
    private static DxgiFrame? TryAcquire(DxgiCapture capture, int timeoutMs, byte[] buffer)
    {
        try { return capture.Acquire(timeoutMs, buffer); } catch (PlatformUnavailableException) { return null; }
    }

    /// <summary>Reasons a real, backend-reported monitor may legitimately refuse duplication. Anything else
    /// (size-mismatch, output-not-found) means DxgiCapture disagrees with the backend: a bug, not a fallback.</summary>
    private static bool Environmental(string reason) => reason is "unsupported" or "access-denied" or "not-currently-available"
        or "session-disconnected" || reason.StartsWith("rotated-", StringComparison.Ordinal);

    private static bool HasContent(byte[] bgra)
    {
        for (var i = 0; i < bgra.Length; i += 4) if ((bgra[i] | bgra[i + 1] | bgra[i + 2]) != 0) return true;
        return false;
    }

    /// <summary>Timings only. Steady-state DXGI frames are opportunistic (the desktop must change on its own). A fresh
    /// instance's first image includes waiting for the next present, so it is reported separately with the open cost.</summary>
    [SupportedOSPlatform("windows")]
    private static void Measure(MonitorInfo monitor, TextWriter output)
    {
        var buffer = new byte[checked(monitor.Width * monitor.Height * 4)];
        var poll = new List<double>(); var steady = new List<double>();
        using (var capture = DxgiCapture.TryCreate(monitor, out _))
        {
            if (capture is null || FirstImage(capture, buffer, out _) is null) { output.WriteLine("TIMING DXGI unavailable"); return; }
            for (var i = 0; i < 30; i++)
            {
                Thread.Sleep(40); // let changes accumulate so Acquire(0) does not wait
                var watch = Stopwatch.StartNew();
                var frame = capture.Acquire(0, buffer);
                (frame.Changed ? steady : poll).Add(watch.Elapsed.TotalMilliseconds);
            }
            for (var i = 0; i < 30; i++)
            {
                var watch = Stopwatch.StartNew();
                var frame = capture.Acquire(0, buffer);
                (frame.Changed ? steady : poll).Add(watch.Elapsed.TotalMilliseconds);
            }
        }
        var open = new List<double>(); var fresh = new List<double>();
        for (var i = 0; i < 30; i++)
        {
            var watch = Stopwatch.StartNew();
            using var instance = DxgiCapture.TryCreate(monitor, out _);
            if (instance is null) break;
            open.Add(watch.Elapsed.TotalMilliseconds);
            watch.Restart();
            if (instance.Acquire(1000, buffer).Changed) fresh.Add(watch.Elapsed.TotalMilliseconds);
        }
        var bitblt = new List<double>();
        for (var i = 0; i < 30; i++) { var watch = Stopwatch.StartNew(); BitBltCopy(monitor, buffer); bitblt.Add(watch.Elapsed.TotalMilliseconds); }
        var backend = new WindowsPlatformBackend(); var png = new List<double>();
        for (var i = 0; i < 5; i++) { var watch = Stopwatch.StartNew(); _ = backend.CaptureAsync(monitor.Id).GetAwaiter().GetResult(); png.Add(watch.Elapsed.TotalMilliseconds); }

        output.WriteLine($"TIMING {monitor.Width}x{monitor.Height} primary, ms (median / p95 / n):");
        output.WriteLine("TIMING   DXGI changed frame (acquire + GPU copy + map + row copy): " + Stats(steady));
        output.WriteLine("TIMING   DXGI unchanged poll (Acquire timeout 0):                 " + Stats(poll));
        output.WriteLine("TIMING   DXGI open (TryCreate: enumerate, device, duplicate):     " + Stats(open));
        output.WriteLine("TIMING   DXGI fresh instance first image (incl. present wait):    " + Stats(fresh));
        output.WriteLine("TIMING   GDI BitBlt + copy (backend path minus cursor and PNG):   " + Stats(bitblt));
        output.WriteLine("TIMING   Backend CaptureAsync (BitBlt + cursor + PNG, in memory): " + Stats(png));
    }

    private static string Stats(List<double> values)
    {
        if (values.Count == 0) return "n/a (n=0)";
        values.Sort();
        double At(double q) => values[Math.Min(values.Count - 1, (int)Math.Ceiling(q * values.Count) - 1)];
        return $"{At(0.5):0.00} / {At(0.95):0.00} / n={values.Count}";
    }

    /// <summary>Same GDI calls as WindowsPlatformBackend.Capture, minus cursor and PNG, into a managed buffer.</summary>
    [SupportedOSPlatform("windows")]
    private static void BitBltCopy(MonitorInfo monitor, byte[] destination)
    {
        var previousDpi = Gdi.SetThreadDpiAwarenessContext(new IntPtr(-4));
        var source = Gdi.GetDC(IntPtr.Zero); var dc = IntPtr.Zero; var bitmap = IntPtr.Zero; var old = IntPtr.Zero;
        try
        {
            dc = Gdi.CreateCompatibleDC(source);
            var info = new Gdi.BitmapInfoHeader { Size = 40, Width = monitor.Width, Height = -monitor.Height, Planes = 1, BitCount = 32 };
            bitmap = Gdi.CreateDIBSection(dc, ref info, 0, out var pixels, IntPtr.Zero, 0);
            old = Gdi.SelectObject(dc, bitmap);
            if (!Gdi.BitBlt(dc, 0, 0, monitor.Width, monitor.Height, source, monitor.Left, monitor.Top, 0x40CC0020)) throw new InvalidOperationException("BitBlt failed");
            Marshal.Copy(pixels, destination, 0, monitor.Width * monitor.Height * 4);
        }
        finally
        {
            if (old != IntPtr.Zero) Gdi.SelectObject(dc, old);
            if (bitmap != IntPtr.Zero) Gdi.DeleteObject(bitmap);
            if (dc != IntPtr.Zero) Gdi.DeleteDC(dc);
            Gdi.ReleaseDC(IntPtr.Zero, source);
            if (previousDpi != IntPtr.Zero) Gdi.SetThreadDpiAwarenessContext(previousDpi);
        }
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; } catch (Exception) { return false; }
    }

    private static class Gdi
    {
        [StructLayout(LayoutKind.Sequential)] internal struct BitmapInfoHeader { public uint Size; public int Width, Height; public ushort Planes, BitCount; public uint Compression, ImageSize; public int XPelsPerMeter, YPelsPerMeter; public uint ColorsUsed, ColorsImportant; }
        [DllImport("user32.dll")] internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfoHeader info, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] internal static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
    }
}
