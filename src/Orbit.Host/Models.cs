namespace Orbit.Host;

public sealed record DevicePermissions(bool View = false, bool Control = false, bool Clipboard = false, bool Files = false, bool Power = false)
{
    public bool IsValid => View && (!Power || Control);
}
public sealed record PairedDevice(string Id, string Name, string Fingerprint, DevicePermissions Permissions, DateTimeOffset CreatedAt, DateTimeOffset? RevokedAt = null, string? ResumeEpoch = null, bool BlockedByOwner = false);
public sealed record HostSettings(bool AllowRemotePower = false, bool FileTransferEnabled = false, string? FileTransferRoot = null, string? HostName = null);
public sealed record InviteRequest(string? DeviceName, DevicePermissions Permissions);
public sealed record PairRequest(string Secret, string DeviceName);
public sealed record SessionRequest(string? MonitorId = null, bool ViewOnly = false, string? ResumeEpoch = null);
public sealed record ClipboardRequest(string Text);
public sealed record PowerRequest(string Action);
public sealed record InvitePayload(int V, string Address, string Fingerprint, string Secret, DateTimeOffset ExpiresAt, string HostName);
public sealed record InviteResult(string InviteUri, DateTimeOffset ExpiresAt, DevicePermissions Permissions);
public sealed record AuditEvent(DateTimeOffset At, string Kind, string? DeviceId, string Detail);
public sealed record RemoteSession(string Id, string DeviceId, string DeviceName, string? MonitorId, DevicePermissions Permissions, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, DateTimeOffset LastActivityAt, DateTimeOffset? LastInputAt = null, string? ResumeEpoch = null);
