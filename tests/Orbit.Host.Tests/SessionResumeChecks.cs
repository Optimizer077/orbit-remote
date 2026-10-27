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
        RejectOwner(() => state.StartSession(first, null, expectedResumeEpoch: session.ResumeEpoch), "Host stop rejects automatic renewal with the owner-block reason");

        state = new HostState(directory, clock);
        first = state.FindDevice(first.Fingerprint)!;
        check(first.ResumeEpoch != session.ResumeEpoch, "Single-session host stop remains effective after process restart");
        RejectOwner(() => state.StartSession(first, null, expectedResumeEpoch: session.ResumeEpoch), "Restart cannot revive a host-stopped resume epoch");
        RejectOwner(() => state.StartSession(first, null), "Explicit Connect cannot bypass the persisted owner block");
        first = state.AllowDevice(first.Id)!;
        var manual = state.StartSession(first, null);
        check(manual.ResumeEpoch == first.ResumeEpoch, "Explicit new connection is allowed after the local owner allows the device again");
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
        check(first.ResumeEpoch != oldFirstEpoch && second.ResumeEpoch != oldSecondEpoch, "Panic disconnect rotates all paired resume epochs while only blocking connected devices");
        RejectOwner(() => state.StartSession(first, null, expectedResumeEpoch: oldFirstEpoch), "Panic disconnect blocks old resume after restart");
        RejectResume(() => state.StartSession(second, null, expectedResumeEpoch: oldSecondEpoch), "Panic disconnect invalidates a just-expired device's old automatic resume epoch");
        check(state.StartSession(second, null).ResumeEpoch == second.ResumeEpoch, "Panic disconnect permits explicit Connect by an idle allowed device");
        RejectOwner(() => state.StartSession(first, null), "Explicit Connect remains blocked after persisted panic disconnect");
        first = state.AllowDevice(first.Id)!;
        check(state.StartSession(first, null).ResumeEpoch == first.ResumeEpoch, "Local Allow again restores explicit connection after persisted panic disconnect");

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
        void RejectOwner(Action action, string message)
        {
            try { action(); check(false, message); }
            catch (OwnerEndedException ex) { check(ex.Message == OwnerEndedException.UserMessage, message); }
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
