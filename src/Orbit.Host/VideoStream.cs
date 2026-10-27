using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;
using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>
/// One raw top-down BGRA frame (stride = width * 4) for the D11 video stream. Width/Height/Left/Top are the physical
/// monitor geometry used for input mapping. A frame is "the same content" as another only when both carry a native
/// identity and the (<see cref="Generation"/>, <see cref="Version"/>) pair matches; versionless frames (GDI fallback)
/// are always treated as new and paced by maxFps.
/// </summary>
public sealed record VideoSourceFrame(byte[] Bgra, int Width, int Height, int Left, int Top, string MonitorId,
    DateTimeOffset CapturedUtc, string? Generation = null, long Version = 0)
{
    /// <summary>The producer object this frame came from (for example the <see cref="ScreenFrame"/>), handed back on waits.</summary>
    internal object? Origin { get; init; }
    public bool SameContent(VideoSourceFrame? other) =>
        other is not null && Generation is not null && Version > 0 && other.Generation == Generation && other.Version == Version;
}

/// <summary>Raw frame producer for <c>/stream</c>. Implementations must return immutable pixel arrays.</summary>
public interface IVideoFrameSource
{
    /// <summary>The newest frame of <paramref name="monitor"/>, or null when no raw pixels are available right now.</summary>
    Task<VideoSourceFrame?> GetLatestAsync(MonitorInfo monitor, CancellationToken cancellationToken);
    /// <summary>Completes when content newer than <paramref name="observed"/> may exist, or after the timeout.</summary>
    Task WaitForChangeAsync(VideoSourceFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken);
}

/// <summary>
/// Zero-copy GPU video (W8g): a per-stream hardware encoder fed by the platform's shared per-monitor desktop duplication
/// (one duplication per output per process; the stream never opens its own). Implemented by the platform backend and
/// discovered as <c>platform is IGpuVideoSource</c>. Used only for viewers that draw the pointer themselves
/// (<c>cursor=local</c>), because GPU frames carry no composited cursor; the CPU path remains the fallback.
/// </summary>
public interface IGpuVideoSource
{
    /// <summary>
    /// Opens an encoder producing <paramref name="width"/> x <paramref name="height"/> (even, at most native) from
    /// <paramref name="monitor"/>. Null when the GPU path is unavailable right now (the stream then uses the CPU path).
    /// </summary>
    IGpuVideoEncoder? TryOpenEncoder(MonitorInfo monitor, int width, int height, int fps, int bitrateBps);
}

/// <summary>One stream's GPU encoder. Used from the stream loop only (one call at a time).</summary>
public interface IGpuVideoEncoder : IDisposable
{
    /// <summary>
    /// Encodes the newest desktop image when it is newer than the last one this encoder encoded (a fresh encoder encodes
    /// the current image at once); otherwise waits up to <paramref name="timeoutMilliseconds"/> for one (0 = poll). Null =
    /// unchanged. Cancellation interrupts only the wait. Throws <see cref="PlatformUnavailableException"/> when the shared
    /// duplication or device is lost or the monitor changed; the stream then falls back to the CPU path.
    /// </summary>
    Task<GpuVideoUnit?> EncodeNextAsync(int timeoutMilliseconds, bool forceKeyframe, CancellationToken cancellationToken);
    /// <summary>Re-encodes the last image this encoder encoded (refresh tail, keyframe request). Null before the first image.</summary>
    GpuVideoUnit? EncodeLast(bool forceKeyframe);
    bool SetBitrate(int bitrateBps);
}

/// <summary>
/// One GPU-encoded Annex-B access unit (empty while the encoder buffers; keyframes carry SPS+PPS) with the physical
/// geometry it was captured from and its native (<see cref="Generation"/>, <see cref="Version"/>) identity.
/// </summary>
public sealed record GpuVideoUnit(byte[] AccessUnit, bool IsKeyframe, int CodedWidth, int CodedHeight,
    int PhysicalLeft, int PhysicalTop, int PhysicalWidth, int PhysicalHeight, string Generation, long Version, DateTimeOffset CapturedUtc)
{
    /// <summary>
    /// The encoder's output for this input, authoritative: 0..n single-picture access units in decode order (an MFT may
    /// hold an input and later return two pictures). Each becomes its own type-2 record. Empty with a non-empty
    /// <see cref="AccessUnit"/> only from an adapter predating Units; the stream then splits that concatenation itself.
    /// </summary>
    public IReadOnlyList<GpuVideoAccessUnit> Units { get; init; } = [];
    /// <summary>Wall time of this encode only (no waiting for the next image), in milliseconds; 0 = not measured.</summary>
    public double EncodeMilliseconds { get; init; }
}

/// <summary>
/// One picture's Annex-B access unit (keyframes carry SPS and PPS). <paramref name="Timestamp100ns"/> is the capture time on
/// the host monotonic clock in 100 ns units (Stopwatch based, the same clock as the record timestamps); 0 = unknown.
/// </summary>
public sealed record GpuVideoAccessUnit(byte[] AccessUnit, bool IsKeyframe, long Timestamp100ns);

/// <summary>Optional on a GPU encoder: drains access units it still holds. Called only at reconfiguration.</summary>
public interface IGpuVideoEncoderFlush
{
    IReadOnlyList<GpuVideoAccessUnit> Flush();
}

/// <summary>
/// Default source: an adapter over <see cref="IPlatformBackend.CaptureAsync"/> (plus the backend's change wait when it has
/// one). It holds the optional capture gate only for each single capture, never for the stream's lifetime.
/// </summary>
public sealed class PlatformVideoFrameSource(IPlatformBackend platform, SemaphoreSlim? captureGate = null) : IVideoFrameSource
{
    private readonly Func<ScreenFrame, int, CancellationToken, Task>? waitForChange = NativeFrameIdentity.ChangeWaiter(platform);

    public async Task<VideoSourceFrame?> GetLatestAsync(MonitorInfo monitor, CancellationToken cancellationToken)
    {
        ScreenFrame frame;
        if (captureGate is not null) await captureGate.WaitAsync(cancellationToken);
        try { frame = await platform.CaptureAsync(monitor.Id, cancellationToken); }
        finally { captureGate?.Release(); }
        if (frame.RawBgra is null || frame.Width <= 0 || frame.Height <= 0 || frame.RawBgra.Length != (long)frame.Width * frame.Height * 4) return null;
        var (generation, version) = NativeFrameIdentity.Read(frame);
        return new VideoSourceFrame(frame.RawBgra, frame.Width, frame.Height, frame.Left, frame.Top, frame.MonitorId ?? monitor.Id,
            frame.CapturedUtc, generation, version) { Origin = frame };
    }

    public Task WaitForChangeAsync(VideoSourceFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken) =>
        observed.Generation is not null && observed.Origin is ScreenFrame screen && waitForChange is not null
            ? waitForChange(screen, maximumWaitMilliseconds, cancellationToken)
            : Task.Delay(Math.Clamp(maximumWaitMilliseconds, 0, 100), cancellationToken);
}

/// <summary>
/// W6a bridge. <c>ScreenFrame.NativeGeneration/NativeVersion</c> and <c>IFrameChangeSource</c> exist only once W6a is
/// committed, and this file must compile both before and after. The members are bound once, by name, to typed
/// delegates (no per-frame reflection). After W6a lands, replace this class with direct member access:
/// <c>(frame.NativeGeneration, frame.NativeVersion)</c> and <c>platform is IFrameChangeSource s ? s.WaitForChangeAsync : null</c>.
/// </summary>
internal static class NativeFrameIdentity
{
    private static readonly Func<ScreenFrame, string>? GenerationOf = Getter<string>("NativeGeneration");
    private static readonly Func<ScreenFrame, long>? VersionOf = Getter<long>("NativeVersion");

    public static (string? Generation, long Version) Read(ScreenFrame frame)
    {
        var generation = GenerationOf?.Invoke(frame);
        var version = VersionOf?.Invoke(frame) ?? 0;
        return generation is { Length: > 0 and <= 128 } && version > 0 ? (generation, version) : (null, 0);
    }

    public static Func<ScreenFrame, int, CancellationToken, Task>? ChangeWaiter(IPlatformBackend platform)
    {
        var contract = platform.GetType().GetInterfaces().FirstOrDefault(i => i.FullName == "Orbit.Host.Platform.IFrameChangeSource");
        var method = contract?.GetMethod("WaitForChangeAsync", [typeof(ScreenFrame), typeof(int), typeof(CancellationToken)]);
        return method is not null && method.ReturnType == typeof(Task) ? method.CreateDelegate<Func<ScreenFrame, int, CancellationToken, Task>>(platform) : null;
    }

    private static Func<ScreenFrame, T>? Getter<T>(string name)
    {
        var property = typeof(ScreenFrame).GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        return property?.GetMethod is { } getter && property.PropertyType == typeof(T) ? getter.CreateDelegate<Func<ScreenFrame, T>>() : null;
    }
}

/// <summary>Requested or controller-adjusted stream settings, always within host bounds.</summary>
public sealed record VideoStreamSettings(int MaxFps, int BitrateBps, double Scale)
{
    public const int DefaultMaxFps = 60;
    public const int DefaultBitrateBps = 8_000_000;
    public const int MinimumBitrateBps = 100_000;
    public const int MaximumBitrateBps = 100_000_000;
    public static VideoStreamSettings Default { get; } = new(DefaultMaxFps, DefaultBitrateBps, 1);

    public static VideoStreamSettings Clamp(int maxFps, long bitrateBps, double scale) => new(
        Math.Clamp(maxFps, 1, 240), (int)Math.Clamp(bitrateBps, MinimumBitrateBps, MaximumBitrateBps),
        double.IsFinite(scale) ? Math.Clamp(scale, FrameQuality.MinimumScale, 1) : 1);

    /// <summary>Parses the optional <c>maxFps</c>, <c>bitrate</c> and <c>scale</c> query values (clamped; malformed → ArgumentException).</summary>
    public static VideoStreamSettings Parse(string? maxFps, string? bitrate, string? scale) => Clamp(
        maxFps is null ? DefaultMaxFps : (int)Math.Clamp(ParseInteger(maxFps, "maxFps"), int.MinValue, int.MaxValue),
        bitrate is null ? DefaultBitrateBps : ParseInteger(bitrate, "bitrate"),
        FrameQuality.ParseScale(scale));

    private static long ParseInteger(string value, string name) =>
        value.Length is > 0 and <= 12 && long.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var parsed)
            ? parsed : throw new ArgumentException(name + " must be one integer.");

    /// <summary>Encoded display size: round-half-away of physical × scale, at least 1, as the viewer checks it.</summary>
    public static (int Width, int Height) ScaledSize(int width, int height, double scale) =>
        scale >= 1 ? (width, height)
            : (Math.Max(1, (int)Math.Round(width * scale, MidpointRounding.AwayFromZero)), Math.Max(1, (int)Math.Round(height * scale, MidpointRounding.AwayFromZero)));
}

internal enum VideoRecordType : byte { Config = 1, AccessUnit = 2, Heartbeat = 3, Terminal = 4, Cursor = 5 }

/// <summary>Wire constants and payload builders of the D11 record framing (docs/PROTOCOL.md, "Video stream").</summary>
internal static partial class VideoStreamRecords
{
    public const int HeaderBytes = 24;
    public const int MaximumConfigBytes = 4096;
    public const int MaximumAccessUnitBytes = 8 * 1024 * 1024;
    public const int MaximumTerminalBytes = 1024;
    public const int MaximumCursorBytes = 64 * 1024;
    /// <summary>Batch fence for one encode's output: at most 64 access units, each within the AU limit, 16 MiB together.</summary>
    public const int MaximumBatchUnits = 64;
    public const long MaximumBatchBytes = 16L * 1024 * 1024;
    public const int MaximumErrorCharacters = 500;
    public const int MaximumPixels = 33_554_432;
    public static readonly string[] TerminalCodes = ["session_ended", "session_ended_by_host", "access_revoked", "permission_changed",
        "identity_rotated", "host_stopping", "stream_replaced", "stream_restart", "stream_error", "display_asleep"];

    [GeneratedRegex("^avc1\\.[0-9A-F]{6}$", RegexOptions.CultureInvariant)]
    public static partial Regex CodecPattern();

    public static int MaximumLength(VideoRecordType type) => type switch
    {
        VideoRecordType.Config => MaximumConfigBytes, VideoRecordType.AccessUnit => MaximumAccessUnitBytes,
        VideoRecordType.Heartbeat => 0, VideoRecordType.Terminal => MaximumTerminalBytes, VideoRecordType.Cursor => MaximumCursorBytes,
        _ => throw new ArgumentOutOfRangeException(nameof(type)),
    };

    public static void WriteHeader(Span<byte> destination, VideoRecordType type, bool keyframe, int length, uint sequence, ulong timestampMicroseconds)
    {
        if (destination.Length < HeaderBytes) throw new ArgumentException("Header buffer too small.", nameof(destination));
        if (keyframe && type != VideoRecordType.AccessUnit) throw new ArgumentException("Only access units carry the keyframe flag.", nameof(keyframe));
        destination[..HeaderBytes].Clear();
        destination[0] = (byte)type;
        destination[1] = keyframe ? (byte)1 : (byte)0;
        BinaryPrimitives.WriteUInt32LittleEndian(destination[4..], checked((uint)length));
        BinaryPrimitives.WriteUInt32LittleEndian(destination[8..], sequence);
        BinaryPrimitives.WriteUInt64LittleEndian(destination[16..], timestampMicroseconds);
    }

    /// <summary>Config JSON with exactly the viewer's accepted fields. Throws when a bound in the contract would be violated.</summary>
    public static byte[] Config(string codec, int width, int height, int codedWidth, int codedHeight, VideoSourceFrame frame, double scale, int fps)
    {
        if (!CodecPattern().IsMatch(codec)) throw new ArgumentException("Invalid codec string.", nameof(codec));
        if (width is < 1 or > 8192 || height is < 1 or > 8192 || (long)width * height > MaximumPixels
            || codedWidth < width || codedWidth > width + 16 || codedHeight < height || codedHeight > height + 16)
            throw new ArgumentException("Encoded stream dimensions are out of bounds.");
        if (frame.Width < 1 || frame.Height < 1 || (long)frame.Width * frame.Height > MaximumPixels) throw new ArgumentException("Physical geometry is out of bounds.");
        if (!double.IsFinite(scale) || scale is < FrameQuality.MinimumScale or > 1
            || Math.Abs(width - Math.Round(frame.Width * scale, MidpointRounding.AwayFromZero)) > 1
            || Math.Abs(height - Math.Round(frame.Height * scale, MidpointRounding.AwayFromZero)) > 1) throw new ArgumentException("Scale does not match geometry.");
        if (fps is < 1 or > 240) throw new ArgumentException("Frame rate out of bounds.", nameof(fps));
        if (frame.MonitorId.Length is 0 or > 128 || frame.MonitorId.Any(char.IsControl)) throw new ArgumentException("Invalid monitor ID.");
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteString("codec", codec);
            json.WriteNumber("width", width); json.WriteNumber("height", height);
            json.WriteNumber("codedWidth", codedWidth); json.WriteNumber("codedHeight", codedHeight);
            json.WriteNumber("physicalLeft", frame.Left); json.WriteNumber("physicalTop", frame.Top);
            json.WriteNumber("physicalWidth", frame.Width); json.WriteNumber("physicalHeight", frame.Height);
            json.WriteNumber("scale", scale); json.WriteNumber("fps", fps);
            json.WriteString("monitorId", frame.MonitorId);
            json.WriteStartObject("colorSpace");
            json.WriteString("primaries", "bt709"); json.WriteString("transfer", "bt709"); json.WriteString("matrix", "bt709"); json.WriteBoolean("fullRange", false);
            json.WriteEndObject();
            json.WriteString("capturedUtc", frame.CapturedUtc.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
            json.WriteEndObject();
        }
        var bytes = buffer.ToArray();
        return bytes.Length <= MaximumConfigBytes ? bytes : throw new ArgumentException("Config exceeds 4 KiB.");
    }

    public static byte[] Terminal(string code, string error)
    {
        if (!TerminalCodes.Contains(code)) throw new ArgumentException("Unknown terminal code.", nameof(code));
        var text = error.Length > MaximumErrorCharacters ? error[..MaximumErrorCharacters] : error;
        if (text.Length == 0) text = code;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(new { code, error = text });
        // Escaped non-ASCII can exceed 1 KiB; shorten until it fits.
        while (bytes.Length > MaximumTerminalBytes) { text = text[..(text.Length * 3 / 4)]; bytes = JsonSerializer.SerializeToUtf8Bytes(new { code, error = text }); }
        return bytes;
    }

    /// <summary>RFC 6381 codec string from the first SPS in an Annex-B access unit, or null.</summary>
    public static string? CodecFromAccessUnit(ReadOnlySpan<byte> accessUnit)
    {
        foreach (var nal in MfH264Encoder.EnumerateNalUnits(accessUnit))
            if (nal.Type == 7 && nal.Length >= 4) return MfH264Encoder.CodecStringFromSps(accessUnit.Slice(nal.Offset, nal.Length));
        return null;
    }

    /// <summary>
    /// Splits encoder output into single-picture access units in decode order (each one record): some MFTs (Qualcomm)
    /// hold the first input and then return two pictures in one sample. A new picture starts at an access unit delimiter,
    /// at SEI/SPS/PPS after the current picture's slices, or at a slice whose first_mb_in_slice is 0 (H.264 7.4.1.2.3).
    /// Leading non-VCL NAL units belong to the picture that follows them; trailing ones to the last picture.
    /// </summary>
    public static List<(byte[] Data, bool Keyframe)> SplitAccessUnits(byte[] data)
    {
        var result = new List<(byte[] Data, bool Keyframe)>();
        var nals = MfH264Encoder.EnumerateNalUnits(data);
        int start = 0; bool hasSlice = false, keyframe = false;
        foreach (var nal in nals)
        {
            var slice = nal.Type is 1 or 5;
            var firstSlice = slice && (nal.Length < 2 || (data[nal.Offset + 1] & 0x80) != 0); // first_mb_in_slice ue(v) == 0 is the single bit 1
            if (hasSlice && (nal.Type is 9 or 6 or 7 or 8 || firstSlice))
            {
                result.Add((data[start..nal.StartCodeOffset], keyframe));
                start = nal.StartCodeOffset; hasSlice = false; keyframe = false;
            }
            if (slice) { hasSlice = true; keyframe |= nal.Type == 5; }
        }
        result.Add((start == 0 ? data : data[start..], keyframe));
        return result;
    }

    public static bool IsAnnexB(ReadOnlySpan<byte> data) =>
        data.Length >= 4 && data[0] == 0 && data[1] == 0 && (data[2] == 1 || data.Length >= 5 && data[2] == 0 && data[3] == 1);

    /// <summary>Host monotonic clock in microseconds (Stopwatch based, overflow-safe).</summary>
    public static long MonotonicMicroseconds()
    {
        var ticks = Stopwatch.GetTimestamp(); var frequency = Stopwatch.Frequency;
        return ticks / frequency * 1_000_000 + ticks % frequency * 1_000_000 / frequency;
    }
}

/// <summary>
/// Serializes records onto one output stream: sequence from 0, +1 per record, never wrapping; non-decreasing timestamps;
/// nothing after a terminal. A failed or cancelled write marks the stream broken, so no further record can follow a
/// possibly partial one. The viewer rejects any record before the first config, so a terminal is only sent after one;
/// before that the caller aborts instead (the viewer reconnects and gets the HTTP status).
/// </summary>
internal sealed class VideoRecordWriter(Stream output, Func<long> clockMicroseconds, uint firstSequence = 0)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly byte[] header = new byte[VideoStreamRecords.HeaderBytes];
    private uint next = firstSequence;
    private ulong lastTimestamp;
    private volatile bool terminated, broken, configured;
    private int configCount;

    public bool IsTerminated => terminated;
    public bool IsBroken => broken;
    public bool HasConfig => configured;
    /// <summary>Config records written so far (each one clears the viewer's pointer-shape cache).</summary>
    public int ConfigCount => Volatile.Read(ref configCount);

    /// <summary>
    /// Builds the payload inside the writer's lock from the current config count, so a record that depends on what the
    /// viewer knows since the last config (pointer shapes) can never race a config record. Null from the builder = skip.
    /// </summary>
    public async Task<uint?> WriteComposedAsync(VideoRecordType type, Func<int, byte[]?> build, CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (terminated || broken) throw new OperationCanceledException("The stream has ended.");
            var payload = build(configCount);
            return payload is null ? null : await WriteLockedAsync(type, false, payload, cancellationToken);
        }
        finally { gate.Release(); }
    }
    public uint NextSequence => next;

    /// <summary>
    /// Writes one record and returns its sequence, or null when only a terminal may follow (sequence space exhausted).
    /// The optional callback runs under the writer lock before any byte leaves, so receipt accounting is ready even
    /// when the peer acknowledges before FlushAsync completes. A failed callback or write breaks this writer.
    /// </summary>
    public async Task<uint?> WriteAsync(VideoRecordType type, bool keyframe, ReadOnlyMemory<byte> payload, CancellationToken cancellationToken,
        long? timestampMicroseconds = null, Action<uint>? beforeWrite = null)
    {
        await gate.WaitAsync(cancellationToken);
        try { return await WriteLockedAsync(type, keyframe, payload, cancellationToken, timestampMicroseconds, beforeWrite); }
        finally { gate.Release(); }
    }

    /// <summary>Best effort: waits at most <paramref name="timeoutMilliseconds"/> for the writer and the write itself.</summary>
    public async Task<bool> TryWriteTerminalAsync(string code, string error, int timeoutMilliseconds)
    {
        var payload = VideoStreamRecords.Terminal(code, error);
        using var timeout = new CancellationTokenSource(timeoutMilliseconds);
        try { if (!await gate.WaitAsync(timeoutMilliseconds)) return false; }
        catch (ObjectDisposedException) { return false; }
        try
        {
            if (terminated || broken || !configured) return false;
            return await WriteLockedAsync(VideoRecordType.Terminal, false, payload, timeout.Token) is not null;
        }
        catch (Exception ex) when (ex is OperationCanceledException or IOException or ObjectDisposedException or InvalidOperationException) { return false; }
        finally { gate.Release(); }
    }

    private async Task<uint?> WriteLockedAsync(VideoRecordType type, bool keyframe, ReadOnlyMemory<byte> payload, CancellationToken cancellationToken,
        long? timestampMicroseconds = null, Action<uint>? beforeWrite = null)
    {
        if (terminated || broken) throw new OperationCanceledException("The stream has ended.");
        var limit = VideoStreamRecords.MaximumLength(type);
        if (payload.Length > limit || type != VideoRecordType.Heartbeat && payload.Length == 0)
            throw new ArgumentException($"Record payload length {payload.Length} is outside the {type} limit.");
        if (type != VideoRecordType.Terminal && next == uint.MaxValue) return null;
        var now = timestampMicroseconds ?? clockMicroseconds(); // An access unit carries its capture time; never decreasing.
        var timestamp = Math.Max(lastTimestamp, now < 0 ? 0UL : (ulong)now);
        VideoStreamRecords.WriteHeader(header, type, keyframe, payload.Length, next, timestamp);
        try
        {
            beforeWrite?.Invoke(next);
            await output.WriteAsync(header, cancellationToken);
            if (payload.Length > 0) await output.WriteAsync(payload, cancellationToken);
            await output.FlushAsync(cancellationToken);
        }
        catch { broken = true; throw; }
        var sequence = next;
        if (next != uint.MaxValue) next++;
        lastTimestamp = timestamp;
        if (type == VideoRecordType.Terminal) terminated = true;
        if (type == VideoRecordType.Config) { configured = true; Interlocked.Increment(ref configCount); }
        return sequence;
    }
}

/// <summary>
/// Type-5 cursor records (W7a): strict <c>{x, y, visible, shapeId, shape?}</c> JSON, at most 64 KiB. The hotspot must lie on
/// the monitor; <c>shapeId</c> is 1..128 printable characters (never empty: a hidden pointer uses <see cref="HiddenShapeId"/>);
/// a shape is 1..256 per side with the hotspot inside, canonical base64 PNGs of exactly that size, and an invert layer only
/// for mono/masked. Anything else is refused (null), so a record the viewer would reject is never written.
/// </summary>
internal static class PointerRecords
{
    public const string HiddenShapeId = "hidden-1";
    public static readonly PointerShape HiddenShape = new(1, 1, 0, 0, "color",
        Convert.ToBase64String(PngEncoder.EncodeBgraWithAlpha([0, 0, 0, 0], 1, 1, CancellationToken.None)));

    public static byte[]? Build(int x, int y, bool visible, string shapeId, PointerShape? shape, MonitorInfo monitor)
    {
        if (x < monitor.Left || x >= (long)monitor.Left + monitor.Width || y < monitor.Top || y >= (long)monitor.Top + monitor.Height) return null;
        if (shapeId.Length is 0 or > 128 || shapeId.Any(c => c < 0x20 || c > 0x7E)) return null;
        if (shape is not null && !IsValidShape(shape)) return null;
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteNumber("x", x); json.WriteNumber("y", y); json.WriteBoolean("visible", visible); json.WriteString("shapeId", shapeId);
            if (shape is not null)
            {
                json.WriteStartObject("shape");
                json.WriteNumber("width", shape.Width); json.WriteNumber("height", shape.Height);
                json.WriteNumber("hotX", shape.HotX); json.WriteNumber("hotY", shape.HotY);
                json.WriteString("kind", shape.Kind); json.WriteString("pngBase64", shape.PngBase64);
                if (shape.InvertPngBase64 is not null) json.WriteString("invertPngBase64", shape.InvertPngBase64);
                json.WriteEndObject();
            }
            json.WriteEndObject();
        }
        var bytes = buffer.ToArray();
        return bytes.Length <= VideoStreamRecords.MaximumCursorBytes ? bytes : null;
    }

    public static bool IsValidShape(PointerShape shape) =>
        shape.Width is >= 1 and <= 256 && shape.Height is >= 1 and <= 256 && shape.HotX >= 0 && shape.HotX < shape.Width && shape.HotY >= 0 && shape.HotY < shape.Height
        && shape.Kind is "color" or "masked" or "mono" && (shape.InvertPngBase64 is null || shape.Kind is "mono" or "masked")
        && IsPng(shape.PngBase64, shape.Width, shape.Height) && (shape.InvertPngBase64 is null || IsPng(shape.InvertPngBase64, shape.Width, shape.Height));

    /// <summary>Canonical base64 of a PNG whose IHDR is exactly <paramref name="width"/> x <paramref name="height"/>.</summary>
    private static bool IsPng(string base64, int width, int height)
    {
        if (base64.Length is 0 or > VideoStreamRecords.MaximumCursorBytes) return false;
        byte[] png;
        try { png = Convert.FromBase64String(base64); } catch (FormatException) { return false; }
        if (Convert.ToBase64String(png) != base64 || png.Length < 24) return false;
        ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
        return png.AsSpan(0, 8).SequenceEqual(signature) && png.AsSpan(12, 4).SequenceEqual("IHDR"u8)
            && BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)) == width && BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20)) == height;
    }
}

/// <summary>One parsed <c>stream/control</c> body.</summary>
internal sealed record VideoControlRequest(bool Keyframe = false, uint? Ack = null, double? DecodeMs = null,
    int? BitrateBps = null, int? MaxFps = null, double? Scale = null)
{
    public const int MaximumBodyBytes = 1024;

    /// <summary>Strict parse: one JSON object of known fields, no duplicates; settings are clamped by the host.</summary>
    public static VideoControlRequest Parse(ReadOnlySpan<byte> body)
    {
        if (body.Length is 0 or > MaximumBodyBytes) throw new ArgumentException("Control body must be one JSON object of at most 1 KiB.");
        JsonDocument document;
        try { document = JsonDocument.Parse(body.ToArray(), new JsonDocumentOptions { MaxDepth = 2 }); }
        catch (JsonException) { throw new ArgumentException("Control body is not valid JSON."); }
        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new ArgumentException("Control body must be a JSON object.");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var request = new VideoControlRequest();
            foreach (var property in root.EnumerateObject())
            {
                if (!seen.Add(property.Name)) throw new ArgumentException("Duplicate control field.");
                var value = property.Value;
                request = property.Name switch
                {
                    "keyframe" => value.ValueKind is JsonValueKind.True or JsonValueKind.False ? request with { Keyframe = value.GetBoolean() } : throw Invalid("keyframe"),
                    "ack" => value.ValueKind == JsonValueKind.Number && value.TryGetUInt32(out var ack) ? request with { Ack = ack } : throw Invalid("ack"),
                    "decodeMs" => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var ms) && double.IsFinite(ms) && ms >= 0 ? request with { DecodeMs = Math.Min(ms, 60_000) } : throw Invalid("decodeMs"),
                    "bitrateBps" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var bps) ? request with { BitrateBps = (int)Math.Clamp(bps, VideoStreamSettings.MinimumBitrateBps, VideoStreamSettings.MaximumBitrateBps) } : throw Invalid("bitrateBps"),
                    "maxFps" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var fps) ? request with { MaxFps = (int)Math.Clamp(fps, 1, 240) } : throw Invalid("maxFps"),
                    "scale" => value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var scale) && double.IsFinite(scale) ? request with { Scale = Math.Clamp(scale, FrameQuality.MinimumScale, 1) } : throw Invalid("scale"),
                    _ => throw new ArgumentException("Supported control fields are keyframe, ack, decodeMs, bitrateBps, maxFps and scale."),
                };
            }
            if (request.DecodeMs is not null && request.Ack is null) throw new ArgumentException("decodeMs is only valid with ack.");
            return request;
        }
        static ArgumentException Invalid(string field) => new($"Invalid {field} value.");
    }
}

/// <summary>Bounded registry: one stream per (session, monitor), a newer one replaces the older; at most N in total.</summary>
internal sealed class VideoStreamSlots<T>(int capacity = 8) where T : class
{
    private readonly object gate = new();
    private readonly Dictionary<(string Session, string Monitor), T> active = [];
    public int Count { get { lock (gate) return active.Count; } }

    /// <summary>False when the host is at capacity. A replacement never counts against the cap.</summary>
    public bool TryAdd(string sessionId, string monitorId, T stream, out T? replaced)
    {
        lock (gate)
        {
            if (active.TryGetValue((sessionId, monitorId), out replaced)) { active[(sessionId, monitorId)] = stream; return true; }
            if (active.Count >= capacity) return false;
            active.Add((sessionId, monitorId), stream); return true;
        }
    }

    public void Remove(string sessionId, string monitorId, T stream)
    {
        lock (gate) if (active.TryGetValue((sessionId, monitorId), out var current) && ReferenceEquals(current, stream)) active.Remove((sessionId, monitorId));
    }

    /// <summary>The stream for a monitor, or the session's only stream when <paramref name="monitorId"/> is null.</summary>
    public T? Find(string sessionId, string? monitorId, out bool ambiguous)
    {
        lock (gate)
        {
            ambiguous = false;
            if (monitorId is not null) return active.GetValueOrDefault((sessionId, monitorId));
            var matches = active.Where(pair => pair.Key.Session == sessionId).Select(pair => pair.Value).Take(2).ToArray();
            ambiguous = matches.Length > 1;
            return matches.Length == 1 ? matches[0] : null;
        }
    }
}

/// <summary>Exact sliding window: at most <paramref name="permits"/> acquisitions per <paramref name="windowMicroseconds"/>.</summary>
internal sealed class SlidingWindowLimiter(int permits, long windowMicroseconds, Func<long> clockMicroseconds)
{
    private readonly Queue<long> recent = new();
    public bool TryAcquire()
    {
        lock (recent)
        {
            var now = clockMicroseconds();
            while (recent.Count > 0 && now - recent.Peek() >= windowMicroseconds) recent.Dequeue();
            if (recent.Count >= permits) return false;
            recent.Enqueue(now); return true;
        }
    }
}

/// <summary>
/// Bounded box-filter downscale of top-down BGRA, in parallel row bands. Alpha is written as 255. An exact 2:1 reduction
/// (scale 0.5, the adaptive controller's usual step) takes a packed-integer path that averages each 2x2 block with
/// rounding in two 32-bit operations per pixel instead of per-channel 64-bit sums and divisions.
/// </summary>
internal static class VideoFrameScaler
{
    private static int Bands => Math.Clamp(Environment.ProcessorCount / 4, 1, 4);

    public static byte[] Resize(byte[] pixels, int sourceWidth, int sourceHeight, int width, int height)
    {
        if (pixels.Length != checked(sourceWidth * sourceHeight * 4)) throw new ArgumentException("Invalid pixel buffer.", nameof(pixels));
        var output = new byte[checked(width * height * 4)];
        if (BitConverter.IsLittleEndian && sourceWidth == width * 2 && sourceHeight == height * 2) { Halve(pixels, sourceWidth, output, width, height); return output; }
        var lefts = new int[width + 1];
        for (var x = 0; x <= width; x++) lefts[x] = (int)((long)x * sourceWidth / width);
        Parallel.For(0, height, new ParallelOptions { MaxDegreeOfParallelism = Bands }, y =>
        {
            var top = (int)((long)y * sourceHeight / height);
            var bottom = Math.Max(top + 1, (int)((long)(y + 1) * sourceHeight / height));
            for (var x = 0; x < width; x++)
            {
                var left = lefts[x]; var right = Math.Max(left + 1, lefts[x + 1]);
                long b = 0, g = 0, r = 0;
                for (var sy = top; sy < bottom; sy++)
                    for (int sx = left, source = (sy * sourceWidth + left) * 4; sx < right; sx++, source += 4)
                    { b += pixels[source]; g += pixels[source + 1]; r += pixels[source + 2]; }
                var count = (long)(bottom - top) * (right - left); var target = (y * width + x) * 4;
                output[target] = (byte)(b / count); output[target + 1] = (byte)(g / count); output[target + 2] = (byte)(r / count); output[target + 3] = 255;
            }
        });
        return output;
    }

    /// <summary>2x2 block average of little-endian BGRA words: B+R and G+A lanes summed in 16-bit fields (max 4 x 255 + 2).</summary>
    private static void Halve(byte[] pixels, int sourceWidth, byte[] output, int width, int height)
    {
        var bands = Math.Min(Bands, height);
        Parallel.For(0, bands, band =>
        {
            var source = MemoryMarshal.Cast<byte, uint>(pixels.AsSpan());
            var target = MemoryMarshal.Cast<byte, uint>(output.AsSpan());
            for (int y = (int)((long)height * band / bands), end = (int)((long)height * (band + 1) / bands); y < end; y++)
            {
                var row0 = source.Slice(2 * y * sourceWidth, sourceWidth);
                var row1 = source.Slice((2 * y + 1) * sourceWidth, sourceWidth);
                var row = target.Slice(y * width, width);
                for (var x = 0; x < row.Length; x++)
                {
                    uint a = row0[2 * x], b = row0[2 * x + 1], c = row1[2 * x], d = row1[2 * x + 1];
                    var blueRed = (a & 0x00FF00FFu) + (b & 0x00FF00FFu) + (c & 0x00FF00FFu) + (d & 0x00FF00FFu) + 0x00020002u;
                    var green = ((a >> 8) & 0xFFu) + ((b >> 8) & 0xFFu) + ((c >> 8) & 0xFFu) + ((d >> 8) & 0xFFu) + 2u;
                    row[x] = 0xFF000000u | ((blueRed >> 2) & 0x00FF00FFu) | ((green >> 2) << 8);
                }
            }
        });
    }
}

/// <summary>
/// Frame-pacing wait. On Windows, <see cref="Task.Delay(TimeSpan, CancellationToken)"/> is bound to the ~15.6 ms system timer
/// tick, so a 12 ms pace often costs 15.6–31 ms and caps a 60 fps stream near 45 fps. A high-resolution waitable timer
/// (Windows 10 1803+) completes within about a millisecond without changing the process-wide timer resolution.
/// Elsewhere, or when that timer is unavailable, it falls back to Task.Delay.
/// </summary>
internal static class PreciseDelay
{
    private const uint CreateWaitableTimerHighResolution = 0x2;
    private const uint TimerAllAccess = 0x1F0003;
    private static int unavailable;

    public static Task WaitAsync(long microseconds, CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested) return Task.FromCanceled(cancellationToken);
        if (microseconds <= 0) return Task.CompletedTask;
        if (OperatingSystem.IsWindows() && Volatile.Read(ref unavailable) == 0 && TryHighResolution(microseconds, cancellationToken) is { } wait) return wait;
        return Task.Delay(TimeSpan.FromMicroseconds(microseconds), cancellationToken);
    }

    [ThreadStatic] private static SafeWaitHandle? threadTimer;

    /// <summary>Blocking variant for dedicated threads (the capture producer): one reusable high-resolution timer per thread.</summary>
    public static void Wait(long microseconds)
    {
        if (microseconds <= 0) return;
        if (OperatingSystem.IsWindows() && Volatile.Read(ref unavailable) == 0 && TryHighResolutionWait(microseconds)) return;
        Thread.Sleep(TimeSpan.FromMicroseconds(Math.Max(1000, microseconds)));
    }

    [SupportedOSPlatform("windows")]
    private static bool TryHighResolutionWait(long microseconds)
    {
        var handle = threadTimer;
        if (handle is null || handle.IsInvalid)
        {
            handle = CreateWaitableTimerExW(IntPtr.Zero, IntPtr.Zero, CreateWaitableTimerHighResolution, TimerAllAccess);
            if (handle.IsInvalid) { handle.Dispose(); Volatile.Write(ref unavailable, 1); return false; }
            threadTimer = handle;
        }
        var due = -microseconds * 10;
        if (!SetWaitableTimer(handle, ref due, 0, IntPtr.Zero, IntPtr.Zero, false)) return false;
        return WaitForSingleObject(handle, uint.MaxValue) == 0;
    }

    [SupportedOSPlatform("windows")]
    private static Task? TryHighResolution(long microseconds, CancellationToken cancellationToken)
    {
        var handle = CreateWaitableTimerExW(IntPtr.Zero, IntPtr.Zero, CreateWaitableTimerHighResolution, TimerAllAccess);
        if (handle.IsInvalid) { handle.Dispose(); Volatile.Write(ref unavailable, 1); return null; }
        var due = -microseconds * 10; // Relative, in 100 ns units.
        if (!SetWaitableTimer(handle, ref due, 0, IntPtr.Zero, IntPtr.Zero, false)) { handle.Dispose(); return null; }
        return WaitAsync(new TimerWaitHandle(handle), cancellationToken);
    }

    private static async Task WaitAsync(WaitHandle timer, CancellationToken cancellationToken)
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var registration = ThreadPool.RegisterWaitForSingleObject(timer, static (state, _) => ((TaskCompletionSource)state!).TrySetResult(), done, Timeout.Infinite, executeOnlyOnce: true);
        try
        {
            using (cancellationToken.Register(() => done.TrySetCanceled(cancellationToken))) await done.Task;
        }
        finally { registration.Unregister(null); timer.Dispose(); }
    }

    private sealed class TimerWaitHandle : WaitHandle
    {
        public TimerWaitHandle(SafeWaitHandle handle) => SafeWaitHandle = handle;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern SafeWaitHandle CreateWaitableTimerExW(IntPtr attributes, IntPtr name, uint flags, uint access);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(SafeWaitHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWaitableTimer(SafeWaitHandle timer, ref long dueTime, int period, IntPtr completion, IntPtr argument, [MarshalAs(UnmanagedType.Bool)] bool resume);
}
