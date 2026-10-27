using System.Collections.Concurrent;
using Orbit.Host;
using Orbit.Host.Platform;

public static class SharedMonitorChecks
{
    public static async Task RunAsync(Action<bool, string> check, Action<Action, string> reject)
    {
        byte[] background = [10, 20, 30, 0, 40, 50, 60, 0];
        var color = background.ToArray();
        CursorCompositor.Draw(color, 2, 1, new(true, 0, 0, new(2, 1, 1, 4, [110, 120, 130, 128])));
        check(color[0] == 60 && color[1] == 70 && color[2] == 80 && color[4] == 40, "Color cursor alpha blends visible RGB without changing other pixels");
        var masked = background.ToArray();
        CursorCompositor.Draw(masked, 2, 1, new(true, 0, 0, new(4, 2, 1, 8, [1, 2, 3, 0, 255, 255, 255, 255])));
        check(masked[0] == 1 && masked[1] == 2 && masked[2] == 3 && masked[4] == (40 ^ 255), "Masked-color cursor supports replacement and XOR masks");
        var mono = new byte[16]; Array.Fill(mono, (byte)0x55);
        CursorCompositor.Draw(mono, 4, 1, new(true, 0, 0, new(1, 4, 2, 1, [0x30, 0x50])));
        check(mono[0] == 0 && mono[4] == 255 && mono[8] == 0x55 && mono[12] == 0xaa, "Monochrome cursor handles black, white, transparent and inverted pixels");
        var clipped = background.ToArray(); CursorCompositor.Draw(clipped, 2, 1, new(true, -1, 0, new(4, 2, 1, 8, [1, 2, 3, 0, 7, 8, 9, 0])));
        check(clipped[0] == 7 && clipped[4] == 40, "Pointer clipping preserves top-left coordinates at negative monitor edges");
        var hidden = background.ToArray(); CursorCompositor.Draw(hidden, 2, 1, new(false, 0, 0, new(2, 1, 1, 4, [1, 2, 3, 255])));
        check(hidden.SequenceEqual(background), "Invisible or hardware-composited pointer is not drawn twice");
        var missingShape = background.ToArray(); CursorCompositor.Draw(missingShape, 2, 1, new(true, 0, 0, null));
        check(missingShape.SequenceEqual(background), "A pointer update without its first shape skips drawing without disabling capture");
        var nonzeroMask = background.ToArray(); CursorCompositor.Draw(nonzeroMask, 2, 1, new(true, 0, 0, new(4, 1, 1, 4, [255, 255, 255, 1, 99])));
        check(nonzeroMask[0] == (10 ^ 255), "Any nonzero masked-color alpha selects XOR and trailing native shape bytes are allowed");
        check(CursorCompositor.SameDrawnState(new(false, 1, 2, null), new(false, 9, 8, new(2, 1, 1, 4, [1, 2, 3, 255]))),
            "Invisible pointer movement or shape changes have identical drawn state");
        check(CursorCompositor.SameDrawnState(new(true, 1, 2, new(2, 1, 1, 4, [1, 2, 3, 255])), new(true, 1, 2, new(2, 1, 1, 4, [1, 2, 3, 255, 99]))),
            "Equivalent visible cursor shapes ignore unused trailing buffer bytes");
        reject(() => CursorCompositor.Validate(new(9, 1, 1, 4, [0, 0, 0, 0])), "Unknown native cursor format fails to fallback");
        reject(() => CursorCompositor.Validate(new(1, 1, 3, 1, [0, 0, 0])), "Odd monochrome mask height is rejected");

        var monitor = new MonitorInfo("synthetic", "Synthetic", -2, 3, 2, 1, true);
        var created = new ConcurrentQueue<FakeCapture>(); var opened = 0;
        await using var source = new SharedMonitorFrames(_ => { Interlocked.Increment(ref opened); var capture = new FakeCapture(); created.Enqueue(capture); return capture; }, _ => { }, 200);
        var firstRequest = source.CaptureAsync(monitor, CancellationToken.None);
        var secondRequest = source.CaptureAsync(monitor, CancellationToken.None);
        var native = await WaitCreated(created); native.Emit(10);
        var first = (await firstRequest)!; var second = (await secondRequest)!;
        check(opened == 1 && ReferenceEquals(first.RawBgra, second.RawBgra), "Concurrent viewers share one per-monitor native producer and immutable snapshot");
        check(!native.UsedThreadPool, "Blocking native capture runs on a dedicated thread rather than the HTTP timer pool");
        check(first.NativeGeneration!.Length >= 22 && first.NativeVersion == 1 && first.RawBgra![0] == 10, "Published frame has random generation and monotonic version");
        var initialPointer = await source.GetPointerAsync(monitor, null, CancellationToken.None);
        check(initialPointer is { Visible: false, Shape: not null } && initialPointer.Generation == first.NativeGeneration && source.SnapshotCopies == 1,
            "Pointer feed initializes its shape from the shared producer without materializing another desktop snapshot");
        var waiting = source.WaitForChangeAsync(first, 1000, CancellationToken.None);
        check(!waiting.IsCompleted, "Wait-for-change does not complete merely because a cached frame exists");
        native.Emit(20); await waiting;
        check(source.SnapshotCopies == 1, "Unconsumed native updates do not allocate or composite full immutable desktop copies");
        var next = (await source.CaptureAsync(monitor, CancellationToken.None))!;
        check(source.SnapshotCopies == 2, "Only the newly requested native version materializes its immutable desktop snapshot");
        check(next.NativeVersion > first.NativeVersion && next.RawBgra![0] == 20 && first.RawBgra![0] == 10, "New captures never overwrite pixels retained by an earlier encoder");
        var firstTag = FrameQuality.Prepare(first, "session", "epoch", null, 1, null).ETag;
        check(FrameQuality.Prepare(next, "session", "epoch", null, 1, firstTag).NotModified == false, "A new native version invalidates the conditional representation");
        native.EmitPointer(new(true, 0, 0, new(4, 1, 1, 4, [1, 2, 3, 0])));
        await source.WaitForChangeAsync(next, 1000, CancellationToken.None);
        var pointer = (await source.CaptureAsync(monitor, CancellationToken.None))!;
        check(pointer.NativeVersion > next.NativeVersion && pointer.RawBgra![0] == 1 && pointer.RawBgra[4] == 20, "Pointer-only updates composite onto cursor-free background and bump version");
        var pointerPacket = await source.GetPointerAsync(monitor, initialPointer!.ShapeId, CancellationToken.None);
        check(pointerPacket is { Visible: true, Shape.Kind: "masked", X: -2, Y: 3 } && pointerPacket.Version > initialPointer.Version,
            "Shared pointer feed advances independently and reports authoritative physical coordinates");
        using (var unchangedAbort = new CancellationTokenSource())
        {
            var equalWait = source.WaitForChangeAsync(pointer, 1000, unchangedAbort.Token); var readCount = native.Delivered;
            native.EmitPointer(new(true, 0, 0, new(4, 1, 1, 4, [1, 2, 3, 0, 99])));
            await WaitUntil(() => native.Delivered > readCount); await Task.Delay(5);
            check(!equalWait.IsCompleted, "Re-reported visible cursor position and equivalent shape do not advance the frame version");
            unchangedAbort.Cancel(); try { await equalWait; } catch (OperationCanceledException) { }
        }
        var recoveryWait = source.WaitForChangeAsync(pointer, 1000, CancellationToken.None);
        native.EmitRecoveryWithoutImage(); await recoveryWait;
        var recoveryCapture = source.CaptureAsync(monitor, CancellationToken.None);
        await Task.Delay(10);
        check(!recoveryCapture.IsCompleted, "A recovered duplication cannot relabel the previous desktop pixels as a fresh frame");
        native.Emit(30);
        var recovered = (await recoveryCapture)!;
        check(recovered.NativeGeneration != pointer.NativeGeneration && recovered.NativeVersion == 1, "Access recovery starts a fresh native generation");
        var invisibleWait = source.WaitForChangeAsync(recovered, 1000, CancellationToken.None);
        var delivered = native.Delivered;
        native.EmitPointer(new(false, 11, 12, new(2, 1, 1, 4, [1, 2, 3, 255])));
        native.EmitPointer(new(false, 99, 88, null));
        await WaitUntil(() => native.Delivered >= delivered + 2); await Task.Delay(5);
        check(!invisibleWait.IsCompleted, "Invisible pointer-only churn on another output does not wake a held frame wait");
        await invisibleWait;
        var invisible = (await source.CaptureAsync(monitor, CancellationToken.None))!;
        check(invisible.NativeVersion == recovered.NativeVersion && ReferenceEquals(invisible.RawBgra, recovered.RawBgra),
            "Invisible pointer updates preserve the cached version and representation");
        var timer = System.Diagnostics.Stopwatch.StartNew();
        await source.WaitForChangeAsync(recovered, 40, CancellationToken.None);
        check(timer.ElapsedMilliseconds >= 25, "An idle source waits until timeout without sending another image");
        using (var abort = new CancellationTokenSource(20))
        {
            var cancelled = false;
            try { await source.WaitForChangeAsync(recovered, 1000, abort.Token); } catch (OperationCanceledException) { cancelled = true; }
            check(cancelled, "Consumer cancellation interrupts a held native wait");
        }
        await native.Disposed.Task.WaitAsync(TimeSpan.FromSeconds(2));
        check(native.DisposeCount == 1, "The short test idle lease disposes duplication and buffers once");
        var restart = source.CaptureAsync(monitor, CancellationToken.None);
        var restartedNative = await WaitCreated(created); restartedNative.Emit(40);
        var restarted = (await restart)!;
        check(opened == 2 && restarted.NativeGeneration != recovered.NativeGeneration, "Returning after idle starts one new producer generation");

        var attempts = 0;
        await using var unavailable = new SharedMonitorFrames(_ => { Interlocked.Increment(ref attempts); return null; }, _ => { });
        check(await unavailable.CaptureAsync(monitor, CancellationToken.None) is null && await unavailable.CaptureAsync(monitor, CancellationToken.None) is null && attempts == 1,
            "Unavailable duplication requests fallback and respects the ten-second native retry cooldown");
        check(await unavailable.CaptureAsync(monitor with { Width = 3 }, CancellationToken.None) is null && attempts == 1,
            "A monitor geometry replacement preserves an active native failure cooldown");

        var throwingAttempts = 0; var failureTimer = System.Diagnostics.Stopwatch.StartNew();
        await using var throwing = new SharedMonitorFrames(_ => { Interlocked.Increment(ref throwingAttempts); throw new InvalidCastException("Synthetic COM cast failure"); }, _ => { });
        check(await throwing.CaptureAsync(monitor, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(3)) is null && failureTimer.ElapsedMilliseconds < 2000,
            "Unexpected nonfatal worker failures return fallback within one overall capture deadline");
        check(await throwing.CaptureAsync(monitor, CancellationToken.None) is null && throwingAttempts == 1,
            "Unexpected worker failures enter cooldown rather than a producer restart loop");

        var badNative = new FakeCapture { ThrowOnDispose = true };
        await using var badDisposer = new SharedMonitorFrames(_ => badNative, _ => { });
        var badRequest = badDisposer.CaptureAsync(monitor, CancellationToken.None); badNative.Emit(1); await badRequest;
        await badDisposer.DisposeAsync();
        check(badNative.DisposeCount == 1, "Nonfatal native disposal failures remain contained during bounded shutdown");

        await CheckRetirementAsync(check, monitor);
        await CheckRetirementTimeoutAsync(check, monitor);
    }

    private static async Task CheckRetirementAsync(Action<bool, string> check, MonitorInfo monitor)
    {
        var created = new ConcurrentQueue<FakeCapture>();
        await using var source = new SharedMonitorFrames(_ => { var capture = new FakeCapture { HoldDispose = true }; created.Enqueue(capture); return capture; }, _ => { }, 20);
        var initial = source.CaptureAsync(monitor, CancellationToken.None); var native = await WaitCreated(created); native.Emit(1); await initial;
        await native.Disposing.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var returning = source.CaptureAsync(monitor, CancellationToken.None);
        await Task.Delay(5); check(!returning.IsCompleted && created.IsEmpty, "A new consumer waits for the retiring duplication instead of opening a competing instance");
        native.AllowDispose.Set(); var successor = await WaitCreated(created); successor.Emit(2);
        check((await returning)?.RawBgra?[0] == 2, "A consumer arriving at idle retirement starts one successor without losing its wakeup");
        successor.AllowDispose.Set();

        var changed = source.CaptureAsync(monitor with { Width = 3 }, CancellationToken.None);
        var resized = await WaitCreated(created); resized.Emit(3); resized.AllowDispose.Set();
        check((await changed)?.Width == 3 && successor.DisposeCount == 1, "Monitor geometry changes await native retirement before opening the replacement");
    }

    private static async Task WaitUntil(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (!predicate()) await Task.Delay(2, timeout.Token);
    }

    private static async Task CheckRetirementTimeoutAsync(Action<bool, string> check, MonitorInfo monitor)
    {
        var native = new FakeCapture { HoldDispose = true };
        await using var source = new SharedMonitorFrames(_ => native, _ => { }, 20);
        var initial = source.CaptureAsync(monitor, CancellationToken.None); native.Emit(1); await initial;
        await native.Disposing.Task.WaitAsync(TimeSpan.FromSeconds(2));
        var replacementMonitor = monitor with { Width = 3 };
        check(await source.CaptureAsync(replacementMonitor, CancellationToken.None) is null,
            "A stalled retiring native worker yields fallback after the bounded initial deadline");
        var timer = System.Diagnostics.Stopwatch.StartNew();
        check(await source.CaptureAsync(replacementMonitor, CancellationToken.None) is null && timer.ElapsedMilliseconds < 500,
            "Later requests bypass an already timed-out native retirement without another two-second stall");
        native.AllowDispose.Set();
    }

    private static async Task<FakeCapture> WaitCreated(ConcurrentQueue<FakeCapture> created)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        while (true) { if (created.TryDequeue(out var capture)) return capture; await Task.Delay(5, timeout.Token); }
    }
    private sealed class FakeCapture : IMonitorCapture
    {
        private readonly BlockingCollection<(byte? Value, bool Recovered, FramePointer? Pointer)> changes = new();
        public TaskCompletionSource<bool> Disposed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> Disposing { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public ManualResetEventSlim AllowDispose { get; } = new();
        public bool HoldDispose, ThrowOnDispose;
        public bool UsedThreadPool;
        public int DisposeCount, Delivered;
        public void Emit(byte value, bool recovered = false) => changes.Add((value, recovered, null));
        public void EmitPointer(FramePointer pointer) => changes.Add((null, false, pointer));
        public void EmitRecoveryWithoutImage() => changes.Add((null, true, null));
        public MonitorUpdate Read(int timeoutMilliseconds, byte[] destination)
        {
            UsedThreadPool |= Thread.CurrentThread.IsThreadPoolThread;
            if (!changes.TryTake(out var update, Math.Min(timeoutMilliseconds, 10))) return new(false, false, false, null);
            if (update.Value is { } value) Array.Fill(destination, value);
            Interlocked.Increment(ref Delivered);
            return new(update.Value is not null, update.Pointer is not null, update.Recovered, update.Pointer);
        }
        public void Dispose()
        {
            Disposing.TrySetResult(true); if (HoldDispose) AllowDispose.Wait(TimeSpan.FromSeconds(5));
            Interlocked.Increment(ref DisposeCount); Disposed.TrySetResult(true); changes.Dispose(); AllowDispose.Dispose();
            if (ThrowOnDispose) throw new InvalidCastException("Synthetic disposal failure");
        }
    }
}
