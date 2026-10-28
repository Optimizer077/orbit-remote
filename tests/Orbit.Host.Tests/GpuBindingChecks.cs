using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Orbit.Host;
using Orbit.Host.Platform;

/// <summary>
/// Standalone GPU checks for the encoder binding (GpuMonitorCapture.Binding / GpuBinding): the device, immediate context
/// and IMFDXGIDeviceManager a new encoder binds to stay alive across a concurrent capture recovery, and encoders do not
/// leak references to them. Synthetic captures only (CreateSynthetic / PushSynthetic): no desktop duplication, no screen
/// pixels, no input. Like <see cref="GpuPipelineChecks"/>, not part of the routine suite; run through <see cref="RunStandalone"/>.
/// </summary>
public static class GpuBindingChecks
{
    private const int Width = 640, Height = 360, StressCycles = 16;
    private static readonly Guid DeviceIid = new("db6f6ddb-ac77-4e88-8253-819df9bbf140"); // ID3D11Device
    private static readonly Guid ContextIid = new("c0bfa96c-e089-44fb-8eaf-26f8796190da"); // ID3D11DeviceContext
    private static readonly Guid ManagerIid = new("eb533d5d-2db6-40f8-97a9-494692014f07"); // IMFDXGIDeviceManager

    public static void Run(Action<bool, string> check)
    {
        if (!OperatingSystem.IsWindows() || !MfH264Encoder.IsSupported) { check(true, "GPU binding checks skipped (no Windows Media Foundation)"); return; }
        RunWindows(check);
    }

    public static int RunStandalone(TextWriter? output = null)
    {
        var total = 0; var failed = 0;
        Run((ok, message) => { total++; if (!ok) failed++; output?.WriteLine((ok ? "PASS  " : "FAIL  ") + message); });
        output?.WriteLine($"{total - failed}/{total} GPU binding checks passed");
        return failed == 0 ? 0 : 1;
    }

    [SupportedOSPlatform("windows")]
    private static void RunWindows(Action<bool, string> check)
    {
        var image = GpuPipelineChecks.Synthetic(Width, Height);
        using var capture = GpuMonitorCapture.CreateSynthetic(Width, Height, out var reason);
        check(capture is not null, "Synthetic GPU capture opens for the binding checks: " + reason);
        if (capture is null) return;
        Guard(check, "binding survives recovery", () => CheckBindingSurvivesRecovery(check, capture, image));
        Guard(check, "encoder reference balance", () => CheckReferenceBalance(check, capture, image));
        Guard(check, "open during recovery", () => CheckOpenDuringRecovery(check, capture, image));
    }

    /// <summary>Deterministic: a binding taken before a recovery still owns live device, context and manager objects.</summary>
    [SupportedOSPlatform("windows")]
    private static void CheckBindingSurvivesRecovery(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        using (capture.PushSynthetic(image)) { }
        var bind = capture.Binding();
        var generation = bind.Generation;
        capture.SimulateAccessLost();
        using (capture.PushSynthetic(image)) { } // recovers: the capture releases its own references to the old objects
        var answers = Answers(bind.Device, DeviceIid) && Answers(bind.Context, ContextIid) && Answers(bind.Manager, ManagerIid);
        check(capture.Generation != generation && generation.Length > 0 && answers,
            "A binding taken before a recovery keeps the old device, context and manager alive (each still answers QueryInterface)");
        bind.Dispose();
        var idempotent = !Throws<Exception>(bind.Dispose);
        check(idempotent && Throws<ObjectDisposedException>(() => _ = bind.Device) && Throws<ObjectDisposedException>(() => _ = bind.Manager),
            "GpuBinding.Dispose releases once and is idempotent; its pointers are unusable afterwards");
    }

    /// <summary>Opening, encoding and disposing an encoder leaves the shared manager's and device's reference counts unchanged.</summary>
    [SupportedOSPlatform("windows")]
    private static void CheckReferenceBalance(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        using var lease = capture.PushSynthetic(image);
        using var bind = capture.Binding();
        static int Count(IntPtr pointer) { var count = Marshal.AddRef(pointer); Marshal.Release(pointer); return count - 1; }
        int managerBefore = Count(bind.Manager), deviceBefore = Count(bind.Device);
        string? name = null;
        using (var encoder = capture.CreateEncoder(0, 0, 30, 4_000_000, out var reason))
        {
            check(encoder is not null, "Reference balance: encoder opens: " + reason);
            if (encoder is not null) { name = encoder.EncoderName; encoder.Encode(lease, true); encoder.Flush(); }
        }
        int managerAfter = Count(bind.Manager), deviceAfter = Count(bind.Device);
        check(managerAfter == managerBefore,
            $"Reference balance: encoder create+encode+dispose leaves the device manager refcount unchanged ({managerBefore} -> {managerAfter}; device {deviceBefore} -> {deviceAfter}, report only; {name})");
    }

    /// <summary>
    /// Stream-reopen race: encoders open, encode and dispose while another thread keeps recovering the capture, with GC and
    /// finalizers between cycles. "Raced" opens (refused as capture-reset, or opened on a generation that is no longer
    /// current) prove the open overlapped a recovery; before the binding held references this was a use-after-free.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static void CheckOpenDuringRecovery(Action<bool, string> check, GpuMonitorCapture capture, byte[] image)
    {
        var recoveries = 0; var stop = false; Exception? recoveryFailure = null;
        var recovering = new Thread(() =>
        {
            try
            {
                while (!Volatile.Read(ref stop))
                {
                    capture.SimulateAccessLost();
                    try { capture.PushSynthetic(image).Dispose(); Interlocked.Increment(ref recoveries); }
                    catch (PlatformUnavailableException) { } // capture-busy or capture-lost: the next cycle retries
                    Thread.Sleep(Random.Shared.Next(1, 120)); // varied pacing: some opens race a recovery, some complete and encode
                }
            }
            catch (Exception ex) { recoveryFailure = ex; } // reported by the joining thread, never a process crash
        }) { IsBackground = true, Name = "GPU recovery stress" };
        int opened = 0, refused = 0, raced = 0, settled = 0;
        var reasons = new List<string>();
        recovering.Start();
        try
        {
            for (var i = 0; i < StressCycles; i++)
            {
                using (var encoder = capture.CreateEncoder(0, 0, 30, 4_000_000, out var reason))
                {
                    if (encoder is null) { refused++; if (reason == "capture-reset") raced++; else reasons.Add(reason); }
                    else
                    {
                        opened++;
                        if (encoder.Generation != capture.Generation) raced++;
                        using var lease = capture.Latest();
                        try { if (lease is not null) encoder.Encode(lease, true); settled++; }
                        catch (PlatformUnavailableException ex) when (ex.Code == "capture-reset") { settled++; } // a recovery won the race: stale, not a crash
                    }
                }
                GC.Collect(); GC.WaitForPendingFinalizers();
            }
        }
        finally { Volatile.Write(ref stop, true); recovering.Join(); }
        if (recoveryFailure is not null) ExceptionDispatchInfo.Capture(recoveryFailure).Throw();
        using var after = capture.PushSynthetic(image);
        using var final = capture.CreateEncoder(0, 0, 30, 4_000_000, out var finalReason);
        var produced = final is null ? [] : final.Encode(after, true).Units.Concat(final.Flush()).ToList();
        check(opened + refused == StressCycles && settled == opened && recoveries > 0 && raced > 0 && reasons.Count == 0,
            $"{StressCycles} encoder open/encode/dispose cycles overlap {recoveries} concurrent recoveries: {raced} raced, {opened} opened, {refused} refused"
            + (reasons.Count > 0 ? " (other refusals: " + string.Join("; ", reasons.Distinct()) + ")" : ""));
        check(produced.Count == 1 && produced[0].IsKeyframe, "After the recovery stress a new encoder encodes a keyframe: " + finalReason);
    }

    private static bool Answers(IntPtr pointer, Guid iid)
    {
        if (pointer == IntPtr.Zero || Marshal.QueryInterface(pointer, in iid, out var result) != 0) return false;
        Marshal.Release(result);
        return true;
    }

    /// <summary>An unexpected exception in a check group is a reported failure, never a process crash.</summary>
    private static void Guard(Action<bool, string> check, string name, Action run)
    {
        try { run(); }
        catch (Exception ex) { check(false, $"GPU binding {name} checks threw {ex.GetType().Name}: {ex.Message}"); }
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; } catch (Exception) { return false; }
    }
}
