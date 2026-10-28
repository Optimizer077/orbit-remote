using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

/// <summary>Batched input on the real route with a fake backend: no native input is ever sent.</summary>
internal static class InputBatchChecks
{
    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        ParseChecks(check);
        var state = new HostState(Path.Combine(temporaryRoot, "input-batch"));
        var peer = Pair(state, "generated-batch-controller", new(View: true, Control: true));
        var session = state.StartSession(peer, null);
        var viewer = Pair(state, "generated-batch-viewer", new(View: true, Control: true));
        var viewSession = state.StartSession(viewer, null, viewOnly: true);
        var ender = Pair(state, "generated-batch-ended", new(View: true, Control: true));
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build(); await using var platform = new VideoStreamChecks.FakePlatform();
        using var gate = new SemaphoreSlim(1, 1);
        var leases = new InputLeases();
        var applied = new List<string>(); var releases = 0; Action<RemoteInput>? afterApply = null;
        platform.ApplyOverride = (input, _) =>
        {
            lock (applied) applied.Add(Describe(input));
            if (input.Key == "GeneratedInvalid") throw new ArgumentException("Unsupported keyboard code.");
            afterApply?.Invoke(input);
            return Task.CompletedTask;
        };
        platform.ReleaseOverride = () => { Interlocked.Increment(ref releases); return Task.CompletedTask; };
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        using var inputs = new InputEndpoints(app, state, platform,
            (context, id) => SessionAccess.FindSession(state, context.Request.Headers["X-Generated-Viewer"].Count > 0 ? viewer
                : context.Request.Headers["X-Generated-Ended"].Count > 0 ? ender : peer, id, value => value.Control),
            gate, leases, app.Services.GetRequiredService<HostShutdown>(), _ => { });
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
        var route = $"/api/sessions/{session.Id}/input";
        void Reset() { lock (applied) applied.Clear(); Volatile.Write(ref releases, 0); leases.Clear(); }
        try
        {
            var ordered = new object[]
            {
                new { kind = "pointerButton", x = 1, y = 1, button = "left", isDown = true },
                new { kind = "pointerMove", x = 2, y = 1 },
                new { kind = "pointerButton", x = 2, y = 1, button = "left", isDown = false },
                new { kind = "key", key = "ShiftLeft", isDown = true },
            };
            using (var response = await client.PostAsJsonAsync(route, new { events = ordered }))
                check(response.StatusCode == HttpStatusCode.NoContent && applied.SequenceEqual(["pointerButton:left:down", "pointerMove", "pointerButton:left:up", "key:ShiftLeft:down"]) && releases == 0,
                    "Input batch HTTP: events apply strictly in order in one request");
            check(leases.HasExpired(DateTimeOffset.UtcNow.AddSeconds(11)) && state.GetSession(session.Id, peer.Id)?.LastInputAt is not null,
                "Input batch HTTP: each event records its own held-input lease and input activity");

            Reset();
            using (var response = await client.PostAsJsonAsync(route, new { kind = "key", key = "KeyA", isDown = true }))
                check(response.StatusCode == HttpStatusCode.NoContent && applied.SequenceEqual(["key:KeyA:down"]), "Input batch HTTP: the single input object is still accepted");

            Reset();
            using var single = await client.PostAsJsonAsync(route, new { kind = "key", key = "GeneratedInvalid", isDown = true });
            var singleError = await single.Content.ReadAsStringAsync();
            var singleReleases = Volatile.Read(ref releases);
            Reset();
            leases.Record(session.Id, new("key", Key: "ControlLeft", IsDown: true), DateTimeOffset.UtcNow);
            using var middle = await client.PostAsJsonAsync(route, new { events = new object[]
            {
                new { kind = "key", key = "KeyA", isDown = true },
                new { kind = "key", key = "GeneratedInvalid", isDown = true },
                new { kind = "key", key = "KeyC", isDown = true },
            } });
            check(single.StatusCode == HttpStatusCode.BadRequest && middle.StatusCode == single.StatusCode && await middle.Content.ReadAsStringAsync() == singleError && singleReleases == 0,
                "Input batch HTTP: an invalid event in the middle returns exactly the single-object error");
            check(applied.SequenceEqual(["key:KeyA:down", "key:GeneratedInvalid:down"]),
                "Input batch HTTP: earlier events stay applied and later events are never applied after a failure");
            check(Volatile.Read(ref releases) == 1 && !leases.HasExpired(DateTimeOffset.UtcNow.AddSeconds(11)) && gate.CurrentCount == 1,
                "Input batch HTTP: a failed batch releases every held input and frees the input gate");

            Reset();
            var malformed = new (string Name, object Body)[]
            {
                ("empty", new { events = Array.Empty<object>() }),
                ("null events", new { events = (object?)null }),
                ("null event", new { events = new object?[] { null } }),
                ("over cap", new { events = Enumerable.Repeat<object>(new { kind = "pointerMove", x = 1, y = 1 }, InputEndpoints.MaximumBatchEvents + 1).ToArray() }),
                ("wrong type", new { events = new object[] { new { kind = "pointerMove", x = "left" } } }),
            };
            foreach (var (name, body) in malformed)
            {
                using var response = await client.PostAsJsonAsync(route, body);
                check(response.StatusCode == HttpStatusCode.BadRequest && applied.Count == 0 && releases == 0, "Input batch HTTP: a malformed batch is rejected before any event: " + name);
            }
            using (var response = await client.PostAsJsonAsync(route, new { events = Enumerable.Repeat<object>(new { kind = "pointerMove", x = 1, y = 1 }, InputEndpoints.MaximumBatchEvents).ToArray() }))
                check(response.StatusCode == HttpStatusCode.NoContent && applied.Count == InputEndpoints.MaximumBatchEvents, "Input batch HTTP: a batch at the cap is accepted");

            Reset();
            using (var request = new HttpRequestMessage(HttpMethod.Post, $"/api/sessions/{viewSession.Id}/input"))
            {
                request.Headers.Add("X-Generated-Viewer", "1");
                request.Content = JsonContent.Create(new { events = new[] { new { kind = "key", key = "KeyA", isDown = true } } });
                using var response = await client.SendAsync(request);
                check(response.StatusCode == HttpStatusCode.NotFound && applied.Count == 0 && releases == 0, "Input batch HTTP: a view-only session cannot send a batch");
            }

            Reset();
            afterApply = _ => { afterApply = null; state.Revoke(peer.Id); };
            using (var response = await client.PostAsJsonAsync(route, new { events = new object[]
            {
                new { kind = "key", key = "KeyA", isDown = true }, new { kind = "key", key = "KeyB", isDown = true },
            } }))
            {
                var code = response.StatusCode == HttpStatusCode.Unauthorized ? (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() : null;
                check(code == SessionRevokedException.Code && applied.SequenceEqual(["key:KeyA:down"]) && Volatile.Read(ref releases) == 1,
                    "Input batch HTTP: authority lost part-way stops the batch with the single-object denial and releases input");
            }

            Reset();
            var endedSession = state.StartSession(ender, null);
            afterApply = _ => { afterApply = null; state.EndSession(endedSession.Id, ender.Id); };
            using (var request = new HttpRequestMessage(HttpMethod.Post, $"/api/sessions/{endedSession.Id}/input"))
            {
                request.Headers.Add("X-Generated-Ended", "1");
                request.Content = JsonContent.Create(new { events = new object[]
                {
                    new { kind = "key", key = "KeyA", isDown = true }, new { kind = "key", key = "KeyB", isDown = true },
                } });
                using var response = await client.SendAsync(request);
                check(response.StatusCode == HttpStatusCode.NotFound && applied.SequenceEqual(["key:KeyA:down"]) && Volatile.Read(ref releases) == 1
                    && !leases.HasExpired(DateTimeOffset.UtcNow.AddSeconds(11)) && gate.CurrentCount == 1,
                    "Input batch HTTP: a session ended part-way stops the batch with 404 and releases held input inside the gate");
            }
        }
        finally { await app.StopAsync(); }
    }

    private static void ParseChecks(Action<bool, string> check)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var parsed = InputEndpoints.ReadInputs(JsonDocument.Parse("""{"Events":[{"kind":"key","key":"KeyA","isDown":true}]}""").RootElement, options, out var batch);
        check(batch && parsed is [{ Kind: "key", Key: "KeyA", IsDown: true }], "Input batch parse: the events property follows the web JSON naming rules");
        parsed = InputEndpoints.ReadInputs(JsonDocument.Parse("""{"kind":"pointerMove","x":3,"y":4}""").RootElement, options, out batch);
        check(!batch && parsed is [{ Kind: "pointerMove", X: 3, Y: 4 }], "Input batch parse: a single input object is one event, not a batch");
        check(InputEndpoints.ReadInputs(JsonDocument.Parse("null").RootElement, options, out _) is null
            && InputEndpoints.ReadInputs(JsonDocument.Parse("[]").RootElement, options, out _) is null, "Input batch parse: null and bare arrays are malformed");
    }

    private static string Describe(RemoteInput input) => input.Kind switch
    {
        "pointerButton" => $"pointerButton:{input.Button}:{(input.IsDown == true ? "down" : "up")}",
        "key" => $"key:{input.Key}:{(input.IsDown == true ? "down" : "up")}",
        _ => input.Kind,
    };

    private static PairedDevice Pair(HostState state, string fingerprint, DevicePermissions permissions)
    {
        var invitation = state.CreateInvite(new("Generated device", permissions), "https://127.0.0.1:1", "generated");
        var encoded = invitation.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
        return state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated device"), fingerprint);
    }
}
