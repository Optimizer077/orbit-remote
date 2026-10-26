using System.Text.Json;
using Orbit.Host;

public static class SessionIsolationChecks
{
    public static void Run(Action<bool, string> check, string tempRoot)
    {
        var clock = new TestClock();
        var limits = new HostState(Path.Combine(tempRoot, "device-session-limits"), clock);
        var viewers = Enumerable.Range(0, 5).Select(index => Pair(limits, "viewer-" + index, false)).ToArray();
        var first = limits.StartSession(viewers[0], null);
        limits.StartSession(viewers[0], null);
        RejectLimit(() => limits.StartSession(viewers[0], null), "This device has reached its limit of 2", "One view-only device cannot consume all eight host slots");
        check(limits.StartSession(viewers[1], null).DeviceId == viewers[1].Id, "Another approved device retains access after one device reaches its cap");
        limits.StartSession(viewers[1], null);
        foreach (var device in viewers.Skip(2).Take(2)) { limits.StartSession(device, null); limits.StartSession(device, null); }
        check(limits.Sessions.Length == 8, "The existing host-wide eight-session capacity remains available across devices");
        RejectLimit(() => limits.StartSession(viewers[4], null), "The host has reached its session limit", "Host-wide cap still applies across distinct devices");
        check(limits.EndSession(first.Id, viewers[0].Id), "An owned session can release a device and host slot");
        check(limits.StartSession(viewers[4], null).DeviceId == viewers[4].Id, "A different device may use the released host slot");
        clock.Advance(TimeSpan.FromSeconds(31));
        check(limits.StartSession(viewers[0], null).DeviceId == viewers[0].Id && limits.Sessions.Length == 1, "Expired sessions free both per-device and host capacity");

        var isolation = new HostState(Path.Combine(tempRoot, "session-input-isolation"));
        var controller = Pair(isolation, "controller", true);
        var viewer = Pair(isolation, "viewer", false);
        var controlled = isolation.StartSession(controller, null);
        var viewed = isolation.StartSession(viewer, null);
        check(isolation.EndSession(viewed.Id, viewer.Id, out var releaseViewer) && !releaseViewer, "Ending a viewing-only device session does not request global input release");
        check(isolation.GetSession(controlled.Id, controller.Id) is not null, "A viewer ending its session leaves the other device's controller active");
        var controllerViewing = isolation.StartSession(controller, null, viewOnly: true);
        check(isolation.EndSession(controllerViewing.Id, controller.Id, out var releasePrivilegedViewer) && !releasePrivilegedViewer, "View-only session of a control-capable device still cannot release the controller's input");
        check(!isolation.EndSession(controlled.Id, viewer.Id, out var releaseForeign) && !releaseForeign, "Foreign session-end denial never requests input release");
        check(isolation.EndSession(controlled.Id, controller.Id, out var releaseController) && releaseController, "Ending the actual controlling session requests held-input release");

        controlled = isolation.StartSession(controller, null);
        isolation.StartSession(viewer, null);
        check(isolation.Revoke(viewer.Id, out var releaseRevokedViewer) && !releaseRevokedViewer, "Revoking a viewing-only peer does not request unrelated global input release");
        check(isolation.GetSession(controlled.Id, controller.Id) is not null, "Revoking a viewing-only peer preserves the controlling device's active session");
        check(isolation.Revoke(controller.Id, out var releaseRevokedController) && releaseRevokedController, "Revoking the controlling peer requests held-input release");
        check(!isolation.Revoke(controller.Id, out var repeatRelease) && !repeatRelease, "Repeated unsuccessful revocation cannot request another global input release");

        void RejectLimit(Action action, string expected, string message)
        {
            try { action(); check(false, message); }
            catch (InvalidOperationException ex) { check(ex.Message.Contains(expected, StringComparison.Ordinal), message); }
        }
    }

    private static PairedDevice Pair(HostState state, string name, bool control)
    {
        var invite = state.CreateInvite(new(name, new(View: true, Control: control)), "https://127.0.0.1:47832", "test-pin");
        var encoded = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        var payload = Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '='));
        var secret = JsonSerializer.Deserialize<JsonElement>(payload).GetProperty("secret").GetString()!;
        return state.Pair(new(secret, name), name);
    }

    private sealed class TestClock : TimeProvider
    {
        private DateTimeOffset now = new(2026, 10, 26, 0, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan duration) => now += duration;
    }
}
