using System.Diagnostics;
using Orbit.Host.Platform;

public static class WindowsSessionChecks
{
    public static void Run(Action<bool, string> check)
    {
        check(WindowsPlatformBackend.CheckedSessionId(false, 1) is null, "Failed native session lookup never becomes an authorized session");
        check(WindowsPlatformBackend.CheckedSessionId(false, 0) is null, "Failed native lookup cannot be confused with session zero");
        check(WindowsPlatformBackend.CheckedSessionId(true, 0) == 0, "Session zero remains identifiable for the non-interactive guard");
        check(WindowsPlatformBackend.CheckedSessionId(true, 1) == 1 && WindowsPlatformBackend.CheckedSessionId(true, int.MaxValue) == int.MaxValue,
            "Valid native session identifiers retain their exact WTS value");
        check(WindowsPlatformBackend.CheckedSessionId(true, (uint)int.MaxValue + 1) is null && WindowsPlatformBackend.CheckedSessionId(true, uint.MaxValue) is null,
            "Unsigned native identifiers never wrap to negative WTS session selectors");
        if (!OperatingSystem.IsWindows()) return;
        using var process = Process.GetCurrentProcess();
        check(WindowsPlatformBackend.ReadProcessSessionId() == process.SessionId, "Direct Win32 lookup matches this live process session without changing it");
    }
}
