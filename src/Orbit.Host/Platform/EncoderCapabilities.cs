using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Mf = Orbit.Host.Platform.MfH264Encoder.Mf;

namespace Orbit.Host.Platform;

/// <summary>What one ICodecAPI property reports on an open encoder. Strings are display-only; no pixel data.</summary>
internal sealed record CodecPropertyReport(string Name, bool Supported, bool Modifiable, string? Current, string? Default, string? Range, string? Values,
    int ModifiableHr = 0);

/// <summary>D3D12 Video Encode support for one codec on one adapter (main profile, highest supported level).</summary>
internal sealed record D3D12CodecReport(string Codec, bool Supported, string? MaxLevel, bool? IntraRefreshRowBased, IReadOnlyList<string> RateControlModes);

internal sealed record D3D12AdapterReport(string Adapter, uint VendorId, uint DeviceId, long Luid, IReadOnlyList<D3D12CodecReport> Codecs);

/// <summary>
/// W8b capability probe. Part 1 asks the selected Media Foundation encoder, through ICodecAPI (IsSupported,
/// IsModifiable, GetValue, GetDefaultValue, GetParameterRange, GetParameterValues), about the controls a
/// low-latency stream needs: long-term reference frames, slices, QP, rate-control buffer, keyframes and intra refresh.
/// Part 2 asks D3D12 Video Encode (ID3D12VideoDevice::CheckFeatureSupport) which codecs and intra-refresh modes the GPU
/// offers. Report only: nothing here changes encoder state. Property GUIDs come from codecapi.h and the D3D12
/// structures from d3d12video.h (Windows SDK 10.0.26100).
/// </summary>
internal static class EncoderCapabilities
{
    /// <summary>Properties probed on the MF encoder, in report order.</summary>
    public static readonly IReadOnlyList<(string Name, Guid Id)> Properties =
    [
        ("AVEncVideoLTRBufferControl", new("a4a0e93d-4cbc-444c-89f4-826d310e92a7")),
        ("AVEncVideoMarkLTRFrame", new("e42f4748-a06d-4ef9-8cea-3d05fde3bd3b")),
        ("AVEncVideoUseLTRFrame", new("00752db8-55f7-4f80-895b-27639195f2ad")),
        ("AVEncSliceControlMode", new("e9e782ef-5f18-44c9-a90b-e9c3c2c17b0b")),
        ("AVEncSliceControlSize", new("92f51df3-07a5-4172-aefe-c69ca3b60e35")),
        ("AVEncVideoEncodeQP", new("2cb5696b-23fb-4ce1-a0f9-ef5b90fd55ca")),
        ("AVEncVideoMinQP", new("0ee22c6a-a37c-4568-b5f1-9d4c2b3ab886")),
        ("AVEncVideoMaxQP", new("3daf6f66-a6a7-45e0-a8e5-f2743f46a3a2")),
        ("AVEncCommonBufferSize", new("0db96574-b6a4-4c8b-8106-3773de0310cd")),
        ("AVEncCommonMaxBitRate", new("9651eae4-39b9-4ebf-85ef-d7f444ec7465")),
        ("AVEncCommonMeanBitRate", new("f7222374-2144-4815-b550-a37f8e12ee52")),
        ("AVEncCommonRateControlMode", new("1c0608e9-370c-4710-8a58-cb6181c42423")),
        ("AVEncVideoForceKeyFrame", new("398c1b98-8353-475a-9ef2-8f265d260345")),
        ("AVLowLatencyMode", new("9c27891a-ed7a-40e1-88e8-b22727a024ee")),
        ("AVEncNumWorkerThreads", new("b0c8bf60-16f7-4951-a30b-1db1609293d6")),
        ("AVEncVideoGradualIntraRefresh", new("8f347dee-cb0d-49ba-b462-db6927ee2101")),
        ("AVEncMPVGOPSize", new("95f31b26-95a4-41aa-9303-246a7fc6eef1")),
        ("AVEncMPVDefaultBPictureCount", new("8d390aac-dc5c-4200-b57f-814d04babab2")),
        ("AVEncVideoMaxNumRefFrame", new("964829ed-94f9-43b4-b74d-ef40944b69a0")),
        ("AVEncVideoTemporalLayerCount", new("19caebff-b74d-4cfd-8c27-c2f9d97d5f52")),
        ("AVEncVideoROIEnabled", new("d74f7f18-44dd-4b85-aba3-05d9f42a8280")),
        ("AVEncVideoDirtyRectEnabled", new("8acb8fdd-5e0c-4c66-8729-b8f629ab04fb")),
        ("AVEncVideoContentType", new("66117aca-eb77-459d-930c-a48d9d0683fc")),
        ("AVEncCommonQualityVsSpeed", new("98332df8-03cd-476b-89fa-3f9e442dec9f")),
        ("AVEncH264CABACEnable", new("ee6cad62-d305-4248-a50e-e1b255f7caf8")),
        ("AVEncVideoSupportedControls", new("d3f40fdd-77b9-473d-8196-061259e69cff")),
    ];

    /// <summary>Queries every property in <see cref="Properties"/> on an open encoder.</summary>
    [SupportedOSPlatform("windows")]
    public static IReadOnlyList<CodecPropertyReport> ProbeCodecApi(MfH264Encoder encoder) =>
        encoder.QueryCodecApi(codec => Properties.Select(p => ProbeProperty(codec, p.Name, p.Id)).ToList()) ?? [];

    [SupportedOSPlatform("windows")]
    private static CodecPropertyReport ProbeProperty(Mf.ICodecAPI codec, string name, Guid id)
    {
        var key = id;
        var supported = codec.IsSupported(ref key) == 0; // S_OK = supported, S_FALSE/E_NOTIMPL = not
        if (!supported) return new CodecPropertyReport(name, false, false, null, null, null, null);
        var modifiableHr = codec.IsModifiable(ref key);
        var modifiable = modifiableHr == 0;
        string? current = codec.GetValue(ref key, out var value) == 0 ? Format(value) : null;
        string? fallback = codec.GetDefaultValue(ref key, out var defaultValue) == 0 ? Format(defaultValue) : null;
        string? range = codec.GetParameterRange(ref key, out var min, out var max, out var step) == 0
            ? $"{Format(min)}..{Format(max)} step {Format(step)}" : null;
        string? values = null;
        if (codec.GetParameterValues(ref key, out var array, out var count) == 0 && array != IntPtr.Zero)
        {
            var size = IntPtr.Size == 8 ? 24 : 16; // sizeof(VARIANT)
            try
            {
                var items = new List<string>();
                for (var i = 0; i < count; i++)
                {
                    var item = array + i * size;
                    items.Add(Format(Marshal.GetObjectForNativeVariant(item)));
                    VariantClear(item);
                }
                values = string.Join(",", items);
            }
            finally { Marshal.FreeCoTaskMem(array); }
        }
        return new CodecPropertyReport(name, true, modifiable, current, fallback, range, values, modifiableHr);
    }

    private static string Format(object? value) => value switch
    {
        null => "empty",
        ulong u => u > uint.MaxValue ? "0x" + u.ToString("X", CultureInfo.InvariantCulture) : u.ToString(CultureInfo.InvariantCulture),
        bool b => b ? "true" : "false",
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? "?",
    };

    [DllImport("oleaut32.dll")] private static extern int VariantClear(IntPtr variant);

    // ---- D3D12 Video Encode ----------------------------------------------------------------------------------------

    private const int FeatureEncoderCodec = 33, FeatureEncoderProfileLevel = 34, FeatureEncoderRateControlMode = 38, FeatureEncoderIntraRefreshMode = 39;
    private static readonly string[] CodecNames = ["H.264", "HEVC", "AV1"];
    private static readonly string[] H264Levels = ["1", "1b", "1.1", "1.2", "1.3", "2", "2.1", "2.2", "3", "3.1", "3.2", "4", "4.1", "4.2", "5", "5.1", "5.2", "6", "6.1", "6.2"];
    private static readonly string[] HevcLevels = ["1", "2", "2.1", "3", "3.1", "4", "4.1", "5", "5.1", "5.2", "6", "6.1", "6.2"];
    private static readonly string[] RateControlNames = ["ABSOLUTE_QP_MAP", "CQP", "CBR", "VBR", "QVBR"];

    /// <summary>
    /// For each hardware DXGI adapter: D3D12 Video Encode support for H.264/HEVC/AV1 (main profile), the highest level,
    /// row-based intra refresh at that level, and the rate-control modes. Returns null with a reason when D3D12 video is
    /// unavailable. 64-bit only (feature structs are laid out for x64).
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static IReadOnlyList<D3D12AdapterReport>? ProbeD3D12VideoEncode(out string reason)
    {
        reason = "";
        if (IntPtr.Size != 8) { reason = "D3D12 probe is x64-only."; return null; }
        var factoryIid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factoryPointer;
        try { if (CreateDXGIFactory1(ref factoryIid, out factoryPointer) < 0) { reason = "CreateDXGIFactory1 failed."; return null; } }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { reason = ex.Message; return null; }
        var reports = new List<D3D12AdapterReport>();
        var factory = (IDXGIFactory1)Marshal.GetObjectForIUnknown(factoryPointer);
        Marshal.Release(factoryPointer);
        try
        {
            for (uint index = 0; factory.EnumAdapters1(index, out var adapterPointer) == 0; index++)
            {
                try
                {
                    var adapter = (IDXGIAdapter1)Marshal.GetObjectForIUnknown(adapterPointer);
                    try
                    {
                        adapter.GetDesc1(out var desc);
                        if ((desc.Flags & 2) != 0) continue; // DXGI_ADAPTER_FLAG_SOFTWARE (WARP)
                        reports.Add(new D3D12AdapterReport(desc.Description, desc.VendorId, desc.DeviceId, desc.AdapterLuid, ProbeAdapter(adapterPointer)));
                    }
                    finally { Mf.Release(adapter); }
                }
                finally { Marshal.Release(adapterPointer); }
            }
        }
        catch (Exception ex) when (ex is COMException or DllNotFoundException or EntryPointNotFoundException or InvalidCastException)
        {
            reason = $"D3D12 probe failed: 0x{ex.HResult:X8} {ex.Message}";
        }
        finally { Mf.Release(factory); }
        return reports;
    }

    [SupportedOSPlatform("windows")]
    private static List<D3D12CodecReport> ProbeAdapter(IntPtr adapter)
    {
        var result = new List<D3D12CodecReport>();
        var deviceIid = new Guid("189819f1-1db6-4b57-be54-1821339b85f7"); // ID3D12Device
        if (D3D12CreateDevice(adapter, 0xb000, ref deviceIid, out var device) < 0 || device == IntPtr.Zero) return result; // D3D_FEATURE_LEVEL_11_0
        IntPtr videoPointer = IntPtr.Zero;
        try
        {
            var videoIid = new Guid("1f052807-0b46-4acc-8a89-364f793718a4"); // ID3D12VideoDevice
            if (Marshal.QueryInterface(device, in videoIid, out videoPointer) < 0) return result;
            var video = (ID3D12VideoDevice)Marshal.GetObjectForIUnknown(videoPointer);
            try { for (var codec = 0; codec < 3; codec++) result.Add(ProbeCodec(video, codec)); }
            finally { Mf.Release(video); }
        }
        finally
        {
            if (videoPointer != IntPtr.Zero) Marshal.Release(videoPointer);
            Marshal.Release(device);
        }
        return result;
    }

    /// <summary>Feature structs are filled in one unmanaged block: [struct | profile value | min level | max level].</summary>
    [SupportedOSPlatform("windows")]
    private static D3D12CodecReport ProbeCodec(ID3D12VideoDevice video, int codec)
    {
        var block = Marshal.AllocHGlobal(256);
        try
        {
            Clear(block, 256);
            Marshal.WriteInt32(block, 4, codec); // D3D12_FEATURE_DATA_VIDEO_ENCODER_CODEC { NodeIndex, Codec, IsSupported }
            if (video.CheckFeatureSupport(FeatureEncoderCodec, block, 12) < 0 || Marshal.ReadInt32(block, 8) == 0)
                return new D3D12CodecReport(CodecNames[codec], false, null, null, []);

            // PROFILE_LEVEL (64 bytes): Node@0 Codec@4 Profile{DataSize@8, ptr@16} IsSupported@24 Min{@32,@40} Max{@48,@56}.
            var levelSize = codec == 0 ? 4 : 8; // H.264 level enum; HEVC/AV1 {Level, Tier}
            IntPtr profile = block + 128, minLevel = block + 144, maxLevel = block + 160;
            Clear(block, 256);
            Marshal.WriteInt32(block, 4, codec);
            Marshal.WriteInt32(block, 8, 4); Marshal.WriteIntPtr(block, 16, profile); // main profile = 0 for all three codecs
            Marshal.WriteInt32(block, 32, levelSize); Marshal.WriteIntPtr(block, 40, minLevel);
            Marshal.WriteInt32(block, 48, levelSize); Marshal.WriteIntPtr(block, 56, maxLevel);
            string? maxLevelName = null; bool? intraRefresh = null;
            if (video.CheckFeatureSupport(FeatureEncoderProfileLevel, block, 64) >= 0 && Marshal.ReadInt32(block, 24) != 0)
            {
                var level = Marshal.ReadInt32(maxLevel);
                var tier = levelSize == 8 ? Marshal.ReadInt32(maxLevel, 4) : 0;
                maxLevelName = codec switch
                {
                    0 => level < H264Levels.Length ? H264Levels[level] : level.ToString(CultureInfo.InvariantCulture),
                    1 => (level < HevcLevels.Length ? HevcLevels[level] : level.ToString(CultureInfo.InvariantCulture)) + (tier == 1 ? " High tier" : " Main tier"),
                    _ => $"{2 + level / 4}.{level % 4}" + (tier == 1 ? " High tier" : " Main tier"),
                };
                // INTRA_REFRESH_MODE (48 bytes): Node@0 Codec@4 Profile{@8,@16} Level{@24,@32} Mode@40 IsSupported@44.
                var levelCopy = Marshal.ReadInt64(maxLevel);
                Clear(block, 128);
                Marshal.WriteInt64(minLevel, levelCopy); // reuse as the level argument
                Marshal.WriteInt32(block, 4, codec);
                Marshal.WriteInt32(block, 8, 4); Marshal.WriteIntPtr(block, 16, profile);
                Marshal.WriteInt32(block, 24, levelSize); Marshal.WriteIntPtr(block, 32, minLevel);
                Marshal.WriteInt32(block, 40, 1); // D3D12_VIDEO_ENCODER_INTRA_REFRESH_MODE_ROW_BASED
                intraRefresh = video.CheckFeatureSupport(FeatureEncoderIntraRefreshMode, block, 48) >= 0 ? Marshal.ReadInt32(block, 44) != 0 : null;
            }

            var modes = new List<string>();
            for (var mode = 0; mode < RateControlNames.Length; mode++)
            {
                Clear(block, 16); // RATE_CONTROL_MODE (16 bytes): Node@0 Codec@4 Mode@8 IsSupported@12
                Marshal.WriteInt32(block, 4, codec); Marshal.WriteInt32(block, 8, mode);
                if (video.CheckFeatureSupport(FeatureEncoderRateControlMode, block, 16) >= 0 && Marshal.ReadInt32(block, 12) != 0) modes.Add(RateControlNames[mode]);
            }
            return new D3D12CodecReport(CodecNames[codec], true, maxLevelName, intraRefresh, modes);
        }
        finally { Marshal.FreeHGlobal(block); }
    }

    private static void Clear(IntPtr block, int length)
    {
        for (var i = 0; i < length; i += 8) Marshal.WriteInt64(block, i, 0);
    }

    [DllImport("dxgi.dll")] private static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d12.dll")] private static extern int D3D12CreateDevice(IntPtr adapter, int minimumFeatureLevel, ref Guid iid, out IntPtr device);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct AdapterDesc1
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint VendorId, DeviceId, SubSysId, Revision;
        public nuint DedicatedVideoMemory, DedicatedSystemMemory, SharedSystemMemory;
        public long AdapterLuid;
        public uint Flags;
    }

    [ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIFactory1
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumAdapters(); void MakeWindowAssociation(); void GetWindowAssociation(); void CreateSwapChain(); void CreateSoftwareAdapter();
        [PreserveSig] int EnumAdapters1(uint index, out IntPtr adapter);
    }

    [ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDXGIAdapter1
    {
        void SetPrivateData(); void SetPrivateDataInterface(); void GetPrivateData(); void GetParent();
        void EnumOutputs(); void GetDesc(); void CheckInterfaceSupport();
        void GetDesc1(out AdapterDesc1 desc);
    }

    [ComImport, Guid("1f052807-0b46-4acc-8a89-364f793718a4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ID3D12VideoDevice
    {
        [PreserveSig] int CheckFeatureSupport(int feature, IntPtr data, uint size);
    }
}
