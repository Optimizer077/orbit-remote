using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Orbit.Host;

public static class OwnerBlockChecks
{
    public static async Task RunAsync(Action<bool, string> check, string tempRoot)
    {
        var directory = Path.Combine(tempRoot, "owner-block-state");
        var state = new HostState(directory);
        var grants = new DevicePermissions(true, true, true, true, true);
        var primary = Pair(state, "primary-owner-block", grants);
        var other = Pair(state, "other-owner-block", new(View: true));
        var idle = Pair(state, "idle-owner-block", new(View: true));
        var control = state.StartSession(primary, null);
        var primaryView = state.StartSession(primary, null, viewOnly: true);
        var otherView = state.StartSession(other, null);
        check(state.EndSession(primaryView.Id, null, out var release) && release,
            "Owner block: ending this device's view session also ends its controller and requests input release");
        check(state.GetSession(control.Id, primary.Id) is null && state.GetSession(primaryView.Id, primary.Id) is null,
            "Owner block: all sessions of the targeted device end atomically");
        check(state.GetSession(otherView.Id, other.Id) is not null && !state.FindDevice(other.Fingerprint)!.BlockedByOwner,
            "Owner block: another device's active session and authority are preserved");
        var blocked = state.FindDevice(primary.Fingerprint)!;
        check(blocked.BlockedByOwner && blocked.ResumeEpoch != primary.ResumeEpoch,
            "Owner block: persisted device state rotates its resume epoch");
        var streamAccess = new HostStateStreamAccess(state, () => false, _ => primary, CancellationToken.None);
        check(streamAccess.Check(new DefaultHttpContext(), control) == VideoStreamDenial.OwnerEnded,
            "Owner block: a stream using a stale request peer still reads the current persisted owner decision");
        OwnerDenied(() => state.StartSession(primary, null), "Owner block: stale paired record cannot explicitly connect");
        OwnerDenied(() => state.StartSession(primary, null, expectedResumeEpoch: primary.ResumeEpoch), "Owner block: automatic renewal is denied with the owner reason");
        var blockedEpoch = blocked.ResumeEpoch;
        var blockAuditCount = state.Audit.Count(entry => entry.Kind == "device.blocked_by_owner" && entry.DeviceId == primary.Id);
        check(state.BlockDevice(primary.Id, out var repeatRelease) && !repeatRelease && state.FindDevice(primary.Fingerprint)!.ResumeEpoch == blockedEpoch,
            "Owner block: repeated device block is idempotent and cannot release another device's input");
        check(blockAuditCount == 1 && state.Audit.Count(entry => entry.Kind == "device.blocked_by_owner" && entry.DeviceId == primary.Id) == blockAuditCount,
            "Owner block: a repeated Block action does not duplicate its device audit event");
        check(!state.BlockDevice("unknown", out var unknownRelease) && !unknownRelease, "Owner block: unknown device is not an input-release authority");

        state = new HostState(directory);
        check(state.FindDevice(primary.Fingerprint)!.BlockedByOwner, "Owner block: block survives a process-state reload");
        OwnerDenied(() => state.StartSession(primary, null), "Owner block: explicit reconnect remains denied after restart");
        state.EndAllSessions(explicitHostStop: false);
        check(state.FindDevice(primary.Fingerprint)!.BlockedByOwner && !state.FindDevice(other.Fingerprint)!.BlockedByOwner,
            "Owner block: lifecycle cleanup preserves both blocked and allowed device decisions");
        check(state.AllowDevice("unknown") is null, "Owner block: unknown device cannot be allowed");
        var allowed = state.AllowDevice(primary.Id)!;
        check(!allowed.BlockedByOwner && allowed.ResumeEpoch != blockedEpoch && allowed.Permissions == grants,
            "Owner block: Allow again rotates authorization and preserves the exact approved grants");
        try { state.StartSession(primary, null, expectedResumeEpoch: primary.ResumeEpoch); check(false, "Owner block: allowing does not revive stale resume epochs"); }
        catch (SessionEndedException) { check(true, "Owner block: allowing does not revive stale resume epochs"); }
        var resumed = state.StartSession(primary, null, viewOnly: true);
        var allowedAgain = state.AllowDevice(primary.Id)!;
        check(allowedAgain.ResumeEpoch == allowed.ResumeEpoch && state.GetSession(resumed.Id, primary.Id) is not null,
            "Owner block: allowing an already-allowed device does not rotate or end current sessions");
        check(state.EndSession(resumed.Id, primary.Id) && !state.FindDevice(primary.Fingerprint)!.BlockedByOwner,
            "Owner block: remote DELETE preserves the device's allowed state");
        resumed = state.StartSession(primary, null, viewOnly: true, expectedResumeEpoch: resumed.ResumeEpoch);
        check(resumed.ResumeEpoch == allowed.ResumeEpoch, "Owner block: remote DELETE retains authorized automatic reconnection");

        var idleEpoch = state.FindDevice(idle.Fingerprint)!.ResumeEpoch;
        state.EndAllSessions();
        check(state.Sessions.Length == 0 && state.FindDevice(primary.Fingerprint)!.BlockedByOwner,
            "Owner block: Disconnect all clears sessions and blocks connected devices");
        check(!state.FindDevice(idle.Fingerprint)!.BlockedByOwner && state.FindDevice(idle.Fingerprint)!.ResumeEpoch != idleEpoch,
            "Owner block: Disconnect all rotates an idle pairing's epoch without blocking explicit Connect");
        check(state.Audit.Count(entry => entry.Kind == "device.blocked_by_owner" && entry.DeviceId == primary.Id) == blockAuditCount + 1
            && !state.Audit.Any(entry => entry.Kind == "device.blocked_by_owner" && entry.DeviceId == idle.Id),
            "Owner block: Disconnect all audits each newly blocked connected device but never an idle device");
        check(state.StartSession(idle, null).DeviceId == idle.Id, "Owner block: an idle paired device may connect after Disconnect all");
        OwnerDenied(() => state.StartSession(primary, null), "Owner block: connected device cannot bypass Disconnect all by explicit Connect");
        var pairedAgain = Pair(state, primary.Fingerprint, grants);
        check(pairedAgain.Id == primary.Id && pairedAgain.BlockedByOwner, "Owner block: re-pairing the same certificate cannot silently clear its owner block");
        OwnerDenied(() => state.StartSession(pairedAgain, null), "Owner block: a fresh invite does not substitute for Allow again");
        check(state.AllowDevice(primary.Id) is not null && state.StartSession(pairedAgain, null, viewOnly: true).DeviceId == primary.Id,
            "Owner block: explicit Allow again permits a newly requested session");
        state.BlockDevice(primary.Id, out _);
        check(state.Revoke(primary.Id) && state.AllowDevice(primary.Id) is null && !state.BlockDevice(primary.Id, out _)
            && !state.Devices.Single(device => device.Id == primary.Id).BlockedByOwner,
            "Owner block: Allow and Block cannot revive a revoked certificate pin");
        var newlyApproved = Pair(state, primary.Fingerprint, grants);
        check(!newlyApproved.BlockedByOwner && state.StartSession(newlyApproved, null, viewOnly: true).DeviceId == primary.Id,
            "Owner block: re-pair after explicit revoke is a new owner decision and starts unblocked");

        var rotation = new HostState(Path.Combine(tempRoot, "owner-block-rotation"));
        var rotating = Pair(rotation, "rotation-connected", new(View: true));
        var rotatingBlocked = Pair(rotation, "rotation-blocked", new(View: true));
        rotation.StartSession(rotating, null); rotation.BlockDevice(rotatingBlocked.Id, out _);
        rotation.EndAllSessions(explicitHostStop: false);
        rotation.InvalidatePairingsForIdentityRotation();
        check(rotation.Devices.All(device => device.RevokedAt is not null && !device.BlockedByOwner)
            && !rotation.Audit.Any(entry => entry.Kind == "device.blocked_by_owner" && entry.DeviceId == rotating.Id),
            "Owner block: identity rotation revokes pins and clears blocks without adding a block to connected devices");
        rotating = Pair(rotation, rotating.Fingerprint, new(View: true));
        rotatingBlocked = Pair(rotation, rotatingBlocked.Fingerprint, new(View: true));
        check(rotation.StartSession(rotating, null).DeviceId == rotating.Id && rotation.StartSession(rotatingBlocked, null).DeviceId == rotatingBlocked.Id,
            "Owner block: fresh pairing after identity rotation permits both formerly connected and blocked devices");

        var legacyDirectory = Path.Combine(tempRoot, "owner-block-legacy"); Directory.CreateDirectory(legacyDirectory);
        var legacy = JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "host.json")))!;
        foreach (var device in legacy["devices"]!.AsArray()) device!.AsObject().Remove("blockedByOwner");
        File.WriteAllText(Path.Combine(legacyDirectory, "host.json"), legacy.ToJsonString());
        check(new HostState(legacyDirectory).FindDevice(idle.Fingerprint) is { BlockedByOwner: false },
            "Owner block: legacy paired-device state defaults to allowed without corrupting its grants");

        await DownloadRevocationAsync(check, tempRoot, "owner");
        await DownloadRevocationAsync(check, tempRoot, "revoke");
        await DownloadRevocationAsync(check, tempRoot, "disable");

        void OwnerDenied(Action action, string message)
        {
            try { action(); check(false, message); }
            catch (OwnerEndedException ex) { check(ex.Message == OwnerEndedException.UserMessage && OwnerEndedException.Code == "ended_by_owner", message); }
        }
    }

    private static async Task DownloadRevocationAsync(Action<bool, string> check, string tempRoot, string reason)
    {
        var state = new HostState(Path.Combine(tempRoot, "download-authority-" + reason));
        var peer = Pair(state, "download-generated", new(View: true, Files: true));
        var session = state.StartSession(peer, null);
        var folder = Path.Combine(tempRoot, "download-transfer-" + reason); Directory.CreateDirectory(folder);
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        var path = Path.Combine(folder, "generated.bin");
        await File.WriteAllBytesAsync(path, new byte[131072]);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build(); using var shutdown = new HostShutdown(app.Lifetime);
        EndAfterChunk? body = null; AbortFeature? abort = null;
        app.Use(async (context, next) =>
        {
            var original = context.Response.Body;
            abort = new(context.Features.Get<IHttpRequestLifetimeFeature>()!); context.Features.Set<IHttpRequestLifetimeFeature>(abort);
            body = new(original, () =>
            {
                if (reason == "owner") state.BlockDevice(peer.Id, out _);
                else if (reason == "revoke") state.Revoke(peer.Id);
                else state.UpdateSettings(state.Settings with { FileTransferEnabled = false });
            });
            context.Response.Body = body;
            try { await next(context); } finally { context.Response.Body = original; }
        });
        app.MapDownload(state, (_, id) => state.GetSession(id, peer.Id) is { Permissions.Files: true } live ? live : null,
            32 * 1024 * 1024, shutdown);
        await app.StartAsync(); var received = 0;
        try
        {
            using var client = new HttpClient { BaseAddress = new Uri(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(3) };
            try
            {
                using var response = await client.GetAsync($"/api/sessions/{session.Id}/files/generated.bin", HttpCompletionOption.ResponseHeadersRead);
                received = (await response.Content.ReadAsByteArrayAsync()).Length;
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException) { }
            check(abort?.Aborted == true && body?.Bytes == 65536 && received < 131072,
                $"Owner block: production download route aborts before the next chunk after {reason}, with transfer enablement rechecked");
        }
        finally { await app.StopAsync(); }
    }

    private static PairedDevice Pair(HostState state, string fingerprint, DevicePermissions permissions)
    {
        var invite = state.CreateInvite(new("Generated device", permissions), "https://127.0.0.1:1", "generated-pin");
        var encoded = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
        return state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated device"), fingerprint);
    }

    private sealed class EndAfterChunk(Stream inner, Action end) : Stream
    {
        public long Bytes { get; private set; }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await inner.WriteAsync(buffer, cancellationToken); Bytes += buffer.Length; end();
        }
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => inner.Flush();
        public override Task FlushAsync(CancellationToken token) => inner.FlushAsync(token);
        public override void Write(byte[] buffer, int offset, int count) { inner.Write(buffer, offset, count); Bytes += count; end(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
    private sealed class AbortFeature(IHttpRequestLifetimeFeature inner) : IHttpRequestLifetimeFeature
    {
        public bool Aborted { get; private set; }
        public CancellationToken RequestAborted { get => inner.RequestAborted; set => inner.RequestAborted = value; }
        public void Abort() { Aborted = true; inner.Abort(); }
    }
}
