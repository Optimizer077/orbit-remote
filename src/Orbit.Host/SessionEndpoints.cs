using Orbit.Host.Platform;

namespace Orbit.Host;

internal static class SessionEndpoints
{
    /// <summary>
    /// Session creation per paired device (H-4): a burst of 4, refilled at 1 per second. A
    /// viewer opens at most 2 sessions at once and retries with backoff; churning sessions to
    /// flood the audit history or reset per-session budgets is held to this rate.
    /// </summary>
    internal const double CreationsPerSecond = 1;
    internal const int CreationBurst = 4;

    internal static DeviceRateLimiter CreateLimiter(TimeProvider? clock = null) => new(CreationsPerSecond, CreationBurst, clock);

    internal static void MapSessions(this WebApplication app, HostState state, IPlatformBackend platform,
        Func<HttpContext, PairedDevice?> peer, Func<HttpContext, string, RemoteSession?> findSession,
        Func<RemoteSession, object> sessionInfo, Func<bool> identityUnavailable,
        SemaphoreSlim inputGate, InputLeases inputLeases, HostShutdown shutdown, DeviceRateLimiter? creations = null)
    {
        bool Stopping() => shutdown.IsStopping || app.Lifetime.ApplicationStopping.IsCancellationRequested;
        PairedDevice? CurrentPeer(HttpContext context)
        {
            if (identityUnavailable()) return null;
            return peer(context) is { } requestPeer ? state.FindDevice(requestPeer.Fingerprint) : null;
        }
        IResult? Revalidate(HttpContext context, SessionRequest request, out PairedDevice? device)
        {
            device = null;
            if (identityUnavailable()) return Results.StatusCode(503);
            device = CurrentPeer(context);
            if (device is null || !device.Permissions.View) return Results.StatusCode(403);
            if (device.BlockedByOwner) throw new OwnerEndedException();
            if (request.ResumeEpoch is not null && !Security.TokenEquals(request.ResumeEpoch, device.ResumeEpoch))
                throw new SessionEndedException();
            return Stopping() ? HostShutdown.StoppingResult() : null;
        }
        app.MapPost("/api/sessions", async (HttpContext context, SessionRequest request) =>
        {
            if (Revalidate(context, request, out var device) is { } initialDenied) return initialDenied;
            if (creations is not null && !creations.TryAcquire(device!.Id))
            {
                context.Response.Headers.RetryAfter = "1";
                return Results.Json(new { error = "Too many new sessions from this device. Wait a moment and try again.", code = "session_rate_limited" }, statusCode: 429);
            }
#if ORBIT_DIAGNOSTICS
            if (DiagnosticSource.IsSynthetic(platform) && !request.ViewOnly)
                return Results.BadRequest(new { error = "Diagnostic synthetic sources require an explicit view-only session." });
#endif
            var status = await platform.GetStatusAsync(context.RequestAborted);
            if (Revalidate(context, request, out device) is { } statusDenied) return statusDenied;
            if (!status.CanCapture) return Results.Conflict(new { error = "Screen capture is unavailable in the current desktop session.", status.Limitations });
            if (request.MonitorId is not null && !status.Monitors.Any(m => m.Id == request.MonitorId)) return Results.BadRequest(new { error = "Unknown monitor." });
            IResult Start()
            {
                if (Revalidate(context, request, out var current) is { } denied) return denied;
                return shutdown.WhileRunning(() => Results.Ok(sessionInfo(state.StartSession(current!, request.MonitorId, request.ViewOnly, request.ResumeEpoch))));
            }
            if (!device!.Permissions.Control || request.ViewOnly) return Start();
            await inputGate.WaitAsync(context.RequestAborted);
            try
            {
                if (Revalidate(context, request, out device) is { } queuedDenied) return queuedDenied;
                // A refused second controller must not release the first one's input.
                if (!state.Sessions.Any(session => session.Permissions.Control))
                {
                    await platform.ReleaseInputsAsync(context.RequestAborted); inputLeases.Clear();
                }
                return Start();
            }
            finally { inputGate.Release(); }
        });
        app.MapGet("/api/sessions/{id}", (HttpContext context, string id) =>
        {
            var session = findSession(context, id);
            if (session is null) return Results.NotFound();
            var device = CurrentPeer(context);
            if (HostShutdown.FrameDenial(Stopping(), identityUnavailable(), device, session,
                () => state.GetSession(id, session.DeviceId)) is { } denied) return denied;
            return Results.Ok(sessionInfo(session));
        });
    }
}
