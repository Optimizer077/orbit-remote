using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;

namespace Orbit.Host.Platform;

// Device, duplication, recovery and pool management for GpuMonitorCapture (split for the file-size limit).
internal sealed partial class GpuMonitorCapture
{
    private int[] metadata = new int[256];

    /// <summary>Creates device, duplication (unless synthetic) and device manager; sets a new generation. Returns "" on success.</summary>
    [SupportedOSPlatform("windows")]
    private string Open()
    {
        var adapter = IntPtr.Zero; var output = IntPtr.Zero;
        // Output coordinates are DPI-virtualized for unaware threads; use per-monitor-v2 like DxgiCapture/WindowsPlatformBackend.
        var previousDpi = Gpu.SetThreadDpiAwarenessContext(new IntPtr(-4));
        try
        {
            if (!FindOutput(monitor?.Id, out adapter, out output)) return "output-not-found";
            var hr = Gpu.D3D11CreateDevice(adapter, 0, IntPtr.Zero, Gpu.CreateBgraSupport | Gpu.CreateVideoSupport, IntPtr.Zero, 0, 7, out device, out _, out context);
            if (hr < 0) return $"device-failed-0x{hr:X8}";
            deviceApi = Gpu.Wrap<Gpu.ID3D11Device>(device);
            contextApi = Gpu.Wrap<Gpu.ID3D11DeviceContext>(context);
            // The MFTs use this device from their own threads.
            var multithread = Gpu.Query(device, Gpu.Multithread10Iid);
            var guard = Gpu.Wrap<Gpu.ID3D10Multithread>(multithread);
            try { guard.SetMultithreadProtected(true); }
            finally { Marshal.ReleaseComObject(guard); Marshal.Release(multithread); }

            if (!synthetic)
            {
                var output1 = Gpu.Wrap<Gpu.IDXGIOutput1>(output);
                try { hr = output1.DuplicateOutput(device, out duplication); }
                finally { Marshal.ReleaseComObject(output1); }
                if (hr == Gpu.NotCurrentlyAvailable) return "not-currently-available (another process already duplicates this output)";
                if (hr == Gpu.AccessDenied) return "access-denied (secure desktop)";
                if (hr == Gpu.Unsupported) return "unsupported";
                if (hr < 0) return $"duplicate-failed-0x{hr:X8}";
                duplicationApi = Gpu.Wrap<Gpu.IDXGIOutputDuplication>(duplication);
                duplicationApi.GetDesc(out var mode);
                if (mode.Rotation is not (0 or 1)) return "rotated-" + (mode.Rotation - 1) * 90;
                Width = mode.Width; Height = mode.Height;
                RefreshHz = mode.RefreshDenominator == 0 ? 0 : (double)mode.RefreshNumerator / mode.RefreshDenominator;
                if (recoveryCount == 0 && monitor!.Width > 0 && (Width != monitor.Width || Height != monitor.Height)) return "size-mismatch";
                PlatformLimits.CheckDimensions(Width, Height);
            }
            else { Width = syntheticWidth; Height = syntheticHeight; }

            Marshal.ThrowExceptionForHR(Gpu.MFCreateDXGIDeviceManager(out var token, out manager));
            var managerApi = Gpu.Wrap<Gpu.IMFDXGIDeviceManager>(manager);
            try { Marshal.ThrowExceptionForHR(managerApi.ResetDevice(device, token)); }
            finally { Marshal.ReleaseComObject(managerApi); }
            Generation = RandomNumberGenerator.GetHexString(32, lowercase: true); // 128 random bits
            needFull = true; pointer = null; pointerVersion++;
            return "";
        }
        catch (PlatformUnavailableException ex) { return ex.Code; }
        finally
        {
            Gpu.Release(ref output); Gpu.Release(ref adapter);
            if (previousDpi != IntPtr.Zero) Gpu.SetThreadDpiAwarenessContext(previousDpi);
        }
    }

    /// <summary>The named output (GDI name), or for null the attached output at desktop origin; also records adapter identity.</summary>
    [SupportedOSPlatform("windows")]
    private bool FindOutput(string? outputName, out IntPtr adapter, out IntPtr output)
    {
        adapter = IntPtr.Zero; output = IntPtr.Zero;
        var iid = Gpu.Factory1Iid;
        Marshal.ThrowExceptionForHR(Gpu.CreateDXGIFactory1(ref iid, out var factoryPointer));
        var factory = Gpu.Wrap<Gpu.IDXGIFactory1>(factoryPointer);
        Marshal.Release(factoryPointer);
        try
        {
            for (uint a = 0; factory.EnumAdapters1(a, out var candidateAdapter) >= 0; a++)
            {
                var adapterApi = Gpu.Wrap<Gpu.IDXGIAdapter1>(candidateAdapter);
                try
                {
                    for (uint o = 0; adapterApi.EnumOutputs(o, out var candidate) >= 0; o++)
                    {
                        var outputApi = Gpu.Wrap<Gpu.IDXGIOutput1>(candidate);
                        var match = outputApi.GetDesc(out var desc) >= 0 && desc.Attached != 0 && (outputName is null
                            ? desc.Desktop.Left == 0 && desc.Desktop.Top == 0
                            : string.Equals(desc.DeviceName, outputName, StringComparison.OrdinalIgnoreCase));
                        Marshal.ReleaseComObject(outputApi);
                        if (!match) { Marshal.Release(candidate); continue; }
                        adapterApi.GetDesc1(out var adapterDesc);
                        AdapterName = adapterDesc.Description; AdapterLuid = adapterDesc.Luid; AdapterVendorId = adapterDesc.VendorId;
                        OutputName = desc.DeviceName;
                        output = candidate; adapter = candidateAdapter; candidateAdapter = IntPtr.Zero;
                        return true;
                    }
                }
                finally { Marshal.ReleaseComObject(adapterApi); Gpu.Release(ref candidateAdapter); }
            }
            return false;
        }
        finally { Marshal.ReleaseComObject(factory); }
    }

    /// <summary>Access lost or a forced recovery: drop everything, reopen with a new generation. Old leases stay valid objects but stale.</summary>
    [SupportedOSPlatform("windows")]
    private void Recover()
    {
        recoveryCount++;
        Reset();
        string reason;
        try { reason = Open(); }
        catch (Exception ex) when (ex is COMException or InvalidCastException) { reason = $"interop-failed-0x{ex.HResult:X8}"; }
        if (reason.Length > 0) { Reset(); throw new PlatformUnavailableException("capture-lost", "GPU desktop capture was lost and cannot resume: " + reason); }
    }

    [SupportedOSPlatform("windows")]
    private void Reset()
    {
        Generation = ""; // every outstanding lease and encoder is stale from here on
        var newest = latest; latest = null; newest?.Dispose();
        foreach (var slot in slots)
        {
            slot.Retired = true;
            if (slot.Refs == 0) { if (slot.Texture != IntPtr.Zero) Marshal.Release(slot.Texture); slot.Texture = IntPtr.Zero; }
            else retired.Add(slot); // released by the last lease (ReleaseHold)
        }
        slots.Clear();
        readback = null; readbackGeneration = null; readbackVersion = -1;
        Gpu.Release(ref staging);
        foreach (var api in new object?[] { duplicationApi, contextApi, deviceApi }) if (api is not null) Marshal.ReleaseComObject(api);
        duplicationApi = null; contextApi = null; deviceApi = null;
        Gpu.Release(ref duplication); Gpu.Release(ref manager); Gpu.Release(ref context); Gpu.Release(ref device);
    }

    [SupportedOSPlatform("windows")]
    private Slot TakeFreeSlot()
    {
        foreach (var slot in slots)
            if (slot.Refs == 0) { slot.Generation = Generation; return slot; }
        if (slots.Count >= MaximumSlots)
            throw new PlatformUnavailableException("capture-busy", $"All {MaximumSlots} GPU frame slots are leased; release old leases.");
        var desc = TextureDesc(Width, Height, Gpu.FormatBgra8, Gpu.BindRenderTarget | Gpu.BindShaderResource);
        var hr = deviceApi!.CreateTexture2D(ref desc, IntPtr.Zero, out var texture);
        if (hr < 0) throw new PlatformUnavailableException("capture-failed", $"Cannot allocate a GPU frame slot (0x{hr:X8}).");
        var created = new Slot { Texture = texture, Width = Width, Height = Height, Generation = Generation };
        slots.Add(created);
        return created;
    }

    private GpuFrameLease Publish(Slot slot, List<DxgiRect>? rects)
    {
        Version++;
        slot.Refs = 1; // the capture's own hold on the newest image (Latest / readback)
        var previous = latest;
        latest = new GpuFrameLease(this, slot, Version, rects is { Count: > 0 } ? rects : [new DxgiRect(0, 0, Width, Height)], needFull, DateTimeOffset.UtcNow);
        needFull = false;
        previous?.Dispose();
        return AddHoldLocked(latest);
    }

    /// <summary>Reads a new cursor shape when the frame carries one (duplication call: producer only, no gate).</summary>
    [SupportedOSPlatform("windows")]
    private CursorShape? ReadPointerShape(Gpu.FrameInfo info)
    {
        CursorShape? shape = null;
        if (info.PointerShapeBufferSize > 0)
        {
            if (info.PointerShapeBufferSize > CursorCompositor.MaximumShapeBytes) throw new PlatformUnavailableException("cursor-unavailable", "Desktop cursor exceeds the bounded shape size.");
            var bytes = new byte[info.PointerShapeBufferSize];
            var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                var hr = duplicationApi!.GetFramePointerShape((uint)bytes.Length, pin.AddrOfPinnedObject(), out var required, out var description);
                if (hr < 0 || required > bytes.Length) throw new PlatformUnavailableException("cursor-unavailable", "Could not retrieve the desktop cursor shape.");
                if (required < bytes.Length) bytes = bytes.AsSpan(0, (int)required).ToArray();
                shape = new((int)description.Type, (int)description.Width, (int)description.Height, (int)description.Pitch, bytes,
                    HotX: description.HotspotX, HotY: description.HotspotY); // hotspot for the viewer-drawn cursor (W7a)
                CursorCompositor.Validate(shape);
            }
            finally { pin.Free(); }
        }
        return shape;
    }

    /// <summary>Updates the pointer state (caller holds the short gate).</summary>
    [SupportedOSPlatform("windows")]
    private void ApplyPointer(Gpu.FrameInfo info, CursorShape? newShape)
    {
        var previous = pointer;
        var shape = newShape ?? previous?.Shape;
        var next = info.LastMouseUpdateTime != 0 || previous is null ? new FramePointer(info.PointerVisible != 0, info.PointerX, info.PointerY, shape)
            : ReferenceEquals(shape, previous.Shape) ? previous : previous with { Shape = shape };
        if (next != previous) { pointer = next; pointerVersion++; }
    }

    /// <summary>Move destinations and dirty rects clamped to the surface; null means unknown (treat as full).</summary>
    [SupportedOSPlatform("windows")]
    private List<DxgiRect>? ReadRects(uint bytes)
    {
        if (bytes == 0 || bytes > 16 * 1024 * 1024) return null;
        if (metadata.Length * 4 < bytes) metadata = new int[(bytes + 3) / 4];
        var rects = new List<DxgiRect>();
        var pin = GCHandle.Alloc(metadata, GCHandleType.Pinned);
        try
        {
            var buffer = pin.AddrOfPinnedObject();
            if (duplicationApi!.GetFrameMoveRects(bytes, buffer, out var used) < 0) return null;
            for (var i = 0; i < used / 24; i++) Add(rects, i * 6 + 2); // DXGI_OUTDUPL_MOVE_RECT: POINT source + RECT destination
            if (duplicationApi.GetFrameDirtyRects(bytes, buffer, out used) < 0) return null;
            for (var i = 0; i < used / 16; i++) Add(rects, i * 4);
            return rects;
        }
        finally { pin.Free(); }
    }

    private void Add(List<DxgiRect> rects, int offset)
    {
        var rect = new DxgiRect(Math.Clamp(metadata[offset], 0, Width), Math.Clamp(metadata[offset + 1], 0, Height),
            Math.Clamp(metadata[offset + 2], 0, Width), Math.Clamp(metadata[offset + 3], 0, Height));
        if (rect.Right > rect.Left && rect.Bottom > rect.Top) rects.Add(rect);
    }

    [SupportedOSPlatform("windows")]
    internal static Gpu.Texture2DDesc TextureDesc(int width, int height, uint format, uint bind) => new()
    {
        Width = width, Height = height, MipLevels = 1, ArraySize = 1, Format = format, SampleCount = 1, Usage = 0 /* DEFAULT */, BindFlags = bind,
    };
}
