using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Orbit.Host;

public sealed class HostState
{
    public const int MaximumSessions = 8;
    public const int MaximumSessionsPerDevice = 2;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object gate = new();
    private readonly string directory;
    private readonly TimeProvider clock;
    private readonly Dictionary<string, PendingInvite> invites = [];
    private readonly Dictionary<string, RemoteSession> sessions = [];
    private readonly List<AuditEvent> audit = [];
    private PersistedState state;
    public string HostId => state.HostId;
    public string HostName { get { lock (gate) return state.Settings.HostName ?? Environment.MachineName; } }
    public HostSettings Settings { get { lock (gate) return state.Settings; } }
    public HostState(string directory, TimeProvider? timeProvider = null)
    {
        this.directory = directory;
        clock = timeProvider ?? TimeProvider.System;
        Security.CreatePrivateDirectory(directory);
        var path = Path.Combine(directory, "host.json");
        state = File.Exists(path) ? JsonSerializer.Deserialize<PersistedState>(File.ReadAllText(path), Json) ?? throw new InvalidOperationException("Host settings are invalid.") : new(Guid.NewGuid().ToString("N"), new(), []);
        // Legacy pairings get one durable authorization generation. Never derive it
        // from a session ID or reset it on normal process startup.
        for (var index = 0; index < state.Devices.Count; index++)
            if (string.IsNullOrWhiteSpace(state.Devices[index].ResumeEpoch))
                state.Devices[index] = state.Devices[index] with { ResumeEpoch = Security.RandomToken() };
        Save();
        var auditPath = Path.Combine(directory, "audit.jsonl");
        if (File.Exists(auditPath))
        {
            foreach (var line in File.ReadLines(auditPath).TakeLast(500))
                try { var entry = JsonSerializer.Deserialize<AuditEvent>(line, Json); if (entry is not null) audit.Add(entry); } catch (JsonException) { }
        }
    }
    public PairedDevice[] Devices { get { lock (gate) return state.Devices.ToArray(); } }
    public RemoteSession[] Sessions { get { lock (gate) { ExpireSessions(); return sessions.Values.ToArray(); } } }
    public AuditEvent[] Audit { get { lock (gate) return audit.AsEnumerable().Reverse().ToArray(); } }
    public PairedDevice? FindDevice(string fingerprint) { lock (gate) return state.Devices.FirstOrDefault(d => d.Fingerprint == fingerprint && d.RevokedAt is null); }
    public void UpdateSettings(HostSettings settings)
    {
        if (settings.HostName is { } name && (string.IsNullOrWhiteSpace(name) || name.Length > 80 || name.Any(char.IsControl))) throw new ArgumentException("Host name must contain 1 to 80 printable characters.");
        if (settings.FileTransferEnabled)
        {
            if (string.IsNullOrWhiteSpace(settings.FileTransferRoot) || !Path.IsPathFullyQualified(settings.FileTransferRoot)) throw new ArgumentException("Choose an absolute dedicated file transfer folder.");
            var root = Path.GetFullPath(settings.FileTransferRoot);
            if (Path.GetPathRoot(root)?.TrimEnd(Path.DirectorySeparatorChar) == root.TrimEnd(Path.DirectorySeparatorChar)) throw new ArgumentException("A disk root cannot be a file transfer folder.");
            if (!Directory.Exists(root)) throw new ArgumentException("Create the dedicated file transfer folder before enabling transfers.");
            RejectLinks(root);
            settings = settings with { FileTransferRoot = root };
        }
        lock (gate) { state = state with { Settings = settings }; Save(); AddAudit("settings.changed", null, "Host permissions updated locally."); }
    }
    public InviteResult CreateInvite(InviteRequest request, string remoteAddress, string fingerprint)
    {
        if (request.Permissions is null || !request.Permissions.IsValid) throw new ArgumentException("Pairing requires explicit screen viewing permission; power permission also requires keyboard/mouse control.");
        if (request.DeviceName is { } deviceName && (deviceName.Length > 80 || deviceName.Any(char.IsControl))) throw new ArgumentException("Device name must be at most 80 printable characters.");
        var secret = Security.RandomToken(); var expiry = clock.GetUtcNow().AddMinutes(5);
        lock (gate)
        {
            foreach (var key in invites.Where(p => p.Value.ExpiresAt <= clock.GetUtcNow()).Select(p => p.Key).ToArray()) invites.Remove(key);
            if (invites.Count >= 20) throw new InvalidOperationException("Too many active invites. Wait for an invite to expire.");
            invites.Add(Security.HashToken(secret), new(request.DeviceName, request.Permissions, expiry));
            AddAudit("invite.created", null, "Five-minute single-use pairing invite created locally.");
        }
        var payload = new InvitePayload(1, remoteAddress, fingerprint, secret, expiry, HostName);
        var encoded = Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(payload, Json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return new("orbit://pair/" + encoded, expiry, request.Permissions);
    }
    public PairedDevice Pair(PairRequest request, string fingerprint)
    {
        if (string.IsNullOrWhiteSpace(request.Secret) || request.Secret.Length > 128 || string.IsNullOrWhiteSpace(request.DeviceName) || request.DeviceName.Length > 80 || request.DeviceName.Any(char.IsControl)) throw new ArgumentException("Invalid pairing request.");
        lock (gate)
        {
            if (!invites.Remove(Security.HashToken(request.Secret), out var invite) || invite.ExpiresAt <= clock.GetUtcNow()) throw new UnauthorizedAccessException("The invite expired, was already used, or is invalid.");
            var existing = state.Devices.FindIndex(d => d.Fingerprint == fingerprint);
            var peer = new PairedDevice(existing >= 0 ? state.Devices[existing].Id : Guid.NewGuid().ToString("N"), string.IsNullOrWhiteSpace(invite.DeviceName) ? request.DeviceName.Trim() : invite.DeviceName.Trim(), fingerprint, invite.Permissions, clock.GetUtcNow(), ResumeEpoch: Security.RandomToken());
            if (existing >= 0) state.Devices[existing] = peer; else state.Devices.Add(peer);
            Save(); AddAudit("device.paired", peer.Id, "Device certificate pinned after invite verification.");
            return peer;
        }
    }
    public bool Revoke(string id) => Revoke(id, out _);
    public bool Revoke(string id, out bool revokedControllingSession)
    {
        lock (gate)
        {
            revokedControllingSession = false;
            var index = state.Devices.FindIndex(d => d.Id == id && d.RevokedAt is null); if (index < 0) return false;
            revokedControllingSession = sessions.Values.Any(s => s.DeviceId == id && s.Permissions.Control);
            state.Devices[index] = state.Devices[index] with { RevokedAt = clock.GetUtcNow() };
            foreach (var session in sessions.Values.Where(s => s.DeviceId == id).ToArray()) sessions.Remove(session.Id);
            Save(); AddAudit("device.revoked", id, "Device access revoked locally; its sessions ended."); return true;
        }
    }
    public RemoteSession StartSession(PairedDevice device, string? monitorId, bool viewOnly = false, string? expectedResumeEpoch = null)
    {
        lock (gate)
        {
            ExpireSessions();
            device = state.Devices.FirstOrDefault(d => d.Fingerprint == device.Fingerprint && d.RevokedAt is null) ?? throw new UnauthorizedAccessException();
            if (expectedResumeEpoch is not null && !Security.TokenEquals(expectedResumeEpoch, device.ResumeEpoch)) throw new SessionEndedException();
            var permissions = viewOnly ? device.Permissions with { Control = false, Clipboard = false, Files = false, Power = false } : device.Permissions;
            if (sessions.Values.Count(session => session.DeviceId == device.Id) >= MaximumSessionsPerDevice)
                throw new InvalidOperationException($"This device has reached its limit of {MaximumSessionsPerDevice} concurrent sessions. Close one of its sessions before connecting again.");
            if (sessions.Count >= MaximumSessions) throw new InvalidOperationException("The host has reached its session limit.");
            if (permissions.Control && sessions.Values.Any(s => s.Permissions.Control)) throw new InvalidOperationException("Another control session is active. End it before starting a new control session.");
            var now = clock.GetUtcNow();
            var session = new RemoteSession(Guid.NewGuid().ToString("N"), device.Id, device.Name, monitorId, permissions, now, now.AddHours(2), now, ResumeEpoch: device.ResumeEpoch);
            sessions.Add(session.Id, session); AddAudit("session.started", device.Id, "Remote desktop session started."); return session;
        }
    }
    public RemoteSession? GetSession(string id, string deviceId)
    {
        lock (gate)
        {
            ExpireSessions();
            if (!sessions.TryGetValue(id, out var session) || session.DeviceId != deviceId) return null;
            session = session with { LastActivityAt = clock.GetUtcNow() }; sessions[id] = session; return session;
        }
    }
    public bool EndSession(string id, string? deviceId = null) => EndSession(id, deviceId, out _);
    public bool EndSession(string id, string? deviceId, out bool endedControllingSession)
    {
        lock (gate)
        {
            endedControllingSession = false;
            if (!sessions.TryGetValue(id, out var session) || deviceId is not null && session.DeviceId != deviceId) return false;
            endedControllingSession = session.Permissions.Control;
            if (deviceId is null)
            {
                var index = state.Devices.FindIndex(d => d.Id == session.DeviceId);
                if (index >= 0) state.Devices[index] = state.Devices[index] with { ResumeEpoch = Security.RandomToken() };
                Save();
            }
            sessions.Remove(id); AddAudit("session.ended", session.DeviceId, "Remote session ended."); return true;
        }
    }
    public void TouchInput(string id)
    {
        lock (gate) if (sessions.TryGetValue(id, out var session)) sessions[id] = session with { LastInputAt = clock.GetUtcNow() };
    }
    public void EndAllSessions(bool explicitHostStop = true)
    {
        lock (gate)
        {
            if (explicitHostStop)
            {
                // Rotate even devices without a live session: a reconnect may be
                // queued while the host is stopped or an old session has expired.
                for (var index = 0; index < state.Devices.Count; index++)
                    state.Devices[index] = state.Devices[index] with { ResumeEpoch = Security.RandomToken() };
                Save();
            }
            sessions.Clear();
            AddAudit("sessions.disconnected", null, explicitHostStop ? "All remote sessions disconnected locally; automatic resumption invalidated." : "Host lifecycle ended active sessions; authorized resumption preserved.");
        }
    }
    public void AddAudit(string kind, string? deviceId, string detail)
    {
        lock (gate)
        {
            var entry = new AuditEvent(clock.GetUtcNow(), kind, deviceId, detail); audit.Add(entry); if (audit.Count > 500) audit.RemoveAt(0);
            var path = Path.Combine(directory, "audit.jsonl");
            // Rewrite a bounded file so an unattended host cannot grow audit logs without limit.
            File.WriteAllLines(path, audit.Select(e => JsonSerializer.Serialize(e, new JsonSerializerOptions(Json) { WriteIndented = false }))); Security.RestrictFile(path);
        }
    }
    public string GetSafeFilePath(string name)
    {
        Security.ValidateFileName(name);
        var settings = Settings;
        if (!settings.FileTransferEnabled || settings.FileTransferRoot is null) throw new UnauthorizedAccessException("File transfer is disabled locally.");
        RejectLinks(settings.FileTransferRoot);
        var path = Path.Combine(settings.FileTransferRoot, name);
        if (File.Exists(path) || Directory.Exists(path)) RejectLinks(path);
        return path;
    }
    private static void RejectLinks(string path)
    {
        var current = Path.GetFullPath(path);
        while (!string.IsNullOrEmpty(current))
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new ArgumentException("File transfer folders and files must not use symlinks or reparse points.");
            current = Path.GetDirectoryName(current);
        }
    }
    private void ExpireSessions()
    {
        var now = clock.GetUtcNow();
        foreach (var session in sessions.Values.Where(s => s.ExpiresAt <= now || now - s.LastActivityAt > TimeSpan.FromSeconds(30)).ToArray()) sessions.Remove(session.Id);
    }
    private void Save()
    {
        var path = Path.Combine(directory, "host.json"); var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(state, Json)); Security.RestrictFile(temporary); File.Move(temporary, path, true);
    }
    private sealed record PersistedState(string HostId, HostSettings Settings, List<PairedDevice> Devices);
    private sealed record PendingInvite(string? DeviceName, DevicePermissions Permissions, DateTimeOffset ExpiresAt);
}
