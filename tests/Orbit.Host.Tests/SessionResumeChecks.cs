using System.Text.Json;
using System.Text.Json.Nodes;
using Orbit.Host;

public static class SessionResumeChecks
{
    public static void Run(Action<bool, string> check, Action<Action, string> reject, string tempRoot)
    {
        var directory = Path.Combine(tempRoot, "session-resume-state");
        var clock = new TestClock();
        var state = new HostState(directory, clock);
        var first = Pair(state, "first-controller");
        var second = Pair(state, "second-controller");
        check(!string.IsNullOrEmpty(first.ResumeEpoch) && first.ResumeEpoch != second.ResumeEpoch, "Each paired device has distinct random resume authorization");
        var session = state.StartSession(first, null);
        check(session.ResumeEpoch == first.ResumeEpoch, "Session response supplies its paired-device resume epoch");
        check(state.EndSession(session.Id), "Local host can stop one session");
        check(state.GetSession(session.Id, first.Id) is null, "Host-stopped session is unavailable");
        RejectResume(() => state.StartSession(first, null, expectedResumeEpoch: session.ResumeEpoch), "Host stop rejects automatic renewal with the old epoch");

        state = new HostState(directory, clock);
        first = state.FindDevice(first.Fingerprint)!;
        check(first.ResumeEpoch != session.ResumeEpoch, "Single-session host stop remains effective after process restart");
        RejectResume(() => state.StartSession(first, null, expectedResumeEpoch: session.ResumeEpoch), "Restart cannot revive a host-stopped resume epoch");
        var manual = state.StartSession(first, null);
        check(manual.ResumeEpoch == first.ResumeEpoch, "Explicit new connection without a resume epoch is allowed after host stop");
        check(state.EndSession(manual.Id, first.Id), "Remote owner may end its own session");
        var resumed = state.StartSession(first, null, expectedResumeEpoch: manual.ResumeEpoch);
        check(resumed.ResumeEpoch == manual.ResumeEpoch, "Remote session end preserves existing reconnect authorization");

        clock.Advance(TimeSpan.FromSeconds(31));
        check(state.GetSession(resumed.Id, first.Id) is null, "Idle expiry produces a missing session");
        resumed = state.StartSession(first, null, expectedResumeEpoch: resumed.ResumeEpoch);
        check(resumed.ResumeEpoch == first.ResumeEpoch, "Normal idle expiry permits authorized automatic renewal");
        clock.Advance(TimeSpan.FromHours(3));
        check(state.GetSession(resumed.Id, first.Id) is null, "Absolute expiry produces a missing session");
        resumed = state.StartSession(first, null, expectedResumeEpoch: resumed.ResumeEpoch);
        check(resumed.ResumeEpoch == first.ResumeEpoch, "Normal absolute expiry preserves resume authorization");

        state.EndAllSessions(explicitHostStop: false);
        state = new HostState(directory, clock);
        first = state.FindDevice(first.Fingerprint)!;
        resumed = state.StartSession(first, null, expectedResumeEpoch: resumed.ResumeEpoch);
        check(resumed.ResumeEpoch == first.ResumeEpoch, "Graceful lifecycle shutdown and restart preserve authorized reconnection");
        second = state.FindDevice(second.Fingerprint)!;
        RejectResume(() => state.StartSession(second, null, expectedResumeEpoch: first.ResumeEpoch), "Another device's valid resume epoch cannot authorize renewal");

        var oldFirstEpoch = first.ResumeEpoch; var oldSecondEpoch = second.ResumeEpoch;
        state.EndAllSessions();
        state = new HostState(directory, clock);
        first = state.FindDevice(first.Fingerprint)!; second = state.FindDevice(second.Fingerprint)!;
        check(state.Sessions.Length == 0, "Panic disconnect clears all active sessions");
        check(first.ResumeEpoch != oldFirstEpoch && second.ResumeEpoch != oldSecondEpoch, "Panic disconnect persistently rotates epochs even for a device with no active session");
        RejectResume(() => state.StartSession(first, null, expectedResumeEpoch: oldFirstEpoch), "Panic disconnect blocks old resume after restart");
        RejectResume(() => state.StartSession(second, null, expectedResumeEpoch: oldSecondEpoch), "Panic disconnect also blocks pending reconnect from an inactive device");
        check(state.StartSession(first, null).ResumeEpoch == first.ResumeEpoch, "Explicit connect remains available after persisted panic disconnect");

        var legacyDirectory = Path.Combine(tempRoot, "legacy-resume-state");
        Directory.CreateDirectory(legacyDirectory);
        var legacy = JsonNode.Parse(File.ReadAllText(Path.Combine(directory, "host.json")))!;
        foreach (var device in legacy["devices"]!.AsArray()) device!.AsObject().Remove("resumeEpoch");
        File.WriteAllText(Path.Combine(legacyDirectory, "host.json"), legacy.ToJsonString());
        var migrated = new HostState(legacyDirectory, clock);
        var migratedEpoch = migrated.FindDevice(first.Fingerprint)!.ResumeEpoch;
        check(!string.IsNullOrEmpty(migratedEpoch), "Legacy pairing state receives a resume epoch on load");
        check(new HostState(legacyDirectory, clock).FindDevice(first.Fingerprint)!.ResumeEpoch == migratedEpoch, "Migrated resume epoch persists rather than resetting on each startup");

        check(new DevicePermissions(View: true).IsValid, "Viewing-only pairing remains valid");
        check(new DevicePermissions(View: true, Control: true, Power: true).IsValid, "Power with viewing and control remains valid");
        check(!new DevicePermissions(View: true, Power: true).IsValid, "Power without control is rejected");
        check(!new DevicePermissions(Control: true).IsValid, "Control without viewing is rejected");
        reject(() => state.CreateInvite(new(null, new(View: true, Power: true)), "https://127.0.0.1:47832", "test-pin"), "Invalid power-only invitation is rejected before creation");

        void RejectResume(Action action, string message)
        {
            try { action(); check(false, message); }
            catch (SessionEndedException ex) { check(ex.Message.Contains("Connect again explicitly", StringComparison.Ordinal), message); }
        }
    }

    private static PairedDevice Pair(HostState state, string fingerprint)
    {
        var invite = state.CreateInvite(new(fingerprint, new(View: true)), "https://127.0.0.1:47832", "test-pin");
        var encoded = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        encoded = encoded.PadRight((encoded.Length + 3) / 4 * 4, '=');
        var secret = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(encoded)).GetProperty("secret").GetString()!;
        return state.Pair(new(secret, fingerprint), fingerprint);
    }

    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset now = new(2026, 10, 26, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
}
