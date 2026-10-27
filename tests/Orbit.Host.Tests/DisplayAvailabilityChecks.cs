using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

internal static class DisplayAvailabilityChecks
{
    private static readonly MonitorInfo Monitor = new("synthetic-1", "Generated", -1920, 0, 64, 48, true);
    internal static async Task RunAsync(Action<bool, string> check, string root)
    {
        Observation(check);
        await BaselineBoundariesAsync(check, root);
        foreach (var state in new[] { "on", "off", "dimmed", "unknown", "invalid" })
        {
            await using var fixture = await Fixture.Create(root);
            fixture.Platform.DisplayState = state; fixture.Platform.FailedCapture = true;
            using var frame = await fixture.Client.GetAsync(fixture.Path("frame"));
            using var stream = await fixture.Client.GetAsync(fixture.Path("stream"));
            check(await Code(frame) == (state == "off" ? "display_asleep" : "capture-failed")
                && await Code(stream) == (state == "off" ? "display_asleep" : "stream_unavailable"),
                "Display: only off plus unavailable capture is asleep for frame/stream: " + state);
            check(fixture.Platform.Wakes == 0, "Display: failed captures never automatically wake: " + state);
        }
        await using (var fixture = await Fixture.Create(root))
        {
            fixture.Platform.DisplayState = "off";
            using var frame = await fixture.Client.GetAsync(fixture.Path("frame"));
            check(frame.IsSuccessStatusCode && frame.Content.Headers.ContentType?.MediaType == "image/png", "Display: observed off never replaces an actually available frame");
            fixture.NoEncoder = true;
            using var stream = await fixture.Client.GetAsync(fixture.Path("stream"));
            check(await Code(stream) == "stream_unavailable", "Display: encoder unavailability alone is not asleep");
            fixture.Platform.FailedCapture = true; fixture.Platform.SessionState = "locked-or-secure-desktop";
            using var locked = await fixture.Client.GetAsync(fixture.Path("frame"));
            check(await Code(locked) == "capture-failed", "Display: off does not mask locked/secure desktop unavailability");
            check(fixture.Platform.Wakes == 0, "Display: connect, metadata, frame and stream have zero wake effects");
        }
        foreach (var mode in new[] { "view-only", "no-control", "unsupported", "owner", "revoke", "expired", "identity", "stop", "body" })
        {
            await using var fixture = await Fixture.Create(root, mode == "view-only", mode != "no-control");
            if (mode == "unsupported") fixture.Platform.CanWakeDisplay = false;
            if (mode == "owner") fixture.State.BlockDevice(fixture.Peer.Id, out _);
            if (mode == "revoke") fixture.State.Revoke(fixture.Peer.Id);
            if (mode == "expired") fixture.Clock.Now += TimeSpan.FromSeconds(31);
            if (mode == "identity") fixture.IdentityUnavailable = true;
            if (mode == "stop") await fixture.Shutdown.StoppingAsync(default);
            using var reply = mode == "body" ? await fixture.Client.PostAsJsonAsync(fixture.Path("wake-display"), new { x = 9, key = "generated" })
                : await fixture.Wake();
            var expected = mode switch { "view-only" or "no-control" or "owner" => 403, "revoke" => 401, "expired" => 404,
                "identity" or "stop" => 503, "unsupported" => 409, _ => 400 };
            check((int)reply.StatusCode == expected && fixture.Platform.Wakes == 0, "Display: denied wake has no provider effect: " + mode);
            if (mode == "unsupported") check(await Code(reply) == "wake_unsupported", "Display: unsupported wake has a typed409");
        }
        foreach (var route in new[] { "frame", "stream" })
        {
            await using var fixture = await Fixture.Create(root);
            fixture.Platform.DisplayState = "off"; fixture.Platform.FailedCapture = true;
            fixture.Platform.StatusHook = reads => { if (reads == (route == "frame" ? 1 : 2)) fixture.State.BlockDevice(fixture.Peer.Id, out _); };
            using var reply = await fixture.Client.GetAsync(fixture.Path(route));
            check((int)reply.StatusCode == 403 && await Code(reply) == OwnerEndedException.Code && fixture.Platform.Wakes == 0,
                "Display: a fresh owner denial after awaiting observation takes precedence over asleep: " + route);
        }
        await using (var fixture = await Fixture.Create(root))
        {
            using var missing = await fixture.Client.PostAsync("/api/sessions/generated-unknown/wake-display", null);
            check((int)missing.StatusCode == 404 && fixture.State.Sessions.Length == 1 && fixture.Platform.Wakes == 0,
                "Display: wake cannot create or resume a missing session");
            fixture.Platform.FailWake = true;
            using var failed = await fixture.Wake(); using var retry = await fixture.Wake();
            check(await Code(failed) == "generated-wake-failed" && (int)retry.StatusCode == 429 && fixture.Platform.Wakes == 1,
                "Display: provider failure stays failed and is never automatically retried");
            check(fixture.State.Audit.Count(entry => entry.Kind == "display.wake.outcome" && entry.Detail == "The fixed display wake request failed.") == 1,
                "Display: a failed fixed request has one bounded failed outcome audit");
        }
        foreach (var failure in new[] { "screen-permission-required", "display-too-large", "desktop-unavailable", "display-changed" })
        {
            await using var fixture = await Fixture.Create(root); fixture.Platform.DisplayState = "off";
            fixture.Platform.FailedCapture = true; fixture.Platform.CaptureFailureCode = failure;
            using var frame = await fixture.Client.GetAsync(fixture.Path("frame"));
            using var stream = await fixture.Client.GetAsync(fixture.Path("stream"));
            check(await Code(frame) == failure && await Code(stream) == "stream_unavailable",
                "Display: off does not mask permission/size/session/topology failures as asleep: " + failure);
        }
        await RateAndFlight(check, root);
        await FlightAcrossSessions(check, root);
        foreach (var mode in new[] { "owner", "revoke", "end", "stop", "capability" }) await Queued(check, root, mode);
        await using (var fixture = await Fixture.Create(root))
        {
            fixture.Platform.BlockWake = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var pending = fixture.Wake(); await fixture.Platform.WakeEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
            fixture.State.BlockDevice(fixture.Peer.Id, out _); fixture.Platform.BlockWake.SetResult();
            using var reply = await pending;
            check((int)reply.StatusCode == 403 && fixture.Platform.Wakes == 1, "Display: authority loss after the fixed fake action prevents a stale accepted response");
        }
        await ActiveStream(check, root);
        foreach (var denial in new[] { VideoStreamDenial.OwnerEnded, VideoStreamDenial.Revoked, VideoStreamDenial.HostStopping,
            VideoStreamDenial.PermissionChanged, VideoStreamDenial.EndedByHost })
        {
            using var output = new MemoryStream();
            await using var run = new VideoStreamRun(output, () => { }, new VideoStreamChecks.SyntheticSource(64, 48), Monitor,
                (w, h, f, _) => new VideoStreamChecks.FakeEncoder(w, h, f), new(60, 1_000_000, 1), () => denial, default, default);
            await run.EndAsync(DisplayAvailability.AsleepCode, DisplayAvailability.AsleepMessage);
            check(run.EndedCode == VideoStreamRun.TerminalCode(denial), "Display: fresh security/stop overrides an asleep terminal: " + denial);
        }
    }

    internal static async Task BaselineBoundariesAsync(Action<bool, string> check, string root)
    {
        await using var fixture = await Fixture.Create(root);
        fixture.Platform.DisplayState = "off"; fixture.Platform.FailedCapture = true;
        using var frame = await fixture.Client.GetAsync(fixture.Path("frame"));
        check((int)frame.StatusCode == 409 && await Code(frame) == "display_asleep", "Display boundary: unavailable off frame has the typed asleep contract");
        using var stream = await fixture.Client.GetAsync(fixture.Path("stream"));
        check((int)stream.StatusCode == 409 && await Code(stream) == "display_asleep", "Display boundary: unavailable off stream has the typed asleep contract");
        fixture.Platform.CanWakeDisplay = false; using var unsupported = await fixture.Wake();
        check((int)unsupported.StatusCode == 409 && await Code(unsupported) == "wake_unsupported" && fixture.Platform.Wakes == 0,
            "Display boundary: unsupported wake is explicitly typed without effects");
        fixture.Platform.CanWakeDisplay = true; using var wake = await fixture.Wake();
        check((int)wake.StatusCode == 202 && fixture.Platform.Wakes == 1, "Display boundary: only an explicit supported Control request reaches the fake provider");
        using var limited = await fixture.Wake();
        check((int)limited.StatusCode == 429 && await Code(limited) == "wake_rate_limited" && fixture.Platform.Wakes == 1,
            "Display boundary: a second immediate request is host rate limited");
        fixture.Platform.FailedCapture = false; using var available = await fixture.Client.GetAsync(fixture.Path("frame"));
        check(available.IsSuccessStatusCode, "Display boundary guard: an available off frame remains available");
        fixture.Platform.FailedCapture = true; fixture.Platform.DisplayState = "unknown";
        using var unknown = await fixture.Client.GetAsync(fixture.Path("frame"));
        check(await Code(unknown) == "capture-failed", "Display boundary guard: unknown display state keeps the existing capture failure");
    }

    private static void Observation(Action<bool, string> check)
    {
        var defaults = new PlatformStatus("Generated", "interactive", true, false, false, false, [], []);
        check(defaults.DisplayState == "unknown" && !defaults.CanWakeDisplay && !DisplayAvailability.CanWake(new VideoStreamChecks.FakePlatform()), "Display: additive defaults remain unknown and unsupported");
        var notifications = new Notifications(); using var display = new WindowsDisplayAvailability(notifications);
        check(display.State == "unknown", "Display: no initial notification means unknown");
        check(notifications.Registered.SetEquals([WindowsDisplayAvailability.SessionDisplayStatus, WindowsDisplayAvailability.ConsoleDisplayState]),
            "Display: both session and console display states are observed independently");
        foreach (var (value, state) in new[] { (0, "off"), (1, "on"), (2, "dimmed") })
        { notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 4, value); check(display.State == state, "Display: per-session callback value: " + state); }
        notifications.Emit(Guid.Empty, 4, 0); check(display.State == "dimmed", "Display: unrelated notification is ignored");
        notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 8, 0); check(display.State == "unknown", "Display: malformed data length fails to unknown");
        notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 4, 99); check(display.State == "unknown", "Display: undefined state fails to unknown");
        notifications.Emit(WindowsDisplayAvailability.ConsoleDisplayState, 4, 0);
        check(display.State == "off", "Display: console off is sufficient even before a session observation");
        notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 4, 1);
        check(display.State == "off", "Display: console off wins over session on");
        notifications.Emit(WindowsDisplayAvailability.ConsoleDisplayState, 4, 2);
        check(display.State == "dimmed", "Display: dimmed is informational when neither observer reports off");
        notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 4, 0); notifications.Emit(WindowsDisplayAvailability.ConsoleDisplayState, 4, 1);
        check(display.State == "off", "Display: session off wins over console on");
        notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 4, 99);
        check(display.State == "on", "Display: one malformed source does not erase another valid on observation");
        notifications.Emit(WindowsDisplayAvailability.ConsoleDisplayState, 8, 0);
        check(display.State == "unknown", "Display: both sources unknown never infer asleep");
        display.Dispose(); display.Dispose(); notifications.Emit(WindowsDisplayAvailability.SessionDisplayStatus, 4, 0);
        check(display.State == "unknown" && notifications.Disposals == 2, "Display: both observer disposals are idempotent and late callbacks cannot revive state");
        var throwing = new Notifications { ThrowOnSessionDispose = true }; var throwingDisplay = new WindowsDisplayAvailability(throwing); var disposalFailed = false;
        try { throwingDisplay.Dispose(); } catch (InvalidOperationException) { disposalFailed = true; }
        check(disposalFailed && throwing.Disposals == 2 && throwingDisplay.State == "unknown", "Display: console cleanup runs even if session observer cleanup fails");
        foreach (var unavailable in new[] { WindowsDisplayAvailability.SessionDisplayStatus, WindowsDisplayAvailability.ConsoleDisplayState })
        {
            var partial = new Notifications { UnavailableSetting = unavailable }; using var partialDisplay = new WindowsDisplayAvailability(partial);
            partial.Emit(unavailable == WindowsDisplayAvailability.SessionDisplayStatus ? WindowsDisplayAvailability.ConsoleDisplayState : WindowsDisplayAvailability.SessionDisplayStatus, 4, 0);
            check(partialDisplay.State == "off", "Display: independent observer can report off when the other registration is unsupported: " + unavailable);
        }
        // Inspect construction only; never invoke SendInput or WakeDisplayAsync.
        var input = typeof(WindowsPlatformBackend).GetMethod("CreateWakeInput", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, null)!;
        object Field(object value, string name) => value.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!.GetValue(value)!;
        var mouse = Field(Field(input, "Union"), "Mouse");
        check(Convert.ToUInt32(Field(input, "Type")) == 0 && Convert.ToInt32(Field(mouse, "X")) == 0 && Convert.ToInt32(Field(mouse, "Y")) == 0
            && Convert.ToUInt32(Field(mouse, "Flags")) == 1 && Convert.ToUInt32(Field(mouse, "MouseData")) == 0,
            "Display: native wake construction is exactly one relative zero-distance mouse move, with no absolute/key/button/wheel flags");
    }

    private static async Task RateAndFlight(Action<bool, string> check, string root)
    {
        await using var fixture = await Fixture.Create(root);
        fixture.Platform.BlockWake = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = fixture.Wake(); await fixture.Platform.WakeEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        using var concurrent = await fixture.Wake();
        check((int)concurrent.StatusCode == 429 && concurrent.Headers.RetryAfter?.Delta == TimeSpan.FromSeconds(5) && fixture.Platform.Wakes == 1,
            "Display: windows sharing a session cannot overlap wake actions and receive Retry-After5");
        fixture.Platform.BlockWake.SetResult(); using var accepted = await first;
        check((int)accepted.StatusCode == 202 && (await accepted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("state").GetString() == "requested", "Display: accepted means requested, without claiming the display woke");
        check(fixture.State.Audit.Count(entry => entry.Kind == "display.wake.outcome" && entry.Detail == "The fixed display wake event was sent.") == 1,
            "Display: a sent fixed event has one bounded sent outcome audit");
        fixture.Clock.Milliseconds = 4999; using var limited = await fixture.Wake();
        check((int)limited.StatusCode == 429 && await Code(limited) == "wake_rate_limited" && fixture.Platform.Wakes == 1, "Display: five-second cooldown is host enforced");
        fixture.Clock.Milliseconds = 5000; using var next = await fixture.Wake();
        check((int)next.StatusCode == 202 && fixture.Platform.Wakes == 2 && fixture.Platform.OtherEffects == 0, "Display: only an explicit later request invokes the fixed fake provider again");
        fixture.State.EndSession(fixture.Session.Id, fixture.Peer.Id);
        fixture.Session = fixture.State.StartSession(fixture.Peer, null);
        using var separate = await fixture.Wake();
        check((int)separate.StatusCode == 429 && fixture.Platform.Wakes == 2, "Display: ending and starting another session cannot reset the paired-device cooldown");
        fixture.Clock.Milliseconds = 10000; using var later = await fixture.Wake();
        check((int)later.StatusCode == 202 && fixture.Platform.Wakes == 3, "Display: a replacement session can request wake only after its paired-device cooldown");
    }

    private static async Task FlightAcrossSessions(Action<bool, string> check, string root)
    {
        await using var fixture = await Fixture.Create(root); fixture.Platform.BlockWake = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = fixture.Wake(); await fixture.Platform.WakeEntered.Task.WaitAsync(TimeSpan.FromSeconds(2));
        fixture.State.EndSession(fixture.Session.Id, fixture.Peer.Id); fixture.Session = fixture.State.StartSession(fixture.Peer, null);
        using var replacement = await fixture.Wake();
        check((int)replacement.StatusCode == 429 && fixture.Platform.Wakes == 1, "Display: replacing a session while its wake is pending cannot overlap a second device wake");
        fixture.Platform.BlockWake.SetResult(); using var ended = await first;
        check((int)ended.StatusCode == 404 && fixture.Platform.Wakes == 1, "Display: the old request cannot return accepted after its session ends during the fake effect");
    }

    private static async Task Queued(Action<bool, string> check, string root, string mode)
    {
        await using var fixture = await Fixture.Create(root);
        var authorized = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Platform.CapabilityObserved = () => authorized.TrySetResult();
        await fixture.Input.WaitAsync();
        var pending = fixture.Wake(); await authorized.Task.WaitAsync(TimeSpan.FromSeconds(2));
        if (mode == "owner") fixture.State.BlockDevice(fixture.Peer.Id, out _);
        if (mode == "revoke") fixture.State.Revoke(fixture.Peer.Id);
        if (mode == "end") fixture.State.EndSession(fixture.Session.Id, fixture.Peer.Id);
        if (mode == "stop") await fixture.Shutdown.StoppingAsync(default);
        if (mode == "capability") fixture.Platform.CanWakeDisplay = false;
        fixture.Input.Release(); using var reply = await pending;
        check((int)reply.StatusCode == (mode switch { "owner" => 403, "revoke" => 401, "end" => 404, "stop" => 503, _ => 409 }) && fixture.Platform.Wakes == 0,
            "Display: authority/capability/stop is rechecked after the input queue: " + mode);
    }

    private static async Task ActiveStream(Action<bool, string> check, string root)
    {
        await using var fixture = await Fixture.Create(root);
        using var reader = await VideoStreamChecks.RecordReader.OpenAsync(fixture.Client, fixture.Path("stream"));
        await reader.ReadUntilAsync(records => records.Any(record => record.Type == 2));
        fixture.Platform.DisplayState = "off"; fixture.Platform.FailedCapture = true;
        await reader.ReadUntilAsync(records => records.Any(record => record.Type == 4));
        var terminal = JsonDocument.Parse(reader.Records.Last(record => record.Type == 4).Payload).RootElement;
        check(terminal.GetProperty("code").GetString() == "display_asleep" && terminal.GetProperty("error").GetString() == DisplayAvailability.AsleepMessage
            && reader.Violation is null && fixture.Platform.Wakes == 0, "Display: an active generated stream emits bounded typed asleep after actual source loss without waking");
    }

    private static async Task<string?> Code(HttpResponseMessage response)
    {
        try { var body = await response.Content.ReadFromJsonAsync<JsonElement>(); return body.TryGetProperty("code", out var code) ? code.GetString() : null; }
        catch (JsonException) { return null; }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal HostState State = null!; internal PairedDevice Peer = null!; internal RemoteSession Session = null!;
        internal readonly FakePlatform Platform = new(); internal readonly Clock Clock = new();
        internal readonly SemaphoreSlim Input = new(1, 1), Capture = new(1, 1);
        internal WebApplication App = null!; internal HttpClient Client = null!; internal HostShutdown Shutdown = null!;
        internal bool IdentityUnavailable, NoEncoder;
        internal string Path(string suffix) => $"/api/sessions/{Session.Id}/{suffix}";
        internal Task<HttpResponseMessage> Wake() => Client.PostAsync(Path("wake-display"), null);
        internal static async Task<Fixture> Create(string root, bool viewOnly = false, bool control = true)
        {
            var f = new Fixture(); f.State = new HostState(System.IO.Path.Combine(root, "generated-display-" + Guid.NewGuid().ToString("N")), f.Clock);
            var invite = f.State.CreateInvite(new("Generated", new(View: true, Control: control)), "https://127.0.0.1:1", "generated");
            var encoded = invite.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
            using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
            f.Peer = f.State.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated"), "generated-pin");
            f.Session = f.State.StartSession(f.Peer, null, viewOnly);
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] }); builder.Logging.ClearProviders();
            builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services); f.App = builder.Build();
            f.Shutdown = f.App.Services.GetRequiredService<HostShutdown>();
            f.App.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, f.App.Logger));
            RemoteSession? Find(Microsoft.AspNetCore.Http.HttpContext _, string id) => SessionAccess.FindSession(f.State, f.Peer, id, permission => permission.View, f.IdentityUnavailable, allowStopping: true);
            f.App.MapWakeDisplay(f.State, f.Platform, Find, _ => f.Peer, () => f.IdentityUnavailable, f.Input, f.Shutdown, () => f.Clock.Milliseconds);
            f.App.MapFrame(f.State, f.Platform, Find, _ => f.Peer, () => f.IdentityUnavailable, f.Capture, new FrameWaitGate(), f.Shutdown);
            var access = new HostStateStreamAccess(f.State, () => f.IdentityUnavailable, _ => f.Peer, f.App.Lifetime.ApplicationStopping);
            VideoStreamEndpoints.Map(f.App, access.FindSession, access.Check, f.Platform, new PlatformVideoFrameSource(f.Platform),
                (w, h, fps, _) => f.NoEncoder ? null : new VideoStreamChecks.FakeEncoder(w, h, fps), () => true,
                f.App.Lifetime.ApplicationStopping, new VideoStreamSlots<VideoStreamRun>(), shutdown: f.Shutdown);
            await f.App.StartAsync(); f.Client = new HttpClient { BaseAddress = new(f.App.Urls.Single()), Timeout = TimeSpan.FromSeconds(3) };
            return f;
        }
        public async ValueTask DisposeAsync()
        { Client.Dispose(); await App.StopAsync(); await App.DisposeAsync(); Input.Dispose(); Capture.Dispose(); }
    }
    private sealed class Clock : TimeProvider
    { internal DateTimeOffset Now = DateTimeOffset.UtcNow; internal long Milliseconds; public override DateTimeOffset GetUtcNow() => Now; }
    private sealed class Notifications : IWindowsDisplayNotifications
    {
        private Action<Guid, int, int>? changed; internal int Disposals; internal bool ThrowOnSessionDispose; internal Guid? UnavailableSetting;
        internal readonly HashSet<Guid> Registered = [];
        public IDisposable? Subscribe(Guid setting, Action<Guid, int, int> callback)
        { changed = callback; Registered.Add(setting); return setting == UnavailableSetting ? null : new Subscription(this, setting); }
        internal void Emit(Guid setting, int size, int value) => changed!(setting, size, value);
        private sealed class Subscription(Notifications owner, Guid setting) : IDisposable
        {
            public void Dispose()
            { owner.Disposals++; if (owner.ThrowOnSessionDispose && setting == WindowsDisplayAvailability.SessionDisplayStatus) throw new InvalidOperationException("Generated dispose failure."); }
        }
    }
    private sealed class FakePlatform : IPlatformBackend, IDisplayAvailability
    {
        public string DisplayState { get; set; } = "unknown";
        private bool canWakeDisplay = true;
        internal Action? CapabilityObserved;
        public bool CanWakeDisplay
        { get { CapabilityObserved?.Invoke(); return canWakeDisplay; } set => canWakeDisplay = value; }
        internal string CaptureFailureCode = "capture-failed";
        internal string SessionState = "interactive"; internal bool FailedCapture, FailWake; internal int Wakes, OtherEffects, StatusReads;
        internal Action<int>? StatusHook;
        internal TaskCompletionSource? BlockWake; internal readonly TaskCompletionSource WakeEntered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<PlatformStatus> GetStatusAsync(CancellationToken token = default)
        {
            StatusHook?.Invoke(++StatusReads);
            return Task.FromResult(new PlatformStatus("Generated", SessionState, true, true, false, false, [Monitor], [], DisplayState: DisplayState, CanWakeDisplay: CanWakeDisplay));
        }
        public Task<ScreenFrame> CaptureAsync(string? monitorId = null, CancellationToken token = default) => FailedCapture
            ? Task.FromException<ScreenFrame>(new PlatformUnavailableException(CaptureFailureCode, "Generated capture unavailable."))
            : Task.FromResult(new ScreenFrame([], 64, 48, -1920, 0, DateTimeOffset.UtcNow, new byte[64 * 48 * 4], Monitor.Id));
        public async Task WakeDisplayAsync(CancellationToken token = default)
        { Wakes++; WakeEntered.TrySetResult(); if (FailWake) throw new PlatformUnavailableException("generated-wake-failed", "Generated wake failed."); if (BlockWake is not null) await BlockWake.Task; }
        public Task ApplyInputAsync(RemoteInput input, CancellationToken token = default) { OtherEffects++; throw new InvalidOperationException(); }
        public Task ReleaseInputsAsync(CancellationToken token = default) => Task.CompletedTask;
        public Task<string> ReadClipboardAsync(CancellationToken token = default) { OtherEffects++; throw new InvalidOperationException(); }
        public Task WriteClipboardAsync(string text, CancellationToken token = default) { OtherEffects++; throw new InvalidOperationException(); }
        public Task LockAsync(CancellationToken token = default) { OtherEffects++; throw new InvalidOperationException(); }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
