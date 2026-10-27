using Orbit.Host.Platform;

internal static class MacCapturePipeChecks
{
    private const ulong Generation = 0x0102030405060708;
    private static readonly MacCaptureHeader Raw = new(MacCaptureKind.RawFrame, 4, Generation, 1, 1, 1, 4,
        MacCaptureFormat.Bgra32, 1, 1, MacCaptureFlags.None);
    private static MacCaptureReader Reader() => new(Generation, new Dictionary<uint, MacCaptureGeometry> { [1] = new(1, 1) });
    internal static async Task RunAsync(Action<bool, string> check)
    {
        var golden = Convert.FromHexString("4F524243000100010000004000000004010203040506070811121314151617180000000100000001000000040000000121222324252627280000000100000000");
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "global.json"))) root = root.Parent;
        if (root is null) throw new InvalidOperationException("Run capture framing checks from the source checkout.");
        check(Convert.FromHexString(File.ReadAllText(Path.Combine(root.FullName, "native/macos-capture/fixtures/raw-v1-header.hex")).Trim()).SequenceEqual(golden),
            "Native producer fixture agrees with independent managed sentinel");
        var header = Raw with { Sequence = 0x1112131415161718, CaptureNanoseconds = 0x2122232425262728 };
        check(header.Encode().SequenceEqual(golden), "Capture pipe header matches independent big-endian fixture");
        check(MacCaptureHeader.Parse(golden) == header, "Capture pipe decodes every header field");
        var reader = Reader();
        check(reader.TryGrant(1) && !reader.TryGrant(1), "Capture credits saturate at one per stream");
        var heartbeat = Raw with { Kind = MacCaptureKind.Heartbeat, PayloadLength = 0, Width = 0, Height = 0, Stride = 0,
            Format = MacCaptureFormat.None, CaptureNanoseconds = 0 };
        using (var fragmented = new FragmentedStream([.. heartbeat.Encode(), .. (Raw with { Sequence = 2 }).Encode(), 1, 2, 3, 0]))
        {
            check((await reader.ReadAsync(fragmented))!.Header.Kind == MacCaptureKind.Heartbeat, "Capture controls work without spending frame credit");
            var frame = await reader.ReadAsync(fragmented);
            check(frame!.Data.SequenceEqual(new byte[] { 1, 2, 3, 0 }) && frame.PhysicalGeometry == new MacCaptureGeometry(1, 1), "Fragmented capture reads retain exact BGRA and physical binding");
            check(reader.TryGrant(1), "Complete frame releases its credit for next demand");
            check(await reader.ReadAsync(fragmented) is null, "Clean capture pipe EOF is explicit");
            Reject<InvalidOperationException>(() => reader.TryGrant(1), "Capture EOF cannot be revived with credits");
        }
        foreach (var changed in new[] {
            Raw with { Generation = Generation + 1 }, Raw with { Sequence = 0 }, Raw with { StreamSlot = 2 },
            Raw with { Kind = (MacCaptureKind)99 }, Raw with { Width = uint.MaxValue }, Raw with { Height = 2 },
            Raw with { Stride = 8 }, Raw with { PayloadLength = uint.MaxValue }, Raw with { PayloadLength = 8 },
            Raw with { Format = MacCaptureFormat.H264AnnexB }, Raw with { Flags = MacCaptureFlags.KeyFrame }, Raw with { CaptureNanoseconds = 0 } })
            await RejectHeader(changed, "Capture rejects malformed/binding-mismatched raw header before body read");
        foreach (var offset in new[] { 0, 4, 8 })
        {
            var bytes = Raw.Encode(); bytes[offset] ^= 255;
            await RejectAsync<InvalidDataException>(() => Granted().ReadAsync(new MemoryStream(bytes)), "Capture rejects magic/version/header-length mismatch");
        }
        await RejectAsync<InvalidDataException>(() => Reader().ReadAsync(new MemoryStream(Raw.Encode())), "Capture refuses uncredited payload before allocation");
        var poisoned = Granted();
        await RejectAsync<InvalidDataException>(() => poisoned.ReadAsync(new MemoryStream((Raw with { Stride = 99 }).Encode())), "Malformed capture record retires reader");
        await RejectAsync<InvalidOperationException>(() => poisoned.ReadAsync(new MemoryStream([.. Raw.Encode(), 1, 2, 3, 0])), "Retired capture reader cannot accept a fresh-looking record");
        var duplicate = Granted();
        await duplicate.ReadAsync(new MemoryStream([.. Raw.Encode(), 1, 2, 3, 0])); duplicate.TryGrant(1);
        await RejectAsync<InvalidDataException>(() => duplicate.ReadAsync(new MemoryStream(Raw.Encode())), "Capture refuses repeated sequence");
        var reversedTime = Granted();
        await reversedTime.ReadAsync(new MemoryStream([.. (Raw with { CaptureNanoseconds = 100 }).Encode(), 1, 2, 3, 0])); reversedTime.TryGrant(1);
        await RejectAsync<InvalidDataException>(() => reversedTime.ReadAsync(new MemoryStream((Raw with { Sequence = 2, CaptureNanoseconds = 99 }).Encode())), "Capture refuses stale per-stream timestamp");
        await RejectAsync<EndOfStreamException>(() => Granted().ReadAsync(new FragmentedStream(Raw.Encode()[..30])), "Truncated capture header fails closed");
        await RejectAsync<EndOfStreamException>(() => Granted().ReadAsync(new FragmentedStream([.. Raw.Encode(), 1, 2])), "Truncated capture pixels fail closed");

        foreach (var kind in new[] { MacCaptureKind.PermissionUnavailable, MacCaptureKind.DisplayChanged, MacCaptureKind.Error })
        {
            var boundary = Reader();
            check((await boundary.ReadAsync(new MemoryStream((heartbeat with { Kind = kind }).Encode())))!.Header.Kind == kind, "Capture state boundary is surfaced without pixels");
            Reject<InvalidOperationException>(() => boundary.TryGrant(1), "Permission/display/error boundary prevents later stale frames");
        }
        await RejectHeader(heartbeat with { PayloadLength = 4 }, "Capture controls cannot smuggle a pixel payload");
        foreach (var codec in new[] { MacCaptureFormat.H264AnnexB, MacCaptureFormat.HevcAnnexB })
        {
            var coded = Raw with { Kind = MacCaptureKind.AccessUnit, PayloadLength = 5, Stride = 0, Format = codec, Flags = MacCaptureFlags.KeyFrame };
            check((await Granted().ReadAsync(new FragmentedStream([.. coded.Encode(), 0, 0, 0, 1, 0x65])))!.Header.Format == codec, "Codec-ready framing accepts bounded Annex-B envelope without decoding");
            await RejectHeader(coded with { PayloadLength = MacCaptureReader.MaximumAccessUnitBytes + 1 }, "Capture access-unit size is bounded before read");
            await RejectHeader(coded with { Flags = (MacCaptureFlags)2 }, "Capture refuses unknown codec flags");
            await RejectAsync<InvalidDataException>(() => Granted().ReadAsync(new MemoryStream([.. coded.Encode(), 1, 2, 3, 4, 5])), "Capture rejects non-Annex-B access unit");
        }
        var fourK = new MacCaptureReader(Generation, new Dictionary<uint, MacCaptureGeometry> { [1] = new(3840, 2160), [2] = new(3840, 2160) });
        fourK.TryGrant(1);
        var fourKHeader = Raw with { Width = 3840, Height = 2160, Stride = 3840 * 4, PayloadLength = 3840 * 2160 * 4 };
        using (var synthetic = new SyntheticBlackFrame(fourKHeader))
            check((await fourK.ReadAsync(synthetic))!.Data.Length == 3840 * 2160 * 4, "Capture limits allow full 4K raw frame with two configured displays");
        Reject<ArgumentException>(() => new MacCaptureReader(0, new Dictionary<uint, MacCaptureGeometry> { [1] = new(1, 1) }), "Capture generation must be nonzero");
        Reject<ArgumentException>(() => new MacCaptureReader(Generation, new Dictionary<uint, MacCaptureGeometry>()), "Capture requires configured streams");
        Reject<ArgumentException>(() => new MacCaptureReader(Generation, new Dictionary<uint, MacCaptureGeometry> { [1] = new(1, 1), [2] = new(1, 1), [3] = new(1, 1) }), "Capture stream count is bounded");
        Reject<ArgumentException>(() => new MacCaptureReader(Generation, new Dictionary<uint, MacCaptureGeometry> { [1] = new(7680, 4320), [2] = new(7680, 4320) }), "Capture total configured raw-memory budget is bounded");
        Reject<ArgumentException>(() => Reader().TryGrant(2), "Capture refuses credits for unknown stream");
        using (var canceled = new CancellationTokenSource())
        {
            var beforeRead = Granted(); canceled.Cancel();
            await RejectAsync<OperationCanceledException>(() => beforeRead.ReadAsync(new MemoryStream(), canceled.Token), "Pre-canceled capture read performs no I/O");
            check((await beforeRead.ReadAsync(new MemoryStream([.. Raw.Encode(), 1, 2, 3, 0]))) is not null, "Pre-cancellation preserves an unconsumed reader");
        }
        using (var block = new BlockingStream())
        using (var canceled = new CancellationTokenSource())
        {
            var blockedReader = Granted(); var pending = blockedReader.ReadAsync(block, canceled.Token);
            await block.Entered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            await RejectAsync<InvalidOperationException>(() => blockedReader.ReadAsync(new MemoryStream()), "Capture refuses concurrent reader queue");
            canceled.Cancel(); await RejectAsync<OperationCanceledException>(() => pending, "Blocked capture read honors cancellation");
            Reject<InvalidOperationException>(() => blockedReader.TryGrant(1), "Interrupted capture pipe requires a fresh reader");
        }

        MacCaptureReader Granted() { var result = Reader(); result.TryGrant(1); return result; }
        async Task RejectHeader(MacCaptureHeader invalid, string message) =>
            await RejectAsync<InvalidDataException>(() => Granted().ReadAsync(new MemoryStream(invalid.Encode())), message);
        void Reject<T>(Action action, string message) where T : Exception
        { try { action(); check(false, message); } catch (T) { check(true, message); } }
        async Task RejectAsync<T>(Func<Task> action, string message) where T : Exception
        { try { await action(); check(false, message); } catch (T) { check(true, message); } }
    }

    private sealed class FragmentedStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(buffer.Length, 3)], cancellationToken);
    }
    private sealed class SyntheticBlackFrame(MacCaptureHeader header) : Stream
    {
        private readonly byte[] _header = header.Encode(); private long _position;
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var remaining = MacCaptureHeader.Size + (long)header.PayloadLength - _position;
            var size = (int)Math.Min(buffer.Length, remaining);
            if (_position < MacCaptureHeader.Size) { size = Math.Min(size, MacCaptureHeader.Size - (int)_position); _header.AsMemory((int)_position, size).CopyTo(buffer); }
            else buffer.Span[..size].Clear();
            _position += size; return ValueTask.FromResult(size);
        }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => _position; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException(); public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
    private sealed class BlockingStream : Stream
    {
        internal readonly TaskCompletionSource Entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { Entered.TrySetResult(); await Task.Delay(Timeout.Infinite, cancellationToken); return 0; }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException(); public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
