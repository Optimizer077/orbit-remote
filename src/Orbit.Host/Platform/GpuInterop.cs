using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>
/// Minimal hand-written DXGI / D3D11 / D3D11-video / MF-DXGI interop for <see cref="GpuMonitorCapture"/> and <see cref="GpuStreamEncoder"/> (decision D10:
/// OS components only). Vtable orders, IIDs, struct layouts and constants were checked against the Windows SDK
/// 10.0.26100 headers (dxgi.h, dxgi1_2.h, d3d11.h, d3d10.h, mfobjects.h, mfapi.h, mftransform.h, dxgiformat.h).
/// Unused slots are placeholders and must never be called. Per-frame calls take raw COM pointers (IntPtr) so the hot
/// path allocates no runtime-callable wrappers. Structs are laid out for x64.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class Gpu
{
    public static readonly Guid Factory1Iid = new("770aae78-f26f-4dba-a829-253c83d1b387");
    public static readonly Guid Texture2DIid = new("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    public static readonly Guid VideoDeviceIid = new("10ec4d5b-975a-4689-b9e4-d0aac30fe333");
    public static readonly Guid VideoContextIid = new("61f21c45-3c0e-4a74-9cea-67100d9ad5e4");
    public static readonly Guid Multithread10Iid = new("9b7e4e00-342c-4106-a19f-4f2704f689f0");
    public static readonly Guid MfD3D11Aware = new("206b4fc8-fcf9-4c51-afe3-9764369e33a0"); // MF_SA_D3D11_AWARE
    public static readonly Guid VideoFormatArgb32 = new("00000015-0000-0010-8000-00aa00389b71"); // D3DFMT_A8R8G8B8 = 21
    public static readonly Guid VideoFormatRgb32 = new("00000016-0000-0010-8000-00aa00389b71"); // D3DFMT_X8R8G8B8 = 22
    public static readonly Guid MftEnumAdapterLuid = new("1d39518c-e220-4da8-a07f-ba172552d6b1"); // MFT_ENUM_ADAPTER_LUID (mfapi.h)
    public static readonly Guid MftHardwareVendorId = new("3aecb0cc-035b-4bcc-8185-2b8d551ef3af"); // MFT_ENUM_HARDWARE_VENDOR_ID_Attribute, "VEN_xxxx"

    public const uint FormatBgra8 = 87, FormatNv12 = 103; // DXGI_FORMAT
    public const uint CreateBgraSupport = 0x20, CreateVideoSupport = 0x800; // D3D11_CREATE_DEVICE_*
    public const uint BindShaderResource = 0x8, BindRenderTarget = 0x20; // D3D11_BIND_*
    public const uint MessageSetD3DManager = 0x2; // MFT_MESSAGE_SET_D3D_MANAGER
    public const int WaitTimeout = unchecked((int)0x887A0027), AccessLost = unchecked((int)0x887A0026),
        NotCurrentlyAvailable = unchecked((int)0x887A0022), AccessDenied = unchecked((int)0x80070005), Unsupported = unchecked((int)0x887A0004);
    /// <summary>D3D11_VIDEO_PROCESSOR_COLOR_SPACE bits: RGB_Range (bit 1, 0 = full), YCbCr_Matrix (bit 2, 1 = BT.709), Nominal_Range (bits 4-5, 1 = 16-235, 2 = 0-255).</summary>
    public const uint ColourRgbFull = 2u << 4, ColourYuv709Limited = 1u << 2 | 1u << 4;

    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags,
        IntPtr featureLevels, uint featureLevelCount, uint sdkVersion, out IntPtr device, out int featureLevel, out IntPtr context);
    [DllImport("mfplat.dll")] public static extern int MFTEnum2(Guid category, uint flags, ref MfH264Encoder.Mf.RegisterTypeInfo input,
        ref MfH264Encoder.Mf.RegisterTypeInfo output, MfH264Encoder.Mf.IMFAttributes? attributes, out IntPtr activates, out uint count);
    [DllImport("mfplat.dll")] public static extern int MFCreateAttributes(out MfH264Encoder.Mf.IMFAttributes attributes, uint initialSize);
    [DllImport("mfplat.dll")] public static extern int MFCreateDXGIDeviceManager(out uint resetToken, out IntPtr manager);
    [DllImport("mfplat.dll")] public static extern int MFCreateDXGISurfaceBuffer(ref Guid iid, IntPtr surface, uint subresource,
        [MarshalAs(UnmanagedType.Bool)] bool bottomUpWhenLinear, out MfH264Encoder.Mf.IMFMediaBuffer buffer);

    public static T Wrap<T>(IntPtr pointer) where T : class => (T)Marshal.GetObjectForIUnknown(pointer);

    public static IntPtr Query(IntPtr unknown, Guid iid)
    {
        Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown, in iid, out var result));
        return result;
    }

    public static void Release(ref IntPtr pointer)
    {
        if (pointer != IntPtr.Zero) { Marshal.Release(pointer); pointer = IntPtr.Zero; }
    }

    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct OutputDesc
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
        public Rect Desktop; public int Attached; public int Rotation; public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct AdapterDesc1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision; public nuint VideoMemory, SystemMemory, SharedMemory; public long Luid; public uint Flags;
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
    [StructLayout(LayoutKind.Sequential)] public struct Texture2DDesc
    {
        public int Width, Height; public uint MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags;
    }
    [StructLayout(LayoutKind.Sequential)] public struct Mapped { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [StructLayout(LayoutKind.Sequential)] public struct PointerShapeInfo { public uint Type, Width, Height, Pitch; public int HotspotX, HotspotY; }
    [StructLayout(LayoutKind.Sequential)] public struct SubresourceData { public IntPtr SysMem; public uint Pitch, SlicePitch; }
    [StructLayout(LayoutKind.Sequential)] public struct ContentDesc
    {
        public uint InputFrameFormat, InputRateNumerator, InputRateDenominator, InputWidth, InputHeight;
        public uint OutputRateNumerator, OutputRateDenominator, OutputWidth, OutputHeight, Usage;
    }
    [StructLayout(LayoutKind.Sequential)] public struct InputViewDesc { public uint FourCC, ViewDimension, MipSlice, ArraySlice; }
    [StructLayout(LayoutKind.Sequential)] public struct OutputViewDesc { public uint ViewDimension, MipSlice, FirstArraySlice, ArraySize; }
    [StructLayout(LayoutKind.Sequential)] public struct ProcessorStream
    {
        public int Enable; public uint OutputIndex, InputFrameOrField, PastFrames, FutureFrames;
        public IntPtr PastSurfaces, InputSurface, FutureSurfaces, PastSurfacesRight, InputSurfaceRight, FutureSurfacesRight;
    }

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDXGIFactory1
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(uint index, out IntPtr adapter);
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDXGIAdapter1
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        [PreserveSig] int EnumOutputs(uint index, out IntPtr output);
        void GetDesc(); void CheckInterfaceSupport();
        [PreserveSig] int GetDesc1(out AdapterDesc1 desc);
    }

    [ComImport, Guid("00cddea8-939b-4b83-a340-a685226666cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDXGIOutput1
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        [PreserveSig] int GetDesc(out OutputDesc desc);
        void GetDisplayModeList(); void FindClosestMatchingMode(); void WaitForVBlank(); void TakeOwnership();
        void ReleaseOwnership(); void GetGammaControlCapabilities(); void SetGammaControl(); void GetGammaControl();
        void SetDisplaySurface(); void GetDisplaySurfaceData(); void GetFrameStatistics();
        void GetDisplayModeList1(); void FindClosestMatchingMode1(); void GetDisplaySurfaceData1();
        [PreserveSig] int DuplicateOutput(IntPtr device, out IntPtr duplication);
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
        [PreserveSig] int Map(IntPtr resource, uint subresource, int mapType, uint mapFlags, out Mapped mapped); // 14
        [PreserveSig] void Unmap(IntPtr resource, uint subresource); // 15
        void PSSetConstantBuffers(); void IASetInputLayout(); void IASetVertexBuffers(); void IASetIndexBuffer(); void DrawIndexedInstanced();
        void DrawInstanced(); void GSSetConstantBuffers(); void GSSetShader(); void IASetPrimitiveTopology(); void VSSetShaderResources();
        void VSSetSamplers(); void Begin(); void End(); void GetData(); void SetPredication(); void GSSetShaderResources(); void GSSetSamplers();
        void OMSetRenderTargets(); void OMSetRenderTargetsAndUnorderedAccessViews(); void OMSetBlendState(); void OMSetDepthStencilState();
        void SOSetTargets(); void DrawAuto(); void DrawIndexedInstancedIndirect(); void DrawInstancedIndirect(); void Dispatch();
        void DispatchIndirect(); void RSSetState(); void RSSetViewports(); void RSSetScissorRects(); void CopySubresourceRegion();
        [PreserveSig] void CopyResource(IntPtr destination, IntPtr source); // 47
        [PreserveSig] void UpdateSubresource(IntPtr destination, uint subresource, IntPtr box, IntPtr source, uint rowPitch, uint depthPitch); // 48
    }

    [ComImport, Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ID3D11Texture2D
    {
        void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface();
        void GetResourceType(); void SetEvictionPriority(); void GetEvictionPriority();
        [PreserveSig] void GetDesc(out Texture2DDesc desc);
    }

    [ComImport, Guid("9b7e4e00-342c-4106-a19f-4f2704f689f0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ID3D10Multithread
    {
        void Enter(); void Leave();
        [PreserveSig] int SetMultithreadProtected([MarshalAs(UnmanagedType.Bool)] bool protect);
    }

    [ComImport, Guid("10ec4d5b-975a-4689-b9e4-d0aac30fe333"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ID3D11VideoDevice
    {
        void CreateVideoDecoder();
        [PreserveSig] int CreateVideoProcessor(IntPtr enumerator, uint rateConversionIndex, out IntPtr processor);
        void CreateAuthenticatedChannel(); void CreateCryptoSession(); void CreateVideoDecoderOutputView();
        [PreserveSig] int CreateVideoProcessorInputView(IntPtr resource, IntPtr enumerator, ref InputViewDesc desc, out IntPtr view);
        [PreserveSig] int CreateVideoProcessorOutputView(IntPtr resource, IntPtr enumerator, ref OutputViewDesc desc, out IntPtr view);
        [PreserveSig] int CreateVideoProcessorEnumerator(ref ContentDesc desc, out IntPtr enumerator);
    }

    [ComImport, Guid("31627037-53ab-4200-9061-05faa9ab45f9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ID3D11VideoProcessorEnumerator
    {
        void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface();
        void GetVideoProcessorContentDesc();
        [PreserveSig] int CheckVideoProcessorFormat(uint format, out uint flags); // flags: 1 = input, 2 = output
    }

    [ComImport, Guid("61f21c45-3c0e-4a74-9cea-67100d9ad5e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ID3D11VideoContext
    {
        void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface(); // 3-6
        void GetDecoderBuffer(); void ReleaseDecoderBuffer(); void DecoderBeginFrame(); void DecoderEndFrame(); void SubmitDecoderBuffers(); void DecoderExtension(); // 7-12
        [PreserveSig] void VideoProcessorSetOutputTargetRect(IntPtr processor, [MarshalAs(UnmanagedType.Bool)] bool enable, ref Rect rect); // 13
        void VideoProcessorSetOutputBackgroundColor(); // 14
        [PreserveSig] void VideoProcessorSetOutputColorSpace(IntPtr processor, ref uint colourSpace); // 15
        void A16(); void A17(); void A18(); void A19(); void A20(); void A21(); void A22(); void A23(); void A24(); void A25(); void A26(); // 16-26
        [PreserveSig] void VideoProcessorSetStreamFrameFormat(IntPtr processor, uint stream, uint format); // 27
        [PreserveSig] void VideoProcessorSetStreamColorSpace(IntPtr processor, uint stream, ref uint colourSpace); // 28
        void VideoProcessorSetStreamOutputRate(); // 29
        [PreserveSig] void VideoProcessorSetStreamSourceRect(IntPtr processor, uint stream, [MarshalAs(UnmanagedType.Bool)] bool enable, ref Rect rect); // 30
        [PreserveSig] void VideoProcessorSetStreamDestRect(IntPtr processor, uint stream, [MarshalAs(UnmanagedType.Bool)] bool enable, ref Rect rect); // 31
        void B32(); void B33(); void B34(); void B35(); void B36(); // 32-36
        [PreserveSig] void VideoProcessorSetStreamAutoProcessingMode(IntPtr processor, uint stream, [MarshalAs(UnmanagedType.Bool)] bool enable); // 37
        void C38(); void C39(); void C40(); void C41(); void C42(); void C43(); void C44(); void C45(); void C46(); void C47(); void C48(); void C49();
        void C50(); void C51(); void C52(); // 38-52
        [PreserveSig] int VideoProcessorBlt(IntPtr processor, IntPtr outputView, uint outputFrame, uint streamCount, ref ProcessorStream streams); // 53
    }

    [ComImport, Guid("eb533d5d-2db6-40f8-97a9-494692014f07"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMFDXGIDeviceManager
    {
        void CloseDeviceHandle(); void GetVideoService(); void LockDevice(); void OpenDeviceHandle();
        [PreserveSig] int ResetDevice(IntPtr device, uint resetToken);
    }

    [ComImport, Guid("7dc9d5f9-9ed9-44ec-9bbf-0600bb589fbb"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMF2DBuffer
    {
        void Lock2D(); void Unlock2D(); void GetScanline0AndPitch(); void IsContiguousFormat();
        [PreserveSig] int GetContiguousLength(out uint length);
    }
}
