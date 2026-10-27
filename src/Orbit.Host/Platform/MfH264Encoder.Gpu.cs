using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Orbit.Host.Platform;

/// <summary>
/// W8g: D3D11 texture input for the hardware MFT. The encoder shares the capture device through an
/// IMFDXGIDeviceManager (MFT_MESSAGE_SET_D3D_MANAGER after MF_TRANSFORM_ASYNC_UNLOCK, before the media types), and each
/// frame is a texture wrapped by MFCreateDXGISurfaceBuffer, so pixels never leave the GPU. Input is NV12 (from the
/// D3D11 video processor) or ARGB32 when the MFT converts RGB itself. The public BGRA <see cref="Encode"/> path is unchanged.
/// </summary>
internal sealed partial class MfH264Encoder
{
    private IntPtr d3dManager; // IMFDXGIDeviceManager*, AddRef'd here so the encoder outlives a capture recovery safely
    private Guid inputSubtype = new("3231564e-0000-0010-8000-00aa00389b71"); // MFVideoFormat_NV12 (Mf.VideoFormatNv12)

    /// <summary>True when frames are D3D11 textures (<see cref="EncodeTexture"/>) rather than BGRA memory.</summary>
    internal bool UsesTextures => d3dManager != IntPtr.Zero;

    /// <summary>
    /// Creates a hardware encoder that takes textures from the device behind <paramref name="deviceManager"/>.
    /// <paramref name="rgbInput"/> asks for ARGB32 input (the MFT converts to YUV); otherwise NV12. Null with a reason
    /// when no hardware MFT on the capture adapter (<paramref name="adapterLuid"/>, else <paramref name="adapterVendorId"/>)
    /// accepts that: an MFT on another GPU of a hybrid laptop cannot read this device's textures.
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal static MfH264Encoder? CreateForTextures(int width, int height, int fps, int bitrateBps, IntPtr deviceManager, bool rgbInput,
        long adapterLuid, uint adapterVendorId, out string reason, H264EncoderOptions? options = null)
    {
        if (deviceManager == IntPtr.Zero || (width | height) % 2 != 0) { reason = "A device manager and even dimensions are required."; return null; }
        return CreateCore(width, height, fps, bitrateBps, out reason, H264EncoderPath.Hardware, options, encoder =>
        {
            Marshal.AddRef(deviceManager);
            encoder.d3dManager = deviceManager;
            encoder.inputSubtype = rgbInput ? Gpu.VideoFormatArgb32 : Mf.VideoFormatNv12;
            encoder.PipeliningAllowed = false; // the caller's texture may be rewritten after EncodeTexture returns; it opts in
        }, adapterLuid, adapterVendorId);
    }

    [SupportedOSPlatform("windows")]
    private void ConfigureD3D(Mf.IMFTransform t, Mf.IMFAttributes attributes)
    {
        if (attributes.GetUINT32(Gpu.MfD3D11Aware, out var aware) != 0 || aware == 0) throw new InvalidOperationException("The hardware MFT is not D3D11-aware.");
        Mf.Check(t.ProcessMessage(Gpu.MessageSetD3DManager, d3dManager), "MFT_MESSAGE_SET_D3D_MANAGER");
        log.Add("MFT_MESSAGE_SET_D3D_MANAGER: ok (input " + (inputSubtype == Mf.VideoFormatNv12 ? "NV12" : "ARGB32") + " textures)");
    }

    /// <summary>
    /// Encodes one D3D11 texture (ID3D11Texture2D*, NV12 or BGRA to match the input type, EncodedWidth x EncodedHeight,
    /// created on the shared device). The texture must not be rewritten until this returns; low-latency mode returns
    /// the access unit before that, so a small rotating pool is enough. With <see cref="PipeliningAllowed"/> one more
    /// picture may still be in flight, so the pool needs a texture beyond that one.
    /// </summary>
    [SupportedOSPlatform("windows")]
    internal H264EncodedFrame EncodeTexture(IntPtr texture, long timestamp100ns, bool forceKeyframe)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (!UsesTextures) throw new InvalidOperationException("This encoder takes BGRA memory; use Encode.");
            var started = Stopwatch.GetTimestamp();
            Mf.IMFSample sample;
            try
            {
                var iid = Gpu.Texture2DIid;
                Marshal.ThrowExceptionForHR(Gpu.MFCreateDXGISurfaceBuffer(ref iid, texture, 0, false, out var buffer));
                try
                {
                    // MF leaves a DXGI buffer's current length at 0; encoders expect the contiguous image size.
                    if (buffer is Gpu.IMF2DBuffer twoD && twoD.GetContiguousLength(out var length) >= 0) buffer.SetCurrentLength(length);
                    sample = Mf.CreateSample();
                    sample.AddBuffer(buffer);
                }
                finally { Mf.Release(buffer); }
                sample.SetSampleTime(timestamp100ns);
                sample.SetSampleDuration(10_000_000L / FramesPerSecond);
            }
            catch (COMException ex) { throw new PlatformUnavailableException("encode-failed", "Cannot wrap the GPU frame: 0x" + ex.HResult.ToString("X8")); }
            return Submit(sample, pooled: false, timestamp100ns, forceKeyframe, started, convertMs: 0);
        }
    }

    /// <summary>Input subtypes this open MFT offers (encoders list them only once the output type is set). Diagnostics.</summary>
    [SupportedOSPlatform("windows")]
    internal IReadOnlyList<Guid> OfferedInputSubtypes()
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            var t = (Mf.IMFTransform)transform!;
            var result = new List<Guid>();
            for (uint i = 0; i < 64 && t.GetInputAvailableType(inputStream, i, out var type) == 0 && type is not null; i++)
            {
                if (((Mf.IMFAttributes)type).GetGUID(Mf.SubType, out var subtype) == 0) result.Add(subtype);
                Mf.Release(type);
            }
            return result.Distinct().ToList();
        }
    }
}
