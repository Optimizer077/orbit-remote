using System.Runtime.InteropServices;

namespace Orbit.Host.Platform;

internal interface IWindowsDisplayNotifications
{
    IDisposable? Subscribe(Guid setting, Action<Guid, int, int> changed);
}

/// <summary>Observes this process session's display state; never requests a power-state change.</summary>
internal sealed class WindowsDisplayAvailability : IDisposable
{
    internal static readonly Guid SessionDisplayStatus = new("2b84c20e-ad23-4ddf-93db-05ffbd7efca5");
    internal static readonly Guid ConsoleDisplayState = new("6fe69556-704a-47a0-8f24-c28d936fda47");
    private readonly IDisposable? sessionSubscription, consoleSubscription;
    private int sessionState = 3, consoleState = 3, disposed;
    internal string State
    {
        get
        {
            if (Volatile.Read(ref disposed) != 0) return "unknown";
            var session = Volatile.Read(ref sessionState); var console = Volatile.Read(ref consoleState);
            return session == 0 || console == 0 ? "off" : session == 2 || console == 2 ? "dimmed"
                : session == 1 || console == 1 ? "on" : "unknown";
        }
    }

    internal WindowsDisplayAvailability(IWindowsDisplayNotifications? notifications = null)
    {
        notifications ??= new NativeNotifications();
        sessionSubscription = notifications.Subscribe(SessionDisplayStatus, Changed);
        consoleSubscription = notifications.Subscribe(ConsoleDisplayState, Changed);
    }

    private void Changed(Guid setting, int length, int value)
    {
        if (Volatile.Read(ref disposed) != 0) return;
        var next = length == 4 && value is >= 0 and <= 2 ? value : 3;
        if (setting == SessionDisplayStatus) Volatile.Write(ref sessionState, next);
        else if (setting == ConsoleDisplayState) Volatile.Write(ref consoleState, next);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        try { sessionSubscription?.Dispose(); } finally { consoleSubscription?.Dispose(); }
    }

    private sealed class NativeNotifications : IWindowsDisplayNotifications
    {
        public IDisposable? Subscribe(Guid setting, Action<Guid, int, int> changed)
        {
            if (!OperatingSystem.IsWindows()) return null;
            try { return NativeSubscription.Create(setting, changed); }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { return null; }
        }
    }

    private sealed class NativeSubscription : IDisposable
    {
        // If unregister fails, the OS may still call the delegate. Retain that
        // one host-lifetime registration rather than free a callable pointer.
        private static readonly List<NativeSubscription> FailedUnregisterRoots = [];
        private readonly Native.Callback callback;
        private IntPtr recipient, handle;
        private int disposed;
        private NativeSubscription(Action<Guid, int, int> changed)
        {
            callback = (_, type, setting) =>
            {
                try
                {
                    if (type == 0x8013 && setting != IntPtr.Zero)
                    {
                        var guid = Marshal.PtrToStructure<Guid>(setting);
                        var length = Marshal.ReadInt32(setting, 16);
                        changed(guid, length, length == 4 ? Marshal.ReadInt32(setting, 20) : 3);
                    }
                }
                catch { /* A native callback must never unwind into the OS. */ }
                return 0;
            };
        }
        internal static NativeSubscription? Create(Guid setting, Action<Guid, int, int> changed)
        {
            var value = new NativeSubscription(changed);
            try
            {
                value.recipient = Marshal.AllocHGlobal(Marshal.SizeOf<Native.Parameters>());
                Marshal.StructureToPtr(new Native.Parameters
                { Callback = Marshal.GetFunctionPointerForDelegate(value.callback) }, value.recipient, false);
                var guid = setting;
                if (Native.Register(ref guid, 2, value.recipient, out value.handle) == 0 && value.handle != IntPtr.Zero) return value;
                value.handle = IntPtr.Zero;
                return null;
            }
            finally
            {
                if (value.handle == IntPtr.Zero && value.recipient != IntPtr.Zero)
                { Marshal.FreeHGlobal(value.recipient); value.recipient = IntPtr.Zero; }
                GC.KeepAlive(value.callback);
            }
        }
        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0) return;
            if (handle != IntPtr.Zero && Native.Unregister(handle) != 0)
            { lock (FailedUnregisterRoots) FailedUnregisterRoots.Add(this); return; }
            handle = IntPtr.Zero;
            if (recipient != IntPtr.Zero) { Marshal.FreeHGlobal(recipient); recipient = IntPtr.Zero; }
            GC.KeepAlive(callback);
        }
    }

    private static class Native
    {
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] internal delegate uint Callback(IntPtr context, uint type, IntPtr setting);
        [StructLayout(LayoutKind.Sequential)] internal struct Parameters { internal IntPtr Callback, Context; }
        [DllImport("powrprof.dll", EntryPoint = "PowerSettingRegisterNotification")] internal static extern uint Register(ref Guid guid, uint flags, IntPtr recipient, out IntPtr handle);
        [DllImport("powrprof.dll", EntryPoint = "PowerSettingUnregisterNotification")] internal static extern uint Unregister(IntPtr handle);
    }
}
