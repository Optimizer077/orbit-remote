using System.Runtime.InteropServices;

namespace Orbit.Host.Platform;

/// <summary>
/// While a video stream runs, asks Windows for 1 ms timer resolution. Encoder and driver code loaded in this process (the
/// Qualcomm H.264 MFT on Windows on ARM, for one) waits with sleeps that otherwise round up to the 15.6 ms default tick: there
/// the encode stages measured 15.7 ms on the CPU path and 2 x 16 ms on the GPU path. Windows 11 ignores the request from a
/// process without a visible window unless it opts out of timer-resolution throttling, so that is set as well.
/// Reference-counted across streams; a no-op off Windows.
/// </summary>
internal static class TimerResolution
{
    private static readonly object gate = new();
    private static int users;

    internal static int Users { get { lock (gate) return users; } }

    public static IDisposable Acquire()
    {
        if (!OperatingSystem.IsWindows()) return new Lease(counted: false);
        lock (gate)
        {
            if (users++ == 0) { IgnoreTimerThrottling(); _ = timeBeginPeriod(1); }
        }
        return new Lease(counted: true);
    }

    private sealed class Lease(bool counted) : IDisposable
    {
        private int disposed;
        public void Dispose()
        {
            if (!counted || Interlocked.Exchange(ref disposed, 1) != 0) return;
            lock (gate) if (--users == 0) _ = timeEndPeriod(1);
        }
    }

    private static void IgnoreTimerThrottling()
    {
        // PROCESS_POWER_THROTTLING_STATE: version 1, control PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION (4), state 0 = honour.
        var state = new PowerThrottlingState { Version = 1, ControlMask = 4, StateMask = 0 };
        _ = SetProcessInformation(GetCurrentProcess(), ProcessPowerThrottling, ref state, (uint)Marshal.SizeOf<PowerThrottlingState>());
    }

    private const int ProcessPowerThrottling = 4;
    [StructLayout(LayoutKind.Sequential)] private struct PowerThrottlingState { public uint Version, ControlMask, StateMask; }
    [DllImport("winmm.dll")] private static extern uint timeBeginPeriod(uint milliseconds);
    [DllImport("winmm.dll")] private static extern uint timeEndPeriod(uint milliseconds);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessInformation(IntPtr process, int informationClass, ref PowerThrottlingState information, uint size);
}
