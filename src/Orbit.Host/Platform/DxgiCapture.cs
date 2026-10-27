using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>A changed region in monitor-relative pixels; Right and Bottom are exclusive.</summary>
internal readonly record struct DxgiRect(int Left, int Top, int Right, int Bottom);

/// <summary>
/// Result of one <see cref="DxgiCapture.Acquire"/>. When <see cref="Changed"/> is false the destination
/// buffer was not touched and the caller's previous frame is still current.
/// </summary>
/// <param name="FullFrame">First image since the duplication was (re)created; the caller has no valid previous frame.</param>
/// <param name="DirtyRects">Changed areas (dirty rects plus move destinations), or one full rect when unknown.</param>
/// <param name="PointerMoved">Only the cursor changed. The cursor is never part of the image.</param>
/// <param name="Recovered">This call recreated the duplication after access was lost (mode change, desktop switch).</param>
internal sealed record DxgiFrame(bool Changed, bool FullFrame, int Width, int Height, IReadOnlyList<DxgiRect> DirtyRects,
    int MoveCount, bool PointerMoved, int AccumulatedFrames, bool Recovered);

/// <summary>
/// GPU screen capture through DXGI Desktop Duplication (decision D10: OS components only, hand-written COM interop).
/// Output is top-down BGRA with stride = width * 4, the contract of <see cref="PngEncoder"/> and <see cref="WicJpegEncoder"/>.
/// The device, duplication and staging texture are reused across calls. Calls are serialized by a lock; use MTA
/// threads (thread-pool threads are), because the D3D objects have no cross-apartment proxies. The cursor is not
/// drawn. Windows allows one duplication per output per process (a second one fails with E_INVALIDARG), so keep one
/// shared instance per monitor. Callers fall back to GDI BitBlt whenever <see cref="TryCreate"/> returns null or Acquire throws
/// <see cref="PlatformUnavailableException"/>.
/// </summary>
internal sealed class DxgiCapture : IDisposable
{
    public const int MaximumTimeoutMs = 10_000;
    private const int AccessDenied = unchecked((int)0x80070005), WaitTimeout = unchecked((int)0x887A0027);
    private const int AccessLost = unchecked((int)0x887A0026), NotFound = unchecked((int)0x887A0002);
    private const int Unsupported = unchecked((int)0x887A0004), NotCurrentlyAvailable = unchecked((int)0x887A0022);
    private const int SessionDisconnected = unchecked((int)0x887A0028);

    private static readonly Lazy<bool> Supported = new(() => OperatingSystem.IsWindowsVersionAtLeast(6, 2) && CanCreateFactory());

    /// <summary>True only on Windows 8+ when a DXGI factory can be created. Safe to query on any OS.</summary>
    public static bool IsSupported => OperatingSystem.IsWindows() && Supported.Value;

    private readonly object _lock = new();
    private readonly MonitorInfo _monitor;
    private D3D.ID3D11Device? _device;
    private D3D.ID3D11DeviceContext? _context;
    private D3D.IDXGIOutputDuplication? _duplication;
    private IntPtr _staging;
    private int[] _metadata = new int[256];
    private bool _needFull = true, _forceLost, _disposed;
    private FramePointer? _pointer;
    public FramePointer? Pointer { get { lock (_lock) return _pointer; } }

    private DxgiCapture(MonitorInfo monitor) => _monitor = monitor;

    public string MonitorId => _monitor.Id;
    public int Width { get; private set; }
    public int Height { get; private set; }
    /// <summary>DXGI_MODE_ROTATION of the duplicated output (1 = identity). Only 0 and 1 are accepted.</summary>
    public int Rotation { get; private set; }
    public int RequiredBytes => checked(Width * Height * 4);

    /// <summary>
    /// Opens duplication for a monitor described by <see cref="WindowsPlatformBackend"/> (GDI device name and physical
    /// desktop coordinates). Returns null with a short reason when duplication is unavailable: not Windows, no GPU
    /// output for the monitor (RDP, indirect displays), rotation, access denied (secure desktop), unsupported or too many clients.
    /// </summary>
    public static DxgiCapture? TryCreate(MonitorInfo monitor, out string reason)
    {
        ArgumentNullException.ThrowIfNull(monitor);
        if (!IsSupported || !OperatingSystem.IsWindows()) { reason = "unsupported-os"; return null; }
        var capture = new DxgiCapture(monitor);
        reason = capture.Open();
        if (reason.Length == 0) return capture;
        capture.Dispose();
        return null;
    }

    /// <summary>
    /// Waits up to <paramref name="timeoutMs"/> for a new desktop image and copies it into <paramref name="destination"/>.
    /// A timeout is a normal "unchanged" result, not an error.
    /// </summary>
    /// <exception cref="PlatformUnavailableException">Access was lost and could not be regained, or the display size changed.</exception>
    [SupportedOSPlatform("windows")]
    public DxgiFrame Acquire(int timeoutMs, byte[] destination)
    {
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentOutOfRangeException.ThrowIfNegative(timeoutMs);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(timeoutMs, MaximumTimeoutMs);
        lock (_lock)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (destination.Length < RequiredBytes) throw new ArgumentException("Destination is smaller than width * height * 4.", nameof(destination));
            var recovered = false; var pointerMoved = false;
            if (_duplication is null) { Reopen(destination); recovered = true; } // An earlier recovery failed; try again.
            var deadline = Environment.TickCount64 + timeoutMs;
            for (var attempt = 0; attempt < 16; attempt++)
            {
                var info = default(D3D.FrameInfo); var resource = IntPtr.Zero;
                var wait = (uint)Math.Max(0, deadline - Environment.TickCount64);
                var hr = _forceLost ? AccessLost : _duplication!.AcquireNextFrame(wait, out info, out resource);
                _forceLost = false;
                if (hr == WaitTimeout) break;
                if (hr == AccessLost && !recovered) { Reopen(destination); recovered = true; continue; }
                if (hr < 0) throw new PlatformUnavailableException("capture-failed", Describe("Desktop duplication failed", hr));
                DxgiFrame? frame;
                try { UpdatePointer(info); frame = CopyFrame(info, resource, destination, recovered); }
                finally
                {
                    if (resource != IntPtr.Zero) Marshal.Release(resource);
                    _duplication!.ReleaseFrame(); // ACCESS_LOST here surfaces on the next Acquire.
                }
                if (frame is not null) return frame;
                // A new duplication always delivers a pointer-only update (empty texture) before its first image.
                pointerMoved = true;
            }
            return Unchanged(pointerMoved, recovered);
        }
    }

    /// <summary>Test hook: the next Acquire behaves as if DXGI reported DXGI_ERROR_ACCESS_LOST.</summary>
    internal void SimulateAccessLost() { lock (_lock) _forceLost = true; }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            if (OperatingSystem.IsWindows()) Reset();
        }
    }

    private DxgiFrame Unchanged(bool pointerMoved, bool recovered) => new(false, false, Width, Height, [], 0, pointerMoved, 0, recovered);

    [SupportedOSPlatform("windows")]
    private void UpdatePointer(D3D.FrameInfo info)
    {
        var previous = _pointer;
        var shape = previous?.Shape;
        if (info.PointerShapeBufferSize > 0)
        {
            if (info.PointerShapeBufferSize > CursorCompositor.MaximumShapeBytes) throw new PlatformUnavailableException("cursor-unavailable", "Desktop cursor exceeds the bounded shape size.");
            var bytes = new byte[info.PointerShapeBufferSize];
            var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                var hr = _duplication!.GetFramePointerShape((uint)bytes.Length, pin.AddrOfPinnedObject(), out var required, out var description);
                if (hr < 0 || required > bytes.Length) throw new PlatformUnavailableException("cursor-unavailable", "Could not retrieve the desktop cursor shape.");
                if (required < bytes.Length) bytes = bytes.AsSpan(0, (int)required).ToArray();
                shape = new((int)description.Type, (int)description.Width, (int)description.Height, (int)description.Pitch, bytes, description.HotspotX, description.HotspotY);
                CursorCompositor.Validate(shape);
            }
            finally { pin.Free(); }
        }
        if (info.LastMouseUpdateTime != 0 || previous is null)
            _pointer = new(info.PointerVisible != 0, info.PointerX, info.PointerY, shape);
        else if (!ReferenceEquals(shape, previous.Shape)) _pointer = previous with { Shape = shape };
    }

    [SupportedOSPlatform("windows")]
    private void Reopen(byte[] destination)
    {
        Reset();
        var reason = Open();
        if (reason.Length > 0) throw new PlatformUnavailableException("capture-lost", "Desktop duplication was lost and cannot resume: " + reason);
        if (destination.Length < RequiredBytes) throw new PlatformUnavailableException("display-changed", "The display size changed; allocate RequiredBytes.");
    }

    [SupportedOSPlatform("windows")]
    private DxgiFrame? CopyFrame(D3D.FrameInfo info, IntPtr resource, byte[] destination, bool recovered)
    {
        // LastPresentTime is zero when only the pointer changed: there is no new image to copy.
        // Null asks Acquire to keep waiting, because the caller has no image at all yet.
        if (info.LastPresentTime == 0) return _needFull ? null : Unchanged(info.LastMouseUpdateTime != 0 || info.PointerShapeBufferSize > 0, recovered);
        var full = new DxgiRect(0, 0, Width, Height);
        var rects = new List<DxgiRect>(); var moves = 0;
        if (!_needFull && !ReadRects(info.TotalMetadataBufferSize, rects, ref moves)) rects.Clear();
        if (_needFull || rects.Count == 0 && moves == 0) rects = [full];

        var texture = QueryInterface(resource, D3D.Texture2DIid);
        try
        {
            if (_staging == IntPtr.Zero) _staging = CreateStaging(texture);
            _context!.CopyResource(_staging, texture);
        }
        finally { Marshal.Release(texture); }
        var hr = _context.Map(_staging, 0, 1 /* D3D11_MAP_READ */, 0, out var mapped);
        if (hr < 0) throw new PlatformUnavailableException("capture-failed", Describe("Cannot read the captured frame", hr));
        try
        {
            var stride = Width * 4; var pitch = (int)mapped.RowPitch;
            if (pitch == stride) Marshal.Copy(mapped.Data, destination, 0, stride * Height);
            else for (var y = 0; y < Height; y++) Marshal.Copy(mapped.Data + y * pitch, destination, y * stride, stride);
        }
        finally { _context.Unmap(_staging, 0); }
        var wasFull = _needFull;
        _needFull = false;
        return new DxgiFrame(true, wasFull, Width, Height, rects, moves, info.LastMouseUpdateTime != 0 || info.PointerShapeBufferSize > 0, (int)info.AccumulatedFrames, recovered);
    }

    /// <summary>Reads move destinations and dirty rects, clamped to the surface. False means "unknown, treat as full".</summary>
    [SupportedOSPlatform("windows")]
    private bool ReadRects(uint bytes, List<DxgiRect> rects, ref int moves)
    {
        if (bytes == 0 || bytes > 16 * 1024 * 1024) return false;
        if (_metadata.Length * 4 < bytes) _metadata = new int[(bytes + 3) / 4];
        var pin = GCHandle.Alloc(_metadata, GCHandleType.Pinned);
        try
        {
            var buffer = pin.AddrOfPinnedObject();
            if (_duplication!.GetFrameMoveRects(bytes, buffer, out var used) < 0) return false;
            moves = (int)(used / 24); // DXGI_OUTDUPL_MOVE_RECT: POINT source + RECT destination
            for (var i = 0; i < moves; i++) Add(rects, i * 6 + 2);
            if (_duplication.GetFrameDirtyRects(bytes, buffer, out used) < 0) return false;
            for (var i = 0; i < used / 16; i++) Add(rects, i * 4);
            return true;
        }
        finally { pin.Free(); }
    }

    private void Add(List<DxgiRect> rects, int offset)
    {
        var rect = new DxgiRect(Math.Clamp(_metadata[offset], 0, Width), Math.Clamp(_metadata[offset + 1], 0, Height),
            Math.Clamp(_metadata[offset + 2], 0, Width), Math.Clamp(_metadata[offset + 3], 0, Height));
        if (rect.Right > rect.Left && rect.Bottom > rect.Top) rects.Add(rect);
    }

    [SupportedOSPlatform("windows")]
    private IntPtr CreateStaging(IntPtr texture)
    {
        var source = (D3D.ID3D11Texture2D)Marshal.GetObjectForIUnknown(texture);
        D3D.Texture2DDesc desc;
        try { source.GetDesc(out desc); } finally { Marshal.ReleaseComObject(source); }
        if (desc.Width != Width || desc.Height != Height || desc.Format != D3D.FormatBgra8)
            throw new PlatformUnavailableException("capture-failed", $"Unexpected duplication surface {desc.Width}x{desc.Height} format {desc.Format}.");
        desc.MipLevels = 1; desc.ArraySize = 1; desc.SampleCount = 1; desc.SampleQuality = 0;
        desc.Usage = 3; desc.BindFlags = 0; desc.CpuAccessFlags = 0x20000; desc.MiscFlags = 0; // STAGING, CPU_ACCESS_READ
        var hr = _device!.CreateTexture2D(ref desc, IntPtr.Zero, out var staging);
        if (hr < 0) throw new PlatformUnavailableException("capture-failed", Describe("Cannot allocate the staging texture", hr));
        return staging;
    }

    /// <summary>Finds the monitor's output on whichever adapter drives it, then creates a device on that adapter.
    /// Duplicating through the wrong adapter fails on hybrid-GPU laptops. Returns "" on success.</summary>
    [SupportedOSPlatform("windows")]
    private string Open()
    {
        D3D.IDXGIFactory1? factory = null; D3D.IDXGIAdapter? adapter = null; D3D.IDXGIOutput? output = null;
        // Output coordinates are DPI-virtualized for unaware threads (half size at 200 %). Use the backend's
        // per-monitor-v2 context so they are physical pixels like WindowsPlatformBackend's MonitorInfo.
        var previousDpi = D3D.SetThreadDpiAwarenessContext(new IntPtr(-4));
        try
        {
            var iid = D3D.Factory1Iid;
            var hr = D3D.CreateDXGIFactory1(ref iid, out factory);
            if (hr < 0 || factory is null) return Reason("factory", hr);
            D3D.OutputDesc desc = default;
            for (uint a = 0; output is null && factory.EnumAdapters(a, out adapter) >= 0 && adapter is not null; a++)
            {
                for (uint o = 0; adapter.EnumOutputs(o, out var candidate) >= 0 && candidate is not null; o++)
                {
                    if (candidate.GetDesc(out desc) >= 0 && desc.Attached != 0 &&
                        (string.Equals(desc.DeviceName, _monitor.Id, StringComparison.OrdinalIgnoreCase) ||
                         desc.Desktop.Left == _monitor.Left && desc.Desktop.Top == _monitor.Top)) { output = candidate; break; }
                    Release(candidate);
                }
                if (output is null) { Release(adapter); adapter = null; }
            }
            if (output is null || adapter is null) return "output-not-found";
            Rotation = desc.Rotation;
            if (desc.Rotation is not (0 or 1)) return "rotated-" + (desc.Rotation - 1) * 90;
            if (desc.Desktop.Right - desc.Desktop.Left != _monitor.Width || desc.Desktop.Bottom - desc.Desktop.Top != _monitor.Height)
                return "size-mismatch";

            hr = D3D.D3D11CreateDevice(adapter, 0 /* UNKNOWN: required with an explicit adapter */, IntPtr.Zero,
                0x20 /* BGRA_SUPPORT */, IntPtr.Zero, 0, 7 /* D3D11_SDK_VERSION */, out _device, out _, out _context);
            if (hr < 0 || _device is null || _context is null) return Reason("device", hr);
            hr = ((D3D.IDXGIOutput1)output).DuplicateOutput(_device, out _duplication);
            if (hr < 0 || _duplication is null) return Reason("duplicate", hr);
            _duplication.GetDesc(out var mode);
            if (mode.Rotation is not (0 or 1)) return "rotated-" + (mode.Rotation - 1) * 90;
            if (mode.Width != _monitor.Width || mode.Height != _monitor.Height) return "size-mismatch";
            PlatformLimits.CheckDimensions(_monitor.Width, _monitor.Height);
            Width = _monitor.Width; Height = _monitor.Height;
            _needFull = true;
            _pointer = null;
            return "";
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or DllNotFoundException or EntryPointNotFoundException)
        {
            return Reason("interop", ex.HResult);
        }
        catch (PlatformUnavailableException ex) { return ex.Code; }
        finally
        {
            Release(output); Release(adapter); Release(factory);
            if (previousDpi != IntPtr.Zero) D3D.SetThreadDpiAwarenessContext(previousDpi);
        }
    }

    [SupportedOSPlatform("windows")]
    private void Reset()
    {
        if (_staging != IntPtr.Zero) { Marshal.Release(_staging); _staging = IntPtr.Zero; }
        Release(_duplication); Release(_context); Release(_device);
        _duplication = null; _context = null; _device = null;
        Width = Height = 0;
    }

    private static string Reason(string step, int hr) => hr switch
    {
        AccessDenied => "access-denied", // secure desktop, lock screen, UAC prompt
        Unsupported => "unsupported", // e.g. some RDP sessions, Basic Display Adapter, wrong GPU
        NotCurrentlyAvailable => "not-currently-available", // too many duplication clients
        SessionDisconnected => "session-disconnected",
        NotFound => "output-not-found",
        _ => $"{step}-failed-0x{hr:X8}",
    };

    private static string Describe(string message, int hr) => $"{message} ({Reason("dxgi", hr)}).";

    private static IntPtr QueryInterface(IntPtr unknown, Guid iid)
    {
        var hr = Marshal.QueryInterface(unknown, in iid, out var result);
        if (hr < 0) throw new PlatformUnavailableException("capture-failed", Describe("The duplication surface is not a texture", hr));
        return result;
    }

    [SupportedOSPlatform("windows")]
    private static bool CanCreateFactory()
    {
        D3D.IDXGIFactory1? factory = null;
        try { var iid = D3D.Factory1Iid; return D3D.CreateDXGIFactory1(ref iid, out factory) >= 0 && factory is not null; }
        catch (Exception ex) when (ex is COMException or InvalidCastException or DllNotFoundException or EntryPointNotFoundException) { return false; }
        finally { Release(factory); }
    }

    [SupportedOSPlatform("windows")]
    private static void Release(object? value)
    {
        if (value is not null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
    }

    /// <summary>Minimal hand-written DXGI/D3D11 interop. Unused vtable slots are placeholders and must never be called;
    /// order verified against the Windows SDK 10.0.26100 headers. Methods that return void natively are [PreserveSig] void.</summary>
    [SupportedOSPlatform("windows")]
    internal static class D3D
    {
        public static readonly Guid Factory1Iid = new("770aae78-f26f-4dba-a829-253c83d1b387");
        public static readonly Guid Texture2DIid = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
        public const uint FormatBgra8 = 87; // DXGI_FORMAT_B8G8R8A8_UNORM

        [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1([In] ref Guid iid, out IDXGIFactory1? factory);
        [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IDXGIAdapter adapter, int driverType, IntPtr software, uint flags,
            IntPtr featureLevels, uint featureLevelCount, uint sdkVersion, out ID3D11Device? device, out int featureLevel, out ID3D11DeviceContext? context);

        [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct OutputDesc
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
            public Rect Desktop; public int Attached; public int Rotation; public IntPtr Monitor;
        }
        [StructLayout(LayoutKind.Sequential)] public struct DuplicationDesc
        {
            public int Width, Height, RefreshNumerator, RefreshDenominator, Format, ScanlineOrdering, Scaling, Rotation, DesktopImageInSystemMemory;
        }
        [StructLayout(LayoutKind.Sequential)] public struct FrameInfo
        {
            public long LastPresentTime, LastMouseUpdateTime; public uint AccumulatedFrames; public int RectsCoalesced, ProtectedContentMaskedOut;
            public int PointerX, PointerY, PointerVisible; public uint TotalMetadataBufferSize, PointerShapeBufferSize;
        }
        [StructLayout(LayoutKind.Sequential)] public struct PointerShapeInfo { public uint Type, Width, Height, Pitch; public int HotspotX, HotspotY; }
        [StructLayout(LayoutKind.Sequential)] public struct Texture2DDesc
        {
            public int Width, Height; public uint MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
        }
        [StructLayout(LayoutKind.Sequential)] public struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }

        [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IDXGIFactory1
        {
            void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
            [PreserveSig] int EnumAdapters(uint index, out IDXGIAdapter? adapter);
        }

        [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IDXGIAdapter
        {
            void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
            [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput? output);
        }

        [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IDXGIOutput
        {
            void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
            [PreserveSig] int GetDesc(out OutputDesc desc);
        }

        [ComImport, Guid("00cddea8-939b-4b83-a340-a685226666cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IDXGIOutput1
        {
            void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
            void GetDesc(); void GetDisplayModeList(); void FindClosestMatchingMode(); void WaitForVBlank(); void TakeOwnership();
            void ReleaseOwnership(); void GetGammaControlCapabilities(); void SetGammaControl(); void GetGammaControl();
            void SetDisplaySurface(); void GetDisplaySurfaceData(); void GetFrameStatistics();
            void GetDisplayModeList1(); void FindClosestMatchingMode1(); void GetDisplaySurfaceData1();
            [PreserveSig] int DuplicateOutput([MarshalAs(UnmanagedType.IUnknown)] object device, out IDXGIOutputDuplication? duplication);
        }

        [ComImport, Guid("191cfac3-a341-470d-b26e-a864f428319c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IDXGIOutputDuplication
        {
            void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
            [PreserveSig] void GetDesc(out DuplicationDesc desc);
            [PreserveSig] int AcquireNextFrame(uint timeoutMs, out FrameInfo info, out IntPtr resource);
            [PreserveSig] int GetFrameDirtyRects(uint bufferSize, IntPtr rects, out uint requiredSize);
            [PreserveSig] int GetFrameMoveRects(uint bufferSize, IntPtr rects, out uint requiredSize);
            [PreserveSig] int GetFramePointerShape(uint bufferSize, IntPtr buffer, out uint required, out PointerShapeInfo description);
            void MapDesktopSurface(); void UnMapDesktopSurface();
            [PreserveSig] int ReleaseFrame();
        }

        [ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface ID3D11Device
        {
            void CreateBuffer(); void CreateTexture1D();
            [PreserveSig] int CreateTexture2D(ref Texture2DDesc desc, IntPtr initialData, out IntPtr texture);
        }

        [ComImport, Guid("c0bfa96c-e089-44fb-8eaf-26f8796190da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface ID3D11DeviceContext
        {
            void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface();
            void VSSetConstantBuffers(); void PSSetShaderResources(); void PSSetShader(); void PSSetSamplers(); void VSSetShader(); void DrawIndexed(); void Draw();
            [PreserveSig] int Map(IntPtr resource, uint subresource, int mapType, uint mapFlags, out Mapped mapped);
            [PreserveSig] void Unmap(IntPtr resource, uint subresource);
            void PSSetConstantBuffers(); void IASetInputLayout(); void IASetVertexBuffers(); void IASetIndexBuffer(); void DrawIndexedInstanced();
            void DrawInstanced(); void GSSetConstantBuffers(); void GSSetShader(); void IASetPrimitiveTopology(); void VSSetShaderResources();
            void VSSetSamplers(); void Begin(); void End(); void GetData(); void SetPredication(); void GSSetShaderResources(); void GSSetSamplers();
            void OMSetRenderTargets(); void OMSetRenderTargetsAndUnorderedAccessViews(); void OMSetBlendState(); void OMSetDepthStencilState();
            void SOSetTargets(); void DrawAuto(); void DrawIndexedInstancedIndirect(); void DrawInstancedIndirect(); void Dispatch();
            void DispatchIndirect(); void RSSetState(); void RSSetViewports(); void RSSetScissorRects(); void CopySubresourceRegion();
            [PreserveSig] void CopyResource(IntPtr destination, IntPtr source);
        }

        [ComImport, Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface ID3D11Texture2D
        {
            void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface();
            void GetResourceType(); void SetEvictionPriority(); void GetEvictionPriority();
            [PreserveSig] void GetDesc(out Texture2DDesc desc);
        }
    }
}
