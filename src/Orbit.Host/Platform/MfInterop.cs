using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

// Split from MfH264Encoder.cs to keep each file under the 800-line limit. No behaviour change: the nested type is still
// MfH264Encoder.Mf, so callers (EncoderCapabilities, the checks) are unchanged.
internal sealed partial class MfH264Encoder
{
    /// <summary>
    /// Minimal hand-written Media Foundation interop. GUIDs, vtable orders and constants were checked against the
    /// Windows SDK 10.0.26100 headers (mfapi.h, mfobjects.h, mftransform.h, codecapi.h, strmif.h, mferror.h).
    /// Unused vtable slots are placeholders and must never be called. Derived interfaces (IMFMediaType, IMFSample,
    /// IMFActivate, IMFMediaEvent) reach their IMFAttributes methods by casting, which queries IID_IMFAttributes.
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal static class Mf
    {
        public static readonly Guid SoftwareEncoderClsid = new("6ca50344-051a-4ded-9779-a43305165e35"); // CLSID_CMSH264EncoderMFT
        public static readonly Guid CategoryVideoEncoder = new("f79eac7d-e545-4387-bdee-d647d7bde42a"); // MFT_CATEGORY_VIDEO_ENCODER
        public static readonly Guid TransformIid = new("bf94c121-5b05-4e6f-8000-ba598961414d");
        public static readonly Guid MajorType = new("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
        public static readonly Guid SubType = new("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
        public static readonly Guid MediaTypeVideo = new("73646976-0000-0010-8000-00aa00389b71");
        public static readonly Guid VideoFormatH264 = new("34363248-0000-0010-8000-00aa00389b71");
        public static readonly Guid VideoFormatNv12 = new("3231564e-0000-0010-8000-00aa00389b71");
        public static readonly Guid FrameSize = new("1652c33d-d6b2-4012-b834-72030849a37d");
        public static readonly Guid FrameRate = new("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
        public static readonly Guid PixelAspectRatio = new("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
        public static readonly Guid InterlaceMode = new("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
        public static readonly Guid AvgBitrate = new("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
        public static readonly Guid Mpeg2Profile = new("ad76a80b-2d5c-4e0b-b375-64e520137036");
        public static readonly Guid DefaultStride = new("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
        public static readonly Guid MpegSequenceHeader = new("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
        public static readonly Guid YuvMatrix = new("3e23d450-2c75-4d25-a00e-b91670d12327");
        public static readonly Guid NominalRange = new("c21b8ee5-b956-4071-8daf-325edf5cab11");
        public static readonly Guid VideoPrimaries = new("dbfbe4d7-0740-4ee0-8192-850ab0e21935");
        public static readonly Guid TransferFunction = new("5fb0fce9-be5c-4935-a811-ec838f8eed93");
        public static readonly Guid TransformAsync = new("f81a699a-649a-497d-8c73-29f8fed6ad7a");
        public static readonly Guid TransformAsyncUnlock = new("e5666d6b-3422-4eb6-a421-da7db1f8e207");
        public static readonly Guid FriendlyName = new("314ffbae-5b41-4c95-9c19-4e7d586face3"); // MFT_FRIENDLY_NAME_Attribute
        public static readonly Guid LowLatency = new("9c27891a-ed7a-40e1-88e8-b22727a024ee"); // MF_LOW_LATENCY
        public static readonly Guid CodecLowLatencyMode = new("9c27891a-ed7a-40e1-88e8-b22727a024ee"); // CODECAPI_AVLowLatencyMode (VT_BOOL)
        public static readonly Guid CodecRateControlMode = new("1c0608e9-370c-4710-8a58-cb6181c42423"); // VT_UI4
        public static readonly Guid CodecMeanBitRate = new("f7222374-2144-4815-b550-a37f8e12ee52"); // VT_UI4
        public static readonly Guid CodecQualityVsSpeed = new("98332df8-03cd-476b-89fa-3f9e442dec9f"); // VT_UI4
        public static readonly Guid CodecGopSize = new("95f31b26-95a4-41aa-9303-246a7fc6eef1"); // VT_UI4
        public static readonly Guid CodecBPictureCount = new("8d390aac-dc5c-4200-b57f-814d04babab2"); // VT_UI4
        public static readonly Guid CodecForceKeyFrame = new("398c1b98-8353-475a-9ef2-8f265d260345"); // VT_UI4
        public static readonly Guid CodecBufferSize = new("0db96574-b6a4-4c8b-8106-3773de0310cd"); // CODECAPI_AVEncCommonBufferSize, VT_UI4 bits
        public static readonly Guid CodecQuality = new("fcbf57a3-7ea5-4b0c-9644-69b40c39c391"); // CODECAPI_AVEncCommonQuality, VT_UI4
        public static readonly Guid CodecMaxBitRate = new("9651eae4-39b9-4ebf-85ef-d7f444ec7465"); // CODECAPI_AVEncCommonMaxBitRate, VT_UI4
        public static readonly Guid CodecMinQp = new("0ee22c6a-a37c-4568-b5f1-9d4c2b3ab886"); // CODECAPI_AVEncVideoMinQP, VT_UI4
        public static readonly Guid CodecMaxQp = new("3daf6f66-a6a7-45e0-a8e5-f2743f46a3a2"); // CODECAPI_AVEncVideoMaxQP, VT_UI4
        public static readonly Guid CodecEncodeQp = new("2cb5696b-23fb-4ce1-a0f9-ef5b90fd55ca"); // CODECAPI_AVEncVideoEncodeQP, VT_UI8
        public static readonly Guid CodecEncodeFrameTypeQp = new("aa70b610-e03f-450c-ad07-07314e639ce7"); // CODECAPI_AVEncVideoEncodeFrameTypeQP, VT_UI8
        public static readonly Guid CodecGradualIntraRefresh = new("8f347dee-cb0d-49ba-b462-db6927ee2101"); // CODECAPI_AVEncVideoGradualIntraRefresh, VT_UI4
        public static readonly Guid SampleCleanPoint = new("9cdf01d8-a0f0-43ba-b077-eaa06cbd728a");

        public const uint MfVersion = 0x0002 << 16 | 0x0070; // MF_SDK_VERSION << 16 | MF_API_VERSION
        public const uint EnumHardware = 0x4, EnumSortAndFilter = 0x40;
        public const uint MessageCommandDrain = 0x1, MessageNotifyBeginStreaming = 0x10000000, MessageNotifyEndStreaming = 0x10000001,
            MessageNotifyEndOfStream = 0x10000002, MessageNotifyStartOfStream = 0x10000003;
        public const uint OutputStreamProvidesSamples = 0x100, OutputStreamCanProvideSamples = 0x200;
        public const uint EventFlagNoWait = 1, TransformNeedInput = 601, TransformHaveOutput = 602, TransformDrainComplete = 603;
        public const int NotAccepting = unchecked((int)0xC00D36B5), NoEventsAvailable = unchecked((int)0xC00D3E80),
            TransformNeedMoreInput = unchecked((int)0xC00D6D72), TransformStreamChange = unchecked((int)0xC00D6D61);

        /// <summary>Process-wide MFStartup/MFShutdown pairing; MF itself also counts calls.</summary>
        public static class Runtime
        {
            private static readonly object Gate = new();
            private static int count;

            public static void AddRef()
            {
                lock (Gate)
                {
                    if (count == 0) Marshal.ThrowExceptionForHR(MFStartup(MfVersion, 0));
                    count++;
                }
            }

            public static void Release()
            {
                lock (Gate)
                {
                    if (count == 0) return;
                    if (--count == 0) MFShutdown();
                }
            }
        }

        public static void Check(int hr, string step)
        {
            if (hr < 0) throw new COMException(step + " failed", hr);
        }

        public static object CreateSoftwareEncoder()
        {
            var type = Type.GetTypeFromCLSID(SoftwareEncoderClsid, throwOnError: true)!;
            var instance = Activator.CreateInstance(type) ?? throw new COMException("H.264 encoder MFT unavailable.");
            if (instance is IMFTransform) return instance;
            Marshal.ReleaseComObject(instance);
            throw new InvalidCastException("The H.264 encoder does not implement IMFTransform.");
        }

        /// <summary>
        /// Hardware H.264 encoders that take NV12, in the system's preferred order. With an adapter LUID (W8g: the encoder
        /// must sit on the capture GPU of a hybrid laptop) MFTEnum2 + MFT_ENUM_ADAPTER_LUID (8-byte LUID blob) asks for that
        /// adapter's MFTs; if that yields none, the MFTEnumEx list is filtered by MFT_ENUM_HARDWARE_VENDOR_ID
        /// (<see cref="SelectForAdapter"/>). The caller releases every returned activation object.
        /// </summary>
        public static List<(object Activate, string Name)> EnumerateHardwareEncoders(long adapterLuid = 0, uint adapterVendorId = 0)
        {
            if (adapterLuid != 0)
            {
                var byLuid = EnumerateRaw(adapterLuid);
                if (byLuid.Count > 0) return byLuid;
            }
            var all = EnumerateRaw(0);
            if (adapterVendorId == 0) return all;
            var keep = SelectForAdapter(all.Select(a => ReadString((IMFAttributes)a.Activate, Gpu.MftHardwareVendorId)).ToList(), adapterVendorId);
            for (var i = 0; i < all.Count; i++) if (!keep.Contains(i)) Release(all[i].Activate);
            return keep.Select(i => all[i]).ToList();
        }

        /// <summary>
        /// Pure selection by PCI vendor ("VEN_10DE"): the candidates of the capture adapter's vendor; all of them when no
        /// candidate reports a vendor (cannot tell, e.g. single-GPU drivers); none when they report only other vendors.
        /// </summary>
        internal static List<int> SelectForAdapter(IReadOnlyList<string?> vendorIds, uint adapterVendorId)
        {
            var tag = $"VEN_{adapterVendorId:X4}";
            var matches = Enumerable.Range(0, vendorIds.Count).Where(i => vendorIds[i]?.Contains(tag, StringComparison.OrdinalIgnoreCase) == true).ToList();
            if (matches.Count > 0) return matches;
            return vendorIds.All(v => string.IsNullOrEmpty(v)) ? Enumerable.Range(0, vendorIds.Count).ToList() : [];
        }

        /// <summary>MFTEnumEx (luid 0) or MFTEnum2 restricted to one adapter.</summary>
        internal static List<(object Activate, string Name)> EnumerateRaw(long adapterLuid)
        {
            var result = new List<(object, string)>();
            var input = new RegisterTypeInfo { MajorType = MediaTypeVideo, SubType = VideoFormatNv12 };
            var output = new RegisterTypeInfo { MajorType = MediaTypeVideo, SubType = VideoFormatH264 };
            var category = CategoryVideoEncoder;
            int hr; IntPtr array; uint count;
            if (adapterLuid == 0) hr = MFTEnumEx(category, EnumHardware | EnumSortAndFilter, ref input, ref output, out array, out count);
            else
            {
                Marshal.ThrowExceptionForHR(Gpu.MFCreateAttributes(out var attributes, 1));
                try
                {
                    var luid = BitConverter.GetBytes(adapterLuid);
                    Check(attributes.SetBlob(Gpu.MftEnumAdapterLuid, luid, (uint)luid.Length), "MFT_ENUM_ADAPTER_LUID");
                    hr = Gpu.MFTEnum2(category, EnumHardware | EnumSortAndFilter, ref input, ref output, attributes, out array, out count);
                }
                finally { Release(attributes); }
            }
            if (hr < 0 || array == IntPtr.Zero) return result;
            try
            {
                for (var i = 0; i < count; i++)
                {
                    var pointer = Marshal.ReadIntPtr(array, i * IntPtr.Size);
                    var activate = Marshal.GetObjectForIUnknown(pointer);
                    Marshal.Release(pointer);
                    result.Add((activate, ReadString((IMFAttributes)activate, FriendlyName) ?? "hardware H.264 encoder"));
                }
            }
            finally { Marshal.FreeCoTaskMem(array); }
            return result;
        }

        public static object Activate(object activate)
        {
            var iid = TransformIid;
            Check(((IMFActivate)activate).ActivateObject(ref iid, out var pointer), "IMFActivate::ActivateObject");
            try { return Marshal.GetObjectForIUnknown(pointer); }
            finally { Marshal.Release(pointer); }
        }

        public static string? ReadString(IMFAttributes attributes, Guid key)
        {
            if (attributes.GetAllocatedString(key, out var text, out _) != 0 || text == IntPtr.Zero) return null;
            try { return Marshal.PtrToStringUni(text); }
            finally { Marshal.FreeCoTaskMem(text); }
        }

        public static IMFMediaType CreateMediaType()
        {
            Marshal.ThrowExceptionForHR(MFCreateMediaType(out var type));
            return type;
        }

        public static IMFSample CreateSample()
        {
            Marshal.ThrowExceptionForHR(MFCreateSample(out var sample));
            return sample;
        }

        public static IMFMediaBuffer CreateMemoryBuffer(int length)
        {
            Marshal.ThrowExceptionForHR(MFCreateMemoryBuffer((uint)length, out var buffer));
            return buffer;
        }

        public static byte[] ReadSample(IMFSample sample)
        {
            sample.ConvertToContiguousBuffer(out var buffer);
            try
            {
                buffer.Lock(out var pointer, out _, out var length);
                try
                {
                    if (length > PlatformLimits.MaximumFrameBytes) throw new InvalidOperationException("Encoded frame is too large.");
                    var data = new byte[length];
                    Marshal.Copy(pointer, data, 0, (int)length);
                    return data;
                }
                finally { buffer.Unlock(); }
            }
            finally { Release(buffer); }
        }

        public static void Release(object? value)
        {
            if (value is not null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }

        [DllImport("mfplat.dll")] private static extern int MFStartup(uint version, uint flags);
        [DllImport("mfplat.dll")] private static extern int MFShutdown();
        [DllImport("mfplat.dll")] private static extern int MFCreateMediaType(out IMFMediaType type);
        [DllImport("mfplat.dll")] private static extern int MFCreateSample(out IMFSample sample);
        [DllImport("mfplat.dll")] private static extern int MFCreateMemoryBuffer(uint maxLength, out IMFMediaBuffer buffer);
        [DllImport("mfplat.dll")]
        private static extern int MFTEnumEx(Guid category, uint flags, ref RegisterTypeInfo input, ref RegisterTypeInfo output, out IntPtr activates, out uint count);

        [StructLayout(LayoutKind.Sequential)]
        public struct RegisterTypeInfo { public Guid MajorType; public Guid SubType; }

        [StructLayout(LayoutKind.Sequential)]
        public struct OutputStreamInfo { public uint Flags; public uint Size; public uint Alignment; }

        [StructLayout(LayoutKind.Sequential)]
        public struct OutputDataBuffer { public uint StreamId; public IntPtr Sample; public uint Status; public IntPtr Events; }

        [ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFAttributes
        {
            void GetItem(); void GetItemType(); void CompareItem(); void Compare();
            [PreserveSig] int GetUINT32(in Guid key, out uint value);
            [PreserveSig] int GetUINT64(in Guid key, out ulong value);
            void GetDouble();
            [PreserveSig] int GetGUID(in Guid key, out Guid value);
            void GetStringLength(); void GetString();
            [PreserveSig] int GetAllocatedString(in Guid key, out IntPtr value, out uint length);
            [PreserveSig] int GetBlobSize(in Guid key, out uint size);
            [PreserveSig] int GetBlob(in Guid key, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, uint size, out uint actual);
            void GetAllocatedBlob(); void GetUnknown(); void SetItem(); void DeleteItem(); void DeleteAllItems();
            [PreserveSig] int SetUINT32(in Guid key, uint value);
            [PreserveSig] int SetUINT64(in Guid key, ulong value);
            void SetDouble();
            [PreserveSig] int SetGUID(in Guid key, in Guid value);
            void SetString();
            [PreserveSig] int SetBlob(in Guid key, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] byte[] buffer, uint size);
        }

        /// <summary>Only passed to the MFT; attribute calls go through <see cref="IMFAttributes"/>.</summary>
        [ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFMediaType { }

        [ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFSample
        {
            void A00(); void A01(); void A02(); void A03(); void A04(); void A05(); void A06(); void A07(); void A08(); void A09();
            void A10(); void A11(); void A12(); void A13(); void A14(); void A15(); void A16(); void A17(); void A18(); void A19();
            void A20(); void A21(); void A22(); void A23(); void A24(); void A25(); void A26(); void A27(); void A28(); void A29();
            void GetSampleFlags(); void SetSampleFlags();
            [PreserveSig] int GetSampleTime(out long time);
            void SetSampleTime(long time);
            void GetSampleDuration();
            void SetSampleDuration(long duration);
            void GetBufferCount(); void GetBufferByIndex();
            void ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
            void AddBuffer(IMFMediaBuffer buffer);
        }

        [ComImport, Guid("045fa593-8799-42b8-bc8d-8968c6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFMediaBuffer
        {
            void Lock(out IntPtr buffer, out uint maxLength, out uint currentLength);
            void Unlock();
            void GetCurrentLength(out uint length);
            void SetCurrentLength(uint length);
        }

        [ComImport, Guid("7fee9e9a-4a89-47a6-899c-b6a53a70fb67"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFActivate
        {
            void A00(); void A01(); void A02(); void A03(); void A04(); void A05(); void A06(); void A07(); void A08(); void A09();
            void A10(); void A11(); void A12(); void A13(); void A14(); void A15(); void A16(); void A17(); void A18(); void A19();
            void A20(); void A21(); void A22(); void A23(); void A24(); void A25(); void A26(); void A27(); void A28(); void A29();
            [PreserveSig] int ActivateObject(ref Guid iid, out IntPtr instance);
            [PreserveSig] int ShutdownObject();
        }

        [ComImport, Guid("df598932-f10c-4e39-bba2-c308f101daa3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFMediaEvent
        {
            void A00(); void A01(); void A02(); void A03(); void A04(); void A05(); void A06(); void A07(); void A08(); void A09();
            void A10(); void A11(); void A12(); void A13(); void A14(); void A15(); void A16(); void A17(); void A18(); void A19();
            void A20(); void A21(); void A22(); void A23(); void A24(); void A25(); void A26(); void A27(); void A28(); void A29();
            void GetEventType(out uint type); // IMFMediaEvent::GetType
            void GetExtendedType(out Guid type);
            void GetStatus(out int status);
        }

        [ComImport, Guid("2cd0bd52-bcd5-4b89-b62c-eadc0c031e7d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFMediaEventGenerator
        {
            [PreserveSig] int GetEvent(uint flags, out IMFMediaEvent? mediaEvent);
        }

        [ComImport, Guid("97ec2ea4-0e42-4937-97ac-9d6d328824e1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFShutdown
        {
            [PreserveSig] int Shutdown();
        }

        [ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IMFTransform
        {
            void GetStreamLimits(); void GetStreamCount();
            [PreserveSig] int GetStreamIDs(uint inputSize, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] uint[] inputIds,
                uint outputSize, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] uint[] outputIds);
            void GetInputStreamInfo();
            void GetOutputStreamInfo(uint streamId, out OutputStreamInfo info);
            [PreserveSig] int GetAttributes(out IMFAttributes? attributes);
            void GetInputStreamAttributes(); void GetOutputStreamAttributes(); void DeleteInputStream(); void AddInputStreams();
            [PreserveSig] int GetInputAvailableType(uint streamId, uint index, out IMFMediaType? type);
            [PreserveSig] int GetOutputAvailableType(uint streamId, uint index, out IMFMediaType? type);
            [PreserveSig] int SetInputType(uint streamId, IMFMediaType? type, uint flags);
            [PreserveSig] int SetOutputType(uint streamId, IMFMediaType? type, uint flags);
            [PreserveSig] int GetInputCurrentType(uint streamId, out IMFMediaType? type);
            [PreserveSig] int GetOutputCurrentType(uint streamId, out IMFMediaType? type);
            void GetInputStatus(); void GetOutputStatus(); void SetOutputBounds(); void ProcessEvent();
            [PreserveSig] int ProcessMessage(uint message, IntPtr parameter);
            [PreserveSig] int ProcessInput(uint streamId, IMFSample sample, uint flags);
            [PreserveSig] int ProcessOutput(uint flags, uint count, ref OutputDataBuffer buffer, out uint status);
        }

        [ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface ICodecAPI
        {
            [PreserveSig] int IsSupported(ref Guid api);
            [PreserveSig] int IsModifiable(ref Guid api);
            [PreserveSig] int GetParameterRange(ref Guid api, [MarshalAs(UnmanagedType.Struct)] out object min,
                [MarshalAs(UnmanagedType.Struct)] out object max, [MarshalAs(UnmanagedType.Struct)] out object step);
            /// <summary>Returns a CoTaskMem array of VARIANTs; the caller clears each and frees the array.</summary>
            [PreserveSig] int GetParameterValues(ref Guid api, out IntPtr values, out uint count);
            [PreserveSig] int GetDefaultValue(ref Guid api, [MarshalAs(UnmanagedType.Struct)] out object value);
            [PreserveSig] int GetValue(ref Guid api, [MarshalAs(UnmanagedType.Struct)] out object value);
            [PreserveSig] int SetValue(ref Guid api, [In, MarshalAs(UnmanagedType.Struct)] ref object value);
        }
    }
}
