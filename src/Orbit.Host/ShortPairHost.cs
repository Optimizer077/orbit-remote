using System.Security.Cryptography;
using Org.BouncyCastle.Crypto.Agreement.Srp;
using Org.BouncyCastle.Security;
using BigInteger = Org.BouncyCastle.Math.BigInteger;

namespace Orbit.Host;

internal sealed class ShortPairException(int status, string code, string message) : Exception(message)
{
    internal int Status { get; } = status;
    internal string Code { get; } = code;
}

internal sealed record ShortCodeCreated(string Code, DateTimeOffset ExpiresAt, DevicePermissions Permissions);
internal sealed record ShortCodeStatus(string State, DateTimeOffset? ExpiresAt, DevicePermissions? Permissions, int? AttemptsRemaining);
/// <summary>Exactly the five grant flags on the wire (DevicePermissions would also serialize its computed isValid).</summary>
internal sealed record ShortPairGrants(bool View, bool Control, bool Clipboard, bool Files, bool Power)
{
    internal static ShortPairGrants From(DevicePermissions grants) => new(grants.View, grants.Control, grants.Clipboard, grants.Files, grants.Power);
    internal DevicePermissions ToPermissions() => new(View, Control, Clipboard, Files, Power);
}
internal sealed record ShortPairStartResponse(int V, string Suite, string AttemptId, string InstanceId, string HostNonce, long ExpiresAt, ShortPairGrants Grants, string Salt, string B);
internal sealed record ShortPairVerifyResponse(string M2, string HostConfirmation);
internal sealed record ShortPairReceipt(string DeviceId, string DeviceName, string HostId, string HostName, ShortPairGrants Permissions, string CertificateFingerprint);

/// <summary>
/// EXPERIMENTAL (F33, disabled by default): the SRP server role for the host's one
/// active short code. All state is in memory. The code itself is never stored:
/// only its salt and SRP verifier, until success, cancel, expiry, lockout or exit.
/// </summary>
internal sealed class ShortPairHost(HostState state, Func<string> hostFingerprint, TimeProvider? timeProvider = null)
{
    internal const int MaximumAttempts = 5;
    internal static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(10);
    internal static readonly TimeSpan AttemptLifetime = TimeSpan.FromSeconds(60);
    internal static readonly TimeSpan ReceiptLifetime = TimeSpan.FromMinutes(2);
    private readonly object gate = new();
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private ActiveCode? active;
    private Completion? completed;
    private string lastState = "none";

    public ShortCodeCreated Create(InviteRequest request)
    {
        if (request.Permissions is null || !request.Permissions.IsValid) throw new ArgumentException("Pairing requires explicit screen viewing permission; power permission also requires keyboard/mouse control.");
        if (request.DeviceName is { } name && (name.Length > 80 || !Security.IsSafeDisplayText(name))) throw new ArgumentException("Device name must be at most 80 printable characters.");
        // The receipt carries the host name; the viewer refuses unsafe text, which would
        // otherwise leave a one-sided pairing after the code is consumed.
        if (!Security.IsSafeDisplayText(state.HostName)) throw new ArgumentException("Rename this computer: its name contains characters that cannot be shown safely.");
        var code = ShortCode.Generate();
        var salt = RandomNumberGenerator.GetBytes(ShortPairProtocol.SaltBytes);
        var verifier = ShortPairProtocol.Verifier(salt, code);
        // Whole seconds, so the transcript's expiry field is the exact value both sides see.
        var expiresAt = DateTimeOffset.FromUnixTimeSeconds(clock.GetUtcNow().ToUnixTimeSeconds()) + CodeLifetime;
        lock (gate)
        {
            if (active is not null) Clear(active);
            active = new(RandomNumberGenerator.GetBytes(ShortPairProtocol.InstanceBytes), salt, verifier, expiresAt, request.Permissions, string.IsNullOrWhiteSpace(request.DeviceName) ? null : request.DeviceName.Trim());
            lastState = "active";
        }
        state.AddAudit("shortcode.created", null, "Experimental ten-minute single-use short pairing code created locally.");
        return new(ShortCode.Format(code), expiresAt, request.Permissions);
    }

    public ShortCodeStatus Status()
    {
        lock (gate)
        {
            Sweep();
            return active is { } code ? new("active", code.ExpiresAt, code.Permissions, MaximumAttempts - code.Started) : new(lastState, null, null, null);
        }
    }

    public bool Cancel()
    {
        lock (gate)
        {
            Sweep();
            if (active is null) return false;
            Clear(active); active = null; lastState = "cancelled";
        }
        state.AddAudit("shortcode.cancelled", null, "Experimental short pairing code cancelled locally.");
        return true;
    }

    /// <param name="connectionId">The TLS connection carrying this request. An unfinished attempt never moves to another connection.</param>
    public ShortPairStartResponse Start(byte[] viewerNonce, string deviceName, string viewerFingerprint, string connectionId)
    {
        if (viewerNonce.Length != ShortPairProtocol.NonceBytes || string.IsNullOrEmpty(connectionId)) throw new ArgumentException("Invalid short-code request.");
        ActiveCode code; Attempt attempt;
        lock (gate)
        {
            Sweep();
            code = active ?? throw Unavailable();
            if (code.Started >= MaximumAttempts) throw Locked();
            // Reserve the slot before any PAKE work: concurrent or abandoned starts
            // spend the same five-attempt budget.
            code.Started++;
            attempt = new(RandomNumberGenerator.GetBytes(ShortPairProtocol.AttemptBytes), viewerNonce.ToArray(),
                RandomNumberGenerator.GetBytes(ShortPairProtocol.NonceBytes), viewerFingerprint, connectionId, deviceName, clock.GetUtcNow() + AttemptLifetime);
            code.Attempts.Add(attempt.Id, attempt);
        }
        try
        {
            var server = new Srp6Server();
            server.Init(ShortPairProtocol.Group, code.Verifier, ShortPairProtocol.Digest(), new SecureRandom());
            attempt.B = ShortPairProtocol.Unsigned(server.GenerateServerCredentials(), ShortPairProtocol.GroupBytes);
            attempt.Server = server;
        }
        catch (Exception)
        {
            lock (gate) Fail(code, attempt);
            throw;
        }
        lock (gate)
        {
            Sweep();
            if (!ReferenceEquals(active, code) || attempt.Stage != Stage.Reserved) throw Unavailable();
            attempt.Stage = Stage.Started;
        }
        return new(ShortPairProtocol.Version, ShortPairProtocol.Suite, attempt.Id, ShortPairProtocol.Encode(code.InstanceId), ShortPairProtocol.Encode(attempt.HostNonce),
            code.ExpiresAt.ToUnixTimeSeconds(), ShortPairGrants.From(code.Permissions), ShortPairProtocol.Encode(code.Salt), ShortPairProtocol.Encode(attempt.B!));
    }

    public ShortPairVerifyResponse Verify(string attemptId, byte[] a, byte[] m1, string viewerFingerprint, string connectionId)
    {
        ActiveCode code; Attempt? attempt;
        lock (gate)
        {
            Sweep();
            code = active ?? throw Unavailable();
            if (!code.Attempts.TryGetValue(attemptId, out attempt) || attempt.Stage != Stage.Started) throw Rejected();
            // The fingerprint and connection come from the TLS connection carrying this request.
            if (!SameChannel(attempt, viewerFingerprint, connectionId)) { Fail(code, attempt); throw Rejected(); }
            attempt.Stage = Stage.Verifying;
        }
        byte[]? key = null;
        try
        {
            var server = attempt.Server ?? throw Rejected();
            // Canonical encoding only: 0 < A < N (Bouncy Castle alone accepts A >= N when A mod N != 0).
            if (!ShortPairProtocol.IsCanonicalElement(a)) throw Rejected();
            server.CalculateSecret(new BigInteger(1, a));
            if (!server.VerifyClientEvidenceMessage(new BigInteger(1, m1))) throw Rejected();
            var m2 = ShortPairProtocol.Unsigned(server.CalculateServerEvidenceMessage(), ShortPairProtocol.HashBytes);
            key = ShortPairProtocol.Unsigned(server.CalculateSessionKey(), ShortPairProtocol.HashBytes);
            var transcript = ShortPairProtocol.Transcript(new(code.InstanceId, attempt.IdBytes, attempt.ViewerNonce, attempt.HostNonce, code.ExpiresAt.ToUnixTimeSeconds(),
                code.Permissions, code.Salt, a, attempt.B!, ShortPairProtocol.FingerprintFromHex(hostFingerprint()), ShortPairProtocol.FingerprintFromHex(viewerFingerprint)));
            var hostConfirmation = ShortPairProtocol.Confirmation(key, hostToViewer: true, transcript);
            var expectedViewer = ShortPairProtocol.Confirmation(key, hostToViewer: false, transcript);
            lock (gate)
            {
                Sweep();
                if (!ReferenceEquals(active, code) || attempt.Stage != Stage.Verifying) throw Unavailable();
                attempt.Stage = Stage.Verified; attempt.Server = null; attempt.ExpectedViewerConfirmation = expectedViewer;
            }
            return new(ShortPairProtocol.Encode(m2), ShortPairProtocol.Encode(hostConfirmation));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Wrong code, invalid group element (Bouncy Castle CryptoException) or any
            // other failure consumes this attempt. Nothing is pinned.
            lock (gate) if (attempt.Stage == Stage.Verifying) Fail(code, attempt);
            if (ex is ShortPairException) throw;
            throw Rejected();
        }
        finally { if (key is not null) CryptographicOperations.ZeroMemory(key); }
    }

    public ShortPairReceipt Confirm(string attemptId, byte[] viewerConfirmation, string viewerFingerprint, string connectionId)
    {
        ShortPairReceipt receipt;
        lock (gate)
        {
            Sweep();
            var confirmationHash = SHA256.HashData(viewerConfirmation);
            var attemptBytes = ShortPairProtocol.Decode(attemptId, ShortPairProtocol.AttemptBytes) ?? [];
            if (completed is { } done && CryptographicOperations.FixedTimeEquals(done.AttemptId, attemptBytes))
            {
                // The only cross-connection message: a COMPLETED attempt may re-fetch its
                // identical receipt with the same certificate and final confirmation.
                if (Security.TokenEquals(done.ViewerFingerprint, viewerFingerprint) && CryptographicOperations.FixedTimeEquals(done.ConfirmationHash, confirmationHash)) return done.Receipt;
                throw Rejected();
            }
            var code = active ?? throw Unavailable();
            if (!code.Attempts.TryGetValue(attemptId, out var attempt) || attempt.Stage != Stage.Verified) throw Rejected();
            if (!SameChannel(attempt, viewerFingerprint, connectionId) ||
                !CryptographicOperations.FixedTimeEquals(attempt.ExpectedViewerConfirmation, viewerConfirmation)) { Fail(code, attempt); throw Rejected(); }
            // Both confirmations verified. Consume first (as the long invite does), then
            // pin, inside one lock: simultaneous successes produce at most one pairing, and
            // a failed save leaves the code used rather than a half-finished pairing.
            var deviceName = code.DeviceName ?? attempt.DeviceName;
            Clear(code); active = null; lastState = "used";
            var device = state.PairShortCode(viewerFingerprint, deviceName, code.Permissions);
            receipt = new(device.Id, device.Name, state.HostId, state.HostName, ShortPairGrants.From(device.Permissions), hostFingerprint());
            completed = new(attempt.IdBytes.ToArray(), viewerFingerprint, confirmationHash, receipt, clock.GetUtcNow() + ReceiptLifetime);
        }
        return receipt;
    }

    private static bool SameChannel(Attempt attempt, string viewerFingerprint, string connectionId) =>
        Security.TokenEquals(attempt.ViewerFingerprint, viewerFingerprint) && string.Equals(attempt.ConnectionId, connectionId, StringComparison.Ordinal);

    private void Sweep()
    {
        var now = clock.GetUtcNow();
        if (completed is not null && completed.ExpiresAt <= now) completed = null;
        var code = active;
        if (code is null) return;
        if (code.ExpiresAt <= now) { Clear(code); active = null; lastState = "expired"; return; }
        // Abandoned or slow attempts count as failures once their deadline passes.
        foreach (var attempt in code.Attempts.Values.Where(attempt => attempt.Deadline <= now).ToArray()) Fail(code, attempt);
    }

    private void Fail(ActiveCode code, Attempt attempt)
    {
        if (attempt.Stage == Stage.Failed) return;
        attempt.Stage = Stage.Failed; attempt.Server = null;
        if (attempt.ExpectedViewerConfirmation is { } expected) CryptographicOperations.ZeroMemory(expected);
        code.Attempts.Remove(attempt.Id);
        code.Failed++;
        if (!ReferenceEquals(active, code)) return;
        if (code.Failed < MaximumAttempts) { state.AddAudit("shortcode.attempt_failed", null, "An experimental short-code pairing attempt failed; nothing was pinned."); return; }
        Clear(code); active = null; lastState = "locked";
        state.AddAudit("shortcode.locked", null, "Experimental short pairing code cancelled after five failed attempts.");
    }

    private static void Clear(ActiveCode code)
    {
        CryptographicOperations.ZeroMemory(code.Salt);
        foreach (var attempt in code.Attempts.Values)
        {
            attempt.Stage = Stage.Failed; attempt.Server = null;
            if (attempt.ExpectedViewerConfirmation is { } expected) CryptographicOperations.ZeroMemory(expected);
        }
        code.Attempts.Clear();
    }

    private ShortPairException Unavailable() => lastState == "locked" ? Locked() :
        new(403, "short_code_unavailable", "No short pairing code is active. Ask the owner for a new code.");
    private static ShortPairException Locked() => new(403, "short_code_locked", "Too many failed attempts. Ask the owner for a new code.");
    private static ShortPairException Rejected() => new(403, "short_code_rejected", "The short pairing code was not accepted.");

    private enum Stage { Reserved, Started, Verifying, Verified, Failed }
    private sealed class ActiveCode(byte[] instanceId, byte[] salt, BigInteger verifier, DateTimeOffset expiresAt, DevicePermissions permissions, string? deviceName)
    {
        public byte[] InstanceId { get; } = instanceId;
        public byte[] Salt { get; } = salt;
        public BigInteger Verifier { get; } = verifier;
        public DateTimeOffset ExpiresAt { get; } = expiresAt;
        public DevicePermissions Permissions { get; } = permissions;
        public string? DeviceName { get; } = deviceName;
        public int Started { get; set; }
        public int Failed { get; set; }
        public Dictionary<string, Attempt> Attempts { get; } = new(StringComparer.Ordinal);
    }
    private sealed class Attempt(byte[] id, byte[] viewerNonce, byte[] hostNonce, string viewerFingerprint, string connectionId, string deviceName, DateTimeOffset deadline)
    {
        public byte[] IdBytes { get; } = id;
        public string Id { get; } = ShortPairProtocol.Encode(id);
        public byte[] ViewerNonce { get; } = viewerNonce;
        public byte[] HostNonce { get; } = hostNonce;
        public string ViewerFingerprint { get; } = viewerFingerprint;
        public string ConnectionId { get; } = connectionId;
        public byte[]? B { get; set; }
        public string DeviceName { get; } = deviceName;
        public DateTimeOffset Deadline { get; } = deadline;
        public Stage Stage { get; set; } = Stage.Reserved;
        public Srp6Server? Server { get; set; }
        public byte[]? ExpectedViewerConfirmation { get; set; }
    }
    private sealed record Completion(byte[] AttemptId, string ViewerFingerprint, byte[] ConfirmationHash, ShortPairReceipt Receipt, DateTimeOffset ExpiresAt);
}
