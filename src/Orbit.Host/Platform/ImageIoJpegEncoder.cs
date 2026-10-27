using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

// OS ImageIO encoder only. Capture, format negotiation and capability flags
// remain separate: an encoded-only capture backend must not advertise JPEG yet.
internal static class ImageIoJpegEncoder
{
    public const int MinimumQuality = 40;
    public const int MaximumQuality = 90;
    private static readonly Lazy<bool> Supported = new(() => OperatingSystem.IsMacOS() && CanCreateDestination());

    public static bool IsSupported => OperatingSystem.IsMacOS() && Supported.Value;
    public static int ClampQuality(int quality) => Math.Clamp(quality, MinimumQuality, MaximumQuality);

    // Same top-down BGRA bytes as PngEncoder; the undefined alpha byte is ignored.
    [SupportedOSPlatform("macos")]
    public static byte[] EncodeBgra(byte[] pixels, int width, int height, int quality, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(pixels);
        PlatformLimits.CheckDimensions(width, height);
        if (pixels.Length != checked(width * height * 4)) throw new ArgumentException("Invalid pixel buffer.", nameof(pixels));
        cancellationToken.ThrowIfCancellationRequested();
        if (!IsSupported) throw Failure();
        nint color = 0, provider = 0, image = 0, type = 0, data = 0, destination = 0, number = 0, properties = 0;
        var pin = default(GCHandle);
        try
        {
            color = Required(Native.CGColorSpaceCreateDeviceRGB());
            pin = GCHandle.Alloc(pixels, GCHandleType.Pinned);
            provider = Required(Native.CGDataProviderCreateWithData(0, pin.AddrOfPinnedObject(), (nuint)pixels.Length, 0));
            // kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst => B,G,R,X.
            image = Required(Native.CGImageCreate((nuint)width, (nuint)height, 8, 32, (nuint)(width * 4),
                color, 0x2000 | 6, provider, 0, false, 0));
            type = Required(Native.CFStringCreateWithCString(0, "public.jpeg", 0x08000100));
            data = Required(Native.CFDataCreateMutable(0, 0));
            destination = Required(Native.CGImageDestinationCreateWithData(data, type, 1, 0));
            var qualityValue = ClampQuality(quality) / 100d;
            number = Required(Native.CFNumberCreate(0, 13, ref qualityValue)); // kCFNumberDoubleType
            properties = Required(Native.CFDictionaryCreate(0, [Native.QualityKey], [number], 1,
                Native.KeyCallbacks, Native.ValueCallbacks));
            cancellationToken.ThrowIfCancellationRequested();
            Native.CGImageDestinationAddImage(destination, image, properties);
            if (!Native.CGImageDestinationFinalize(destination)) throw Failure();
            cancellationToken.ThrowIfCancellationRequested();
            var length = Native.CFDataGetLength(data);
            if (length <= 0 || length > PlatformLimits.MaximumFrameBytes) throw Failure();
            var buffer = new byte[(int)length];
            var bytes = Required(Native.CFDataGetBytePtr(data));
            Marshal.Copy(bytes, buffer, 0, buffer.Length);
            return buffer;
        }
        finally
        {
            // The provider borrows pinned pixels. Release every image/destination
            // reference before unpinning, including failure and cancellation paths.
            Release(destination); Release(properties); Release(number); Release(data); Release(type);
            Release(image); Release(provider); Release(color);
            if (pin.IsAllocated) pin.Free();
        }
    }

    [SupportedOSPlatform("macos")]
    private static bool CanCreateDestination()
    {
        nint type = 0, data = 0, destination = 0;
        try
        {
            type = Required(Native.CFStringCreateWithCString(0, "public.jpeg", 0x08000100));
            data = Required(Native.CFDataCreateMutable(0, 0));
            destination = Native.CGImageDestinationCreateWithData(data, type, 1, 0);
            return destination != 0;
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException or TypeInitializationException or PlatformUnavailableException)
        { return false; }
        finally { Release(destination); Release(data); Release(type); }
    }

    private static PlatformUnavailableException Failure() => new("encode-failed", "The macOS ImageIO JPEG encoder could not produce a bounded image.");
    private static nint Required(nint value) => value != 0 ? value : throw Failure();
    [SupportedOSPlatform("macos")]
    private static void Release(nint value) { if (value != 0) Native.CFRelease(value); }

    [SupportedOSPlatform("macos")]
    private static class Native
    {
        private const string CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
        private const string CG = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
        private const string IO = "/System/Library/Frameworks/ImageIO.framework/ImageIO";
        // Framework handles and borrowed constants remain valid for process lifetime.
        private static readonly nint CfHandle = NativeLibrary.Load(CF);
        private static readonly nint IoHandle = NativeLibrary.Load(IO);
        internal static nint QualityKey => Marshal.ReadIntPtr(NativeLibrary.GetExport(IoHandle, "kCGImageDestinationLossyCompressionQuality"));
        internal static nint KeyCallbacks => NativeLibrary.GetExport(CfHandle, "kCFTypeDictionaryKeyCallBacks");
        internal static nint ValueCallbacks => NativeLibrary.GetExport(CfHandle, "kCFTypeDictionaryValueCallBacks");
        [DllImport(CG)] internal static extern nint CGColorSpaceCreateDeviceRGB();
        [DllImport(CG)] internal static extern nint CGDataProviderCreateWithData(nint info, nint data, nuint size, nint releaseData);
        [DllImport(CG)] internal static extern nint CGImageCreate(nuint width, nuint height, nuint bitsPerComponent,
            nuint bitsPerPixel, nuint bytesPerRow, nint space, uint bitmapInfo, nint provider, nint decode,
            [MarshalAs(UnmanagedType.I1)] bool interpolate, int intent);
        [DllImport(CF)] internal static extern nint CFStringCreateWithCString(nint allocator, [MarshalAs(UnmanagedType.LPUTF8Str)] string value, uint encoding);
        [DllImport(CF)] internal static extern nint CFDataCreateMutable(nint allocator, nint capacity);
        [DllImport(CF)] internal static extern nint CFNumberCreate(nint allocator, int type, ref double value);
        [DllImport(CF)] internal static extern nint CFDictionaryCreate(nint allocator, [In] nint[] keys, [In] nint[] values,
            nint count, nint keyCallbacks, nint valueCallbacks);
        [DllImport(CF)] internal static extern nint CFDataGetLength(nint data);
        [DllImport(CF)] internal static extern nint CFDataGetBytePtr(nint data);
        [DllImport(CF)] internal static extern void CFRelease(nint value);
        [DllImport(IO)] internal static extern nint CGImageDestinationCreateWithData(nint data, nint type, nuint count, nint options);
        [DllImport(IO)] internal static extern void CGImageDestinationAddImage(nint destination, nint image, nint properties);
        [DllImport(IO)] [return: MarshalAs(UnmanagedType.I1)] internal static extern bool CGImageDestinationFinalize(nint destination);
    }
}
