using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>
/// One captured desktop image held on the GPU (a pooled BGRA texture of the shared capture). The pair
/// (<see cref="Generation"/>, <see cref="Version"/>) identifies it: a new generation means the duplication or device was
/// recreated (recovery, mode change) and every older lease is stale. Disposing releases this hold; the texture is reused
/// only after every hold on it is gone. Never shown to or stored by anything but the encoder and on-demand readback.
/// </summary>
internal sealed class GpuFrameLease : IDisposable
{
    private readonly GpuMonitorCapture owner;
    internal readonly GpuMonitorCapture.Slot Slot;
    private int disposed;

    internal GpuFrameLease(GpuMonitorCapture owner, GpuMonitorCapture.Slot slot, long version, IReadOnlyList<DxgiRect> dirtyRects, bool fullFrame, DateTimeOffset capturedUtc)
    {
        this.owner = owner; Slot = slot; Version = version; DirtyRects = dirtyRects; FullFrame = fullFrame; CapturedUtc = capturedUtc;
    }

    /// <summary>Random 128-bit hex id of the capture instance (open or recovery) that produced this image.</summary>
    public string Generation => Slot.Generation;
    public long Version { get; }
    public int Width => Slot.Width;
    public int Height => Slot.Height;
    /// <summary>Changed areas since the previous version (dirty rects plus move destinations), or one full rect.</summary>
    public IReadOnlyList<DxgiRect> DirtyRects { get; }
    /// <summary>First image of its generation: consumers have no valid previous image.</summary>
    public bool FullFrame { get; }
    public DateTimeOffset CapturedUtc { get; }
    /// <summary>False once disposed or once the capture recovered (new generation).</summary>
    public bool IsCurrent => Volatile.Read(ref disposed) == 0 && owner.IsCurrentGeneration(Slot.Generation);

    /// <summary>The ID3D11Texture2D* (not AddRef'd; valid while this lease is held).</summary>
    internal IntPtr Texture
    {
        get { ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this); return Slot.Texture; }
    }

    /// <summary>An independent hold on the same image (for example an encoder keeping its last frame for the refresh tail).</summary>
    public GpuFrameLease Share()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref disposed) != 0, this);
        return owner.AddHold(this);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) owner.ReleaseHold(Slot);
    }
}

/// <summary>
/// W8g/G2: the shared per-monitor GPU capture (DXGI allows one duplication per output per process). One D3D11 device
/// (BGRA + video support, multithread-protected) and one IMFDXGIDeviceManager serve the duplication, on-demand CPU
/// readback and any number of per-stream <see cref="GpuStreamEncoder"/> children created on the same adapter.
/// <see cref="AcquireNext"/> copies each new desktop image into a free pooled texture (GPU only) and returns a lease.
/// DXGI_ERROR_ACCESS_LOST (mode change, desktop switch) recreates everything with a new <see cref="Generation"/>;
/// outstanding leases and encoders of the old generation become stale and must be reopened. The cursor is not drawn:
/// <see cref="Pointer"/> reports position and shape for a viewer-drawn cursor (W7a). Thread-safe; use MTA threads.
/// </summary>
internal sealed partial class GpuMonitorCapture : IDisposable
{
    public const int MaximumSlots = 10;

    /// <summary>A pooled texture. Refs counts the capture's own hold on the newest image plus every lease.</summary>
    internal sealed class Slot
    {
        public IntPtr Texture;
        public int Refs, Width, Height;
        public string Generation = "";
        public bool Retired;
    }

    // Two gates (codex-host-1 review): `producer` owns the duplication (AcquireNext, PushSynthetic, recovery, Dispose)
    // and is held across the blocking native wait; `gate` is short and guards state plus every immediate-context call
    // (copies, readback, video-processor blits), so consumers never wait for the desktop to change. Order: producer, then gate.
    private readonly object producer = new();
    private readonly object gate = new();
    private readonly MonitorInfo? monitor;
    private readonly bool synthetic;
    private readonly int syntheticWidth, syntheticHeight;
    private IntPtr device, context, duplication, manager, staging;
    private Gpu.ID3D11Device? deviceApi;
    private Gpu.ID3D11DeviceContext? contextApi;
    private Gpu.IDXGIOutputDuplication? duplicationApi;
    private readonly List<Slot> slots = [], retired = [];
    private GpuFrameLease? latest;
    private byte[]? readback; private string? readbackGeneration; private long readbackVersion = -1;
    private bool needFull = true, forceLost, disposed;

    private GpuMonitorCapture(MonitorInfo? monitor, int syntheticWidth, int syntheticHeight)
    {
        this.monitor = monitor; synthetic = monitor is null; this.syntheticWidth = syntheticWidth; this.syntheticHeight = syntheticHeight;
    }

    public string Generation { get; private set; } = "";
    /// <summary>Version of the newest image; increases across generations.</summary>
    public long Version { get; private set; }
    public int Width { get; private set; }
    public int Height { get; private set; }
    public double RefreshHz { get; private set; }
    public string AdapterName { get; private set; } = "";
    public long AdapterLuid { get; private set; }
    public uint AdapterVendorId { get; private set; }
    public string OutputName { get; private set; } = "";
    /// <summary>Latest pointer state from the duplication (null before the first update). Not composited into images.</summary>
    public FramePointer? Pointer { get { lock (gate) return pointer; } }
    /// <summary>Increases whenever <see cref="Pointer"/> changes (position, visibility or shape).</summary>
    public long PointerVersion { get { lock (gate) return pointerVersion; } }
    public long ReadbackCount { get { lock (gate) return readbackCount; } }
    public long RecoveryCount { get { lock (gate) return recoveryCount; } }
    /// <summary>GPU textures alive (pool plus retired ones still leased). For checks.</summary>
    internal int LiveTextureCount { get { lock (gate) return slots.Count + retired.Count; } }

    private FramePointer? pointer;
    private long pointerVersion, readbackCount, recoveryCount;

    /// <summary>Opens duplication of <paramref name="monitor"/> (GDI device name in <see cref="MonitorInfo.Id"/>). Null with a reason on failure.</summary>
    [SupportedOSPlatform("windows")]
    public static GpuMonitorCapture? TryCreate(MonitorInfo monitor, out string reason)
    {
        ArgumentNullException.ThrowIfNull(monitor);
        return Create(new GpuMonitorCapture(monitor, 0, 0), out reason);
    }

    /// <summary>A capture without duplication, fed by <see cref="PushSynthetic"/>: checks never touch the real screen.</summary>
    [SupportedOSPlatform("windows")]
    internal static GpuMonitorCapture? CreateSynthetic(int width, int height, out string reason)
    {
        if (width <= 0 || height <= 0) { reason = "invalid-size"; return null; }
        return Create(new GpuMonitorCapture(null, width, height), out reason);
    }

    [SupportedOSPlatform("windows")]
    private static GpuMonitorCapture? Create(GpuMonitorCapture capture, out string reason)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 2) || !MfH264Encoder.IsSupported) { reason = "unsupported"; return null; }
        lock (capture.gate)
        {
            try { reason = capture.Open(); }
            catch (Exception ex) when (ex is COMException or InvalidCastException or DllNotFoundException or EntryPointNotFoundException)
            {
                reason = $"interop-failed-0x{ex.HResult:X8}";
            }
            if (reason.Length == 0) return capture;
            capture.Reset();
            capture.disposed = true;
            return null;
        }
    }

    public bool IsCurrentGeneration(string generation)
    {
        lock (gate) return !disposed && generation == Generation;
    }

    /// <summary>
    /// Waits up to <paramref name="timeoutMs"/> for a new desktop image. Null when unchanged (timeout or pointer-only
    /// update; <see cref="Pointer"/> still updates). Recovers once from access loss within the call. The native wait
    /// holds only the producer gate, so <see cref="Latest"/>, <see cref="ReadBgra"/> and encoders never wait for it.
    /// A synthetic capture models an idle desktop here: it blocks for the timeout and returns null.
    /// </summary>
    /// <exception cref="PlatformUnavailableException">Duplication was lost and cannot be recreated, or every slot is leased.</exception>
    [SupportedOSPlatform("windows")]
    public GpuFrameLease? AcquireNext(int timeoutMs)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(timeoutMs);
        lock (producer)
        {
            var recovered = false;
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (!synthetic && duplicationApi is null) { Recover(); recovered = true; }
            }
            if (synthetic) { Thread.Sleep(timeoutMs); return null; }
            var deadline = Environment.TickCount64 + timeoutMs;
            for (var attempt = 0; attempt < 16; attempt++)
            {
                int hr; Gpu.FrameInfo info = default; var resource = IntPtr.Zero;
                bool lost;
                lock (gate) { lost = forceLost; forceLost = false; }
                var duplicationNow = duplicationApi!; // replaced only by this producer (Recover), under both gates
                if (lost) hr = Gpu.AccessLost;
                else hr = AcquireSliced(duplicationNow, deadline, out info, out resource); // no context gate held while waiting
                if (hr == Gpu.WaitTimeout) return null;
                if (hr == Gpu.AccessLost && !recovered) { lock (gate) Recover(); recovered = true; continue; }
                if (hr < 0) throw new PlatformUnavailableException("capture-failed", $"Desktop duplication failed (0x{hr:X8}).");
                GpuFrameLease? lease = null;
                try
                {
                    var shape = ReadPointerShape(info); // duplication calls: producer only
                    var rects = info.LastPresentTime != 0 && !needFull ? ReadRects(info.TotalMetadataBufferSize) : null;
                    lock (gate) // short: pointer state, slot, one queued CopyResource, publish
                    {
                        ApplyPointer(info, shape);
                        if (info.LastPresentTime != 0)
                        {
                            var slot = TakeFreeSlot();
                            var texture = Gpu.Query(resource, Gpu.Texture2DIid);
                            try { contextApi!.CopyResource(slot.Texture, texture); }
                            finally { Marshal.Release(texture); }
                            lease = Publish(slot, rects);
                        }
                    }
                }
                finally
                {
                    if (resource != IntPtr.Zero) Marshal.Release(resource);
                    duplicationNow.ReleaseFrame(); // the copy is queued on this device ahead of anything reading the slot
                }
                if (lease is not null) return lease;
                if (!needFull) return null; // pointer-only update; a new duplication sends one before its first image
            }
            return null;
        }
    }

    private const uint AcquireSliceMilliseconds = 1;
    private const long AcquirePollMicroseconds = 1000;

    /// <summary>
    /// Waits for the next desktop update in short driver waits with a high-resolution sleep between them. Some drivers
    /// (Qualcomm on Windows on ARM) hold the device's multithread lock for the whole AcquireNextFrame wait; with one long
    /// wait every encoder call on this shared device stalled until the next desktop update (~33 ms each, ~66 ms a frame).
    /// Sliced, an encoder call waits at most about one slice, and an update is seen within about two milliseconds.
    /// </summary>
    [SupportedOSPlatform("windows")]
    private static int AcquireSliced(Gpu.IDXGIOutputDuplication duplication, long deadline, out Gpu.FrameInfo info, out IntPtr resource)
    {
        while (true)
        {
            var remaining = deadline - Environment.TickCount64;
            var hr = duplication.AcquireNextFrame(remaining > 0 ? AcquireSliceMilliseconds : 0, out info, out resource);
            if (hr != Gpu.WaitTimeout || remaining <= AcquireSliceMilliseconds) return hr;
            PreciseDelay.Wait(AcquirePollMicroseconds);
        }
    }

    /// <summary>Uploads a synthetic BGRA image (Width x Height, stride Width*4) as the next version. Checks only.</summary>
    [SupportedOSPlatform("windows")]
    internal GpuFrameLease PushSynthetic(byte[] bgra)
    {
        lock (producer)
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!synthetic) throw new InvalidOperationException("Only a synthetic capture accepts pushed images.");
            if (forceLost) { forceLost = false; Recover(); }
            if (bgra.Length != Width * Height * 4) throw new ArgumentException("Invalid pixel buffer.", nameof(bgra));
            var slot = TakeFreeSlot();
            var pin = GCHandle.Alloc(bgra, GCHandleType.Pinned);
            try { contextApi!.UpdateSubresource(slot.Texture, 0, IntPtr.Zero, pin.AddrOfPinnedObject(), (uint)(Width * 4), 0); }
            finally { pin.Free(); }
            return Publish(slot, null);
        }
    }

    /// <summary>A new hold on the newest image (for a new encoder or the image path), or null before the first one.</summary>
    public GpuFrameLease? Latest()
    {
        lock (gate) return latest is null || disposed ? null : AddHoldLocked(latest);
    }

    /// <summary>
    /// CPU copy of a leased image (top-down BGRA, stride Width*4) for the PNG/JPEG path. Done only when asked, through a
    /// staging texture; the array is cached per (generation, version) and shared, so callers must not modify it.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public byte[] ReadBgra(GpuFrameLease lease)
    {
        ArgumentNullException.ThrowIfNull(lease);
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!lease.IsCurrent) throw new PlatformUnavailableException("capture-reset", "The GPU capture was recreated; this image is gone.");
            if (readback is not null && readbackGeneration == lease.Generation && readbackVersion == lease.Version) return readback;
            if (staging == IntPtr.Zero)
            {
                var desc = TextureDesc(Width, Height, Gpu.FormatBgra8, 0);
                desc.Usage = 3; desc.CpuAccessFlags = 0x20000; // STAGING, CPU_ACCESS_READ
                var hr = deviceApi!.CreateTexture2D(ref desc, IntPtr.Zero, out staging);
                if (hr < 0) throw new PlatformUnavailableException("capture-failed", $"Cannot allocate the readback texture (0x{hr:X8}).");
            }
            contextApi!.CopyResource(staging, lease.Texture);
            var mapHr = contextApi.Map(staging, 0, 1 /* READ */, 0, out var mapped);
            if (mapHr < 0) throw new PlatformUnavailableException("capture-failed", $"Cannot read the captured image (0x{mapHr:X8}).");
            var bytes = new byte[Width * Height * 4];
            try
            {
                var stride = Width * 4;
                if (mapped.RowPitch == stride) Marshal.Copy(mapped.Data, bytes, 0, bytes.Length);
                else for (var y = 0; y < Height; y++) Marshal.Copy(mapped.Data + y * (int)mapped.RowPitch, bytes, y * stride, stride);
            }
            finally { contextApi.Unmap(staging, 0); }
            readbackCount++;
            readback = bytes; readbackGeneration = lease.Generation; readbackVersion = lease.Version;
            return bytes;
        }
    }

    /// <summary>Test hook: the next AcquireNext/PushSynthetic behaves as if DXGI reported DXGI_ERROR_ACCESS_LOST.</summary>
    internal void SimulateAccessLost() { lock (gate) forceLost = true; }

    /// <summary>
    /// A per-stream encoder child on this capture's device and adapter (see <see cref="GpuStreamEncoder"/>).
    /// Null with a reason when no hardware MFT on the capture adapter accepts the request.
    /// </summary>
    [SupportedOSPlatform("windows")]
    public GpuStreamEncoder? CreateEncoder(int width, int height, int fps, int bitrateBps, out string reason,
        GpuColourPath colour = GpuColourPath.Auto, H264EncoderOptions? options = null)
        => GpuStreamEncoder.Create(this, width, height, fps, bitrateBps, colour, options, out reason);

    /// <summary>Device state a new encoder binds to, read atomically with the generation it belongs to.</summary>
    internal (string Generation, IntPtr Device, IntPtr Context, IntPtr Manager, int Width, int Height, long Luid, uint Vendor) Binding()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return (Generation, device, context, manager, Width, Height, AdapterLuid, AdapterVendorId);
        }
    }

    /// <summary>Serializes immediate-context work (copies, readback, video-processor blits) across the capture and its encoders.</summary>
    internal object ContextGate => gate;

    internal GpuFrameLease AddHold(GpuFrameLease lease) { lock (gate) return AddHoldLocked(lease); }

    private GpuFrameLease AddHoldLocked(GpuFrameLease lease)
    {
        lease.Slot.Refs++;
        return new GpuFrameLease(this, lease.Slot, lease.Version, lease.DirtyRects, lease.FullFrame, lease.CapturedUtc);
    }

    internal void ReleaseHold(Slot slot)
    {
        lock (gate)
        {
            if (--slot.Refs > 0 || !slot.Retired) return;
            retired.Remove(slot);
            if (slot.Texture != IntPtr.Zero) { Marshal.Release(slot.Texture); slot.Texture = IntPtr.Zero; }
        }
    }

    /// <summary>Waits for a running AcquireNext (at most its timeout), then releases everything but still-leased textures.</summary>
    public void Dispose()
    {
        lock (producer)
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (OperatingSystem.IsWindows()) Reset(); // leased textures stay alive until their last lease is disposed
        }
    }
}
