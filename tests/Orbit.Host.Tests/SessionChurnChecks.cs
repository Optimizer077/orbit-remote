using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Orbit.Host;

/// <summary>H-4: a view-only peer churning sessions cannot flush the audit history.</summary>
internal static class SessionChurnChecks
{
    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        CoalescingChecks(check, temporaryRoot);
        await CreationLimitAsync(check, temporaryRoot);
    }

    private static void CoalescingChecks(Action<bool, string> check, string root)
    {
        var clock = new Clock();
        var state = new HostState(Path.Combine(root, "session-churn-audit"), clock);
        var peer = Pair(state, "generated-churn-viewer");
        state.AddAudit("generated.owner_event", null, "Generated owner event that must survive churn.");
        for (var index = 0; index < 400; index++)
        {
            var session = state.StartSession(peer, null, viewOnly: true);
            state.EndSession(session.Id, peer.Id);
            clock.Now += TimeSpan.FromMilliseconds(100);
        }
        var audit = state.Audit;
        check(audit.Count(entry => entry.Kind == "session.started") == 1 && audit.Count(entry => entry.Kind == "session.ended") == 1,
            "H-4: repeated session start/end from one device is audited once per kind per minute");
        check(audit.Any(entry => entry.Kind == "generated.owner_event"), "H-4: session churn cannot push earlier events out of the 500-entry history");
        clock.Now += HostState.AuditCoalesceWindow;
        var next = state.StartSession(peer, null, viewOnly: true);
        var reported = state.Audit.First(entry => entry.Kind == "session.started");
        check(reported.Detail.Contains("399 similar earlier events", StringComparison.Ordinal) && reported.DeviceId == peer.Id,
            "H-4: the next minute's entry reports the coalesced session starts");
        var other = Pair(state, "generated-churn-other");
        state.StartSession(other, null, viewOnly: true);
        check(state.Audit.Count(entry => entry.Kind == "session.started" && entry.DeviceId == other.Id) == 1,
            "H-4: coalescing is per device, so another device's session is still recorded");
        check(state.EndSession(next.Id) && state.Audit.First().Detail.StartsWith("Owner ended", StringComparison.Ordinal),
            "H-4: owner-ended sessions are never coalesced");
    }

    private static async Task CreationLimitAsync(Action<bool, string> check, string root)
    {
        var clock = new Clock();
        var state = new HostState(Path.Combine(root, "session-creation-limit"), clock);
        var peer = Pair(state, "generated-creation-viewer");
        var other = Pair(state, "generated-creation-other");
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0"); HostShutdown.Add(builder.Services);
        await using var app = builder.Build();
        await using var platform = new VideoStreamChecks.FakePlatform();
        using var gate = new SemaphoreSlim(1, 1);
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        app.MapSessions(state, platform, context => context.Request.Headers.ContainsKey("X-Generated-Other") ? other : peer,
            (_, _) => null, value => value, () => false, gate, new InputLeases(), app.Services.GetRequiredService<HostShutdown>(),
            SessionEndpoints.CreateLimiter(clock));
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
        async Task<HttpResponseMessage> Create(bool useOther = false)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/sessions") { Content = JsonContent.Create(new { viewOnly = true }) };
            if (useOther) request.Headers.Add("X-Generated-Other", "1");
            var response = await client.SendAsync(request);
            if (response.IsSuccessStatusCode)
            {
                // End it again, as a churning peer would, so the per-device session cap is not what stops it.
                var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
                state.EndSession(id, useOther ? other.Id : peer.Id);
            }
            return response;
        }
        try
        {
            var statuses = new List<HttpStatusCode>();
            for (var attempt = 0; attempt <= SessionEndpoints.CreationBurst; attempt++) { using var response = await Create(); statuses.Add(response.StatusCode); }
            check(statuses.Take(SessionEndpoints.CreationBurst).All(status => status == HttpStatusCode.OK) && statuses[^1] == HttpStatusCode.TooManyRequests,
                "H-4: a device may create a small burst of sessions, then session creation returns 429");
            using (var limited = await Create())
                check(limited.StatusCode == HttpStatusCode.TooManyRequests && limited.Headers.RetryAfter?.Delta == TimeSpan.FromSeconds(1)
                    && (await limited.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "session_rate_limited",
                    "H-4: a rate-limited session creation returns code session_rate_limited with Retry-After");
            using (var otherDevice = await Create(useOther: true))
                check(otherDevice.IsSuccessStatusCode, "H-4: the session-creation limit is per device");
            clock.Now += TimeSpan.FromSeconds(1);
            using (var refilled = await Create())
                check(refilled.IsSuccessStatusCode, "H-4: session creation refills at one per second");
        }
        finally { await app.StopAsync(); }
    }

    private static PairedDevice Pair(HostState state, string name)
    {
        var invitation = state.CreateInvite(new(name, new(View: true)), "https://127.0.0.1:1", "generated");
        var encoded = invitation.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
        return state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, name), name);
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
