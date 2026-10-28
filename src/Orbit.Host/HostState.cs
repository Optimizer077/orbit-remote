using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Orbit.Host;

public sealed class HostState
{
    public const int MaximumSessions = 8;
    public const int MaximumSessionsPerDevice = 2;
    /// <summary>Size at which audit.jsonl is rotated to audit.1.jsonl; at most two files are kept.</summary>
    internal const long AuditRotationBytes = 256 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private static readonly JsonSerializerOptions AuditJson = new(Json) { WriteIndented = false };
    private readonly object gate = new();
    private readonly string directory;
    private readonly TimeProvider clock;
    private readonly Dictionary<string, PendingInvite> invites = [];
    private readonly Dictionary<string, RemoteSession> sessions = [];
    private readonly List<AuditEvent> audit = [];
    private PersistedState state;
    private long auditFileBytes;
    /// <summary>Window in which repeated per-device events of one kind are written once.</summary>
    internal static readonly TimeSpan AuditCoalesceWindow = TimeSpan.FromMinutes(1);
    private const int MaximumCoalescedKeys = 256;
    private readonly Dictionary<string, CoalescedEvent> coalesced = new(StringComparer.Ordinal);
    private DateTimeOffset nextAuditFailureReport = DateTimeOffset.MinValue;
    /// <summary>Receives local-only reports of audit write failures, at most once a minute.</summary>
    internal Action<string>? AuditWriteFailed { get; set; }
    /// <summary>Test seam for <see cref="AuditRotationBytes"/>.</summary>
    internal long AuditRotationLimit { get; set; } = AuditRotationBytes;
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
        var previousAuditPath = Path.Combine(directory, "audit.1.jsonl");
        var lines = (File.Exists(previousAuditPath) ? File.ReadLines(previousAuditPath) : [])
            .Concat(File.Exists(auditPath) ? File.ReadLines(auditPath) : []);
        foreach (var line in lines.TakeLast(500))
            try { var entry = JsonSerializer.Deserialize<AuditEvent>(line, Json); if (entry is not null) audit.Add(entry); } catch (JsonException) { }
        auditFileBytes = File.Exists(auditPath) ? new FileInfo(auditPath).Length : 0;
    }
    public PairedDevice[] Devices { get { lock (gate) return state.Devices.ToArray(); } }
    public RemoteSession[] Sessions { get { lock (gate) { ExpireSessions(); return sessions.Values.ToArray(); } } }
    public AuditEvent[] Audit { get { lock (gate) return audit.AsEnumerable().Reverse().ToArray(); } }
    public PairedDevice? FindDevice(string fingerprint) { lock (gate) return state.Devices.FirstOrDefault(d => d.Fingerprint == fingerprint && d.RevokedAt is null); }
    public void UpdateSettings(HostSettings settings)
    {
        if (settings.HostName is { } name && (string.IsNullOrWhiteSpace(name) || name.Length > 80 || !Security.IsSafeDisplayText(name))) throw new ArgumentException("Host name must contain 1 to 80 printable characters.");
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
        if (request.DeviceName is { } deviceName && (deviceName.Length > 80 || !Security.IsSafeDisplayText(deviceName))) throw new ArgumentException("Device name must be at most 80 printable characters.");
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
        if (string.IsNullOrWhiteSpace(request.Secret) || request.Secret.Length > 128 || string.IsNullOrWhiteSpace(request.DeviceName) || request.DeviceName.Length > 80 || !Security.IsSafeDisplayText(request.DeviceName)) throw new ArgumentException("Invalid pairing request.");
        lock (gate)
        {
            if (!invites.Remove(Security.HashToken(request.Secret), out var invite) || invite.ExpiresAt <= clock.GetUtcNow()) throw new UnauthorizedAccessException("The invite expired, was already used, or is invalid.");
            return Pin(fingerprint, string.IsNullOrWhiteSpace(invite.DeviceName) ? request.DeviceName.Trim() : invite.DeviceName.Trim(), invite.Permissions, "Device certificate pinned after invite verification.");
        }
    }
    /// <summary>EXPERIMENTAL (F33): pins a certificate after both short-code confirmations verified. The caller consumes the code.</summary>
    internal PairedDevice PairShortCode(string fingerprint, string deviceName, DevicePermissions permissions)
    {
        if (!permissions.IsValid || string.IsNullOrWhiteSpace(deviceName) || deviceName.Length > 80 || !Security.IsSafeDisplayText(deviceName)) throw new ArgumentException("Invalid pairing request.");
        lock (gate) return Pin(fingerprint, deviceName.Trim(), permissions, "Device certificate pinned after experimental short-code verification.");
    }
    private PairedDevice Pin(string fingerprint, string deviceName, DevicePermissions permissions, string auditDetail)
    {
        var existing = state.Devices.FindIndex(d => d.Fingerprint == fingerprint);
        var peer = new PairedDevice(existing >= 0 ? state.Devices[existing].Id : Guid.NewGuid().ToString("N"), deviceName, fingerprint, permissions, clock.GetUtcNow(), ResumeEpoch: Security.RandomToken(), BlockedByOwner: existing >= 0 && state.Devices[existing].BlockedByOwner);
        // A pin exists only once it is saved: if saving fails, restore the previous
        // in-memory list so the certificate is not trusted until the next restart.
        var previous = state.Devices.ToList();
        if (existing >= 0) state.Devices[existing] = peer; else state.Devices.Add(peer);
        try { Save(); }
        catch
        {
            state.Devices.Clear(); state.Devices.AddRange(previous);
            throw;
        }
        foreach (var session in sessions.Values.Where(session => session.DeviceId == peer.Id).ToArray()) sessions.Remove(session.Id);
        AddAudit("device.paired", peer.Id, auditDetail);
        return peer;
    }
    public bool Revoke(string id) => Revoke(id, out _);
    public bool Revoke(string id, out bool revokedControllingSession)
    {
        lock (gate)
        {
            revokedControllingSession = false;
            var index = state.Devices.FindIndex(d => d.Id == id && d.RevokedAt is null); if (index < 0) return false;
            revokedControllingSession = sessions.Values.Any(s => s.DeviceId == id && s.Permissions.Control);
            state.Devices[index] = state.Devices[index] with { RevokedAt = clock.GetUtcNow(), BlockedByOwner = false };
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
            if (device.BlockedByOwner) throw new OwnerEndedException();
            if (expectedResumeEpoch is not null && !Security.TokenEquals(expectedResumeEpoch, device.ResumeEpoch)) throw new SessionEndedException();
            var permissions = viewOnly ? device.Permissions with { Control = false, Clipboard = false, Files = false, Power = false } : device.Permissions;
            if (sessions.Values.Count(session => session.DeviceId == device.Id) >= MaximumSessionsPerDevice)
                throw new InvalidOperationException($"This device has reached its limit of {MaximumSessionsPerDevice} concurrent sessions. Close one of its sessions before connecting again.");
            // One slot stays free for a control session, so paired viewers cannot lock
            // out the controller; only one control session can exist at a time anyway.
            if (sessions.Count >= MaximumSessions || !permissions.Control && sessions.Values.Count(s => !s.Permissions.Control) >= MaximumSessions - 1)
                throw new InvalidOperationException("The host has reached its session limit.");
            if (permissions.Control && sessions.Values.Any(s => s.Permissions.Control)) throw new InvalidOperationException("Another control session is active. End it before starting a new control session.");
            var now = clock.GetUtcNow();
            var session = new RemoteSession(Guid.NewGuid().ToString("N"), device.Id, device.Name, monitorId, permissions, now, now.AddHours(2), now, ResumeEpoch: device.ResumeEpoch);
            sessions.Add(session.Id, session); AddCoalescedAudit("session.started", device.Id, "Remote desktop session started."); return session;
        }
    }
    public RemoteSession? GetSession(string id, string deviceId)
    {
        lock (gate)
        {
            ExpireSessions();
            if (!sessions.TryGetValue(id, out var session) || session.DeviceId != deviceId) return null;
            var device = state.Devices.FirstOrDefault(candidate => candidate.Id == deviceId && candidate.RevokedAt is null);
            if (device is null || device.BlockedByOwner || !Security.TokenEquals(device.ResumeEpoch, session.ResumeEpoch)) return null;
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
                if (!BlockDevice(session.DeviceId, out endedControllingSession)) return false;
                AddAudit("session.ended", session.DeviceId, "Owner ended the session and blocked its device until explicitly allowed again.");
                return true;
            }
            sessions.Remove(id); AddCoalescedAudit("session.ended", session.DeviceId, "Remote session ended."); return true;
        }
    }
    public void TouchInput(string id)
    {
        lock (gate) if (sessions.TryGetValue(id, out var session)) sessions[id] = session with { LastInputAt = clock.GetUtcNow() };
    }
    public bool BlockDevice(string id, out bool endedControllingSession)
    {
        lock (gate)
        {
            endedControllingSession = false;
            var index = state.Devices.FindIndex(device => device.Id == id && device.RevokedAt is null);
            if (index < 0) return false;
            endedControllingSession = sessions.Values.Any(session => session.DeviceId == id && session.Permissions.Control);
            if (!state.Devices[index].BlockedByOwner)
            {
                state.Devices[index] = state.Devices[index] with { BlockedByOwner = true, ResumeEpoch = Security.RandomToken() };
                Save();
                AddAudit("device.blocked_by_owner", id, "Owner blocked the device until explicitly allowed again.");
            }
            foreach (var session in sessions.Values.Where(session => session.DeviceId == id).ToArray()) sessions.Remove(session.Id);
            return true;
        }
    }
    public PairedDevice? AllowDevice(string id)
    {
        lock (gate)
        {
            var index = state.Devices.FindIndex(device => device.Id == id && device.RevokedAt is null);
            if (index < 0) return null;
            if (!state.Devices[index].BlockedByOwner) return state.Devices[index];
            state.Devices[index] = state.Devices[index] with { BlockedByOwner = false, ResumeEpoch = Security.RandomToken() };
            Save(); AddAudit("device.allowed_by_owner", id, "Owner explicitly allowed the device again with its existing grants.");
            return state.Devices[index];
        }
    }
    public void EndAllSessions(bool explicitHostStop = true)
    {
        lock (gate)
        {
            if (explicitHostStop)
            {
                // Block the devices represented by the current live-session
                // snapshot. Idle pairings were not targets of this action.
                ExpireSessions();
                var connected = sessions.Values.Select(session => session.DeviceId).ToHashSet(StringComparer.Ordinal);
                var newlyBlocked = new List<string>();
                for (var index = 0; index < state.Devices.Count; index++)
                {
                    var device = state.Devices[index];
                    if (device.RevokedAt is not null) continue;
                    var block = device.BlockedByOwner || connected.Contains(device.Id);
                    if (block && !device.BlockedByOwner) newlyBlocked.Add(device.Id);
                    state.Devices[index] = device with { BlockedByOwner = block, ResumeEpoch = Security.RandomToken() };
                }
                Save();
                foreach (var id in newlyBlocked) AddAudit("device.blocked_by_owner", id, "Owner disconnected all sessions and blocked this connected device until explicitly allowed again.");
            }
            sessions.Clear();
            AddAudit("sessions.disconnected", null, explicitHostStop ? "All remote sessions disconnected locally; their devices blocked until explicitly allowed again." : "Host lifecycle ended active sessions; authorized resumption preserved.");
        }
    }
    public void AddAudit(string kind, string? deviceId, string detail)
    {
        lock (gate)
        {
            var entry = new AuditEvent(clock.GetUtcNow(), kind, deviceId, detail); audit.Add(entry); if (audit.Count > 500) audit.RemoveAt(0);
            // Append one line per event; rotate to a single previous file so the
            // on-disk log stays bounded at about twice AuditRotationLimit.
            // The operation that produced this event has already committed, so a file
            // failure is reported locally and never thrown back to it.
            var path = Path.Combine(directory, "audit.jsonl");
            var line = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(entry, AuditJson) + "\n");
            if (auditFileBytes > 0 && auditFileBytes + line.Length > AuditRotationLimit)
            {
                // A locked previous file only delays rotation; appending continues.
                try { if (File.Exists(path)) File.Move(path, Path.Combine(directory, "audit.1.jsonl"), overwrite: true); auditFileBytes = 0; }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { ReportAuditFailure("rotate", ex); }
            }
            try
            {
                var created = !File.Exists(path);
                var options = new FileStreamOptions { Mode = FileMode.Append, Access = FileAccess.Write, Share = FileShare.Read };
                if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
                using (var output = new FileStream(path, options)) output.Write(line);
                if (created) { Security.RestrictFile(path); auditFileBytes = 0; }
                auditFileBytes += line.Length;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                ReportAuditFailure("append", ex);
                try { auditFileBytes = File.Exists(path) ? new FileInfo(path).Length : 0; }
                catch (Exception lengthError) when (lengthError is IOException or UnauthorizedAccessException) { auditFileBytes = 0; }
            }
        }
    }

    /// <summary>
    /// Audits a remote, per-device event at most once per <see cref="AuditCoalesceWindow"/> for
    /// each (kind, device). Repeats are counted and reported in the next entry, so a peer that
    /// churns sessions or the clipboard cannot push other events out of the bounded history.
    /// </summary>
    internal bool AddCoalescedAudit(string kind, string deviceId, string detail)
    {
        lock (gate)
        {
            var now = clock.GetUtcNow();
            var key = kind + "|" + deviceId;
            if (coalesced.TryGetValue(key, out var known) && now - known.RecordedAt < AuditCoalesceWindow) { known.Suppressed++; return false; }
            if (known is null && coalesced.Count >= MaximumCoalescedKeys)
                foreach (var stale in coalesced.Where(entry => now - entry.Value.RecordedAt >= AuditCoalesceWindow).Select(entry => entry.Key).ToArray())
                    coalesced.Remove(stale);
            var repeats = known?.Suppressed ?? 0;
            coalesced[key] = new CoalescedEvent { RecordedAt = now };
            AddAudit(kind, deviceId, repeats > 0 ? $"{detail} {repeats} similar earlier events from this device were not recorded individually." : detail);
            return true;
        }
    }

    private void ReportAuditFailure(string step, Exception ex)
    {
        var now = clock.GetUtcNow();
        if (now < nextAuditFailureReport) return;
        nextAuditFailureReport = now + AuditCoalesceWindow;
        try { AuditWriteFailed?.Invoke($"Audit log {step} failed ({ex.GetType().Name}); events stay in memory and later writes retry."); }
        catch (Exception reportError) when (reportError is IOException or InvalidOperationException) { /* Reporting must not fail the operation. */ }
    }

    private sealed class CoalescedEvent { internal DateTimeOffset RecordedAt; internal int Suppressed; }
    public int InvalidatePairingsForIdentityRotation()
    {
        lock (gate)
        {
            sessions.Clear(); invites.Clear();
            var count = state.Devices.Count(device => device.RevokedAt is null);
            for (var index = 0; index < state.Devices.Count; index++)
                state.Devices[index] = state.Devices[index] with { RevokedAt = state.Devices[index].RevokedAt ?? clock.GetUtcNow(), ResumeEpoch = Security.RandomToken(), BlockedByOwner = false };
            Save();
            return count;
        }
    }
    public string GetSafeFilePath(string name)
    {
        Security.ValidateFileName(name);
        if (UploadStore.IsReservedName(name)) throw new ArgumentException("That filename is reserved for private upload staging.");
        var settings = Settings;
        if (!settings.FileTransferEnabled || settings.FileTransferRoot is null) throw new UnauthorizedAccessException("File transfer is disabled locally.");
        RejectLinks(settings.FileTransferRoot);
        var path = Path.Combine(settings.FileTransferRoot, name);
        if (File.Exists(path) || Directory.Exists(path))
        {
            RejectLinks(path);
            if (OperatingSystem.IsWindows()) ValidateResolvedFileName(name, Path.GetFileName(WindowsLongPath(path)));
        }
        return path;
    }
    internal static void ValidateResolvedFileName(string requested, string resolved)
    {
        if (UploadStore.IsReservedName(resolved) || !string.Equals(requested, resolved, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Use the full, non-reserved filename; file aliases are not accepted.");
    }
    private static string WindowsLongPath(string path)
    {
        var nativePath = path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path : path.StartsWith(@"\\", StringComparison.Ordinal)
            ? @"\\?\UNC\" + path[2..] : @"\\?\" + path;
        var required = GetLongPathName(nativePath, null, 0);
        if (required is 0 or > 32768) throw new UnauthorizedAccessException("The file's full name could not be resolved.");
        var buffer = new StringBuilder((int)required);
        var length = GetLongPathName(nativePath, buffer, required);
        if (length == 0 || length >= required) throw new UnauthorizedAccessException("The file's full name could not be resolved.");
        return buffer.ToString();
    }
    [DllImport("kernel32.dll", EntryPoint = "GetLongPathNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetLongPathName(string path, StringBuilder? buffer, uint length);
    internal void PublishUpload(string name, string expectedDestination, string staging, Func<bool> authorized)
    {
        lock (gate)
        {
            if (!authorized()) throw new UnauthorizedAccessException();
            var destination = GetSafeFilePath(name);
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!string.Equals(destination, expectedDestination, comparison) ||
                !string.Equals(Path.GetDirectoryName(destination), Path.GetDirectoryName(staging), comparison) ||
                !UploadStore.IsOwnedStageName(Path.GetFileName(staging))) throw new UnauthorizedAccessException();
            RejectLinks(staging);
            try { File.Move(staging, destination, overwrite: false); }
            catch (IOException) when (File.Exists(destination) || Directory.Exists(destination)) { throw UploadStore.Exists(); }
        }
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
    /// <summary>Test seam: runs before every state save; throwing simulates a failed write.</summary>
    internal Action? BeforeSave { get; set; }
    private void Save()
    {
        BeforeSave?.Invoke();
        var path = Path.Combine(directory, "host.json"); var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            // Create the private file without a permissive creation window and
            // flush its content (WritePrivateNewFile calls Flush(true)) before
            // replacing the state name. Directory
            // metadata and the state/identity pair are not one crash transaction.
            Security.WritePrivateNewFile(temporary, JsonSerializer.SerializeToUtf8Bytes(state, Json));
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private sealed record PersistedState(string HostId, HostSettings Settings, List<PairedDevice> Devices);
    private sealed record PendingInvite(string? DeviceName, DevicePermissions Permissions, DateTimeOffset ExpiresAt);
}
