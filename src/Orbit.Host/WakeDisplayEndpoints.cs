using Microsoft.AspNetCore.Http.Features;
using Orbit.Host.Platform;

namespace Orbit.Host;

internal static class WakeDisplayEndpoints
{
    internal const int CooldownMilliseconds = 5000;
    internal static void MapWakeDisplay(this WebApplication app, HostState state, IPlatformBackend platform,
        Func<HttpContext, string, RemoteSession?> findSession, Func<HttpContext, PairedDevice?> peer,
        Func<bool> identityUnavailable, SemaphoreSlim inputGate, HostShutdown shutdown, Func<long>? clock = null)
    {
        clock ??= () => Environment.TickCount64;
        var rates = new Dictionary<string, WakeRate>(StringComparer.Ordinal);
        var rateGate = new object();
        bool Stopping() => shutdown.IsStopping || app.Lifetime.ApplicationStopping.IsCancellationRequested;
        app.MapPost("/api/sessions/{id}/wake-display", async (HttpContext context, string id) =>
        {
            if (identityUnavailable()) return Results.StatusCode(503);
            // Lookup requires View deliberately; Access returns typed Control denial rather than concealing it as404.
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            IResult? Access()
            {
                if (identityUnavailable()) return Results.StatusCode(503);
                var current = SessionAccess.CurrentPeer(state, peer(context));
                if (current?.Permissions.Control != true || !session.Permissions.Control) return Results.StatusCode(403);
                if (HostShutdown.FrameDenial(Stopping(), false,
                    current, session,
                    () => findSession(context, id)) is { } denied) return denied;
                var live = findSession(context, id);
                return live?.Permissions.Control == true ? null : Results.StatusCode(403);
            }
            if (Access() is { } initialDenied) return initialDenied;
            if (context.Request.ContentLength is > 0 || context.Request.Headers.TransferEncoding.Count > 0
                || context.Features.Get<IHttpRequestBodyDetectionFeature>()?.CanHaveBody == true)
                return Results.BadRequest(new { error = "Wake display requires an empty body." });
            if (platform is not IDisplayAvailability provider || !provider.CanWakeDisplay) return Unsupported();
            WakeRate rate;
            lock (rateGate)
            {
                var liveIds = state.Devices.Where(value => value.RevokedAt is null).Select(value => value.Id).ToHashSet(StringComparer.Ordinal);
                foreach (var old in rates.Keys.Where(key => !liveIds.Contains(key)).ToArray()) rates.Remove(old);
                if (!rates.TryGetValue(session.DeviceId, out rate!)) rates.Add(session.DeviceId, rate = new());
                var now = clock();
                if (rate.Pending || rate.LastAt is { } last && now - last < CooldownMilliseconds)
                {
                    context.Response.Headers.RetryAfter = "5";
                    return Results.Json(new { error = "Wait before requesting another display wake.", code = "wake_rate_limited" }, statusCode: 429);
                }
                rate.Pending = true; rate.LastAt = now;
            }
            using var cancelled = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted,
                shutdown.StoppingToken, app.Lifetime.ApplicationStopping);
            try
            {
                await inputGate.WaitAsync(cancelled.Token);
                try
                {
                    if (Access() is { } queuedDenied) return queuedDenied;
                    if (!provider.CanWakeDisplay) return Unsupported();
                    cancelled.Token.ThrowIfCancellationRequested();
                    state.AddAudit("display.wake.requested", session.DeviceId, "An approved controller requested a fixed display wake.");
                    try { await provider.WakeDisplayAsync(cancelled.Token); }
                    catch
                    {
                        state.AddAudit("display.wake.outcome", session.DeviceId, "The fixed display wake request failed.");
                        throw;
                    }
                    state.AddAudit("display.wake.outcome", session.DeviceId, "The fixed display wake event was sent.");
                    if (Access() is { } completedDenied) return completedDenied;
                    return Results.Accepted(value: new { state = "requested" });
                }
                finally { inputGate.Release(); }
            }
            catch (OperationCanceledException) when (Stopping()) { return Access() ?? HostShutdown.StoppingResult(); }
            finally { lock (rateGate) rate.Pending = false; }
        });
    }
    private static IResult Unsupported() => Results.Json(new { error = "This host does not support requesting a display wake.", code = "wake_unsupported" }, statusCode: 409);
    private sealed class WakeRate { internal bool Pending; internal long? LastAt; }
}
