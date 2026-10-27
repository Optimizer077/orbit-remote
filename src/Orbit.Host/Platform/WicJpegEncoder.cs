using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using ComStream = System.Runtime.InteropServices.ComTypes.IStream;

namespace Orbit.Host.Platform;

/// <summary>
/// Lossy frame encoder backed by the Windows Imaging Component JPEG codec that
/// ships with the OS (decision D10: built-in encoders only, no packages).
/// Input is the same top-down BGRA buffer that <see cref="PngEncoder"/> takes.
/// Every call creates and releases its own COM objects, so it is thread-safe.
/// </summary>
internal static class WicJpegEncoder
{
    public const int MinimumQuality = 40;
    public const int MaximumQuality = 90;
    private const int StripRows = 64;

    private static readonly Lazy<bool> Supported = new(() => OperatingSystem.IsWindows() && CanCreateFactory());

    /// <summary>True only on Windows when the WIC imaging factory can be created. Safe to query on any OS.</summary>
    public static bool IsSupported => OperatingSystem.IsWindows() && Supported.Value;

    public static int ClampQuality(int quality) => Math.Clamp(quality, MinimumQuality, MaximumQuality);

    /// <summary>Encodes top-down BGRA pixels as a baseline JFIF image. The undefined GDI alpha byte is ignored.</summary>
    [SupportedOSPlatform("windows")]
    public static byte[] EncodeBgra(byte[] pixels, int width, int height, int quality, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pixels);
        PlatformLimits.CheckDimensions(width, height);
        if (pixels.Length != checked(width * height * 4)) throw new ArgumentException("Invalid pixel buffer.", nameof(pixels));
        cancellationToken.ThrowIfCancellationRequested();
        var imageQuality = ClampQuality(quality) / 100f;

        Wic.IWICImagingFactory? factory = null; ComStream? stream = null; Wic.IWICBitmapEncoder? encoder = null;
        Wic.IWICBitmapFrameEncode? frame = null; Wic.IPropertyBag2? options = null;
        var name = IntPtr.Zero; var pin = default(GCHandle);
        try
        {
            factory = Wic.CreateFactory();
            stream = Wic.CreateStream();
            var container = Wic.ContainerFormatJpeg;
            factory.CreateEncoder(ref container, IntPtr.Zero, out encoder);
            encoder.Initialize(stream, Wic.EncoderNoCache);
            encoder.CreateNewFrame(out frame, out options);
            name = Marshal.StringToCoTaskMemUni("ImageQuality");
            var property = new Wic.PropBag2 { Type = Wic.PropBag2TypeData, Vt = Wic.VtR4, Name = name };
            object value = imageQuality;
            options.Write(1, ref property, ref value);
            frame.Initialize(options);
            frame.SetSize((uint)width, (uint)height);
            var format = Wic.PixelFormat32bppBgr;
            frame.SetPixelFormat(ref format);
            if (format == Wic.PixelFormat32bppBgr)
            {
                // The codec reads BGRX directly; X (GDI's undefined alpha) is ignored.
                pin = GCHandle.Alloc(pixels, GCHandleType.Pinned);
                var start = pin.AddrOfPinnedObject();
                var stride = width * 4;
                for (var y = 0; y < height; y += StripRows)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var rows = Math.Min(StripRows, height - y);
                    frame.WritePixels((uint)rows, (uint)stride, (uint)(rows * stride), start + y * stride);
                }
            }
            else if (format == Wic.PixelFormat24bppBgr)
            {
                var stride = checked(width * 3);
                var strip = new byte[checked(stride * Math.Min(StripRows, height))];
                pin = GCHandle.Alloc(strip, GCHandleType.Pinned);
                for (var y = 0; y < height; y += StripRows)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var rows = Math.Min(StripRows, height - y);
                    for (int source = y * width * 4, end = (y + rows) * width * 4, target = 0; source < end; source += 4, target += 3)
                    {
                        strip[target] = pixels[source]; strip[target + 1] = pixels[source + 1]; strip[target + 2] = pixels[source + 2];
                    }
                    frame.WritePixels((uint)rows, (uint)stride, (uint)(rows * stride), pin.AddrOfPinnedObject());
                }
            }
            else throw new PlatformUnavailableException("encode-failed", "The Windows JPEG encoder rejected every supported pixel format.");
            cancellationToken.ThrowIfCancellationRequested();
            frame.Commit();
            encoder.Commit();
            return Wic.ReadAll(stream);
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException)
        {
            throw new PlatformUnavailableException("encode-failed", "The Windows JPEG encoder failed: 0x" + ex.HResult.ToString("X8"));
        }
        finally
        {
            if (pin.IsAllocated) pin.Free();
            if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
            Wic.Release(options); Wic.Release(frame); Wic.Release(encoder); Wic.Release(stream); Wic.Release(factory);
        }
    }

    [SupportedOSPlatform("windows")]
    private static bool CanCreateFactory()
    {
        Wic.IWICImagingFactory? factory = null;
        try { factory = Wic.CreateFactory(); return true; }
        catch (Exception ex) when (ex is COMException or InvalidCastException or TypeLoadException or NotSupportedException or PlatformNotSupportedException) { return false; }
        finally { Wic.Release(factory); }
    }

    /// <summary>Minimal hand-written WIC interop. Unused vtable slots are placeholders and must never be called.</summary>
    [SupportedOSPlatform("windows")]
    internal static class Wic
    {
        public static readonly Guid FactoryClsid = new("317d06e8-5f24-433d-bdf7-79ce68d8abc2"); // CLSID_WICImagingFactory2 (free-threaded)
        public static readonly Guid ContainerFormatJpeg = new("19e4a5aa-5662-4fc5-a0c0-1758028e1057");
        public static readonly Guid PixelFormat24bppBgr = new("6fddc324-4e03-4bfe-b185-3d77768dc90c");
        public static readonly Guid PixelFormat32bppBgr = new("6fddc324-4e03-4bfe-b185-3d77768dc90e");
        public const int EncoderNoCache = 2;
        public const uint PropBag2TypeData = 1;
        public const ushort VtR4 = 4;

        public static IWICImagingFactory CreateFactory()
        {
            var type = Type.GetTypeFromCLSID(FactoryClsid, throwOnError: true)!;
            var instance = Activator.CreateInstance(type) ?? throw new COMException("WIC factory unavailable.");
            try { return (IWICImagingFactory)instance; }
            catch (InvalidCastException) { Marshal.ReleaseComObject(instance); throw; }
        }

        public static ComStream CreateStream()
        {
            Marshal.ThrowExceptionForHR(CreateStreamOnHGlobal(IntPtr.Zero, true, out var stream));
            return stream;
        }

        public static byte[] ReadAll(ComStream stream)
        {
            stream.Stat(out var stat, 1); // STATFLAG_NONAME
            if (stat.cbSize is <= 0 or > PlatformLimits.MaximumFrameBytes)
                throw new PlatformUnavailableException("encode-failed", "The Windows JPEG encoder produced an invalid image size.");
            var data = new byte[(int)stat.cbSize];
            var read = Marshal.AllocHGlobal(sizeof(int));
            try
            {
                stream.Seek(0, 0, IntPtr.Zero); // STREAM_SEEK_SET
                stream.Read(data, data.Length, read);
                if (Marshal.ReadInt32(read) != data.Length)
                    throw new PlatformUnavailableException("encode-failed", "The Windows JPEG encoder output could not be read.");
            }
            finally { Marshal.FreeHGlobal(read); }
            return data;
        }

        public static void Release(object? value)
        {
            if (value is not null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
        }

        [DllImport("ole32.dll")]
        private static extern int CreateStreamOnHGlobal(IntPtr global, [MarshalAs(UnmanagedType.Bool)] bool deleteOnRelease, out ComStream stream);

        [StructLayout(LayoutKind.Sequential)]
        public struct PropBag2
        {
            public uint Type; public ushort Vt; public ushort ClipboardFormat; public uint Hint; public IntPtr Name; public Guid Clsid;
        }

        [ComImport, Guid("ec5ec8a9-c395-4314-9c77-54d7a935ff70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IWICImagingFactory
        {
            void CreateDecoderFromFilename();
            void CreateDecoderFromStream(ComStream stream, IntPtr vendor, int metadataOptions, [MarshalAs(UnmanagedType.Interface)] out object decoder);
            void CreateDecoderFromFileHandle();
            void CreateComponentInfo();
            void CreateDecoder();
            void CreateEncoder([In] ref Guid containerFormat, IntPtr vendor, out IWICBitmapEncoder encoder);
        }

        [ComImport, Guid("00000103-a8f2-4877-ba0a-fd2b6645fb94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IWICBitmapEncoder
        {
            void Initialize(ComStream stream, int cacheOption);
            void GetContainerFormat();
            void GetEncoderInfo();
            void SetColorContexts();
            void SetPalette();
            void SetThumbnail();
            void SetPreview();
            void CreateNewFrame(out IWICBitmapFrameEncode frame, out IPropertyBag2 options);
            void Commit();
        }

        [ComImport, Guid("00000105-a8f2-4877-ba0a-fd2b6645fb94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IWICBitmapFrameEncode
        {
            void Initialize(IPropertyBag2 options);
            void SetSize(uint width, uint height);
            void SetResolution(double dpiX, double dpiY);
            void SetPixelFormat(ref Guid pixelFormat);
            void SetColorContexts();
            void SetPalette();
            void SetThumbnail();
            void WritePixels(uint lineCount, uint stride, uint bufferSize, IntPtr pixels);
            void WriteSource();
            void Commit();
        }

        [ComImport, Guid("22f55882-280b-11d0-a8a9-00a0c90c2004"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        public interface IPropertyBag2
        {
            void Read();
            void Write(uint count, [In] ref PropBag2 property, [In, MarshalAs(UnmanagedType.Struct)] ref object value);
        }
    }
}
