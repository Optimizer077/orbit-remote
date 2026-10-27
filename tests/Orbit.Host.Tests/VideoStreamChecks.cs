using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

/// <summary>
/// D11 /stream checks. Synthetic BGRA frames and a fake encoder only: no screen capture, no real input. The one Media
/// Foundation check encodes synthetic pixels and runs only when <see cref="MfH264Encoder.IsSupported"/>. The HTTP checks
/// bind an ephemeral 127.0.0.1 port. Every produced stream is validated with the viewer's framing rules (stream-parser.cjs).
/// </summary>
public static class VideoStreamChecks
{
    private static readonly MonitorInfo Monitor = new("synthetic-1", "Synthetic", -1920, 0, 64, 48, true);
    private static readonly VideoStreamTimings Fast = new(HeartbeatMilliseconds: 150, AuthorizationMilliseconds: 40, TerminalMilliseconds: 250,
        RetryMilliseconds: 10, MaximumConsecutiveSourceFailures: 5);
    private static readonly VideoStreamSettings Quick = new(240, 2_000_000, 1);

    public static void Run(Action<bool, string> check) => RunAsync(check).GetAwaiter().GetResult();

    public static async Task RunAsync(Action<bool, string> check)
    {
        await Section(check, "wire", () => { WireChecks(check); return Task.CompletedTask; });
        await Section(check, "writer", () => WriterChecks(check));
        await Section(check, "parsing", () => { ParsingChecks(check); return Task.CompletedTask; });
        await Section(check, "limits", () => { LimitChecks(check); return Task.CompletedTask; });
        await Section(check, "loop", () => LoopChecks(check));
        await Section(check, "refresh tail", () => TailChecks(check));
        await Section(check, "authorization", () => AuthorizationChecks(check));
        await Section(check, "source adapter", () => SourceAdapterChecks(check));
        await Section(check, "http", () => HttpChecks(check));
        await Section(check, "media foundation", () => MediaFoundationCheck(check));
        await Section(check, "performance", () => PerformanceChecks(check));
        await Section(check, "gpu source", () => GpuChecks(check));
        await Section(check, "access units", () => AccessUnitChecks(check));
        await Section(check, "cursor records", () => CursorChecks(check));
        await Section(check, "startup receipts", () => StreamStartChecks.RunAsync(check));
        await Section(check, "GPU recovery", () => GpuRecoveryChecks(check));
        await Section(check, "host shutdown", () => HostShutdownChecks.RunAsync(check));
    }

    private static async Task Section(Action<bool, string> check, string name, Func<Task> run)
    {
        try { await run(); }
        catch (Exception ex) { check(false, $"Video stream {name} checks threw {ex.GetType().Name}: {ex.Message}"); }
    }

    private static void WireChecks(Action<bool, string> check)
    {
        var header = new byte[24];
        VideoStreamRecords.WriteHeader(header, VideoRecordType.AccessUnit, true, 0x01020304, 0xA1B2C3D4, 0x1122334455667788);
        check(header[0] == 2 && header[1] == 1 && header[2] == 0 && header[3] == 0, "Header: type and keyframe flag, zero reserved u16");
        check(header.AsSpan(4, 4).SequenceEqual(new byte[] { 4, 3, 2, 1 }) && header.AsSpan(8, 4).SequenceEqual(new byte[] { 0xD4, 0xC3, 0xB2, 0xA1 }), "Header: length and sequence are little-endian u32");
        check(header.AsSpan(12, 4).SequenceEqual(new byte[4]) && header.AsSpan(16, 8).SequenceEqual(new byte[] { 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11 }), "Header: zero reserved u32 and little-endian u64 timestamp");
        check(Throws(() => VideoStreamRecords.WriteHeader(header, VideoRecordType.Heartbeat, true, 0, 0, 0)), "Header: keyframe flag only on access units");

        var physical = Frame(1919, 1079, -1920, 0, "g", 1);
        var config = VideoStreamRecords.Config("avc1.4D4028", 960, 540, 960, 540, physical, 0.5, 60);
        check(ConfigViolation(config, physical.MonitorId) is null, "Config: 0.5 scale of 1919x1079 passes the viewer's field, bound and mapping rules");
        var wide = Frame(3024, 1898, 0, 0, "g", 1);
        var (sw, sh) = VideoStreamSettings.ScaledSize(3024, 1898, 0.33);
        check(sw == 998 && sh == 626 && ConfigViolation(VideoStreamRecords.Config("avc1.640033", sw, sh, sw, sh, wide, 0.33, 240), "synthetic-1") is null, "Config: minimum scale of a 3024x1898 display maps within one pixel");
        check(Throws(() => VideoStreamRecords.Config("avc1.4d4028", 960, 540, 960, 540, physical, 0.5, 60)), "Config: lowercase codec hex is refused");
        check(Throws(() => VideoStreamRecords.Config("avc1.4D4028", 960, 540, 977, 540, physical, 0.5, 60)), "Config: coded size more than 16 beyond display is refused");
        check(Throws(() => VideoStreamRecords.Config("avc1.4D4028", 900, 540, 900, 540, physical, 0.5, 60)), "Config: scale/geometry mismatch is refused");
        check(Throws(() => VideoStreamRecords.Config("avc1.4D4028", 960, 540, 960, 540, physical, 0.5, 241)), "Config: fps above 240 is refused");
        check(Throws(() => VideoStreamRecords.Config("avc1.4D4028", 960, 540, 960, 540, physical with { MonitorId = new string('m', 129) }, 0.5, 60)), "Config: monitor ID above 128 characters is refused");

        foreach (var code in VideoStreamRecords.TerminalCodes)
        {
            var bytes = VideoStreamRecords.Terminal(code, new string('é', 5000));
            using var json = JsonDocument.Parse(bytes);
            var names = json.RootElement.EnumerateObject().Select(p => p.Name).ToArray();
            check(bytes.Length <= 1024 && names.SequenceEqual(["code", "error"]) && json.RootElement.GetProperty("code").GetString() == code
                && json.RootElement.GetProperty("error").GetString()!.Length <= 500, "Terminal: " + code + " is {code,error}, error <= 500 chars, <= 1 KiB");
        }
        check(Throws(() => VideoStreamRecords.Terminal("teapot", "x")), "Terminal: unknown codes are never sent");
        check(VideoStreamRecords.CodecFromAccessUnit(FakeEncoder.Keyframe) == "avc1.4D4028" && VideoStreamRecords.CodecFromAccessUnit(FakeEncoder.Delta) is null, "Codec string comes from the keyframe's SPS");
    }

    private static async Task WriterChecks(Action<bool, string> check)
    {
        var times = new Queue<long>([100, 50, 200, 300, 400]);
        var output = new RecordingStream();
        var writer = new VideoRecordWriter(output, () => times.Dequeue());
        var s0 = await writer.WriteAsync(VideoRecordType.Config, false, new byte[] { (byte)'{', (byte)'}' }, default);
        var s1 = await writer.WriteAsync(VideoRecordType.Heartbeat, false, ReadOnlyMemory<byte>.Empty, default);
        var s2 = await writer.WriteAsync(VideoRecordType.AccessUnit, true, FakeEncoder.Keyframe, default);
        var bytes = output.Snapshot();
        check(s0 == 0 && s1 == 1 && s2 == 2, "Writer: sequence starts at 0 and adds 1 per record");
        check(BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(16)) == 100 && BinaryPrimitives.ReadUInt64LittleEndian(bytes.AsSpan(26 + 16)) == 100
            && BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(26 + 4)) == 0, "Writer: timestamps never decrease when the clock steps back; heartbeat length 0");
        check(await ThrowsAsync(() => writer.WriteAsync(VideoRecordType.Config, false, new byte[4097], default)), "Writer: config above 4 KiB is refused");
        check(await ThrowsAsync(() => writer.WriteAsync(VideoRecordType.Heartbeat, false, new byte[1], default)), "Writer: heartbeat with payload is refused");
        check(await ThrowsAsync(() => writer.WriteAsync(VideoRecordType.AccessUnit, false, ReadOnlyMemory<byte>.Empty, default)), "Writer: empty access unit is refused");
        check(await ThrowsAsync(() => writer.WriteAsync(VideoRecordType.AccessUnit, false, new byte[8 * 1024 * 1024 + 1], default)), "Writer: access unit above 8 MiB is refused");

        check(!await new VideoRecordWriter(new RecordingStream(), () => 1).TryWriteTerminalAsync("stream_error", "x", 50), "Writer: no terminal before the first config (the viewer rejects it; the host aborts instead)");
        var edge = new VideoRecordWriter(new RecordingStream(), () => 1, uint.MaxValue - 1);
        var last = await edge.WriteAsync(VideoRecordType.Config, false, new byte[] { (byte)'{', (byte)'}' }, default);
        var refused = await edge.WriteAsync(VideoRecordType.Heartbeat, false, ReadOnlyMemory<byte>.Empty, default);
        var terminal = await edge.TryWriteTerminalAsync("stream_restart", "restart", 250);
        check(last == uint.MaxValue - 1 && refused is null && terminal && edge.NextSequence == uint.MaxValue, "Writer: never wraps; only a terminal may take sequence 0xFFFFFFFF");
        check(await ThrowsAsync(() => edge.WriteAsync(VideoRecordType.Heartbeat, false, ReadOnlyMemory<byte>.Empty, default)) && !await edge.TryWriteTerminalAsync("stream_error", "x", 50), "Writer: nothing follows a terminal");
    }

    private static void ParsingChecks(Action<bool, string> check)
    {
        static VideoControlRequest P(string json) => VideoControlRequest.Parse(Encoding.UTF8.GetBytes(json));
        check(P("{\"keyframe\":true}").Keyframe && P("{\"ack\":5,\"decodeMs\":1.5}") is { Ack: 5u, DecodeMs: 1.5 }, "Control: keyframe and ack+decodeMs parse");
        check(P("{\"bitrateBps\":1,\"maxFps\":1000,\"scale\":5}") is { BitrateBps: 100_000, MaxFps: 240, Scale: 1.0 }, "Control: settings are clamped by the host");
        check(P("{\"bitrateBps\":99999999999,\"maxFps\":0,\"scale\":0.01}") is { BitrateBps: 100_000_000, MaxFps: 1, Scale: 0.33 }, "Control: extreme settings clamp to the other bounds");
        foreach (var bad in new[] { "{\"unknown\":1}", "{\"ack\":1,\"ack\":2}", "{\"ack\":-1}", "{\"ack\":1.5}", "{\"ack\":\"5\"}", "{\"ack\":4294967296}",
            "{\"keyframe\":\"true\"}", "{\"decodeMs\":3}", "{\"ack\":1,\"decodeMs\":-1}", "[1]", "", "{\"scale\":{\"a\":1}}", "{\"maxFps\":1.5}", "not json", "{\"keyframe\":true" })
            check(Throws(() => P(bad)), "Control: malformed body is refused: " + bad);
        check(Throws(() => VideoControlRequest.Parse(new byte[1025])), "Control: body above 1 KiB is refused");

        check(VideoStreamSettings.Parse(null, null, null) == VideoStreamSettings.Default, "Query: defaults apply when absent");
        check(VideoStreamSettings.Parse("0", "1", "0.1") is { MaxFps: 1, BitrateBps: 100_000, Scale: 0.33 } && VideoStreamSettings.Parse("1000", "999999999999", "1") is { MaxFps: 240, BitrateBps: 100_000_000 }, "Query: maxFps, bitrate and scale clamp");
        foreach (var (fps, bitrate, scale) in new (string?, string?, string?)[] { ("1.5", null, null), ("", null, null), (null, "1e6", null), (null, null, "NaN"), (null, "1234567890123", null) })
            check(Throws(() => VideoStreamSettings.Parse(fps, bitrate, scale)), $"Query: malformed value is refused ({fps}|{bitrate}|{scale})");
    }

    private static void LimitChecks(Action<bool, string> check)
    {
        var slots = new VideoStreamSlots<object>(8);
        var streams = Enumerable.Range(0, 9).Select(_ => new object()).ToArray();
        var added = Enumerable.Range(0, 8).All(i => slots.TryAdd("s" + i, "m", streams[i], out var none) && none is null);
        check(added && !slots.TryAdd("s8", "m", streams[8], out _), "Slots: at most 8 streams per host");
        check(slots.TryAdd("s0", "m", streams[8], out var replaced) && ReferenceEquals(replaced, streams[0]) && slots.Count == 8, "Slots: same session+monitor replaces the older stream, even at the cap");
        slots.Remove("s0", "m", streams[0]);
        check(slots.Count == 8 && ReferenceEquals(slots.Find("s0", "m", out _), streams[8]), "Slots: a replaced stream's cleanup cannot remove its successor");
        slots.Remove("s0", "m", streams[8]);
        check(slots.Count == 7 && slots.TryAdd("x", "m", new object(), out _), "Slots: ending a stream frees its slot");
        var pair = new VideoStreamSlots<object>(8);
        pair.TryAdd("s1", "m", new object(), out _); pair.TryAdd("s1", "m2", new object(), out _); pair.TryAdd("s2", "m", new object(), out _);
        check(pair.Find("s1", null, out var ambiguous) is null && ambiguous && pair.Find("s2", null, out var single) is not null && !single, "Slots: control without monitorId resolves only a session's single stream");

        long now = 0;
        var limiter = new SlidingWindowLimiter(VideoStreamRun.ControlRequestsPerSecond, 1_000_000, () => now);
        var allowed = Enumerable.Range(0, 60).Count(_ => limiter.TryAcquire());
        check(VideoStreamRun.ControlRequestsPerSecond == 60 && allowed == 60 && !limiter.TryAcquire(), "Control rate: 60 per second per stream, the 61st is refused (429)");
        now = 999_999; check(!limiter.TryAcquire(), "Control rate: the window slides, not resets early");
        now = 1_000_000; check(limiter.TryAcquire(), "Control rate: permits return after one second");

        var device = new PairedDevice("d", "Device", "pin", new DevicePermissions(View: true), DateTimeOffset.UtcNow, ResumeEpoch: "epoch");
        var session = new RemoteSession("s", "d", "Device", null, new DevicePermissions(View: true), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1), DateTimeOffset.UtcNow, ResumeEpoch: "epoch");
        VideoStreamDenial C(bool stop = false, bool id = false, PairedDevice? d = null, bool gone = false, bool noD = false) =>
            HostStateStreamAccess.Classify(stop, id, noD ? null : d ?? device, session, () => gone ? null : session);
        check(C() == VideoStreamDenial.None, "Access: valid device, epoch, grant and session pass");
        check(C(d: device with { BlockedByOwner = true }) == VideoStreamDenial.OwnerEnded
            && C(stop: true, d: device with { BlockedByOwner = true }) == VideoStreamDenial.OwnerEnded,
            "Access: an owner block remains authoritative before ordinary shutdown");
        check(C(stop: true, id: true) == VideoStreamDenial.IdentityUnavailable && C(stop: true, noD: true) == VideoStreamDenial.Revoked
            && C(stop: true, d: device with { ResumeEpoch = "rotated" }) == VideoStreamDenial.EndedByHost
            && C(stop: true, d: device with { Permissions = new DevicePermissions() }) == VideoStreamDenial.PermissionChanged,
            "Access: identity, revocation, host-ended epoch and viewing denial remain authoritative during shutdown");
        check(C(stop: true, gone: true) == VideoStreamDenial.HostStopping, "Access: lifecycle-cleared session entries retain ordinary host_stopping after security checks");
        check(C(noD: true) == VideoStreamDenial.Revoked && C(d: device with { ResumeEpoch = "rotated" }) == VideoStreamDenial.EndedByHost, "Access: revocation (401) and host-ended epoch (410)");
        check(C(d: device with { Permissions = new DevicePermissions() }) == VideoStreamDenial.PermissionChanged && C(gone: true) == VideoStreamDenial.SessionEnded, "Access: lost viewing grant and ended session");
        check(VideoStreamEndpoints.Denied(VideoStreamDenial.Revoked) is IStatusCodeHttpResult { StatusCode: 401 } && VideoStreamEndpoints.Denied(VideoStreamDenial.IdentityUnavailable) is IStatusCodeHttpResult { StatusCode: 503 }
            && VideoStreamEndpoints.Denied(VideoStreamDenial.EndedByHost) is IStatusCodeHttpResult { StatusCode: 410 } && VideoStreamEndpoints.Denied(VideoStreamDenial.SessionEnded) is IStatusCodeHttpResult { StatusCode: 404 }
            && VideoStreamEndpoints.Denied(VideoStreamDenial.None) is null, "Access: open-time statuses match /frame (401/503/410/404)");
        check(VideoStreamEndpoints.Denied(VideoStreamDenial.OwnerEnded) is IStatusCodeHttpResult { StatusCode: 403 }
            && VideoStreamRun.TerminalCode(VideoStreamDenial.OwnerEnded) == VideoStreamRun.TerminalCode(VideoStreamDenial.EndedByHost),
            "Access: owner block returns403 and retains the compatible terminal stream code");
        var codes = Enum.GetValues<VideoStreamDenial>().Where(d => d is not VideoStreamDenial.None and not VideoStreamDenial.OwnerEnded).Select(VideoStreamRun.TerminalCode).ToArray();
        check(codes.All(VideoStreamRecords.TerminalCodes.Contains) && codes.Distinct().Count() == codes.Length, "Access: distinct original denials retain their contract terminal codes");

        var solid = Enumerable.Range(0, 16).SelectMany(_ => new byte[] { 10, 20, 30, 0 }).ToArray();
        var half = VideoFrameScaler.Resize(solid, 4, 4, 2, 2);
        check(half.Length == 16 && Enumerable.Range(0, 4).All(i => half[i * 4] == 10 && half[i * 4 + 1] == 20 && half[i * 4 + 2] == 30), "Scale: box downscale keeps a uniform color");
    }

    private static async Task LoopChecks(Action<bool, string> check)
    {
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }))
        {
            await Until(() => h.Records().Count(r => r.Type == 2) >= 8, 2000);
            await Task.Delay(300);
            var records = h.Records(out var violation);
            check(violation is null && records.Count >= 3 && records[0].Type == 1 && records[1].Type == 2 && (records[1].Flags & 1) == 1, "Join: config first, then a keyframe; stream passes viewer validation");
            check(records.Count(r => r.Type == 2) == 8 && h.Run.EncodeCount == 8 && h.Run.InFlight == 8, "Count bound: a ninth access unit is neither encoded nor queued while eight small ones are unacknowledged");
            var gets = h.Source.Gets;
            await Task.Delay(200);
            check(h.Source.Gets == gets, "Count bound: capture is skipped too while backed up");
            h.Run.Ack(records[1].Sequence, 2.5);
            await Until(() => h.Records().Count(r => r.Type == 2) >= 9, 1000);
            await Task.Delay(100);
            check(h.Records().Count(r => r.Type == 2) == 9 && h.Run.InFlight == 8 && h.Run.LastDecodeMilliseconds == 2.5, "Ack: acknowledging one access unit releases exactly one more");
            var fifth = h.Records().Where(r => r.Type == 2).ElementAt(4);
            h.Run.Ack(fifth.Sequence, null);
            await Until(() => h.Records().Count(r => r.Type == 2) >= 13, 1000);
            await Task.Delay(100);
            check(h.Records().Count(r => r.Type == 2) == 13 && h.Run.InFlight == 8, "Ack: cumulative ack of the fifth access unit releases every earlier one");
            check(AckIgnored(h.Run), "Ack: an ack beyond the last sent access unit is ignored");
            var lastAu = h.Records().Last(r => r.Type == 2);
            h.Run.RequestKeyframe();
            await Until(() => h.Records().Any(r => r.Type == 2 && r.Sequence > lastAu.Sequence), 1000);
            var next = h.Records(out var v2).First(r => r.Type == 2 && r.Sequence > lastAu.Sequence);
            check(v2 is null && (next.Flags & 1) == 1, "Keyframe request: releases the full window and the next access unit is a keyframe");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { KeyframeBytes = 300_000 }))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            await Task.Delay(300);
            var records = h.Records(out var violation);
            check(VideoStreamRun.InFlightByteBudget(2_000_000, 0.1) == 25_000, "Byte bound: 2 Mbit/s allows 25,000 bytes (100 ms) in flight");
            check(violation is null && records.Count(r => r.Type == 2) == 1 && records.First(r => r.Type == 2).Payload.Length == 300_000 && h.Run.EncodeCount == 1 && h.Run.InFlightBytes == 300_000,
                "Byte bound: a 300 KB keyframe at 2 Mbit/s goes alone (at least one access unit is always allowed); the next waits, not encoded");
            h.Run.Ack(records.First(r => r.Type == 2).Sequence, null);
            await Until(() => h.Records().Count(r => r.Type == 2) >= 9, 1000);
            await Task.Delay(100);
            check(h.Records().Count(r => r.Type == 2) == 9 && h.Run.InFlight == 8 && h.Run.InFlightBytes < 100, "Byte bound: after its ack, small deltas flow until the 8-unit count bound");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { DeltaBytes = 10_000 }))
        {
            await Until(() => h.Records().Count(r => r.Type == 2) >= 4, 1000);
            await Task.Delay(300);
            check(h.Records().Count(r => r.Type == 2) == 4 && h.Run.EncodeCount == 4 && h.Run.InFlightBytes == 22 + 3 * 10_000,
                "Byte bound: 10 KB deltas at 2 Mbit/s stop at 4 in flight (budget reached before the count bound)");
            h.Run.UpdateSettings(8_000_000, null, null);
            await Until(() => h.Run.InFlight >= 8, 1000);
            await Task.Delay(100);
            check(h.Run.InFlight == 8 && h.Records().Count(r => r.Type == 2) == 8, "Byte bound: a higher controller bitrate widens the byte budget (8 Mbit/s → 100 KB) up to the count bound");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            await Task.Delay(520);
            var records = h.Records(out var violation);
            check(violation is null && records.Count(r => r.Type == 2) == 1 && records.Count(r => r.Type == 3) >= 2 && h.Run.EncodeCount == 1, "Idle: unchanged content is encoded once, then heartbeats (no access units)");
            var heartbeats = records.Where(r => r.Type == 3).Select(r => r.Timestamp).ToArray();
            check(heartbeats.Zip(heartbeats.Skip(1)).All(p => p.Second - p.First >= 100_000), "Idle: heartbeats follow the configured interval");

            h.Run.RequestKeyframe();
            await Until(() => h.Records().Count(r => r.Type == 2) >= 2, 1000);
            var key = h.Records().Where(r => r.Type == 2).ElementAt(1);
            check((key.Flags & 1) == 1 && h.Run.EncodeCount == 2, "Keyframe request: re-encodes unchanged content as a keyframe");

            h.Run.UpdateSettings(null, null, 0.5);
            await Until(() => h.Records().Count(r => r.Type == 1) >= 2, 1000);
            var all = h.Records(out var v3);
            var configIndex = all.FindLastIndex(r => r.Type == 1);
            using var cfg = JsonDocument.Parse(all[configIndex].Payload);
            check(v3 is null && cfg.RootElement.GetProperty("width").GetInt32() == 32 && cfg.RootElement.GetProperty("height").GetInt32() == 24
                && cfg.RootElement.GetProperty("scale").GetDouble() == 0.5 && all.Count > configIndex + 1 && all[configIndex + 1].Type == 2 && (all[configIndex + 1].Flags & 1) == 1,
                "Scale change: new config with scaled size, followed by a keyframe");

            h.Run.UpdateSettings(3_000_000, 30, null);
            var configs = h.Records().Count(r => r.Type == 1);
            h.Run.Ack(h.Records().Last(r => r.Type == 2).Sequence, null);
            h.Source.Reset("generation-b-00000000000000");
            await Until(() => h.Records().Count(r => r.Type == 2) >= 4, 1000);
            var reset = h.Records(out var v4);
            check(v4 is null && reset.Count(r => r.Type == 1) == configs && (reset.Where(r => r.Type == 2).ElementAt(3).Flags & 1) == 1 && h.Encoders.Last().Bitrate == 3_000_000,
                "Generation change, same geometry: keyframe without a new config; bitrate applied at runtime");
            h.Run.Ack(h.Records().Last(r => r.Type == 2).Sequence, null);
            h.Source.Reset("generation-c-00000000000000", width: 50, height: 40);
            await Until(() => h.Records().Count(r => r.Type == 1) > configs, 1000);
            var resized = h.Records(out var v5);
            var newConfig = resized.FindLastIndex(r => r.Type == 1);
            using var cfg2 = JsonDocument.Parse(resized[newConfig].Payload);
            check(v5 is null && cfg2.RootElement.GetProperty("physicalWidth").GetInt32() == 50 && cfg2.RootElement.GetProperty("width").GetInt32() == 25
                && cfg2.RootElement.GetProperty("height").GetInt32() == 20 && resized.Count > newConfig + 1 && (resized[newConfig + 1].Flags & 1) == 1, "Geometry change: new config then keyframe");
            check(h.Encoders.Count >= 3 && h.Encoders.Take(h.Encoders.Count - 1).All(e => e.Disposed), "Encoder: replaced encoders are disposed");
        }

        await using (var h = new Harness(new SyntheticSource(65, 49)))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            using var cfg = JsonDocument.Parse(h.Records().First(r => r.Type == 1).Payload);
            check(cfg.RootElement.GetProperty("width").GetInt32() == 65 && cfg.RootElement.GetProperty("codedWidth").GetInt32() == 66 && cfg.RootElement.GetProperty("codedHeight").GetInt32() == 50,
                "Odd dimensions: display size kept, coded size padded to even");
        }

        var blocking = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, startBlocked: true);
        await using (blocking)
        {
            await Task.Delay(300);
            check(blocking.Run.EncodeCount <= 1 && blocking.Source.Gets <= 1, "Pending write: no further capture or encode while the socket write is blocked");
            blocking.Denial = VideoStreamDenial.Revoked;
            await Until(() => blocking.Aborts > 0, 1500);
            check(blocking.Aborts == 1 && blocking.Run.EndedCode == "access_revoked", "Pending write: undeliverable terminal is bounded, then the connection is aborted");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, firstSequence: uint.MaxValue - 3))
        {
            await Until(() => h.Records().Count(r => r.Type == 2) >= 2, 1000);
            h.Run.Ack(uint.MaxValue - 1, null);
            await Until(() => h.Running.IsCompleted, 1000);
            var records = h.Records(out var violation);
            check(violation is null && records.Last() is { Type: 4, Sequence: uint.MaxValue } last && TerminalCode(last) == "stream_restart", "Sequence: the stream ends with stream_restart instead of wrapping");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { FailAfter = 0 }))
        {
            await Until(() => h.Running.IsCompleted, 1000);
            check(h.Running.IsCompleted && h.Output.Snapshot().Length == 0 && h.Aborts == 1, "Encoder failure before the first config: abort, never a terminal-first stream");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { FailAfter = 1 }))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            h.Run.Ack(h.Records().Last(r => r.Type == 2).Sequence, null);
            await Until(() => h.Running.IsCompleted, 1000);
            check(h.Records(out var violation) is var r && violation is null && TerminalCode(r.Last()) == "stream_error" && h.Aborts == 0, "Encoder failure mid-stream: terminal stream_error");
        }

        var lost = new SyntheticSource(64, 48);
        await using (var h = new Harness(lost))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            lost.ReturnNull = true;
            await Until(() => h.Running.IsCompleted, 1500);
            var r = h.Records(out var violation);
            check(violation is null && h.Running.IsCompleted && TerminalCode(r.Last()) == "stream_error", "Lost source: bounded retries, then terminal stream_error");
        }

        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            await h.Connection.CancelAsync();
            await Until(() => h.Running.IsCompleted, 1000);
            check(h.Running.IsCompleted && h.Aborts == 0 && !h.Records().Any(r => r.Type == 4), "Client disconnect: loop ends without terminal or abort");
        }
    }

    private static async Task TailChecks(Action<bool, string> check)
    {
        check(VideoStreamRun.RefreshTailFrames == 15, "Tail: refresh tail length is the 15-frame constant");

        // Idle from the start: join keyframe only, then heartbeats; no tail.
        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Task.Delay(500);
            var r = h.Records(out var violation);
            check(violation is null && r.Count(x => x.Type == 2) == 1 && h.Run.TailEncodeCount == 0 && r.Count(x => x.Type == 3) >= 2, "Tail: none when the screen is idle from the start (join keyframe, then heartbeats)");
            await acks.CancelAsync(); await acking;
        }

        // One change: the change frame, exactly 15 tail re-encodes of the same pixels at the stream fps, then heartbeats.
        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            h.Source.Advance();
            await Until(() => h.Run.TailEncodeCount >= 15, 2000);
            await Task.Delay(400);
            var r = h.Records(out var violation);
            var units = r.Where(x => x.Type == 2).ToArray();
            var encoder = h.Encoders.Last();
            var changeInput = encoder.Inputs[1];
            check(violation is null && units.Length == 17 && h.Run.TailEncodeCount == 15 && h.Run.EncodeCount == 17 && units.Skip(1).All(x => (x.Flags & 1) == 0),
                $"Tail: one change yields the change frame plus exactly 15 tail deltas, then stops (units={units.Length}, tail={h.Run.TailEncodeCount})");
            check(encoder.Inputs.Count == 17 && encoder.Inputs.Skip(2).All(input => ReferenceEquals(input, changeInput)), "Tail: re-encodes reuse the retained immutable last frame (no new pixels)");
            var stamps = units.Skip(1).Select(x => x.Timestamp).ToArray();
            check(stamps[^1] - stamps[0] >= (ulong)((stamps.Length - 1) * 1_000_000 / 240 * 85 / 100), $"Tail: paced at the stream's current fps on average (240 fps: {stamps.Length} frames over {(stamps[^1] - stamps[0]) / 1000.0:0.0} ms)");
            var afterTail = r.Where(x => x.Sequence > units[^1].Sequence).ToArray();
            check(afterTail.Length >= 1 && afterTail.All(x => x.Type == 3), "Tail: heartbeats as before once the tail ends");
            await acks.CancelAsync(); await acking;
        }

        // A change during the tail restarts normal encoding and a fresh tail.
        await using (var h = new Harness(new SyntheticSource(64, 48), settings: new VideoStreamSettings(30, 2_000_000, 1)))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            h.Source.Advance();
            await Until(() => h.Run.TailEncodeCount >= 3, 2000);
            var partial = h.Run.TailEncodeCount;
            h.Source.Advance();
            await Until(() => h.Run.TailEncodeCount >= partial + 15, 3000);
            await Task.Delay(300);
            var units = h.Records(out var violation).Count(x => x.Type == 2);
            var tail = h.Run.TailEncodeCount;
            check(violation is null && partial < 15 && tail - partial is 15 or 16 && units == 3 + tail,
                $"Tail: a change during the tail is encoded normally and restarts the tail (first tail {partial}, total tail {tail}, units {units})");
            await acks.CancelAsync(); await acking;
        }

        // The tail obeys the count bound and skip-when-backed-up (no acks), then resumes after acks.
        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            h.Source.Advance();
            await Until(() => h.Run.InFlight >= 8, 1000);
            await Task.Delay(250);
            var gets = h.Source.Gets;
            check(h.Run.InFlight == 8 && h.Run.EncodeCount == 8 && h.Run.TailEncodeCount == 6, $"Tail: stops at the 8-unit count bound (tail {h.Run.TailEncodeCount})");
            await Task.Delay(200);
            check(h.Run.EncodeCount == 8 && h.Source.Gets == gets, "Tail: no encode or capture while backed up");
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Run.TailEncodeCount >= 15, 2000);
            await Task.Delay(200);
            check(h.Run.TailEncodeCount == 15, "Tail: resumes after acks and still totals 15");
            await acks.CancelAsync(); await acking;
        }

        // The tail obeys the byte bound: 10 KB deltas at 2 Mbit/s stop at 4 in flight.
        await using (var h = new Harness(new SyntheticSource(64, 48), factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { DeltaBytes = 10_000 }))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            h.Source.Advance();
            await Until(() => h.Run.InFlight >= 4, 1000);
            await Task.Delay(250);
            check(h.Run.InFlight == 4 && h.Run.TailEncodeCount == 2 && h.Run.InFlightBytes == 22 + 3 * 10_000, $"Tail: stops at the byte budget (tail {h.Run.TailEncodeCount}, bytes {h.Run.InFlightBytes})");
        }

        // A pending keyframe request is served as a keyframe, never as a tail delta.
        await using (var h = new Harness(new SyntheticSource(64, 48), settings: new VideoStreamSettings(30, 2_000_000, 1)))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            h.Source.Advance();
            await Until(() => h.Run.TailEncodeCount >= 3, 2000);
            var last = h.Records().Last(x => x.Type == 2).Sequence;
            h.Run.RequestKeyframe();
            await Until(() => h.Records().Count(x => x.Type == 2 && x.Sequence > last) >= 2, 1000);
            var next = h.Records(out var violation).Where(x => x.Type == 2 && x.Sequence > last).Take(2).ToArray();
            check(violation is null && next.Length == 2 && ((next[0].Flags & 1) == 1 || (next[1].Flags & 1) == 1),
                "Tail: a pending keyframe request is sent as a keyframe instead of a tail frame");
            await Until(() => h.Run.TailEncodeCount >= 15, 2000);
            await Task.Delay(200);
            check(h.Run.TailEncodeCount == 15, "Tail: the keyframe does not extend or restart the tail");
            await acks.CancelAsync(); await acking;
        }
    }

    /// <summary>Acknowledges the newest access unit every few milliseconds, like a viewer on a fast link.</summary>
    private static async Task AutoAck(Harness h, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                if (h.Records().LastOrDefault(x => x.Type == 2) is { } last) h.Run.Ack(last.Sequence, null);
                await Task.Delay(5, token);
            }
        }
        catch (OperationCanceledException) { }
    }

    private static async Task AuthorizationChecks(Action<bool, string> check)
    {
        foreach (var (denial, code) in new[] { (VideoStreamDenial.Revoked, "access_revoked"), (VideoStreamDenial.EndedByHost, "session_ended_by_host"),
            (VideoStreamDenial.OwnerEnded, "session_ended_by_host"),
            (VideoStreamDenial.PermissionChanged, "permission_changed"), (VideoStreamDenial.SessionEnded, "session_ended"), (VideoStreamDenial.IdentityUnavailable, "identity_rotated") })
        {
            await using var h = new Harness(new SyntheticSource(64, 48), timings: Fast with { AuthorizationMilliseconds = 250, HeartbeatMilliseconds = 60_000 });
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            var started = Environment.TickCount64;
            h.Denial = denial;
            await Until(() => h.Running.IsCompleted, 1500);
            var elapsed = Environment.TickCount64 - started;
            var records = h.Records(out var violation);
            check(violation is null && h.Running.IsCompleted && elapsed < 1000 && records.Last().Type == 4 && TerminalCode(records.Last()) == code && h.Aborts == 0,
                $"Authorization timer: {denial} ends an idle stream with terminal {code} within 1 s ({elapsed} ms)");
        }
        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            await h.Stopping.CancelAsync();
            await Until(() => h.Running.IsCompleted, 1000);
            check(h.Records(out var violation) is var r && violation is null && TerminalCode(r.Last()) == "host_stopping", "Host stop: terminal host_stopping");
        }
        await using (var h = new Harness(new SyntheticSource(64, 48)))
        {
            await Until(() => h.Records().Any(r => r.Type == 2), 1000);
            await h.Run.EndAsync("stream_replaced", "A newer stream replaced this one.");
            await Until(() => h.Running.IsCompleted, 1000);
            check(h.Records(out var violation) is var r && violation is null && TerminalCode(r.Last()) == "stream_replaced" && h.Aborts == 0, "Replacement: the older stream ends with terminal stream_replaced");
        }
    }

    private static async Task SourceAdapterChecks(Action<bool, string> check)
    {
        var gate = new SemaphoreSlim(1, 1);
        await using var platform = new FakePlatform();
        var adapter = new PlatformVideoFrameSource(platform, gate);
        var frame = await adapter.GetLatestAsync(Monitor, default);
        check(frame is { Width: 4, Height: 2, Left: -1920, MonitorId: "synthetic-1" } && gate.CurrentCount == 1, "Adapter: raw BGRA frames map through; the capture gate is held only per capture");
        check(frame!.Generation is null || frame.Version > 0, "Adapter: native identity is read only when the backend supplies it");
        var second = await adapter.GetLatestAsync(Monitor, default);
        check(frame.Generation is not null || !second!.SameContent(frame), "Adapter: versionless frames are never treated as unchanged");
        platform.Raw = null;
        check(await adapter.GetLatestAsync(Monitor, default) is null, "Adapter: encoded-only capture (RawBgra null) yields no stream frame (409 at open)");
        platform.Raw = new byte[5];
        check(await adapter.GetLatestAsync(Monitor, default) is null, "Adapter: mismatched raw buffer is refused");
        var started = Environment.TickCount64;
        await adapter.WaitForChangeAsync(frame with { Generation = null }, 5000, default);
        check(Environment.TickCount64 - started < 1000, "Adapter: versionless waits are short (paced by maxFps instead)");

        // The W6a bridge binds by name; this must hold both before W6a (no members) and after (members bound).
        var constructor = typeof(ScreenFrame).GetConstructors().Single();
        if (typeof(ScreenFrame).GetProperty("NativeGeneration") is null)
            check(NativeFrameIdentity.Read(new ScreenFrame([], 4, 2, 0, 0, DateTimeOffset.UtcNow, new byte[32], "m")) == (null, 0), "W6a bridge: without native members every frame is versionless");
        else
        {
            var native = (ScreenFrame)constructor.Invoke(constructor.GetParameters().Select(object? (p) => p.Name switch
            {
                "Png" => Array.Empty<byte>(), "Width" => 4, "Height" => 2, "Left" => 0, "Top" => 0, "CapturedUtc" => DateTimeOffset.UtcNow, "RawBgra" => new byte[32],
                "MonitorId" => "m", "NativeGeneration" => "generation-bridge-000000000", "NativeVersion" => 7L, _ => p.DefaultValue,
            }).ToArray());
            check(NativeFrameIdentity.Read(native) == ("generation-bridge-000000000", 7), "W6a bridge: native generation and version are read as a pair");
            var changeContract = typeof(IPlatformBackend).Assembly.GetType("Orbit.Host.Platform.IFrameChangeSource");
            if (changeContract is not null && OperatingSystem.IsWindows())
            {
                await using var windows = PlatformBackendFactory.Create(); // Constructing the backend captures nothing.
                check(!changeContract.IsInstanceOfType(windows) || NativeFrameIdentity.ChangeWaiter(windows) is not null, "W6a bridge: the backend's change wait binds when it implements IFrameChangeSource");
            }
        }
    }

    private static async Task HttpChecks(Action<bool, string> check)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        var source = new SyntheticSource(64, 48);
        var denial = 0; var available = true; var nullEncoder = false;
        using var stopping = new CancellationTokenSource();
        await using var platform = new FakePlatform();
        RemoteSession? Find(HttpContext _, string id) => id == "missing" ? null
            : new RemoteSession(id, id is "a" or "g" ? "d" : "device-" + id, "Device", null, new DevicePermissions(View: true), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1), DateTimeOffset.UtcNow);
        var gpuSource = new FakeGpuSource(Monitor);
        var slots = new VideoStreamSlots<VideoStreamRun>(8);
        var pointerFeed = new FakePointerFeed(); IPointerFeed? currentFeed = null;
        VideoStreamEndpoints.Map(app, Find, (_, _) => (VideoStreamDenial)Volatile.Read(ref denial), platform, source,
            (w, h, f, b) => nullEncoder ? null : new FakeEncoder(w, h, f), () => available, stopping.Token, slots, gpuSource, pointers: () => Volatile.Read(ref currentFeed));
        await app.StartAsync();
        // No response draining: closing a reader closes its connection at once, as a viewer disconnect does.
        using var client = new HttpClient(new SocketsHttpHandler { MaxResponseDrainSize = 0 }) { BaseAddress = new Uri(app.Urls.First()), Timeout = TimeSpan.FromSeconds(10) };
        async Task<HttpStatusCode> Status(string path) { using var r = await client.GetAsync(path, HttpCompletionOption.ResponseHeadersRead); return r.StatusCode; }
        async Task<string?> Code(string path) { using var r = await client.GetAsync(path); return r.StatusCode == HttpStatusCode.Conflict ? (await r.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() : null; }
        check(await Status("/api/sessions/missing/stream") == HttpStatusCode.NotFound, "HTTP: unknown session is 404");
        check(await Status("/api/sessions/a/stream?fps=60") == HttpStatusCode.BadRequest && await Status("/api/sessions/a/stream?scale=0.5&scale=1") == HttpStatusCode.BadRequest
            && await Status("/api/sessions/a/stream?maxFps=x") == HttpStatusCode.BadRequest && await Status("/api/sessions/a/stream?monitorId=" + new string('x', 129)) == HttpStatusCode.BadRequest,
            "HTTP: unknown, duplicate and malformed parameters are 400 before capture");
        check(await Code("/api/sessions/a/stream?codec=hvc1.1.6.L93") == "stream_unavailable", "HTTP: a non-H.264 codec is 409 stream_unavailable");
        available = false; check(await Code("/api/sessions/a/stream") == "stream_unavailable", "HTTP: no encoder capability is 409 stream_unavailable"); available = true;
        nullEncoder = true; check(await Code("/api/sessions/a/stream") == "stream_unavailable", "HTTP: encoder creation failure is 409 stream_unavailable"); nullEncoder = false;
        source.ReturnNull = true; check(await Code("/api/sessions/a/stream") == "stream_unavailable", "HTTP: no raw frame (encoded-only platform) is 409 stream_unavailable"); source.ReturnNull = false;
        foreach (var (d, status) in new[] { (VideoStreamDenial.OwnerEnded, HttpStatusCode.Forbidden), (VideoStreamDenial.Revoked, HttpStatusCode.Unauthorized), (VideoStreamDenial.EndedByHost, HttpStatusCode.Gone), (VideoStreamDenial.IdentityUnavailable, HttpStatusCode.ServiceUnavailable), (VideoStreamDenial.SessionEnded, HttpStatusCode.NotFound) })
        { denial = (int)d; check(await Status("/api/sessions/a/stream") == status, $"HTTP: open-time {d} is {(int)status}"); }
        denial = 0;
        check((await client.PostAsync("/api/sessions/a/stream/control", Json("{\"keyframe\":true}"))).StatusCode == HttpStatusCode.NotFound, "HTTP: control without an active stream is 404");

        var first = await RecordReader.OpenAsync(client, "/api/sessions/a/stream?monitorId=synthetic-1&maxFps=120");
        check(first.Response.StatusCode == HttpStatusCode.OK && first.Response.Content.Headers.ContentType?.MediaType == "application/vnd.orbit.stream", "HTTP: stream opens as application/vnd.orbit.stream");
        await first.ReadUntilAsync(r => r.Count(x => x.Type == 2) >= 1);
        check(first.Violation is null && first.Records[0].Type == 1 && first.Records[1] is { Type: 2, Flags: 1 }, "HTTP: config and keyframe arrive as soon as they are written (chunked, unbuffered)");
        check((await client.PostAsync("/api/sessions/a/stream/control", Json("{\"bogus\":1}"))).StatusCode == HttpStatusCode.BadRequest, "HTTP: malformed control body is 400");
        check((await client.PostAsync("/api/sessions/a/stream/control", Json("{\"keyframe\":true}"))).StatusCode == HttpStatusCode.NoContent, "HTTP: keyframe request is 204");
        await first.ReadUntilAsync(r => r.Count(x => x.Type == 2) >= 2);
        check(first.Records.Where(x => x.Type == 2).ElementAt(1).Flags == 1, "HTTP: requested keyframe arrives on the open stream");
        check(gpuSource.Opens == 0, "HTTP: a stream opened without cursor=local stays on the CPU path (cursor composited)");
        check(await Status("/api/sessions/g/stream?cursor=pointer") == HttpStatusCode.BadRequest, "HTTP: cursor must be video or local");
        using (var noPointer = await RecordReader.OpenAsync(client, "/api/sessions/g/stream?monitorId=synthetic-1&cursor=local"))
        {
            await noPointer.ReadUntilAsync(r => r.Any(x => x.Type == 2));
            check(noPointer.Response.StatusCode == HttpStatusCode.OK && noPointer.Records.Count >= 2 && gpuSource.Opens == 0,
                "HTTP: cursor=local without a pointer feed stays on the CPU path (composited cursor, never cursorless)");
        }
        await Until(() => slots.Count == 1, 2000);
        Volatile.Write(ref currentFeed, pointerFeed);
        using (var gpuStream = await RecordReader.OpenAsync(client, "/api/sessions/g/stream?monitorId=synthetic-1&cursor=local"))
        {
            await gpuStream.ReadUntilAsync(r => r.Any(x => x.Type == 2));
            check(gpuStream.Response.StatusCode == HttpStatusCode.OK && gpuStream.Violation is null && gpuStream.Records[0].Type == 1 && gpuStream.Records[1] is { Type: 2, Flags: 1 }
                && gpuSource.Opens == 1 && gpuSource.Encodes > 0, "HTTP: cursor=local streams from the GPU source (config, then a GPU keyframe)");
            await gpuStream.ReadUntilAsync(r => r.Any(x => x.Type == 5));
            check(gpuStream.Violation is null && gpuStream.Records.FirstOrDefault(x => x.Type == 5) is { } cursorRecord && Cursor(cursorRecord).HasShape && Cursor(cursorRecord).Visible,
                "HTTP: the GPU stream carries type-5 pointer records (first with its shape)");
        }
        await Until(() => slots.Count == 1, 2000);
        check(slots.Count == 1 && gpuSource.Disposed == 1, "HTTP: closing the GPU stream frees its slot and disposes its GPU encoder");
        gpuSource.Unavailable = true;
        using (var fallback = await RecordReader.OpenAsync(client, "/api/sessions/g/stream?monitorId=synthetic-1&cursor=local"))
        {
            await fallback.ReadUntilAsync(r => r.Any(x => x.Type == 2));
            check(fallback.Response.StatusCode == HttpStatusCode.OK && fallback.Violation is null && fallback.Records[1] is { Type: 2, Flags: 1 } && gpuSource.Opens == 1,
                "HTTP: cursor=local with no GPU encoder available opens on the CPU path instead of failing");
        }
        await Until(() => slots.Count == 1, 2000);
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 64; i++) statuses.Add((await client.PostAsync("/api/sessions/a/stream/control?monitorId=synthetic-1", Json("{\"ack\":0}"))).StatusCode);
        check(statuses.Contains(HttpStatusCode.TooManyRequests) && statuses.Count(s => s == HttpStatusCode.NoContent) <= 60, "HTTP: more than 60 control requests per second are 429");

        var replacement = await RecordReader.OpenAsync(client, "/api/sessions/a/stream?monitorId=synthetic-1");
        await first.ReadUntilAsync(r => r.Any(x => x.Type == 4));
        await replacement.ReadUntilAsync(r => r.Any(x => x.Type == 2));
        check(first.Violation is null && first.Records.Last().Type == 4 && TerminalCode(first.Records.Last()) == "stream_replaced" && first.Ended
            && replacement.Records.FirstOrDefault()?.Type == 1, "HTTP: a new stream for the same session+monitor ends the older one with stream_replaced");

        var others = new List<RecordReader>();
        for (var i = 0; i < 7; i++) others.Add(await RecordReader.OpenAsync(client, $"/api/sessions/s{i}/stream"));
        check(others.All(o => o.Response.StatusCode == HttpStatusCode.OK) && await Status("/api/sessions/s9/stream") == HttpStatusCode.TooManyRequests, "HTTP: the ninth concurrent stream on a host is 429");

        Volatile.Write(ref denial, (int)VideoStreamDenial.Revoked);
        var started = Environment.TickCount64;
        await replacement.ReadUntilAsync(r => r.Any(x => x.Type == 4));
        check(replacement.Violation is null && TerminalCode(replacement.Records.Last()) == "access_revoked" && Environment.TickCount64 - started < 1000 && replacement.Ended,
            "HTTP: revocation during a stream delivers terminal access_revoked within 1 s and closes the response");
        foreach (var other in others) other.Dispose();
        first.Dispose(); replacement.Dispose();
        await stopping.CancelAsync();
        await app.StopAsync();
    }

    private static async Task PerformanceChecks(Action<bool, string> check)
    {
        // 2:1 fast path matches a reference 2x2 box average (it rounds; the reference truncates, so within 1).
        var random = new Random(11);
        var source = new byte[64 * 48 * 4]; random.NextBytes(source);
        var half = VideoFrameScaler.Resize(source, 64, 48, 32, 24);
        var within = true;
        for (var y = 0; y < 24; y++)
            for (var x = 0; x < 32; x++)
                for (var c = 0; c < 3; c++)
                {
                    int Px(int sx, int sy) => source[(sy * 64 + sx) * 4 + c];
                    var reference = (Px(2 * x, 2 * y) + Px(2 * x + 1, 2 * y) + Px(2 * x, 2 * y + 1) + Px(2 * x + 1, 2 * y + 1)) / 4;
                    within &= Math.Abs(half[(y * 32 + x) * 4 + c] - reference) <= 1 && half[(y * 32 + x) * 4 + 3] == 255;
                }
        check(within, "Scale: the 2:1 fast path equals a 2x2 box average within rounding, alpha 255");
        var third = VideoFrameScaler.Resize(source, 64, 48, 21, 16);
        check(third.Length == 21 * 16 * 4, "Scale: non-2:1 reductions keep the general box filter");

        // Pacing precision: Task.Delay rounds to the ~15.6 ms Windows tick; the pacing wait must not.
        var waits = new double[20];
        for (var i = 0; i < waits.Length; i++) { var t = System.Diagnostics.Stopwatch.GetTimestamp(); await PreciseDelay.WaitAsync(5_000, default); waits[i] = System.Diagnostics.Stopwatch.GetElapsedTime(t).TotalMilliseconds; }
        check(waits.Average() is >= 4.5 and < 9, $"Pacing: a 5 ms pacing wait takes {waits.Average():0.0} ms on average (not a 15.6 ms timer tick)");
        using (var cancelled = new CancellationTokenSource(20))
            check(await ThrowsAsync(() => PreciseDelay.WaitAsync(5_000_000, cancelled.Token)), "Pacing: a pacing wait is cancellable");

        // The loop alone (fake encoder, no capture) sustains the 60 fps target at 1280x720 from a 2560x1440 source.
        var frames = Enumerable.Range(0, 2).Select(i => { var f = new byte[2560 * 1440 * 4]; f.AsSpan().Fill((byte)(40 + i * 80)); return f; }).ToArray();
        await using var h = new Harness(new CyclingSource(frames, 2560, 1440), settings: new VideoStreamSettings(60, 8_000_000, 0.5), timings: new VideoStreamTimings());
        using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
        await Task.Delay(500);
        var startUnits = h.Run.EncodeCount; var started = System.Diagnostics.Stopwatch.GetTimestamp();
        await Task.Delay(2000);
        var fps = (h.Run.EncodeCount - startUnits) / System.Diagnostics.Stopwatch.GetElapsedTime(started).TotalSeconds;
        await acks.CancelAsync(); await acking;
        using var cfg = JsonDocument.Parse(h.Records().First(r => r.Type == 1).Payload);
        check(fps >= 55 && cfg.RootElement.GetProperty("width").GetInt32() == 1280, $"Performance: the stream loop sustains {fps:0.0} fps at 1280x720 (2560x1440 source, scale 0.5, maxFps 60; target >= 55)");
    }

    private static async Task GpuChecks(Action<bool, string> check)
    {
        // Join, change and refresh tail on the GPU path: no CPU capture at all.
        var gpu = new FakeGpuSource(Monitor);
        var cpu = new SyntheticSource(64, 48);
        await using (var h = new Harness(cpu, gpu: gpu))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            using (var cfg = JsonDocument.Parse(h.Records().First(r => r.Type == 1).Payload))
                check(h.Run.UsingGpu && h.Records(out var v0) is { Count: >= 2 } r0 && v0 is null && r0[1] is { Type: 2, Flags: 1 } && cpu.Gets == 0 && h.Encoders.Count == 0
                    && cfg.RootElement.GetProperty("width").GetInt32() == 64 && cfg.RootElement.GetProperty("physicalLeft").GetInt32() == -1920,
                    "GPU: join is a config plus a GPU keyframe; no CPU capture or CPU encoder");
            await Task.Delay(300);
            check(h.Records().Count(x => x.Type == 2) == 1 && h.Run.TailEncodeCount == 0 && h.Records().Any(x => x.Type == 3), "GPU: an idle screen gets no tail, only heartbeats");
            gpu.Advance();
            await Until(() => h.Run.TailEncodeCount >= 15, 2000);
            await Task.Delay(300);
            var units = h.Records(out var violation).Where(x => x.Type == 2).ToArray();
            check(violation is null && units.Length == 17 && h.Run.TailEncodeCount == 15 && gpu.Lasts == 15 && units.Skip(1).All(x => (x.Flags & 1) == 0),
                $"GPU: a change is encoded from the next image, then the refresh tail re-encodes the last image 15 times (units {units.Length}, re-encodes {gpu.Lasts})");
            var lastSequence = units[^1].Sequence;
            h.Run.RequestKeyframe();
            await Until(() => h.Records().Any(x => x.Type == 2 && x.Sequence > lastSequence), 1000);
            check(h.Records().First(x => x.Type == 2 && x.Sequence > lastSequence).Flags == 1 && gpu.LastKeyframes >= 1, "GPU: a keyframe request on a still screen re-encodes the last image as a keyframe");
            var configs = h.Records().Count(x => x.Type == 1);
            lastSequence = h.Records().Last(x => x.Type == 2).Sequence;
            gpu.Reset("generation-gpu-b-0000000000");
            await Until(() => h.Records().Any(x => x.Type == 2 && x.Sequence > lastSequence), 1000);
            check(h.Records().First(x => x.Type == 2 && x.Sequence > lastSequence).Flags == 1 && h.Records().Count(x => x.Type == 1) == configs,
                "GPU: a new generation with the same geometry is sent as a keyframe, without a new config");
            h.Run.UpdateSettings(null, null, 0.5);
            await Until(() => h.Records().Count(x => x.Type == 1) > configs, 1000);
            var all = h.Records(out var v2); var at = all.FindLastIndex(x => x.Type == 1);
            using (var cfg = JsonDocument.Parse(all[at].Payload))
                check(v2 is null && gpu.Opens == 2 && gpu.Disposed == 1 && cfg.RootElement.GetProperty("width").GetInt32() == 32 && all.Count > at + 1 && all[at + 1].Flags == 1,
                    "GPU: a scale change reopens the GPU encoder at the new size; new config, then keyframe");
            check(h.Logs.Count == 0 && h.Run.GpuFallbackReason is null, "GPU: no fallback is logged while the GPU path works");
            await acks.CancelAsync(); await acking;
        }

        // The GPU path obeys the in-flight window (count bound) and calls nothing while backed up.
        gpu = new FakeGpuSource(Monitor);
        await using (var h = new Harness(new SyntheticSource(64, 48), gpu: gpu))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            gpu.Advance();
            await Until(() => h.Run.InFlight >= 8, 1000);
            await Task.Delay(250);
            var calls = gpu.Calls;
            await Task.Delay(200);
            check(h.Run.InFlight == 8 && h.Run.GpuEncodeCount == 8 && gpu.Calls == calls, $"GPU: stops at the 8-unit window and makes no GPU calls while backed up (encodes {h.Run.GpuEncodeCount})");
        }

        // The GPU path obeys the byte budget: 10 KB GPU deltas at 2 Mbit/s stop at 4 in flight.
        gpu = new FakeGpuSource(Monitor) { DeltaBytes = 10_000 };
        await using (var h = new Harness(new SyntheticSource(64, 48), gpu: gpu))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            gpu.Advance();
            await Until(() => h.Run.InFlight >= 4, 1000);
            await Task.Delay(250);
            check(h.Run.InFlight == 4 && h.Run.InFlightBytes == gpu.KeyframeLength + 3 * 10_000, $"GPU: stops at the byte budget ({h.Run.InFlightBytes} bytes in flight)");
        }

        // A GPU path slower than the frame budget (Windows on ARM: ~66 ms a frame) hands the stream to the CPU path, and the
        // verdict holds for later streams on the same GPU source.
        gpu = new FakeGpuSource(Monitor) { EncodeMilliseconds = 66 };
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: gpu))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            for (var i = 0; i < 160 && h.Run.UsingGpu; i++) { gpu.Advance(); await Task.Delay(20); }
            await Until(() => !h.Run.UsingGpu, 2000);
            var gpuEncodes = gpu.Encodes;
            await Task.Delay(200);
            check(!h.Run.UsingGpu && h.Run.SlowGpuMedianMilliseconds is 66 && h.Run.GpuFallbackReason?.Contains("median 66 ms") == true && h.Logs.Count == 1
                && gpuEncodes >= GpuEncodeHealthWindow.WarmupEncodes + VideoStreamRun.SlowGpuSamples && gpu.Encodes == gpuEncodes && h.Records(out var slowViolation).Count(x => x.Type == 1) >= 2 && slowViolation is null,
                $"GPU: a median encode above the frame budget moves the stream to the CPU path (after {gpuEncodes} GPU encodes, fresh config)");
            await acks.CancelAsync(); await acking;
        }
        await using (var h = new Harness(new SyntheticSource(64, 48), gpu: gpu))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            check(!h.Run.UsingGpu && gpu.Opens == 1 && h.Run.GpuFallbackReason is not null, "GPU: a later stream on the same slow GPU starts on the CPU path without opening the GPU encoder");
        }
        gpu = new FakeGpuSource(Monitor) { EncodeMilliseconds = 30 }; // the ARM GPU path after the sliced capture wait
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: gpu))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            for (var i = 0; i < 90; i++) { gpu.Advance(); await Task.Delay(20); }
            check(h.Run.UsingGpu && gpu.Encodes > VideoStreamRun.SlowGpuSamples && h.Run.LastGpuMedianMilliseconds is 30 && h.Run.SlowGpuMedianMilliseconds is null, "GPU: a measured steady30ms median (still faster than the CPU path there) keeps the GPU path");
            await acks.CancelAsync(); await acking;
        }

        gpu = new FakeGpuSource(Monitor) { EncodeMilliseconds = 15, SlowStartEncodes = 10, SlowStartMilliseconds = 120 };
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: gpu))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            for (var i = 0; i < 90; i++) { gpu.Advance(); await Task.Delay(20); }
            check(h.Run.UsingGpu && gpu.Encodes > GpuEncodeHealthWindow.WarmupEncodes + VideoStreamRun.SlowGpuSamples && h.Run.LastGpuMedianMilliseconds is 15 && h.Run.SlowGpuMedianMilliseconds is null && h.Logs.Count == 0,
                "GPU: ten startup encodes at120ms followed by15ms deltas keep the stream on the GPU path");
            await acks.CancelAsync(); await acking;
        }

        // 1 ms timer resolution is held exactly while streams run (reference-counted across concurrent streams).
        var usersBefore = TimerResolution.Users;
        await using (var first = new Harness(new SyntheticSource(64, 48)))
        await using (var second = new Harness(new SyntheticSource(64, 48)))
        {
            await Until(() => first.Records().Any(x => x.Type == 2) && second.Records().Any(x => x.Type == 2), 1000);
            check(TimerResolution.Users == usersBefore + (OperatingSystem.IsWindows() ? 2 : 0), "Timer: running streams hold the timer resolution only on Windows");
        }
        await Until(() => TimerResolution.Users == usersBefore, 1000);
        check(TimerResolution.Users == usersBefore, "Timer: ended streams release the timer resolution");

        // Unavailable GPU encoder: CPU path from the start, logged once.
        gpu = new FakeGpuSource(Monitor) { Unavailable = true };
        await using (var h = new Harness(new SyntheticSource(64, 48), gpu: gpu))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            await Task.Delay(200);
            check(!h.Run.UsingGpu && h.Run.GpuFallbackReason is not null && h.Logs.Count == 1 && h.Encoders.Count == 1 && h.Records(out var v) is { Count: >= 2 } r && v is null && r[1].Flags == 1,
                "GPU: an unavailable GPU encoder falls back to the CPU path (logged once)");
        }

        // GPU failure mid-stream: the same stream continues on the CPU path with a fresh config and keyframe.
        gpu = new FakeGpuSource(Monitor) { FailAfter = 3 };
        var changing = new SyntheticSource(64, 48) { AutoAdvance = true };
        await using (var h = new Harness(changing, gpu: gpu))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            gpu.Advance(); await Task.Delay(30); gpu.Advance(); await Task.Delay(30); gpu.Advance();
            await Until(() => h.Encoders.Count == 1 && h.Records().Count(x => x.Type == 1) >= 2, 1500);
            await Task.Delay(200);
            var records = h.Records(out var violation);
            var cpuConfig = records.FindIndex(1, x => x.Type == 1);
            check(violation is null && !h.Run.UsingGpu && h.Logs.Count == 1 && h.Run.GpuEncodeCount == 3 && cpuConfig > 0 && records[cpuConfig + 1] is { Type: 2, Flags: 1 }
                && records.Count(x => x.Type == 2) > 5 && !records.Any(x => x.Type == 4) && gpu.Disposed == 1,
                $"GPU: a GPU failure mid-stream switches to the CPU path with a new config and keyframe, no terminal, logged once (GPU encodes {h.Run.GpuEncodeCount})");
            await acks.CancelAsync(); await acking;
        }
    }

    private static async Task GpuRecoveryChecks(Action<bool, string> check)
    {
        StreamRecoveryChecks.Run(check);
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true }; var feed = new FakePointerFeed();
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu, pointers: feed,
                timings: Fast with { MaximumUnackedAccessUnits = 1 });
            await Until(() => h.Run.InFlight == 1 && feed.Calls > 0, 1000);
            var calls = gpu.Calls; var pointerCalls = feed.Calls;
            feed.ReturnNull = true; gpu.Reset("generation-pointer-reset-first");
            await Until(() => feed.Calls >= pointerCalls + 3, 1000);
            check(h.Run.UsingGpu && gpu.Calls == calls && h.Run.GpuFallbackReason is null,
                "GPU recovery: pointer sees reset first while receipts are blocked; no GPU work or permanent cursor fallback occurs");
            feed.ReturnNull = false;
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Run.GpuRecoveryCount == 1, 2000);
            check(h.Run.UsingGpu && h.Run.GpuRecoveryCount == 1 && h.Run.GpuFallbackReason is null,
                "GPU recovery: the first receipt releases reset detection and GPU recovery with local cursor still available");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true, ResetFailureCode = "capture-lost", ReopenCooldownMilliseconds = 10_000 };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            gpu.Reset("generation-producer-cooldown");
            await Until(() => !h.Run.UsingGpu && h.Records().Count(record => record.Type == 1) >= 2, 2000);
            check(!h.Run.UsingGpu && h.Run.GpuRecoveryCount == 0 && gpu.Opens == 3 && gpu.Disposed == 1 && h.Encoders.Count == 1,
                "GPU recovery: capture-lost producer cooldown rejects both GPU reopens and selects fresh CPU video");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true, ResetFailureCode = "device-lost" };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            gpu.Reset("generation-typed-recovery");
            await Until(() => h.Run.GpuRecoveryCount == 1, 2000);
            check(h.Run.UsingGpu && h.Run.GpuRecoveryCount == 1 && gpu.Opens == 2 && gpu.Disposed == 1,
                "GPU recovery: synthetic future device-lost code replaces the failed encoder (no current native producer emits this code)");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            for (var reset = 1; reset <= 3; reset++)
            {
                gpu.Reset("generation-flapping-" + reset);
                await Until(() => !h.Run.UsingGpu || h.Run.GpuRecoveryCount >= reset, 2000);
            }
            check(!h.Run.UsingGpu && h.Run.GpuRecoveryCount == 2 && gpu.Opens == 3 && gpu.Disposed == 3
                && h.Run.GpuFallbackReason?.Contains("twice within ten seconds") == true,
                "GPU recovery: repeated loss immediately after a replacement keyframe trips the bounded circuit instead of reopening forever");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true, ReopenDelayMilliseconds = 100 };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu,
                timings: Fast with { HeartbeatMilliseconds = 50 });
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            var beforeRecovery = h.Records().Count;
            gpu.RejectedOpensRemaining = 2; gpu.Reset("generation-slow-reopens");
            await Until(() => !h.Run.UsingGpu && h.Records().Count(record => record.Type == 1) >= 2, 2000);
            var duringRecovery = h.Records().Skip(beforeRecovery).TakeWhile(record => record.Type != 1).ToList();
            check(duringRecovery.Count(record => record.Type == 3) >= 2 && !h.Running.IsCompleted,
                "GPU recovery: heartbeats follow each bounded slow rejected reopen, preserving the established stream until CPU fallback");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            gpu.RejectFirstReopenedEncodeRemaining = 2;
            gpu.Reset("generation-no-first-keyframe");
            await Until(() => !h.Run.UsingGpu, 2000);
            check(!h.Run.UsingGpu && gpu.Opens == 3 && h.Run.GpuRecoveryCount == 0 && h.Run.GpuFallbackReason?.Contains("twice within ten seconds") == true,
                "GPU recovery: two encoders that open but fail before their first keyframe count as failed reopens, not successful recovery");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true }; var feed = new DeferredRecoveryPointerFeed();
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu, pointers: feed);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            feed.Arm(); await feed.Started.Task.WaitAsync(TimeSpan.FromSeconds(1));
            gpu.Reset("generation-pointer-recovered");
            await Until(() => h.Records().Count(record => record.Type == 1) >= 2, 2000);
            feed.CompleteStaleNull(); await Task.Delay(100);
            check(h.Run.UsingGpu && h.Run.GpuRecoveryCount == 1 && h.Run.GpuFallbackReason is null,
                "GPU recovery: a pre-reset pointer read completing late cannot force the recovered stream onto CPU");
            await acks.CancelAsync(); await acking;
        }
        foreach (var rejectedOpens in new[] { 0, 1, 2 })
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true };
            await using var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: gpu, pointers: new FakePointerFeed());
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            gpu.RejectedOpensRemaining = rejectedOpens;
            gpu.Reset("generation-recovered-0000000");
            await Until(() => h.Records().Count(record => record.Type == 1) >= 2, 2000);
            var records = h.Records(out var violation);
            var nextConfig = records.FindIndex(1, record => record.Type == 1);
            check(violation is null && nextConfig > 0 && records.Skip(nextConfig + 1).FirstOrDefault() is { Type: 2, Flags: 1 },
                $"GPU recovery: {rejectedOpens} rejected reopens lead to a fresh config and keyframe, never an old-generation delta");
            if (rejectedOpens < 2)
                check(h.Run.UsingGpu && h.Run.GpuRecoveryCount == 1 && h.Encoders.Count == 0 && gpu.Opens == rejectedOpens + 2 && gpu.Disposed == 1,
                    $"GPU recovery: {rejectedOpens} rejected reopens retain the GPU path/local-cursor capability with one new encoder");
            else
                check(!h.Run.UsingGpu && h.Run.GpuFallbackReason?.Contains("twice within ten seconds") == true && gpu.Opens == 3 && h.Encoders.Count == 1,
                    "GPU recovery: only two failed reopens in the bounded window cause CPU fallback");
            await acks.CancelAsync(); await acking;
        }
        {
            var gpu = new FakeGpuSource(Monitor) { ThrowOnReset = true };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(record => record.Type == 2), 1000);
            h.Denial = VideoStreamDenial.Revoked;
            gpu.Reset("generation-denied-0000000000");
            await Until(() => h.Running.IsCompleted, 1000);
            check(h.Run.EndedCode == "access_revoked" && gpu.Opens == 1 && h.Run.GpuRecoveryCount == 0,
                "GPU recovery: revocation blocks encoder reopen and remains terminal");
            await acks.CancelAsync(); await acking;
        }
    }

    private static async Task AccessUnitChecks(Action<bool, string> check)
    {
        byte[] Nal(params byte[] bytes) => [0, 0, 0, 1, .. bytes];
        byte[] Join(params byte[][] parts) => parts.SelectMany(part => part).ToArray();
        var qualcomm = Join(Nal(0x09, 0xF0), Nal(0x67, 0x4D, 0x40, 0x28), Nal(0x68, 0xEE), Nal(0x65, 0x88, 0x84), Nal(0x09, 0xF0), Nal(0x41, 0x9A, 0x02));
        var split = VideoStreamRecords.SplitAccessUnits(qualcomm);
        check(split.Count == 2 && split[0].Keyframe && !split[1].Keyframe && split[0].Data.Length + split[1].Data.Length == qualcomm.Length && split[1].Data[4] == 0x09,
            "AU split: NAL 9,7,8,5,9,1 (two pictures in one output) becomes a keyframe AU and a delta AU");
        var noDelimiter = VideoStreamRecords.SplitAccessUnits(Join(Nal(0x67, 0x4D, 0x40, 0x28), Nal(0x68, 0xEE), Nal(0x65, 0x88), Nal(0x41, 0x9A)));
        check(noDelimiter.Count == 2 && noDelimiter[0].Keyframe && !noDelimiter[1].Keyframe, "AU split: without delimiters, a slice with first_mb_in_slice 0 starts the next picture");
        var slices = VideoStreamRecords.SplitAccessUnits(Join(Nal(0x65, 0x88), Nal(0x65, 0x40), Nal(0x65, 0x20)));
        check(slices.Count == 1 && slices[0].Keyframe, "AU split: further slices of the same picture stay in one AU");
        var sei = VideoStreamRecords.SplitAccessUnits(Join(Nal(0x41, 0x9A), Nal(0x06, 0x05), Nal(0x41, 0x9A)));
        check(sei.Count == 2 && sei[1].Data[4] == 0x06, "AU split: SEI after a picture opens the next AU");
        check(VideoStreamRecords.SplitAccessUnits(FakeEncoder.Keyframe).Count == 1 && VideoStreamRecords.SplitAccessUnits([]).Count == 1, "AU split: a single picture is returned as is");

        // Qualcomm-like encoder: no output for the first input, then two pictures: two records, consecutive sequences.
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { HoldFirst = true }))
        {
            await Until(() => h.Records().Count(r => r.Type == 2) >= 2, 1000);
            var r = h.Records(out var violation);
            var units = r.Where(x => x.Type == 2).ToArray();
            check(violation is null && r[0].Type == 1 && units[0].Flags == 1 && units[1].Sequence == units[0].Sequence + 1 && h.Run.EncodeCount >= 2,
                "Multi-AU: nothing for the first input, then each of the two pictures is its own record with its own sequence");
            await Task.Delay(200);
            check(h.Run.InFlight == 8 && h.Records().Count(x => x.Type == 2) == 8, "Multi-AU: the window counts every access unit (8 in flight)");
        }

        // An encoder that holds the join picture on a still screen: drained when idle, never a stall.
        FakeEncoder? held = null;
        await using (var h = new Harness(new SyntheticSource(64, 48), factory: (w, ht, f, b) => held = new FakeEncoder(w, ht, f) { OneBehind = true }))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            var r = h.Records(out var violation);
            check(violation is null && r.Count(x => x.Type == 2) == 1 && r.First(x => x.Type == 2).Flags == 1 && held!.Flushes == 0 && held.Inputs.Count == 2,
                "Zero AUs: a picture the encoder holds on an idle screen is pushed out by one re-encode of the last frame (no stall, no Flush)");
            await Task.Delay(300);
            check(held!.Inputs.Count == 2, "Zero AUs: the push happens once, not at the frame rate");
        }

        // A batch is never split across captures: with room for one, the second unit waits for an ack (bounded).
        var source = new SyntheticSource(64, 48) { AutoAdvance = true };
        await using (var h = new Harness(source, timings: Fast with { MaximumUnackedAccessUnits = 1, BatchWaitMilliseconds = 400, HeartbeatMilliseconds = 60_000 },
            factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { HoldFirst = true }))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            await Task.Delay(150);
            var gets = source.Gets;
            check(h.Records().Count(x => x.Type == 2) == 1 && h.Run.EncodeCount == 2, "Batch: with a full window, the rest of the batch waits instead of being sent");
            h.Run.Ack(h.Records().Last(x => x.Type == 2).Sequence, null);
            await Until(() => h.Records().Count(x => x.Type == 2) >= 2, 300);
            check(h.Records().Count(x => x.Type == 2) == 2 && source.Gets == gets, "Batch: an ack releases the rest of the batch before any new capture");
        }
        source = new SyntheticSource(64, 48) { AutoAdvance = true };
        await using (var h = new Harness(source, timings: Fast with { MaximumUnackedAccessUnits = 1, BatchWaitMilliseconds = 300, HeartbeatMilliseconds = 60_000 },
            factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { HoldFirst = true }))
        {
            await Until(() => h.Records().Count(x => x.Type == 2) >= 2, 1500);
            check(h.Records(out var violation).Count(x => x.Type == 2) == 2 && violation is null && h.Run.EncodeCount == 2, "Batch: without acks the wait is bounded, then the batch completes (never dropped or split)");
        }

        // Batch fence: at most 64 units and 16 MiB per encode. GPU: that encoder is dropped for the CPU path; CPU: stream_error.
        foreach (var (units, bytes, label) in new[] { (65, 0, "65 access units"), (3, 6 * 1024 * 1024, "18 MiB in one batch") })
        {
            var gpu = new FakeGpuSource(Monitor) { BatchUnits = units, BatchUnitBytes = bytes };
            await using var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: gpu);
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            gpu.Advance();
            await Until(() => !h.Run.UsingGpu && h.Records().Count(x => x.Type == 1) >= 2, 1500);
            var r = h.Records(out var violation);
            check(violation is null && !h.Run.UsingGpu && h.Logs.Count == 1 && h.Logs[0].Contains("oversized") && r.Count(x => x.Type == 2 && x.Payload.Length > 1000) == 0
                && r.FindIndex(1, x => x.Type == 1) is var cpu && cpu > 0 && r[cpu + 1] is { Type: 2, Flags: 1 },
                $"Batch fence: a GPU batch of {label} is not sent; the stream falls back to the CPU path (typed, logged once)");
            await acks.CancelAsync(); await acking;
        }
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => new FakeEncoder(w, ht, f) { BatchUnits = 65 }))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Running.IsCompleted, 1500);
            var r = h.Records(out var violation);
            check(violation is null && TerminalCode(r.Last()) == "stream_error" && r.Count(x => x.Type == 2) == 1, "Batch fence: a CPU encoder batch over 64 units ends the stream with stream_error, nothing of it sent");
            await acks.CancelAsync(); await acking;
        }

        // Reconfiguration drains the old encoder under the old config, then the new config and a keyframe.
        var encoders = new List<FakeEncoder>();
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, factory: (w, ht, f, b) => { var e = new FakeEncoder(w, ht, f) { OneBehind = true }; encoders.Add(e); return e; }))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Count(x => x.Type == 2) >= 3, 1000);
            h.Run.UpdateSettings(null, null, 0.5);
            await Until(() => h.Records().Count(x => x.Type == 1) >= 2 && h.Records().SkipWhile(x => x.Type != 1).Skip(1).SkipWhile(x => x.Type != 1).Any(x => x.Type == 2), 1000);
            var r = h.Records(out var violation);
            var second = r.FindIndex(1, x => x.Type == 1);
            check(violation is null && encoders.Count >= 2 && encoders[0].Flushes == 1 && second > 0 && r.Take(second).Last(x => x.Type != 3).Type == 2 && r[second + 1] is { Type: 2, Flags: 1 },
                "Drain on reconfiguration: held pictures are sent under the old config before the new config and keyframe");
            await acks.CancelAsync(); await acking;
        }

        // GPU output carrying two pictures: two records (from the pictures list or by splitting the concatenation).
        foreach (var listed in new[] { false, true })
        {
            var gpu = new FakeGpuSource(Monitor) { TwoPictures = true, ListPictures = listed };
            await using var h = new Harness(new SyntheticSource(64, 48), gpu: gpu);
            await Until(() => h.Records().Count(x => x.Type == 2) >= 2, 1000);
            var units = h.Records(out var violation).Where(x => x.Type == 2).ToArray();
            check(violation is null && units.Length >= 2 && units[0].Flags == 1 && units[1].Flags == 0 && units[1].Sequence == units[0].Sequence + 1 && h.Run.GpuEncodeCount == 1,
                $"Multi-AU: one GPU output with two pictures becomes two records ({(listed ? "authoritative Units" : "legacy concatenation split by the stream")})");
        }
    }

    private static async Task CursorChecks(Action<bool, string> check)
    {
        check(!VideoStreamEndpoints.CanLocalCursor(new FakePlatform()), "Capability: canLocalCursor stays false until the viewer side ships (and needs a pointer feed + GPU source)");
        var feed = new FakePointerFeed();
        var gpu = new FakeGpuSource(Monitor);
        await using (var h = new Harness(new SyntheticSource(64, 48), gpu: gpu, pointers: feed))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 5), 1000);
            var r = h.Records(out var violation);
            var first = r.First(x => x.Type == 5);
            check(violation is null && r.FindIndex(x => x.Type == 5) > r.FindIndex(x => x.Type == 1) && Cursor(first) is { X: -1900, Y: 10, Visible: true, ShapeId: "arrow-1", HasShape: true } && h.Run.LocalCursorActive,
                "Cursor: the first pointer record follows the config and carries its shape (viewer-valid)");
            var count = h.Records().Count(x => x.Type == 5); var calls = feed.Calls;
            await Task.Delay(200);
            check(h.Records().Count(x => x.Type == 5) == count && feed.Calls > calls + 5, "Cursor: an unchanged pointer is polled but not re-sent (host-side dedup)");
            feed.Set(x: -1890);
            await Until(() => h.Records().Count(x => x.Type == 5) > count, 500);
            check(Cursor(h.Records().Last(x => x.Type == 5)) is { X: -1890, HasShape: false }, "Cursor: a move is sent without the already-known shape");

            count = h.Records().Count(x => x.Type == 5);
            var started = Environment.TickCount64;
            while (Environment.TickCount64 - started < 500) { feed.Set(x: -1900 + (int)(Environment.TickCount64 % 40)); await Task.Delay(1); }
            var sent = h.Records().Count(x => x.Type == 5) - count; var elapsed = (Environment.TickCount64 - started) / 1000.0;
            check(sent > 10 && sent <= 240 * elapsed * 1.2 + 5, $"Cursor: records are rate-limited to the stream fps ({sent} in {elapsed:0.00} s at 240 fps)");

            feed.Set(shapeId: "beam-1", shape: FakePointerFeed.MakeShape(4, 12, "mono", invert: true));
            await Until(() => Cursor(h.Records().Last(x => x.Type == 5)).ShapeId == "beam-1", 500);
            check(h.Records(out var v2).Last(x => x.Type == 5) is var beam && v2 is null && Cursor(beam).HasShape, "Cursor: a new shapeId is sent with its shape (mono with an invert layer)");

            feed.Set(visible: false);
            await Until(() => !Cursor(h.Records().Last(x => x.Type == 5)).Visible, 500);
            check(Cursor(h.Records().Last(x => x.Type == 5)) is { Visible: false, ShapeId: "hidden-1", HasShape: true }, "Cursor: a hidden pointer uses the defined hidden-1 shape (sent once), never an empty id");
            var hiddenMoveX = Cursor(h.Records().Last(x => x.Type == 5)).X == -1880 ? -1881 : -1880;
            var beforeHiddenMove = h.Records().Count(x => x.Type == 5);
            feed.Set(x: hiddenMoveX);
            await Until(() => h.Records().Count(x => x.Type == 5) > beforeHiddenMove
                && Cursor(h.Records().Last(x => x.Type == 5)).X == hiddenMoveX, 500);
            check(Cursor(h.Records().Last(x => x.Type == 5)) is { Visible: false, ShapeId: "hidden-1", HasShape: false }, "Cursor: hidden-1 is referenced by id once known");

            feed.Set(x: -3000, y: -50);
            await Until(() => Cursor(h.Records().Last(x => x.Type == 5)).X == -1920, 500);
            check(h.Records(out var v3).Last(x => x.Type == 5) is var clampedHidden && v3 is null && Cursor(clampedHidden) is { X: -1920, Y: 0, Visible: false },
                "Cursor: a hidden pointer's last position on another monitor is clamped to this monitor (negative origin)");
            feed.Set(x: 5000, y: 20, visible: true, shapeId: "arrow-1", shape: FakePointerFeed.MakeShape(8, 8));
            await Until(() => Cursor(h.Records().Last(x => x.Type == 5)).X == -1920 + 63, 500);
            check(h.Records(out var v4).Last(x => x.Type == 5) is var offMonitor && v4 is null && Cursor(offMonitor) is { X: -1857, Y: 20, Visible: false, ShapeId: "hidden-1" },
                "Cursor: a visible pointer outside this monitor is sent as hidden, clamped to the monitor");

            feed.Set(x: -1900, y: 10);
            await Until(() => Cursor(h.Records().Last(x => x.Type == 5)).Visible, 500);
            var configs = h.Records().Count(x => x.Type == 1);
            h.Run.UpdateSettings(null, null, 0.5);
            await Until(() => h.Records() is var rr && rr.Count(x => x.Type == 1) > configs && rr.Skip(rr.FindLastIndex(x => x.Type == 1)).Any(x => x.Type == 5), 1000);
            var all = h.Records(out var v5); var at = all.FindLastIndex(x => x.Type == 1);
            check(v5 is null && all.Skip(at).FirstOrDefault(x => x.Type == 5) is { } afterConfig && Cursor(afterConfig).HasShape, "Cursor: a new config clears the shape cache; the pointer is re-sent with its shape");

            // Hovering across many pointers in one config: never rely on more shapes than the viewer caches.
            for (var i = 0; i <= VideoStreamRun.MaxViewerShapes + 1; i++)
            {
                var id = "many-" + i; feed.Set(x: -1910 + i % 40, shapeId: id, shape: FakePointerFeed.MakeShape(8, 8));
                await Until(() => Cursor(h.Records().Last(x => x.Type == 5)).ShapeId == id, 500);
            }
            feed.Set(x: -1880, shapeId: "many-0", shape: FakePointerFeed.MakeShape(8, 8));
            await Until(() => Cursor(h.Records().Last(x => x.Type == 5)).ShapeId == "many-0", 500);
            check(h.Records(out var v6).Last(x => x.Type == 5) is var back && v6 is null && Cursor(back) is { ShapeId: "many-0", HasShape: true },
                $"Cursor: after {VideoStreamRun.MaxViewerShapes} other shapes in one config, an earlier shape is re-sent with its definition (viewer cache bound)");
            await acks.CancelAsync(); await acking;
        }

        // Grant re-check before each pointer write: nothing is written once access is denied.
        feed = new FakePointerFeed();
        await using (var h = new Harness(new SyntheticSource(64, 48), gpu: new FakeGpuSource(Monitor), pointers: feed, timings: Fast with { AuthorizationMilliseconds = 200 }))
        {
            await Until(() => h.Records().Any(x => x.Type == 5), 1000);
            h.Denial = VideoStreamDenial.Revoked;
            var atDenial = h.Records().Count(x => x.Type == 5);
            var started = Environment.TickCount64;
            while (!h.Running.IsCompleted && Environment.TickCount64 - started < 1000) { feed.Set(x: -1900 + (int)(Environment.TickCount64 % 40)); await Task.Delay(2); }
            var r = h.Records(out var violation);
            check(violation is null && TerminalCode(r.Last()) == "access_revoked" && r.Count(x => x.Type == 5) <= atDenial + 1, $"Cursor: the grant is re-checked before each pointer write ({r.Count(x => x.Type == 5) - atDenial} after denial)");
        }

        // A feed that cannot describe the pointer: one hidden record, then composited CPU video, no more pointer records.
        feed = new FakePointerFeed();
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: new FakeGpuSource(Monitor), pointers: feed))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 5), 1000);
            feed.ReturnNull = true;
            await Until(() => !h.Run.UsingGpu && h.Records().Count(x => x.Type == 1) >= 2, 1000);
            await Task.Delay(200);
            var r = h.Records(out var violation);
            var hidden = r.FindLastIndex(x => x.Type == 5); var cpuConfig = r.FindIndex(1, x => x.Type == 1);
            check(violation is null && hidden >= 0 && Cursor(r[hidden]) is { Visible: false, ShapeId: "hidden-1" } && hidden < cpuConfig && r[cpuConfig + 1] is { Type: 2, Flags: 1 }
                && !h.Run.LocalCursorActive && h.Logs.Count == 1, "Cursor: an unusable pointer feed sends one hidden record before composited (CPU) frames, logged once");
            await acks.CancelAsync(); await acking;
        }

        // A GPU failure mid-stream: the hidden record precedes the CPU config.
        feed = new FakePointerFeed();
        var failing = new FakeGpuSource(Monitor) { FailAfter = 3 };
        await using (var h = new Harness(new SyntheticSource(64, 48) { AutoAdvance = true }, gpu: failing, pointers: feed))
        {
            using var acks = new CancellationTokenSource(); var acking = AutoAck(h, acks.Token);
            await Until(() => h.Records().Any(x => x.Type == 5), 1000);
            failing.Advance(); await Task.Delay(20); failing.Advance();
            await Until(() => !h.Run.UsingGpu && h.Records().Count(x => x.Type == 1) >= 2, 1500);
            await Task.Delay(100);
            var r = h.Records(out var violation);
            var cpuConfig = r.FindIndex(1, x => x.Type == 1);
            check(violation is null && cpuConfig > 0 && r.Take(cpuConfig).LastOrDefault(x => x.Type == 5) is { } last && Cursor(last) is { Visible: false, ShapeId: "hidden-1" }
                && !r.Skip(cpuConfig).Any(x => x.Type == 5), "Cursor: after a GPU failure, a hidden record precedes the composited CPU video and no pointer records follow");
            await acks.CancelAsync(); await acking;
        }

        // CPU-only stream: the cursor is composited; no pointer records even with a feed.
        await using (var h = new Harness(new SyntheticSource(64, 48), pointers: new FakePointerFeed()))
        {
            await Until(() => h.Records().Any(x => x.Type == 2), 1000);
            await Task.Delay(200);
            check(!h.Records().Any(x => x.Type == 5) && !h.Run.LocalCursorActive, "Cursor: a CPU (composited) stream never sends pointer records");
        }
    }

    private static async Task MediaFoundationCheck(Action<bool, string> check)
    {
        if (!MfH264Encoder.IsSupported) { check(VideoStreamEndpoints.CanVideoStream == false && VideoStreamEndpoints.VideoCodecs.Count == 0, "Capability: no encoder → canVideoStream false"); return; }
        check(VideoStreamEndpoints.CanVideoStream && VideoStreamEndpoints.VideoCodecs.All(c => VideoStreamRecords.CodecPattern().IsMatch(c)), "Capability: canVideoStream with uppercase avc1 codec strings");
        using (var odd = VideoEncoders.CreateMediaFoundation(641, 361, 30, 2_000_000))
            check(odd is { EncodedWidth: 642, EncodedHeight: 362 }, "MF: odd dimensions pad to even coded size");
        await using var h = new Harness(new SyntheticSource(640, 360) { AutoAdvance = true }, factory: VideoEncoders.CreateMediaFoundation, settings: new VideoStreamSettings(60, 4_000_000, 1),
            timings: new VideoStreamTimings());
        await Until(() => h.Records().Count(r => r.Type == 2) >= 2, 5000);
        h.Run.Ack(h.Records().Last(r => r.Type == 2).Sequence, 1);
        await Until(() => h.Records().Count(r => r.Type == 2) >= 3, 5000);
        var records = h.Records(out var violation);
        var key = records.First(r => r.Type == 2).Payload;
        var nals = MfH264Encoder.EnumerateNalUnits(key).Select(n => n.Type).ToHashSet();
        using var cfg = JsonDocument.Parse(records[0].Payload);
        check(violation is null && records.Count(r => r.Type == 2) >= 3 && nals.IsSupersetOf([7, 8, 5]) && VideoStreamRecords.CodecPattern().IsMatch(cfg.RootElement.GetProperty("codec").GetString()!)
            && cfg.RootElement.GetProperty("codedWidth").GetInt32() == 640, "MF integration: real H.264 stream of synthetic frames is viewer-valid; keyframe carries SPS+PPS+IDR");
    }

    // ---- helpers ----

    internal sealed record Rec(int Type, int Flags, uint Sequence, ulong Timestamp, byte[] Payload);

    /// <summary>Mirror of apps/desktop/electron/stream-parser.cjs: returns the first framing violation, or null.</summary>
    internal static List<Rec> Parse(byte[] data, string monitorId, uint firstSequence, out string? violation, out bool partial)
    {
        var records = new List<Rec>(); violation = null; partial = false;
        var next = firstSequence; ulong lastTs = 0; bool configured = false, needsKey = true, terminal = false;
        var knownShapes = new List<string>(); (int Left, int Top, int Width, int Height) rect = default;
        var offset = 0;
        while (offset < data.Length)
        {
            if (terminal) { violation = "bytes after terminal"; break; }
            if (data.Length - offset < 24) { partial = true; break; }
            var h = data.AsSpan(offset, 24);
            int type = h[0], flags = h[1]; var length = BinaryPrimitives.ReadUInt32LittleEndian(h[4..]); var seq = BinaryPrimitives.ReadUInt32LittleEndian(h[8..]);
            var ts = BinaryPrimitives.ReadUInt64LittleEndian(h[16..]);
            if (type is < 1 or > 5 || BinaryPrimitives.ReadUInt16LittleEndian(h[2..]) != 0 || BinaryPrimitives.ReadUInt32LittleEndian(h[12..]) != 0 || (type == 2 ? (flags & ~1) != 0 : flags != 0)) { violation = "type/flags/reserved"; break; }
            if (seq != next || seq == uint.MaxValue && type != 4) { violation = $"sequence {seq} != {next}"; break; }
            if (ts < lastTs || ts > 9_007_199_254_740_991) { violation = "timestamp"; break; }
            var limit = type switch { 1 => 4096u, 2 => 8u * 1024 * 1024, 3 => 0u, 5 => 65536u, _ => 1024u };
            if (length > limit || type != 3 && length == 0) { violation = "length"; break; }
            if (!configured && type != 1) { violation = "config must come first"; break; }
            if (type == 2 && needsKey && (flags & 1) == 0) { violation = "config must be followed by keyframe"; break; }
            if (data.Length - offset - 24 < length) { partial = true; break; }
            var payload = data.AsSpan(offset + 24, (int)length).ToArray();
            if (type == 1)
            {
                violation = ConfigViolation(payload, monitorId); if (violation is not null) break; configured = true; needsKey = true;
                using var cfg = JsonDocument.Parse(payload); var c = cfg.RootElement;
                rect = (c.GetProperty("physicalLeft").GetInt32(), c.GetProperty("physicalTop").GetInt32(), c.GetProperty("physicalWidth").GetInt32(), c.GetProperty("physicalHeight").GetInt32());
                knownShapes.Clear(); // A config clears the viewer's shape cache.
            }
            else if (type == 5) { if (CursorViolation(payload, knownShapes, rect) is { } bad) { violation = bad; break; } }
            else if (type == 2) { if (!VideoStreamRecords.IsAnnexB(payload)) { violation = "not Annex-B"; break; } needsKey = false; }
            else if (type == 4) { if (TerminalViolation(payload) is { } bad) { violation = bad; break; } terminal = true; }
            records.Add(new Rec(type, flags, seq, ts, payload));
            next = seq + 1; lastTs = ts; offset += 24 + (int)length;
        }
        return records;
    }

    internal static string? ConfigViolation(byte[] payload, string monitorId)
    {
        using var document = JsonDocument.Parse(payload);
        var c = document.RootElement;
        string[] allowed = ["codec", "width", "height", "codedWidth", "codedHeight", "physicalLeft", "physicalTop", "physicalWidth", "physicalHeight", "scale", "fps", "monitorId", "colorSpace", "capturedUtc"];
        if (c.EnumerateObject().Any(p => !allowed.Contains(p.Name))) return "config field";
        if (!VideoStreamRecords.CodecPattern().IsMatch(c.GetProperty("codec").GetString() ?? "")) return "codec";
        int I(string n) => c.GetProperty(n).GetInt32();
        int w = I("width"), h = I("height");
        if (w is < 1 or > 8192 || h is < 1 or > 8192 || (long)w * h > 33_554_432 || I("codedWidth") < w || I("codedWidth") > w + 16 || I("codedHeight") < h || I("codedHeight") > h + 16) return "dimensions";
        var scale = c.GetProperty("scale").GetDouble();
        if (scale is < 0.33 or > 1 || Math.Abs(w - Math.Round(I("physicalWidth") * scale, MidpointRounding.AwayFromZero)) > 1 || Math.Abs(h - Math.Round(I("physicalHeight") * scale, MidpointRounding.AwayFromZero)) > 1) return "scale mapping";
        if (c.GetProperty("fps").GetDouble() is < 1 or > 240) return "fps";
        if (c.GetProperty("monitorId").GetString() != monitorId) return "monitorId";
        var cs = c.GetProperty("colorSpace");
        if (cs.EnumerateObject().Count() != 4 || cs.GetProperty("primaries").GetString() != "bt709" || cs.GetProperty("transfer").GetString() != "bt709"
            || cs.GetProperty("matrix").GetString() != "bt709" || cs.GetProperty("fullRange").GetBoolean()) return "colorSpace";
        var captured = c.GetProperty("capturedUtc").GetString()!;
        return captured.Length <= 64 && DateTimeOffset.TryParse(captured, out _) ? null : "capturedUtc";
    }

    /// <summary>Viewer rules for a type-5 record (docs/PROTOCOL.md, "Cursor").</summary>
    internal static string? CursorViolation(byte[] payload, List<string> knownShapes, (int Left, int Top, int Width, int Height) rect)
    {
        using var document = JsonDocument.Parse(payload);
        var c = document.RootElement;
        if (c.ValueKind != JsonValueKind.Object || c.EnumerateObject().Any(p => p.Name is not ("x" or "y" or "visible" or "shapeId" or "shape"))) return "cursor fields";
        if (!c.TryGetProperty("x", out var xe) || !xe.TryGetInt32(out var x) || !c.TryGetProperty("y", out var ye) || !ye.TryGetInt32(out var y)) return "cursor x/y";
        if (x < rect.Left || x >= (long)rect.Left + rect.Width || y < rect.Top || y >= (long)rect.Top + rect.Height) return $"cursor outside the monitor ({x},{y})";
        if (!c.TryGetProperty("visible", out var v) || v.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return "cursor visible";
        var id = c.TryGetProperty("shapeId", out var ide) && ide.ValueKind == JsonValueKind.String ? ide.GetString()! : null;
        if (id is null || id.Length is 0 or > 128 || id.Any(ch => ch < 0x20 || ch > 0x7E)) return "cursor shapeId";
        if (c.TryGetProperty("shape", out var shape))
        {
            if (shape.EnumerateObject().Any(p => p.Name is not ("width" or "height" or "hotX" or "hotY" or "kind" or "pngBase64" or "invertPngBase64"))) return "shape fields";
            int w = shape.GetProperty("width").GetInt32(), h = shape.GetProperty("height").GetInt32(), hx = shape.GetProperty("hotX").GetInt32(), hy = shape.GetProperty("hotY").GetInt32();
            var kind = shape.GetProperty("kind").GetString();
            if (w is < 1 or > 256 || h is < 1 or > 256 || hx < 0 || hx >= w || hy < 0 || hy >= h || kind is not ("color" or "masked" or "mono")) return "shape bounds";
            bool Png(string? b64)
            {
                try { var png = Convert.FromBase64String(b64!); return Convert.ToBase64String(png) == b64 && png.Length >= 24 && BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(16)) == w && BinaryPrimitives.ReadInt32BigEndian(png.AsSpan(20)) == h; }
                catch (FormatException) { return false; }
            }
            if (!Png(shape.GetProperty("pngBase64").GetString())) return "shape png";
            if (shape.TryGetProperty("invertPngBase64", out var inv) && (kind == "color" || !Png(inv.GetString()))) return "shape invert";
            // The viewer keeps the 64 most recently defined shapes per config (docs/PROTOCOL.md type 5).
            knownShapes.Remove(id); knownShapes.Add(id);
            if (knownShapes.Count > VideoStreamRun.MaxViewerShapes) knownShapes.RemoveAt(0);
        }
        else if (!knownShapes.Contains(id)) return "unknown shapeId without shape";
        return null;
    }

    private static (int X, int Y, bool Visible, string ShapeId, bool HasShape) Cursor(Rec record)
    {
        using var d = JsonDocument.Parse(record.Payload); var c = d.RootElement;
        return (c.GetProperty("x").GetInt32(), c.GetProperty("y").GetInt32(), c.GetProperty("visible").GetBoolean(), c.GetProperty("shapeId").GetString()!, c.TryGetProperty("shape", out _));
    }

    private static string? TerminalViolation(byte[] payload)
    {
        using var document = JsonDocument.Parse(payload);
        var names = document.RootElement.EnumerateObject().Select(p => p.Name).ToArray();
        return names.All(n => n is "code" or "error") && System.Text.RegularExpressions.Regex.IsMatch(document.RootElement.GetProperty("code").GetString() ?? "", "^[a-z0-9_]{1,80}$")
            && document.RootElement.GetProperty("error").GetString()!.Length <= 1000 ? null : "terminal";
    }

    private static string? TerminalCode(Rec record) => record.Type == 4 ? JsonDocument.Parse(record.Payload).RootElement.GetProperty("code").GetString() : null;

    private static VideoSourceFrame Frame(int w, int h, int left, int top, string generation, long version) =>
        new(new byte[w * h * 4], w, h, left, top, "synthetic-1", DateTimeOffset.UtcNow, generation, version);

    /// <summary>An ack past the last sent access unit must not change the window.</summary>
    private static bool AckIgnored(VideoStreamRun run)
    {
        var before = (run.InFlight, run.InFlightBytes);
        run.Ack(uint.MaxValue - 7, null);
        return (run.InFlight, run.InFlightBytes) == before;
    }

    private static StringContent Json(string json) => new(json, Encoding.UTF8, "application/json");

    private static bool Throws(Action action)
    {
        try { action(); return false; } catch (Exception ex) when (ex is ArgumentException or InvalidOperationException) { return true; }
    }

    private static async Task<bool> ThrowsAsync(Func<Task> action)
    {
        try { await action(); return false; } catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or OperationCanceledException) { return true; }
    }

    private static async Task Until(Func<bool> condition, int milliseconds)
    {
        var deadline = Environment.TickCount64 + milliseconds;
        while (!condition() && Environment.TickCount64 < deadline) await Task.Delay(10);
    }

    private sealed class Harness : IAsyncDisposable
    {
        public readonly RecordingStream Output;
        private readonly IVideoFrameSource source;
        public SyntheticSource Source => (SyntheticSource)source;
        public readonly List<FakeEncoder> Encoders = [];
        public readonly List<string> Logs = [];
        public readonly CancellationTokenSource Connection = new(), Stopping = new();
        public readonly VideoStreamRun Run;
        public readonly Task Running;
        private readonly uint firstSequence;
        private int aborts;
        private int denial;
        public int Aborts => Volatile.Read(ref aborts);
        public VideoStreamDenial Denial { get => (VideoStreamDenial)Volatile.Read(ref denial); set => Volatile.Write(ref denial, (int)value); }

        public Harness(IVideoFrameSource source, VideoStreamSettings? settings = null, VideoStreamTimings? timings = null, uint firstSequence = 0,
            VideoEncoderFactory? factory = null, bool startBlocked = false, IGpuVideoSource? gpu = null, IPointerFeed? pointers = null)
        {
            this.source = source; this.firstSequence = firstSequence;
            Output = new RecordingStream { BlockAfterFirstWrite = startBlocked };
            factory ??= (w, h, fps, bitrate) => { var e = new FakeEncoder(w, h, fps) { Bitrate = bitrate }; lock (Encoders) Encoders.Add(e); return e; };
            Run = new VideoStreamRun(Output, () => Interlocked.Increment(ref aborts), source, Monitor, factory, settings ?? Quick, () => Denial,
                Connection.Token, Stopping.Token, timings ?? Fast, firstSequence: firstSequence, gpu: gpu, log: message => { lock (Logs) Logs.Add(message); }, pointers: pointers);
            Running = Run.RunAsync();
        }

        public List<Rec> Records() => Records(out _);
        public List<Rec> Records(out string? violation) => Parse(Output.Snapshot(), Monitor.Id, firstSequence, out violation, out _);

        public async ValueTask DisposeAsync()
        {
            Output.Release();
            await Connection.CancelAsync();
            await Running.WaitAsync(TimeSpan.FromSeconds(3));
            await Run.DisposeAsync();
        }
    }

    internal sealed class SyntheticSource(int width, int height) : IVideoFrameSource
    {
        private readonly object gate = new();
        private TaskCompletionSource changed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private string generation = "generation-a-00000000000000";
        private long version = 1;
        private int gets;
        public bool AutoAdvance { get; init; }
        public volatile bool ReturnNull;
        public int Gets => Volatile.Read(ref gets);

        public void Advance() { lock (gate) { version++; Signal(); } }

        public void Reset(string newGeneration, int? width = null, int? height = null)
        {
            lock (gate) { generation = newGeneration; version = 1; if (width is { } w) this.width = w; if (height is { } h) this.height = h; Signal(); }
        }
        private int width = width, height = height;
        private void Signal() { var old = changed; changed = new(TaskCreationOptions.RunContinuationsAsynchronously); old.TrySetResult(); }

        public Task<VideoSourceFrame?> GetLatestAsync(MonitorInfo monitor, CancellationToken cancellationToken)
        {
            lock (gate)
            {
                Interlocked.Increment(ref gets);
                if (ReturnNull) return Task.FromResult<VideoSourceFrame?>(null);
                if (AutoAdvance) version++;
                var pixels = new byte[width * height * 4];
                for (var i = 0; i < pixels.Length; i += 4) { pixels[i] = (byte)(i / 4 + version); pixels[i + 1] = (byte)(i / 7); pixels[i + 2] = (byte)(version * 3); pixels[i + 3] = 255; }
                return Task.FromResult<VideoSourceFrame?>(new VideoSourceFrame(pixels, width, height, monitor.Left, monitor.Top, monitor.Id, DateTimeOffset.UtcNow, generation, version));
            }
        }

        public async Task WaitForChangeAsync(VideoSourceFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken)
        {
            Task signal;
            lock (gate) { if (observed.Generation != generation || observed.Version != version) return; signal = changed.Task; }
            try { await signal.WaitAsync(TimeSpan.FromMilliseconds(maximumWaitMilliseconds), cancellationToken); } catch (TimeoutException) { }
        }
    }

    /// <summary>A source whose content changes on every read, cycling pre-built immutable frames (no per-frame allocation).</summary>
    private sealed class CyclingSource(byte[][] frames, int width, int height) : IVideoFrameSource
    {
        private long version;
        public Task<VideoSourceFrame?> GetLatestAsync(MonitorInfo monitor, CancellationToken cancellationToken)
        {
            var v = Interlocked.Increment(ref version);
            return Task.FromResult<VideoSourceFrame?>(new VideoSourceFrame(frames[v % frames.Length], width, height, monitor.Left, monitor.Top, monitor.Id, DateTimeOffset.UtcNow, "generation-cycle-000000000", v));
        }
        public Task WaitForChangeAsync(VideoSourceFrame observed, int maximumWaitMilliseconds, CancellationToken cancellationToken) => Task.CompletedTask;
    }

    /// <summary>Fake shared GPU source: an image version the checks advance, encoders that encode it like the pipeline.</summary>
    internal sealed class FakeGpuSource(MonitorInfo monitor) : IGpuVideoSource
    {
        private readonly object gate = new();
        private TaskCompletionSource changed = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public string Generation = "generation-gpu-a-0000000000";
        public long Version = 1;
        public volatile bool Unavailable;
        public int FailAfter { get; init; } = -1;
        public int DeltaBytes { get; init; }
        /// <summary>Each output also carries a second (delta) picture, as a buffering MFT returns two at once.</summary>
        public bool TwoPictures { get; init; }
        /// <summary>Fill the authoritative <see cref="GpuVideoUnit.Units"/>; false = a legacy adapter (the stream splits the concatenation).</summary>
        public bool ListPictures { get; init; } = true;
        /// <summary>When set, every output after the first carries this many delta units (batch fence checks).</summary>
        public int BatchUnits { get; init; }
        public int BatchUnitBytes { get; init; }
        /// <summary>Reported per encode (<see cref="GpuVideoUnit.EncodeMilliseconds"/>); 0 = not measured.</summary>
        public double EncodeMilliseconds { get; init; }
        public int SlowStartEncodes { get; init; }
        public double SlowStartMilliseconds { get; init; }
        public bool ThrowOnReset { get; init; }
        public string ResetFailureCode { get; init; } = "capture-reset";
        public int ReopenDelayMilliseconds { get; init; }
        public int ReopenCooldownMilliseconds { get; init; }
        private long reopenAfter;
        public int RejectedOpensRemaining;
        public int RejectFirstReopenedEncodeRemaining;
        public int KeyframeLength => FakeEncoder.Keyframe.Length;
        public MonitorInfo Screen { get; } = monitor;
        public int Opens, Disposed, Encodes, Lasts, LastKeyframes, Calls;
        public void Advance() { TaskCompletionSource old; lock (gate) { Version++; old = changed; changed = new(TaskCreationOptions.RunContinuationsAsynchronously); } old.TrySetResult(); }
        public void Reset(string generation) { TaskCompletionSource old; lock (gate) { Generation = generation; Version = 1; if (ReopenCooldownMilliseconds > 0) Volatile.Write(ref reopenAfter, Environment.TickCount64 + ReopenCooldownMilliseconds); old = changed; changed = new(TaskCreationOptions.RunContinuationsAsynchronously); } old.TrySetResult(); }
        public IGpuVideoEncoder? TryOpenEncoder(MonitorInfo requested, int width, int height, int fps, int bitrateBps)
        {
            if (Unavailable) return null;
            Interlocked.Increment(ref Opens);
            if (Environment.TickCount64 < Volatile.Read(ref reopenAfter)) return null;
            if (Opens > 1 && ReopenDelayMilliseconds > 0) Thread.Sleep(ReopenDelayMilliseconds);
            if (Volatile.Read(ref RejectedOpensRemaining) > 0 && Interlocked.Decrement(ref RejectedOpensRemaining) >= 0) return null;
            return new Encoder(this, width, height);
        }

        private sealed class Encoder(FakeGpuSource source, int width, int height) : IGpuVideoEncoder
        {
            private (string Generation, long Version)? encoded;
            private bool firstEncode = true;
            private bool disposed;
            public async Task<GpuVideoUnit?> EncodeNextAsync(int timeoutMilliseconds, bool forceKeyframe, CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref source.Calls);
                var deadline = Environment.TickCount64 + timeoutMilliseconds;
                while (true)
                {
                    Task signal;
                    lock (source.gate)
                    {
                        ObjectDisposedException.ThrowIf(disposed, this);
                        if (source.ThrowOnReset && encoded is { } previous && previous.Generation != source.Generation)
                            throw new PlatformUnavailableException(source.ResetFailureCode, "Synthetic generation change requires a new encoder.");
                        if (encoded != (source.Generation, source.Version)) { var fresh = encoded is null; encoded = (source.Generation, source.Version); return Unit(forceKeyframe || fresh); }
                        signal = source.changed.Task;
                    }
                    var remaining = deadline - Environment.TickCount64;
                    if (remaining <= 0) return null;
                    try { await signal.WaitAsync(TimeSpan.FromMilliseconds(remaining), cancellationToken); } catch (TimeoutException) { return null; }
                }
            }
            public GpuVideoUnit? EncodeLast(bool forceKeyframe)
            {
                Interlocked.Increment(ref source.Calls);
                lock (source.gate)
                {
                    if (encoded is null) return null;
                    Interlocked.Increment(ref source.Lasts); if (forceKeyframe) Interlocked.Increment(ref source.LastKeyframes);
                    return Unit(forceKeyframe);
                }
            }
            private GpuVideoUnit Unit(bool keyframe)
            {
                if (firstEncode)
                {
                    firstEncode = false;
                    if (source.Opens > 1 && Volatile.Read(ref source.RejectFirstReopenedEncodeRemaining) > 0 && Interlocked.Decrement(ref source.RejectFirstReopenedEncodeRemaining) >= 0)
                        throw new PlatformUnavailableException("capture-reset", "Synthetic reopened encoder failed before its first output.");
                }
                if (source.FailAfter >= 0 && source.Encodes >= source.FailAfter) throw new PlatformUnavailableException("encode-failed", "Synthetic nonrecoverable encoder failure.");
                var encodeNumber = Interlocked.Increment(ref source.Encodes); var first = encodeNumber == 1;
                keyframe |= first;
                var data = new byte[Math.Max(keyframe ? FakeEncoder.Keyframe.Length : FakeEncoder.Delta.Length, keyframe ? 0 : source.DeltaBytes)];
                (keyframe ? FakeEncoder.Keyframe : FakeEncoder.Delta).CopyTo(data, 0);
                var screen = source.Screen;
                var units = new List<GpuVideoAccessUnit> { new(data, keyframe, VideoStreamRecords.MonotonicMicroseconds() * 10) };
                if (source.TwoPictures) units.Add(new([.. FakeEncoder.Delta], false, VideoStreamRecords.MonotonicMicroseconds() * 10));
                if (source.BatchUnits > 0 && !first)
                {
                    units.Clear();
                    for (var i = 0; i < source.BatchUnits; i++)
                    {
                        var delta = new byte[Math.Max(FakeEncoder.Delta.Length, source.BatchUnitBytes)]; FakeEncoder.Delta.CopyTo(delta, 0);
                        units.Add(new(delta, false, VideoStreamRecords.MonotonicMicroseconds() * 10));
                    }
                }
                return new GpuVideoUnit(units.SelectMany(unit => unit.AccessUnit).ToArray(), keyframe, width, height, screen.Left, screen.Top, screen.Width, screen.Height,
                    encoded!.Value.Generation, encoded.Value.Version, DateTimeOffset.UtcNow) { Units = source.ListPictures ? units : [],
                        EncodeMilliseconds = encodeNumber <= source.SlowStartEncodes ? source.SlowStartMilliseconds : source.EncodeMilliseconds };
            }
            public bool SetBitrate(int bitrateBps) => true;
            public void Dispose() { lock (source.gate) { if (disposed) return; disposed = true; } Interlocked.Increment(ref source.Disposed); }
        }
    }

    /// <summary>Fake pointer feed with the real feed's contract: shape only when knownShapeId differs; hidden = hidden-1.</summary>
    internal sealed class FakePointerFeed : IPointerFeed
    {
        private readonly object gate = new();
        private int x = -1900, y = 10; private bool visible = true; private string shapeId = "arrow-1";
        private PointerShape shape = MakeShape(8, 8);
        private long version = 1;
        public volatile bool ReturnNull;
        public int Calls;
        public void Set(int? x = null, int? y = null, bool? visible = null, string? shapeId = null, PointerShape? shape = null)
        {
            lock (gate)
            {
                this.x = x ?? this.x; this.y = y ?? this.y; this.visible = visible ?? this.visible; this.shapeId = shapeId ?? this.shapeId; this.shape = shape ?? this.shape;
                version++;
            }
        }
        public Task<PointerSnapshot?> GetPointerAsync(MonitorInfo monitor, string? knownShapeId, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref Calls);
            lock (gate)
            {
                if (ReturnNull) return Task.FromResult<PointerSnapshot?>(null);
                var id = visible ? shapeId : PointerRecords.HiddenShapeId;
                var current = visible ? shape : PointerRecords.HiddenShape;
                return Task.FromResult<PointerSnapshot?>(new PointerSnapshot(x, y, visible, id, knownShapeId == id ? null : current, "pointer-generation-a", version));
            }
        }
        public static PointerShape MakeShape(int width, int height, string kind = "color", bool invert = false)
        {
            string Png() => Convert.ToBase64String(PngEncoder.EncodeBgraWithAlpha(new byte[width * height * 4], width, height, CancellationToken.None));
            return new PointerShape(width, height, 0, 0, kind, Png(), invert ? Png() : null);
        }
    }

    internal sealed class FakeEncoder(int width, int height, int fps) : IVideoStreamEncoder
    {
        public static readonly byte[] Keyframe = [0, 0, 0, 1, 0x67, 0x4D, 0x40, 0x28, 0x95, 0, 0, 0, 1, 0x68, 0xEE, 0x3C, 0, 0, 1, 0x65, 0x88, 0x84];
        public static readonly byte[] Delta = [0, 0, 0, 1, 0x41, 0x9A, 0x02];
        private int encodes;
        public int FailAfter { get; init; } = -1;
        public int KeyframeBytes { get; init; }
        public List<byte[]?> Inputs { get; } = [];
        public int DeltaBytes { get; init; }
        public int Bitrate { get; set; }
        public bool Disposed { get; private set; }
        public int EncodedWidth => width + (width & 1);
        public int EncodedHeight => height + (height & 1);
        public int FramesPerSecond => fps;
        /// <summary>Qualcomm-like: nothing for the first input, then both pictures in one output.</summary>
        public bool HoldFirst { get; init; }
        /// <summary>Always one picture behind; <see cref="Flush"/> returns the held one.</summary>
        public bool OneBehind { get; init; }
        public int Flushes { get; private set; }
        /// <summary>When set, every output after the first is this many units (batch fence checks).</summary>
        public int BatchUnits { get; init; }
        private VideoEncodedUnit? held;
        public IReadOnlyList<VideoEncodedUnit> Flush() { Flushes++; var h = held; held = null; return h is null ? [] : [h]; }
        public IReadOnlyList<VideoEncodedUnit> Encode(ReadOnlyMemory<byte> bgra, long timestamp100ns, bool forceKeyframe)
        {
            ObjectDisposedException.ThrowIf(Disposed, this);
            Inputs.Add(MemoryMarshal.TryGetArray(bgra, out var segment) ? segment.Array : null);
            if (bgra.Length != width * height * 4) throw new ArgumentException("Invalid pixel buffer.");
            if (FailAfter >= 0 && encodes >= FailAfter) throw new PlatformUnavailableException("encode-failed", "Synthetic encoder failure.");
            var key = forceKeyframe || encodes == 0;
            encodes++;
            var template = key ? Keyframe : Delta;
            var data = new byte[Math.Max(template.Length, key ? KeyframeBytes : DeltaBytes)]; // Zero padding = trailing_zero_8bits.
            template.CopyTo(data, 0);
            var current = new VideoEncodedUnit(data, key, timestamp100ns);
            if (BatchUnits > 0 && encodes > 1) return Enumerable.Range(0, BatchUnits).Select(_ => new VideoEncodedUnit([.. Delta], false, timestamp100ns)).ToList();
            if (HoldFirst)
            {
                if (encodes == 1) { held = current; return []; }
                if (held is { } first) { held = null; return [first, current]; }
                return [current];
            }
            if (OneBehind) { var previous = held; held = current; return previous is null ? [] : [previous]; }
            return [current];
        }
        public bool SetBitrate(int bitrateBps) { Bitrate = bitrateBps; return true; }
        public void Dispose() => Disposed = true;
    }

    private sealed class RecordingStream : Stream
    {
        private readonly MemoryStream data = new();
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int writes;
        public bool BlockAfterFirstWrite { get; init; }
        public void Release() => released.TrySetResult();
        public byte[] Snapshot() { lock (data) return data.ToArray(); }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (BlockAfterFirstWrite && Interlocked.Increment(ref writes) > 1) await released.Task.WaitAsync(cancellationToken);
            lock (data) data.Write(buffer.Span);
        }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override void Write(byte[] buffer, int offset, int count) { lock (data) data.Write(buffer, offset, count); }
        public override Task FlushAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public override void Flush() { }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    internal sealed class RecordReader : IDisposable
    {
        private readonly List<byte> bytes = [];
        private readonly Stream body;
        private readonly byte[] buffer = new byte[65536];
        public HttpResponseMessage Response { get; }
        public List<Rec> Records { get; private set; } = [];
        public string? Violation { get; private set; }
        public bool Ended { get; private set; }
        private RecordReader(HttpResponseMessage response, Stream body) { Response = response; this.body = body; }

        public static async Task<RecordReader> OpenAsync(HttpClient client, string path)
        {
            var response = await client.GetAsync(path, HttpCompletionOption.ResponseHeadersRead);
            return new RecordReader(response, await response.Content.ReadAsStreamAsync());
        }

        public async Task ReadUntilAsync(Func<List<Rec>, bool> done, int milliseconds = 3000)
        {
            using var timeout = new CancellationTokenSource(milliseconds);
            try
            {
                while (!done(Records))
                {
                    var read = await body.ReadAsync(buffer, timeout.Token);
                    if (read == 0) { Ended = true; break; }
                    bytes.AddRange(buffer.AsSpan(0, read).ToArray());
                    Records = Parse([.. bytes], Monitor.Id, 0, out var violation, out _); Violation = violation;
                }
                if (Records.Any(r => r.Type == 4) && !Ended)
                    Ended = await body.ReadAsync(buffer, timeout.Token) == 0;
            }
            catch (Exception ex) when (ex is OperationCanceledException or IOException or HttpRequestException) { }
        }

        public void Dispose() { body.Dispose(); Response.Dispose(); }
    }

    internal sealed class FakePlatform : IPlatformBackend
    {
        public byte[]? Raw = new byte[4 * 2 * 4];
        public Func<CancellationToken, Task<ScreenFrame>>? CaptureOverride;
        public Func<RemoteInput, CancellationToken, Task>? ApplyOverride;
        public Func<Task>? ReleaseOverride;
        public Task<PlatformStatus> GetStatusAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(new PlatformStatus("Synthetic", "interactive", true, false, false, false, [Monitor], []));
        public Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken cancellationToken = default) =>
            CaptureOverride?.Invoke(cancellationToken) ?? Task.FromResult(new ScreenFrame([], 4, 2, -1920, 0, DateTimeOffset.UtcNow, Raw, monitorId));
        public Task ApplyInputAsync(RemoteInput input, CancellationToken cancellationToken = default) => ApplyOverride?.Invoke(input, cancellationToken) ?? throw new NotSupportedException();
        public Task ReleaseInputsAsync(CancellationToken cancellationToken = default) => ReleaseOverride?.Invoke() ?? Task.CompletedTask;
        public Task<string> ReadClipboardAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task WriteClipboardAsync(string text, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task LockAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
