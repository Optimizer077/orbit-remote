using System.Buffers.Binary;
using System.Security.Cryptography;

namespace Orbit.Host.Platform;

internal enum MacCaptureKind : ushort
{ RawFrame = 1, Heartbeat = 2, PermissionUnavailable = 3, DisplayChanged = 4, Error = 5, AccessUnit = 6 }
internal enum MacCaptureFormat : uint
{ None = 0, Bgra32 = 1, H264AnnexB = 2, HevcAnnexB = 3 }
[Flags] internal enum MacCaptureFlags : uint { None = 0, KeyFrame = 1 }
internal readonly record struct MacCaptureGeometry(int Width, int Height);
internal readonly record struct MacCaptureHeader(MacCaptureKind Kind, uint PayloadLength, ulong Generation, ulong Sequence,
    uint Width, uint Height, uint Stride, MacCaptureFormat Format, ulong CaptureNanoseconds, uint StreamSlot, MacCaptureFlags Flags)
{
    internal const int Size = 64;
    private const uint Magic = 0x4F524243; // ORBC
    internal byte[] Encode()
    {
        var data = new byte[Size]; var span = data.AsSpan();
        BinaryPrimitives.WriteUInt32BigEndian(span, Magic);
        BinaryPrimitives.WriteUInt16BigEndian(span[4..], 1);
        BinaryPrimitives.WriteUInt16BigEndian(span[6..], (ushort)Kind);
        BinaryPrimitives.WriteUInt32BigEndian(span[8..], Size);
        BinaryPrimitives.WriteUInt32BigEndian(span[12..], PayloadLength);
        BinaryPrimitives.WriteUInt64BigEndian(span[16..], Generation);
        BinaryPrimitives.WriteUInt64BigEndian(span[24..], Sequence);
        BinaryPrimitives.WriteUInt32BigEndian(span[32..], Width);
        BinaryPrimitives.WriteUInt32BigEndian(span[36..], Height);
        BinaryPrimitives.WriteUInt32BigEndian(span[40..], Stride);
        BinaryPrimitives.WriteUInt32BigEndian(span[44..], (uint)Format);
        BinaryPrimitives.WriteUInt64BigEndian(span[48..], CaptureNanoseconds);
        BinaryPrimitives.WriteUInt32BigEndian(span[56..], StreamSlot);
        BinaryPrimitives.WriteUInt32BigEndian(span[60..], (uint)Flags);
        return data;
    }
    internal static MacCaptureHeader Parse(ReadOnlySpan<byte> data)
    {
        if (data.Length != Size || BinaryPrimitives.ReadUInt32BigEndian(data) != Magic ||
            BinaryPrimitives.ReadUInt16BigEndian(data[4..]) != 1 || BinaryPrimitives.ReadUInt32BigEndian(data[8..]) != Size)
            throw new InvalidDataException("Unsupported capture pipe header.");
        return new((MacCaptureKind)BinaryPrimitives.ReadUInt16BigEndian(data[6..]), BinaryPrimitives.ReadUInt32BigEndian(data[12..]),
            BinaryPrimitives.ReadUInt64BigEndian(data[16..]), BinaryPrimitives.ReadUInt64BigEndian(data[24..]),
            BinaryPrimitives.ReadUInt32BigEndian(data[32..]), BinaryPrimitives.ReadUInt32BigEndian(data[36..]),
            BinaryPrimitives.ReadUInt32BigEndian(data[40..]), (MacCaptureFormat)BinaryPrimitives.ReadUInt32BigEndian(data[44..]),
            BinaryPrimitives.ReadUInt64BigEndian(data[48..]), BinaryPrimitives.ReadUInt32BigEndian(data[56..]),
            (MacCaptureFlags)BinaryPrimitives.ReadUInt32BigEndian(data[60..]));
    }
}

internal sealed record MacCaptureRecord(MacCaptureHeader Header, MacCaptureGeometry PhysicalGeometry, byte[] Data);

// No capture, process launch or backend wiring in this slice. The future broker
// owns its child/stream lifetime; a failed reader must be replaced with a fresh
// launch generation. Per-request cancellation must cancel waiters, not this reader.
internal sealed class MacCaptureReader
{
    internal const int MaximumStreams = 2;
    internal const int MaximumAccessUnitBytes = 8 * 1024 * 1024;
    private readonly ulong _generation;
    private readonly Dictionary<uint, MacCaptureGeometry> _geometry;
    private readonly HashSet<uint> _credits = [];
    private readonly Dictionary<uint, ulong> _captureTimes = [];
    private readonly object _state = new();
    private ulong _sequence;
    private volatile bool _failed;
    private int _reading;

    internal MacCaptureReader(ulong generation, IReadOnlyDictionary<uint, MacCaptureGeometry> streams)
    {
        ArgumentNullException.ThrowIfNull(streams);
        if (generation == 0 || streams.Count is < 1 or > MaximumStreams) throw new ArgumentException("Invalid capture pipe configuration.");
        long total = 0;
        _geometry = [];
        foreach (var (slot, geometry) in streams)
        {
            if (slot == 0) throw new ArgumentException("Capture stream slots must be nonzero.");
            PlatformLimits.CheckDimensions(geometry.Width, geometry.Height);
            total += (long)geometry.Width * geometry.Height * 4;
            _geometry.Add(slot, geometry);
        }
        if (total > PlatformLimits.MaximumFrameBytes) throw new ArgumentException("Capture streams exceed the raw-memory budget.");
        _generation = generation;
    }

    // A true result authorizes sending exactly one grant(slot, 1) command.
    // Duplicate demand cannot accumulate an unbounded producer/pipe queue.
    internal bool TryGrant(uint streamSlot)
    {
        lock (_state)
        {
            if (_failed) throw new InvalidOperationException("The capture pipe has ended.");
            if (!_geometry.ContainsKey(streamSlot)) throw new ArgumentException("Unknown capture stream slot.");
            return _credits.Add(streamSlot);
        }
    }

    internal async Task<MacCaptureRecord?> ReadAsync(Stream stream, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        cancellationToken.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref _reading, 1, 0) != 0) throw new InvalidOperationException("Only one capture pipe reader is allowed.");
        byte[] body = [];
        try
        {
            if (_failed) throw new InvalidOperationException("The capture pipe has ended.");
            var bytes = new byte[MacCaptureHeader.Size];
            var first = await stream.ReadAsync(bytes, cancellationToken);
            if (first == 0) { _failed = true; return null; }
            await stream.ReadExactlyAsync(bytes.AsMemory(first), cancellationToken);
            var header = MacCaptureHeader.Parse(bytes);
            var isFrame = header.Kind is MacCaptureKind.RawFrame or MacCaptureKind.AccessUnit;
            var geometry = Validate(header);
            // Header, binding and demand checks happen before payload allocation.
            body = header.PayloadLength == 0 ? [] : new byte[checked((int)header.PayloadLength)];
            await stream.ReadExactlyAsync(body, cancellationToken);
            if (header.Kind == MacCaptureKind.AccessUnit && !HasAnnexBPrefix(body))
                throw new InvalidDataException("Capture access unit is not Annex-B.");
            lock (_state)
            {
                _sequence = header.Sequence;
                if (isFrame) { _credits.Remove(header.StreamSlot); _captureTimes[header.StreamSlot] = header.CaptureNanoseconds; }
            }
            return new(header, geometry, body);
        }
        catch
        {
            _failed = true;
            CryptographicOperations.ZeroMemory(body);
            throw;
        }
        finally { Volatile.Write(ref _reading, 0); }
    }

    private MacCaptureGeometry Validate(MacCaptureHeader header)
    {
        lock (_state)
        {
            if (header.Generation != _generation || header.Sequence <= _sequence ||
                !_geometry.TryGetValue(header.StreamSlot, out var geometry))
                throw new InvalidDataException("Capture pipe generation, sequence or stream binding is invalid.");
            if (header.Kind is MacCaptureKind.RawFrame or MacCaptureKind.AccessUnit &&
                _captureTimes.TryGetValue(header.StreamSlot, out var previous) && header.CaptureNanoseconds < previous)
                throw new InvalidDataException("Capture timestamp moved backwards.");
            switch (header.Kind)
            {
                case MacCaptureKind.RawFrame:
                    if (header.Format != MacCaptureFormat.Bgra32 || header.Flags != MacCaptureFlags.None ||
                        header.Width != geometry.Width || header.Height != geometry.Height ||
                        header.Stride != (long)geometry.Width * 4 || header.PayloadLength != (long)header.Stride * geometry.Height ||
                        header.CaptureNanoseconds == 0 || !_credits.Contains(header.StreamSlot))
                        throw new InvalidDataException("Invalid or unrequested raw capture frame.");
                    break;
                case MacCaptureKind.AccessUnit:
                    // Geometry is coded here; the immutable binding retains physical
                    // dimensions. Codec configuration/cropping is a later stream slice.
                    if (header.Format is not (MacCaptureFormat.H264AnnexB or MacCaptureFormat.HevcAnnexB) ||
                        (header.Flags & ~MacCaptureFlags.KeyFrame) != 0 || header.Stride != 0 ||
                        header.Width == 0 || header.Height == 0 || (ulong)header.Width * header.Height > PlatformLimits.MaximumPixels ||
                        header.Width > int.MaxValue || header.Height > int.MaxValue ||
                        header.PayloadLength is < 4 or > MaximumAccessUnitBytes || header.CaptureNanoseconds == 0 || !_credits.Contains(header.StreamSlot))
                        throw new InvalidDataException("Invalid or unrequested capture access unit.");
                    break;
                case MacCaptureKind.Heartbeat:
                case MacCaptureKind.PermissionUnavailable:
                case MacCaptureKind.DisplayChanged:
                case MacCaptureKind.Error:
                    if (header.PayloadLength != 0 || header.Width != 0 || header.Height != 0 || header.Stride != 0 ||
                        header.Format != MacCaptureFormat.None || header.Flags != MacCaptureFlags.None || header.CaptureNanoseconds != 0)
                        throw new InvalidDataException("Invalid capture control record.");
                    // A state boundary retires the pipe so no later cached pixels
                    // can cross a permission/display/error transition.
                    if (header.Kind != MacCaptureKind.Heartbeat) _failed = true;
                    break;
                default: throw new InvalidDataException("Unknown capture record type.");
            }
            if (header.PayloadLength > PlatformLimits.MaximumFrameBytes)
                throw new InvalidDataException("Capture payload exceeds its byte limit.");
            return geometry;
        }
    }

    private static bool HasAnnexBPrefix(ReadOnlySpan<byte> data) => data.Length >= 4 && data[0] == 0 && data[1] == 0 &&
        (data[2] == 1 || (data.Length >= 5 && data[2] == 0 && data[3] == 1));
}
