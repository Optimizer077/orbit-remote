using Orbit.Host.Platform;

namespace Orbit.Host;

internal static class FrameEndpoints
{
    internal static void MapFrame(this WebApplication app, HostState state, IPlatformBackend platform,
        Func<HttpContext, string, RemoteSession?> findSession, Func<HttpContext, PairedDevice?> peer,
        Func<bool> identityUnavailable, SemaphoreSlim captureGate, FrameWaitGate frameWaits, HostShutdown shutdown)
    {
        app.MapGet("/api/sessions/{id}/frame", async (HttpContext context, string id) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            var requestedMonitor = context.Request.Query["monitorId"];
            if (requestedMonitor.Count > 1) return Results.BadRequest(new { error = "Supply only one monitorId per frame request." });
            if (context.Request.Query.Keys.Any(key => key is not "monitorId" and not "scale" and not "format" and not "quality" and not "wait"))
                return Results.BadRequest(new { error = "Supported frame parameters are monitorId, scale, format, quality and wait." });
            var requestedScale = context.Request.Query["scale"];
            if (requestedScale.Count > 1) return Results.BadRequest(new { error = "Supply only one scale per frame request." });
            var scale = FrameQuality.ParseScale(requestedScale.Count == 0 ? null : requestedScale.ToString());
            var requestedFormat = context.Request.Query["format"];
            if (requestedFormat.Count > 1) return Results.BadRequest(new { error = "Supply only one format per frame request." });
            var format = FrameQuality.ParseFormat(requestedFormat.Count == 0 ? null : requestedFormat.ToString());
            var requestedQuality = context.Request.Query["quality"];
            if (requestedQuality.Count > 1) return Results.BadRequest(new { error = "Supply only one quality per frame request." });
            var quality = FrameQuality.ParseQuality(requestedQuality.Count == 0 ? null : requestedQuality.ToString());
            var validators = context.Request.Headers.IfNoneMatch;
            if (validators.Count > 1) return Results.BadRequest(new { error = "Supply only one If-None-Match validator." });
            var validator = FrameQuality.ParseConditionalTag(validators.Count == 0 ? null : validators.ToString());
            var requestedWait = context.Request.Query["wait"];
            if (requestedWait.Count > 1) return Results.BadRequest(new { error = "Supply only one wait per frame request." });
            var wait = FrameWaitGate.ParseWait(requestedWait.Count == 0 ? null : requestedWait.ToString());
            if (wait > 0 && validator is null) return Results.BadRequest(new { error = "A positive wait requires If-None-Match for the cached frame." });
            // A viewer may select any existing host monitor while sharing its authenticated
            // control session with other windows; this does not create a virtual display.
            var monitorId = Security.SelectFrameMonitor(requestedMonitor.Count == 0 ? null : requestedMonitor.ToString(), session.MonitorId);
            IDisposable? held = null;
            if (wait > 0)
            {
                var status = await platform.GetStatusAsync(context.RequestAborted);
                monitorId = PlatformLimits.SelectMonitor(status.Monitors, monitorId).Id;
                held = frameWaits.TryEnter(session.DeviceId, id, monitorId);
                if (held is null) return Results.StatusCode(429);
            }
            using var heldLease = held;
            IResult? CheckAccess()
            {
                return HostShutdown.FrameDenial(shutdown.IsStopping || app.Lifetime.ApplicationStopping.IsCancellationRequested,
                    identityUnavailable(), peer(context) is { } requestPeer ? state.FindDevice(requestPeer.Fingerprint) : null,
                    session, () => state.GetSession(id, session.DeviceId));
            }
            await using var authorization = new FrameWaitAuthorization<IResult>(wait > 0, CheckAccess, context.RequestAborted);
            var deadline = Environment.TickCount64 + wait;
            try
            {
                while (true)
                {
                    if (CheckAccess() is { } denied) return denied;
                    ScreenFrame frame; PreparedFrame prepared;
                    await captureGate.WaitAsync(authorization.Token);
                    try
                    {
                        if (CheckAccess() is { } queuedDenied) return queuedDenied;
                        try { frame = await platform.CaptureAsync(monitorId, authorization.Token); }
                        catch (PlatformUnavailableException failure) when (DisplayAvailability.IsCaptureFailure(failure))
                        {
                            if (CheckAccess() is { } failedDenied) return failedDenied;
                            var asleep = await DisplayAvailability.IsAsleepAsync(platform, authorization.Token);
                            if (CheckAccess() is { } observedDenied) return observedDenied;
                            if (asleep) return DisplayAvailability.AsleepResult();
                            throw;
                        }
                        if (CheckAccess() is { } captureDenied) return captureDenied;
                        prepared = FrameQuality.Prepare(frame, session.Id, session.ResumeEpoch, monitorId, scale, validator, authorization.Token, format, quality);
                        if (CheckAccess() is { } encodedDenied) return encodedDenied;
                    }
                    finally { captureGate.Release(); }
                    var remaining = (int)Math.Max(0, deadline - Environment.TickCount64);
                    if (prepared.NotModified && remaining > 0)
                    {
                        // A wait retains metadata only, never a large old pixel array.
                        frame = frame with { RawBgra = null, Png = [] };
                        if (platform is IFrameChangeSource source) await source.WaitForChangeAsync(frame, remaining, authorization.Token);
                        else await Task.Delay(Math.Min(100, remaining), authorization.Token);
                        continue;
                    }
                    if (CheckAccess() is { } finalDenied) return finalDenied;
                    context.Response.Headers["X-Orbit-Width"] = frame.Width.ToString(); context.Response.Headers["X-Orbit-Height"] = frame.Height.ToString();
                    context.Response.Headers["X-Orbit-Left"] = frame.Left.ToString(); context.Response.Headers["X-Orbit-Top"] = frame.Top.ToString();
                    context.Response.Headers["X-Orbit-Encoded-Width"] = prepared.EncodedWidth.ToString(); context.Response.Headers["X-Orbit-Encoded-Height"] = prepared.EncodedHeight.ToString();
                    context.Response.Headers["X-Orbit-Scale"] = prepared.Scale.ToString("0.################", System.Globalization.CultureInfo.InvariantCulture);
                    context.Response.Headers["X-Orbit-Frame-Format"] = prepared.Format;
                    if (prepared.Quality is { } actualQuality) context.Response.Headers["X-Orbit-Frame-Quality"] = actualQuality.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    context.Response.Headers["X-Orbit-Encode-Ms"] = prepared.EncodeMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    context.Response.ContentType = prepared.ContentType;
                    if (prepared.ETag is not null) context.Response.Headers.ETag = prepared.ETag;
                    context.Response.Headers["X-Orbit-Captured-At"] = frame.CapturedUtc.ToString("O");
                    return prepared.NotModified ? Results.StatusCode(StatusCodes.Status304NotModified) : Results.Bytes(prepared.Body, prepared.ContentType);
                }
            }
            catch (OperationCanceledException) when (authorization.Failure is not null) { return authorization.Failure!; }
        });
    }
}
