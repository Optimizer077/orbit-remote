namespace Orbit.Host.Platform;

internal sealed record MonitorUpdate(bool DesktopChanged, bool PointerChanged, bool Recovered, FramePointer? Pointer);
// DesktopChanged=true MUST fill the whole destination with cursor-free BGRA.
// Alternating reusable buffers must never depend on pixels from a prior read.
internal interface IMonitorCapture : IDisposable { MonitorUpdate Read(int timeoutMilliseconds, byte[] destination); }

/// <summary>One native duplication per output; published arrays are immutable and never reused by capture.</summary>
internal sealed class SharedMonitorFrames(Func<MonitorInfo, IMonitorCapture?> create, Action<MonitorInfo> validate, int idleLeaseMilliseconds = 2000) : IAsyncDisposable
{
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = [];
    private bool disposed;
    internal long SnapshotCopies { get { lock (gate) return entries.Values.Sum(entry => entry.SnapshotCopies); } }
    private static bool NonFatal(Exception ex) => ex is not (OutOfMemoryException or StackOverflowException or AccessViolationException);

    public async Task<ScreenFrame?> CaptureAsync(MonitorInfo monitor, CancellationToken cancellationToken)
    {
        var deadline = Environment.TickCount64 + 2000;
        var entry = await SelectEntryAsync(monitor, deadline, cancellationToken);
        if (entry is null) return null;
        var frame = await entry.CaptureAsync(deadline, cancellationToken);
        validate(monitor); return frame;
    }

    public async Task<PointerSnapshot?> GetPointerAsync(MonitorInfo monitor, string? knownShapeId, CancellationToken cancellationToken)
    {
        var deadline = Environment.TickCount64 + 2000;
        var entry = await SelectEntryAsync(monitor, deadline, cancellationToken);
        if (entry is null) return null;
        var pointer = await entry.GetPointerAsync(knownShapeId, deadline, cancellationToken);
        validate(monitor); return pointer;
    }

    public IGpuVideoEncoder? TryOpenEncoder(MonitorInfo monitor, int width, int height, int fps, int bitrate)
    {
        var deadline = Environment.TickCount64 + 2000;
        var entry = SelectEntryAsync(monitor, deadline, CancellationToken.None).GetAwaiter().GetResult();
        var encoder = entry?.OpenEncoder(width, height, fps, bitrate, deadline);
        try { validate(monitor); return encoder; } catch { encoder?.Dispose(); throw; }
    }

    private async Task<Entry?> SelectEntryAsync(MonitorInfo monitor, long deadline, CancellationToken cancellationToken)
    {
        validate(monitor);
        Entry entry;
        while (true)
        {
            Entry? retiring = null;
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (entries.TryGetValue(monitor.Id, out var existing) && existing.Monitor != monitor)
                { existing.Stop(); retiring = existing; entry = existing; }
                else if (existing is not null) entry = existing;
                else
                {
                    foreach (var stale in entries.Where(pair => pair.Value.IsEvictable).ToArray()) { stale.Value.Stop(); entries.Remove(stale.Key); }
                    // Bound outputs and source pixels. Each active output keeps two
                    // reusable raw buffers and at most one lazily materialized snapshot.
                    if (entries.Count >= 8 || entries.Values.Sum(value => (long)value.Monitor.Width * value.Monitor.Height) + (long)monitor.Width * monitor.Height > 67_108_864)
                        return null;
                    entry = new Entry(monitor, create, validate, idleLeaseMilliseconds); entries.Add(monitor.Id, entry);
                }
            }
            if (retiring is null) break;
            if (retiring.RetirementTimedOut && !retiring.Completion.IsCompleted) return null;
            var remaining = deadline - Environment.TickCount64; if (remaining <= 0) return null;
            try { await retiring.Completion.WaitAsync(TimeSpan.FromMilliseconds(remaining), cancellationToken); }
            catch (TimeoutException) { retiring.MarkRetirementTimeout(); return null; }
            catch (Exception ex) when (NonFatal(ex) && ex is not OperationCanceledException) { return null; }
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (entries.TryGetValue(monitor.Id, out var current) && ReferenceEquals(current, retiring))
                {
                    var otherPixels = entries.Values.Where(value => !ReferenceEquals(value, retiring)).Sum(value => (long)value.Monitor.Width * value.Monitor.Height);
                    if (otherPixels + (long)monitor.Width * monitor.Height > 67_108_864) return null;
                    // Native failure cooldown survives topology replacement as well.
                    entries[monitor.Id] = new Entry(monitor, create, validate, idleLeaseMilliseconds, retiring.RetryAfter);
                }
            }
        }
        return entry;
    }

    public Task WaitForChangeAsync(ScreenFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken)
    {
        Entry? entry;
        lock (gate) entries.TryGetValue(observed.MonitorId ?? "", out entry);
        return entry is not null ? entry.WaitForChangeAsync(observed, maximumWaitMilliseconds, cancellationToken)
            : Task.Delay(Math.Min(maximumWaitMilliseconds, 100), cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        Entry[] all;
        lock (gate) { if (disposed) return; disposed = true; all = entries.Values.ToArray(); entries.Clear(); }
        foreach (var entry in all) entry.Stop();
        try { await Task.WhenAll(all.Select(entry => entry.Completion)).WaitAsync(TimeSpan.FromSeconds(3)); }
        catch (Exception ex) when (NonFatal(ex)) { /* The desktop parent has its own bounded process shutdown. */ }
    }

    private sealed class Entry(MonitorInfo monitor, Func<MonitorInfo, IMonitorCapture?> create, Action<MonitorInfo> validate, int idleLeaseMilliseconds, long initialRetryAfter = 0)
    {
        private readonly object gate = new();
        private TaskCompletionSource<bool> changed = NewSignal();
        private ScreenFrame? latest;
        private byte[]? front;
        private IDisposable? frontTexture;
        private IMonitorCapture? nativeCapture;
        private ILazyMonitorCapture? lazyCapture;
        private FramePointer? pointer;
        private readonly PointerPacketBuilder pointerPackets = new();
        private string generation = "";
        private long version, snapshotCopies, pointerVersion = 1;
        private DateTimeOffset capturedUtc;
        private Task? worker;
        private bool stopping, unavailable, running, hasImage, retirementTimedOut;
        private int consumers;
        private long lastUse = Environment.TickCount64, retryAfter = initialRetryAfter;
        public MonitorInfo Monitor => monitor;
        public Task Completion { get { lock (gate) return worker ?? Task.CompletedTask; } }
        public long SnapshotCopies { get { lock (gate) return snapshotCopies; } }
        public long RetryAfter { get { lock (gate) return retryAfter; } }
        public bool RetirementTimedOut { get { lock (gate) return retirementTimedOut; } }
        public void MarkRetirementTimeout() { lock (gate) retirementTimedOut = true; }
        public bool IsEvictable { get { lock (gate) return consumers == 0 && !running && Environment.TickCount64 >= retryAfter && Environment.TickCount64 - lastUse >= idleLeaseMilliseconds; } }
        private static TaskCompletionSource<bool> NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
        private void StartWorker()
        {
            // Called under gate. Native waits use dedicated threads, leaving HTTP
            // and independent revocation timers runnable even on small-core hosts.
            running = true; unavailable = false; hasImage = false; latest = null;
            worker = Task.Factory.StartNew(Run, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        }
        private void Signal() { var old = changed; changed = NewSignal(); old.TrySetResult(true); }
        private IDisposable Use()
        {
            lock (gate)
            {
                consumers++; lastUse = Environment.TickCount64;
                if (!stopping && !running && lastUse >= retryAfter) StartWorker();
            }
            return new UseLease(() => { lock (gate) { consumers--; lastUse = Environment.TickCount64; } });
        }
        public async Task<ScreenFrame?> CaptureAsync(long deadline, CancellationToken cancellationToken)
        {
            using var use = Use();
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                Task signal;
                lock (gate)
                {
                    if (stopping || unavailable || !running && Environment.TickCount64 < retryAfter) return null;
                    if (hasImage)
                    {
                        if (latest is null)
                        {
                            // Capture writes only the other buffer. Copy at most once
                            // for the version actually requested, never per DXGI event.
                            var pixels = lazyCapture is null ? front! : lazyCapture.ReadBgra(frontTexture ?? throw new PlatformUnavailableException("capture-reset", "The published GPU image was released."));
                            var immutable = pixels.ToArray(); CursorCompositor.Draw(immutable, monitor.Width, monitor.Height, pointer);
                            latest = new ScreenFrame([], monitor.Width, monitor.Height, monitor.Left, monitor.Top, capturedUtc,
                                immutable, monitor.Id, generation, version); snapshotCopies++;
                        }
                        return latest;
                    }
                    signal = changed.Task;
                }
                var remaining = deadline - Environment.TickCount64; if (remaining <= 0) return null;
                try { await signal.WaitAsync(TimeSpan.FromMilliseconds(remaining), cancellationToken); } catch (TimeoutException) { return null; }
            }
        }
        public async Task WaitForChangeAsync(ScreenFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken)
        {
            using var use = Use();
            Task signal;
            lock (gate)
            {
                if (stopping || unavailable || !running && Environment.TickCount64 < retryAfter || hasImage && (generation != observed.NativeGeneration || version != observed.NativeVersion)) return;
                signal = changed.Task;
            }
            try { await signal.WaitAsync(TimeSpan.FromMilliseconds(maximumWaitMilliseconds), cancellationToken); } catch (TimeoutException) { }
        }
        public async Task<PointerSnapshot?> GetPointerAsync(string? knownShapeId, long deadline, CancellationToken cancellationToken)
        {
            using var use = Use();
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested(); Task signal;
                lock (gate)
                {
                    if (stopping || unavailable || !running && Environment.TickCount64 < retryAfter) return null;
                    if (hasImage) return pointerPackets.Build(pointer, monitor, knownShapeId, generation, pointerVersion, cancellationToken);
                    signal = changed.Task;
                }
                var remaining = deadline - Environment.TickCount64; if (remaining <= 0) return null;
                try { await signal.WaitAsync(TimeSpan.FromMilliseconds(remaining), cancellationToken); } catch (TimeoutException) { return null; }
            }
        }
        public IGpuVideoEncoder? OpenEncoder(int width, int height, int fps, int bitrate, long deadline)
        {
            IDisposable? consumer = Use();
            try
            {
                while (true)
                {
                    Task signal; IMonitorCapture? source;
                    lock (gate)
                    {
                        if (stopping || unavailable || !running && Environment.TickCount64 < retryAfter) return null;
                        source = nativeCapture; signal = changed.Task;
                    }
                    if (source is not null)
                    {
                        if (source is not ILazyMonitorCapture gpu) return null;
                        void AssertActive() { lock (gate) if (stopping || unavailable || !ReferenceEquals(nativeCapture, source)) throw new PlatformUnavailableException("capture-lost", "The shared monitor producer stopped."); }
                        Task NextChange() { lock (gate) { AssertActive(); return changed.Task; } }
                        var encoder = gpu.OpenEncoder(monitor, width, height, fps, bitrate, () => validate(monitor), AssertActive, NextChange, consumer);
                        if (encoder is not null) consumer = null; // The stream owns this producer lease now.
                        return encoder;
                    }
                    var remaining = deadline - Environment.TickCount64; if (remaining <= 0) return null;
                    try { signal.WaitAsync(TimeSpan.FromMilliseconds(remaining)).GetAwaiter().GetResult(); } catch (TimeoutException) { return null; }
                }
            }
            finally { consumer?.Dispose(); }
        }
        public void Stop() { lock (gate) { stopping = true; hasImage = false; front = null; latest = null; Signal(); } }
        private void Fail() { unavailable = true; retryAfter = Environment.TickCount64 + 10000; }
        private void Run()
        {
            IMonitorCapture? capture = null; var cleanIdleExit = false;
            try
            {
                validate(monitor); capture = create(monitor);
                if (capture is null) throw new PlatformUnavailableException("capture-unavailable", "Desktop duplication unavailable.");
                var lazy = capture as ILazyMonitorCapture;
                byte[] back = lazy is null ? new byte[checked(monitor.Width * monitor.Height * 4)] : [];
                lock (gate) { nativeCapture = capture; lazyCapture = lazy; front = lazy is null ? new byte[back.Length] : null; generation = Security.RandomToken(); version = 0; pointerVersion = 1; pointer = null; Signal(); }
                while (true)
                {
                    lock (gate)
                    {
                        if (stopping || consumers == 0 && Environment.TickCount64 - lastUse >= idleLeaseMilliseconds)
                        { hasImage = false; latest = null; cleanIdleExit = !stopping; break; }
                    }
                    validate(monitor);
                    var started = Environment.TickCount64;
                    var captured = lazy is null ? (capture.Read(250, back), (IDisposable?)null) : lazy.ReadTexture(250);
                    var update = captured.Item1; var nextTexture = captured.Item2;
                    try
                    {
                        validate(monitor);
                        lock (gate)
                        {
                            if (stopping) break;
                            if (update.Recovered)
                            {
                                frontTexture?.Dispose(); frontTexture = null;
                                generation = Security.RandomToken(); version = 0; pointerVersion = 1; hasImage = false; pointer = null; latest = null; Signal();
                            }
                            var nextPointer = update.Pointer is not null || update.PointerChanged ? update.Pointer : pointer;
                            var pointerChanged = !CursorCompositor.SameDrawnState(pointer, nextPointer); pointer = nextPointer;
                            if (pointerChanged)
                            {
                                if (pointerVersion == long.MaxValue) { generation = Security.RandomToken(); version = 0; pointerVersion = 1; latest = null; }
                                else pointerVersion++;
                            }
                            if (update.DesktopChanged)
                            {
                                if (lazy is null) (front, back) = (back, front!);
                                else { frontTexture?.Dispose(); frontTexture = nextTexture ?? throw new PlatformUnavailableException("capture-failed", "The GPU producer did not publish its image lease."); nextTexture = null; }
                                hasImage = true;
                            }
                            if (hasImage && (update.DesktopChanged || pointerChanged))
                            {
                                if (version == long.MaxValue) { generation = Security.RandomToken(); version = 0; }
                                version++; capturedUtc = DateTimeOffset.UtcNow; latest = null; Signal();
                            }
                        }
                    }
                    finally { nextTexture?.Dispose(); }
                    // Bound drivers that report empty, immediate pointer wakeups.
                    if (Environment.TickCount64 - started < 2) Thread.Sleep(2);
                }
            }
            catch (Exception ex) when (NonFatal(ex)) { lock (gate) Fail(); }
            finally
            {
                IDisposable? retiredTexture;
                lock (gate) { hasImage = false; retiredTexture = frontTexture; frontTexture = null; }
                try { try { retiredTexture?.Dispose(); } finally { capture?.Dispose(); } }
                catch (Exception ex) when (NonFatal(ex)) { lock (gate) { Fail(); cleanIdleExit = false; } }
                finally
                {
                    lock (gate)
                    {
                        // Preserve a cooldown even when an exceptional non-clean
                        // exit bypasses the nonfatal catch (for example an OOM).
                        if (!cleanIdleExit && !stopping && !unavailable) Fail();
                        hasImage = false; front = null; latest = null; pointer = null; nativeCapture = null; lazyCapture = null; running = false; Signal();
                        // A request may arrive between the idle decision and native
                        // disposal. Start its successor only after retirement finishes.
                        if (!stopping && !unavailable && cleanIdleExit && consumers > 0) StartWorker();
                    }
                }
            }
        }
        private sealed class UseLease(Action release) : IDisposable
        {
            private Action? action = release;
            public void Dispose() => Interlocked.Exchange(ref action, null)?.Invoke();
        }
    }
}
