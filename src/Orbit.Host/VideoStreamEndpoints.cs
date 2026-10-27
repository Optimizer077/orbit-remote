using Microsoft.AspNetCore.Http.Features;
using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>D11 routes: <c>GET /api/sessions/{id}/stream</c> and <c>POST /api/sessions/{id}/stream/control</c>.</summary>
public static class VideoStreamEndpoints
{
    public const string ContentType = "application/vnd.orbit.stream";
    public const int MaximumStreams = 8;
    public const int MaximumStreamsPerDevice = 4;
    internal const int ReplacementCleanupMilliseconds = 500;

    /// <summary>Capability probe for <c>canVideoStream</c>: Windows with a usable Media Foundation H.264 encoder.</summary>
    public static bool CanVideoStream => OperatingSystem.IsWindows() && MfH264Encoder.IsSupported;

    /// <summary>
    /// The viewer-drawn pointer (W7a) is negotiated only when both sides support it. The host emits type-5 records; this
    /// stays false until the viewer's cursor layer ships with it (coordinator decision), then flips in one place.
    /// </summary>
    internal static bool LocalCursorViewerReady { get; set; } = true;

    /// <summary>
    /// Capability probe for <c>canLocalCursor</c>: true only when this host emits type-5 pointer records for a stream opened
    /// with <c>cursor=local</c> (a pointer feed and a GPU source), and the viewer side has shipped.
    /// </summary>
    public static bool CanLocalCursor(IPlatformBackend platform) =>
        LocalCursorViewerReady && CanVideoStream && platform is IPointerFeed && platform is IGpuVideoSource;

    /// <summary>Advertised <c>videoCodecs</c>: H.264 Main. The exact level of a stream is in its config record.</summary>
    public static IReadOnlyList<string> VideoCodecs => CanVideoStream ? ["avc1.4D4028"] : [];

    /// <summary>
    /// Registers both routes. Authorization mirrors <c>/frame</c>: identity expiry or rotation, device revocation, resume
    /// epoch, viewing grant and session ownership are checked at open, after the first capture, on every control request
    /// and every 250 ms by a timer independent of encoding and writes.
    /// </summary>
    /// <param name="identityUnavailable">True while the host identity is expired or a rotation is pending.</param>
    /// <param name="peer">The paired device the remote middleware attached to the request.</param>
    /// <param name="captureGate">Optional gate held per single capture by the default frame source (never for a stream's lifetime).</param>
    /// <param name="frames">Raw frame producer; defaults to an adapter over <paramref name="platform"/>.</param>
    /// <param name="gpu">Zero-copy GPU source; defaults to <paramref name="platform"/> when it implements <see cref="IGpuVideoSource"/>.</param>
    public static void MapVideoStream(this WebApplication app, HostState state, IPlatformBackend platform, Func<bool> identityUnavailable,
        Func<HttpContext, PairedDevice?> peer, SemaphoreSlim? captureGate = null, IVideoFrameSource? frames = null, IGpuVideoSource? gpu = null)
    {
        var stopping = app.Lifetime.ApplicationStopping;
        var access = new HostStateStreamAccess(state, identityUnavailable, peer, stopping);
        var logger = app.Logger;
        Map(app, access.FindSession, access.Check, platform, frames ?? new PlatformVideoFrameSource(platform, captureGate),
            VideoEncoders.CreateMediaFoundation, () => CanVideoStream, stopping, new VideoStreamSlots<VideoStreamRun>(MaximumStreams),
            gpu ?? platform as IGpuVideoSource, message => logger.LogWarning("Video stream: {Message}", message),
            () => platform as IPointerFeed, app.Services.GetRequiredService<HostShutdown>());
    }

    internal static void Map(IEndpointRouteBuilder app, Func<HttpContext, string, RemoteSession?> findSession, Func<HttpContext, RemoteSession, VideoStreamDenial> check,
        IPlatformBackend platform, IVideoFrameSource frames, VideoEncoderFactory encoders, Func<bool> available, CancellationToken hostStopping,
        VideoStreamSlots<VideoStreamRun> slots, IGpuVideoSource? gpu = null, Action<string>? log = null, Func<IPointerFeed?>? pointers = null,
        HostShutdown? shutdown = null)
    {
        var admission = new VideoStreamAdmission<VideoStreamRun>(MaximumStreams, MaximumStreamsPerDevice);
        app.MapGet("/api/sessions/{id}/stream", async (HttpContext context, string id) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            var query = context.Request.Query;
            if (query.Keys.Any(key => key is not ("monitorId" or "codec" or "maxFps" or "bitrate" or "scale" or "cursor")))
                return BadRequest("Supported stream parameters are monitorId, codec, maxFps, bitrate, scale and cursor.");
            if (query.Any(pair => pair.Value.Count > 1)) return BadRequest("Supply each stream parameter at most once.");
            string? One(string key) => query.TryGetValue(key, out var value) ? value.ToString() : null;
            VideoStreamSettings settings; string? monitorId;
            try { settings = VideoStreamSettings.Parse(One("maxFps"), One("bitrate"), One("scale")); monitorId = Security.SelectFrameMonitor(One("monitorId"), session.MonitorId); }
            catch (ArgumentException ex) { return BadRequest(ex.Message); }
            var cursor = One("cursor") ?? "video";
            if (cursor is not ("video" or "local")) return BadRequest("cursor must be video or local.");
            var codec = One("codec");
            if (codec is not null && (codec.Length is 0 or > 32 || codec.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '.'))) return BadRequest("codec must be one RFC 6381 codec string.");
            if (codec is not null && !codec.StartsWith("avc1", StringComparison.Ordinal)) return Unavailable("Only H.264 (avc1) streams are available.");
            if (!available()) return Unavailable("This host cannot encode a video stream. Use /frame.");
            if (Denied(check(context, session)) is { } denied) return denied;

            MonitorInfo monitor;
            try { monitor = PlatformLimits.SelectMonitor((await platform.GetStatusAsync(context.RequestAborted)).Monitors, monitorId); }
            catch (ArgumentException ex) { return BadRequest(ex.Message); }
            catch (PlatformUnavailableException) { return Unavailable("No display is available for streaming. Use /frame."); }

            if (Denied(check(context, session)) is { } selectedDenied) return selectedDenied;
            using var reservation = admission.TryReserve(session.DeviceId, session.Id, monitor.Id);
            if (reservation is null) return AtCapacity();
            if (reservation.Previous is { } previous)
            {
                _ = previous.EndAsync("stream_replaced", "A newer stream for this session and monitor replaced this one.");
                try { await reservation.PreviousReleased.WaitAsync(TimeSpan.FromMilliseconds(ReplacementCleanupMilliseconds), context.RequestAborted); }
                catch (TimeoutException) { return Denied(check(context, session)) ?? AtCapacity(); }
                if (Denied(check(context, session)) is { } replacementDenied) return replacementDenied;
            }
            context.RequestAborted.ThrowIfCancellationRequested();

            // GPU frames carry no composited cursor: the GPU path needs a viewer that draws the pointer (cursor=local) AND a
            // pointer feed for type-5 records. Otherwise the CPU path keeps the cursor composited, never invisible or doubled.
            var feed = cursor == "local" ? pointers?.Invoke() : null;
            var gpuSource = feed is not null ? gpu : null;
            IGpuVideoEncoder? gpuEncoder = null;
            IVideoStreamEncoder? encoder = null;
            VideoStreamRun? run = null;
            var active = 1; // A finished request's (pooled) connection must never be aborted later.
            try
            {
                if (gpuSource is not null)
                {
                    var (gpuWidth, gpuHeight) = VideoStreamRun.GpuOutputSize(monitor, settings.Scale);
                    try { gpuEncoder = gpuSource.TryOpenEncoder(monitor, gpuWidth, gpuHeight, settings.MaxFps, settings.BitrateBps); }
                    catch (Exception ex) when (ex is PlatformUnavailableException or InvalidOperationException or System.Runtime.InteropServices.ExternalException or ArgumentException)
                    { log?.Invoke($"The GPU video path is unavailable ({ex.GetType().Name}); using the CPU path."); }
                    context.RequestAborted.ThrowIfCancellationRequested();
                    if (gpuEncoder is null) gpuSource = null;
                }
                VideoSourceFrame? first = null;
                var captureUnavailable = true;
                if (gpuEncoder is null)
                {
                    try { first = await frames.GetLatestAsync(monitor, context.RequestAborted); }
                    catch (ArgumentException ex) { return BadRequest(ex.Message); }
                    catch (PlatformUnavailableException failure) { first = null; captureUnavailable = DisplayAvailability.IsCaptureFailure(failure); }
                    context.RequestAborted.ThrowIfCancellationRequested();
                    if (Denied(check(context, session)) is { } capturedDenied) return capturedDenied;
                    if (first is null)
                    {
                        var asleep = captureUnavailable && await DisplayAvailability.IsAsleepAsync(platform, context.RequestAborted);
                        if (Denied(check(context, session)) is { } observedDenied) return observedDenied;
                        return asleep ? DisplayAvailability.AsleepResult() : Unavailable("Raw frames are unavailable for this display. Use /frame.");
                    }
                    var (width, height) = VideoStreamSettings.ScaledSize(first.Width, first.Height, settings.Scale);
                    encoder = encoders(width, height, settings.MaxFps, settings.BitrateBps);
                    context.RequestAborted.ThrowIfCancellationRequested();
                    if (encoder is null) return Unavailable("The H.264 encoder is unavailable. Use /frame.");
                }
                else if (Denied(check(context, session)) is { } gpuDenied) return gpuDenied;

                run = new VideoStreamRun(context.Response.Body, () => { if (Volatile.Read(ref active) == 1) context.Abort(); }, frames, monitor, encoders,
                    settings, () => check(context, session), context.RequestAborted, hostStopping, firstFrame: first, firstEncoder: encoder,
                    gpu: gpuSource, firstGpuEncoder: gpuEncoder, log: log, pointers: gpuSource is null ? null : feed,
                    displayAsleep: token => DisplayAvailability.IsAsleepAsync(platform, token));
                encoder = null; gpuEncoder = null; // The run now owns these resources.
                if (shutdown is not null && !shutdown.TryTrack(run))
                {
                    return shutdown.IsStopping ? HostShutdown.StoppingResult() : AtCapacity();
                }
                reservation.Activate(run);
                if (!slots.TryAdd(session.Id, monitor.Id, run, out var replaced)) return AtCapacity();
                System.Diagnostics.Debug.Assert(replaced is null, "Admission must finish predecessor cleanup before publishing a successor.");
                if (replaced is not null) _ = replaced.EndAsync("stream_replaced", "A newer stream for this session and monitor replaced this one.");
                context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = ContentType;
                await context.Response.StartAsync(context.RequestAborted);
                await run.RunAsync();
            }
            finally
            {
                try
                {
                    if (run is not null)
                    {
                        shutdown?.Remove(run);
                        await run.DisposeAsync();
                    }
                    else { encoder?.Dispose(); gpuEncoder?.Dispose(); }
                }
                finally
                {
                    Volatile.Write(ref active, 0);
                    if (run is not null) slots.Remove(session.Id, monitor.Id, run);
                    // The using reservation releases only after endpoint/native disposal,
                    // so its successor cannot allocate while the old encoder is still live.
                }
            }
            return Results.Empty;
        });

        app.MapPost("/api/sessions/{id}/stream/control", async (HttpContext context, string id) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            var query = context.Request.Query;
            if (query.Keys.Any(key => key != "monitorId") || query.Any(pair => pair.Value.Count > 1)) return BadRequest("The only control parameter is one monitorId.");
            string? monitorId = null;
            try { if (query.TryGetValue("monitorId", out var requested)) monitorId = Security.SelectFrameMonitor(requested.ToString(), null); }
            catch (ArgumentException ex) { return BadRequest(ex.Message); }
            if (Denied(check(context, session)) is { } denied) return denied;
            var run = slots.Find(session.Id, monitorId, out var ambiguous);
            if (ambiguous) return BadRequest("This session has several streams; supply monitorId.");
            if (run is null) return Results.NotFound();
            if (!run.ControlLimiter.TryAcquire()) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
            if (context.Request.ContentLength > VideoControlRequest.MaximumBodyBytes) return BadRequest("Control body is limited to 1 KiB.");
            var buffer = new byte[VideoControlRequest.MaximumBodyBytes + 1]; var total = 0; int read;
            while (total < buffer.Length && (read = await context.Request.Body.ReadAsync(buffer.AsMemory(total), context.RequestAborted)) > 0) total += read;
            VideoControlRequest request;
            try { request = VideoControlRequest.Parse(buffer.AsSpan(0, total)); }
            catch (ArgumentException ex) { return BadRequest(ex.Message); }
            run.Apply(request);
            return Results.NoContent();
        });
    }

    /// <summary>Open-time HTTP result of a denial (same statuses as <c>/frame</c>); null when allowed.</summary>
    internal static IResult? Denied(VideoStreamDenial denial) => denial switch
    {
        VideoStreamDenial.None => null,
        VideoStreamDenial.HostStopping => HostShutdown.StoppingResult(),
        VideoStreamDenial.IdentityUnavailable => Results.StatusCode(StatusCodes.Status503ServiceUnavailable),
        VideoStreamDenial.Revoked => Results.Unauthorized(),
        VideoStreamDenial.OwnerEnded => Results.Json(new { error = OwnerEndedException.UserMessage, code = OwnerEndedException.Code }, statusCode: StatusCodes.Status403Forbidden),
        VideoStreamDenial.EndedByHost => Results.Json(new { error = "Session ended by host. Connect again explicitly.", code = "session_ended_by_host" }, statusCode: StatusCodes.Status410Gone),
        _ => Results.NotFound(),
    };

    private static IResult BadRequest(string error) => Results.BadRequest(new { error });
    private static IResult AtCapacity() => Results.Json(new
    {
        error = $"At most {MaximumStreamsPerDevice} video streams per device and {MaximumStreams} per host may be active or opening. Try again later.",
        code = "stream_capacity",
    }, statusCode: StatusCodes.Status429TooManyRequests);
    private static IResult Unavailable(string error) => Results.Json(new { error, code = "stream_unavailable" }, statusCode: StatusCodes.Status409Conflict);
}

internal static class VideoEncoders
{
    public static IVideoStreamEncoder? CreateMediaFoundation(int width, int height, int fps, int bitrateBps)
    {
        if (!OperatingSystem.IsWindows() || !MfH264Encoder.IsSupported) return null;
        var created = MfH264Encoder.Create(width, height, fps, bitrateBps, out _);
        return created is null ? null : new MfVideoStreamEncoder(created);
    }
}

/// <summary>Session lookup and the periodic access check, over <see cref="HostState"/>, mirroring <c>/frame</c>.</summary>
internal sealed class HostStateStreamAccess(HostState state, Func<bool> identityUnavailable, Func<HttpContext, PairedDevice?> peer, CancellationToken hostStopping, Func<string, string, RemoteSession?>? lookup = null)
{
    public RemoteSession? FindSession(HttpContext context, string id) =>
        SessionAccess.FindSession(state, peer(context), id, permissions => permissions.View,
            identityUnavailable(), allowStopping: true, lookup: lookup);
    public VideoStreamDenial Check(HttpContext context, RemoteSession session)
    {
        var requestPeer = peer(context);
        return Classify(hostStopping.IsCancellationRequested, identityUnavailable(), requestPeer is null ? null : state.FindDevice(requestPeer.Fingerprint),
            session, () => state.GetSession(session.Id, session.DeviceId));
    }

    /// <summary>Security denials precede ordinary shutdown; lifecycle session cleanup cannot mask a valid stop reason.</summary>
    internal static VideoStreamDenial Classify(bool stopping, bool identityUnavailable, PairedDevice? device, RemoteSession session, Func<RemoteSession?> current)
    {
        if (identityUnavailable) return VideoStreamDenial.IdentityUnavailable;
        if (device is null) return VideoStreamDenial.Revoked;
        if (device.BlockedByOwner) return VideoStreamDenial.OwnerEnded;
        if (!Security.TokenEquals(device.ResumeEpoch, session.ResumeEpoch)) return VideoStreamDenial.EndedByHost;
        if (!device.Permissions.View) return VideoStreamDenial.PermissionChanged;
        if (stopping) return VideoStreamDenial.HostStopping;
        var live = current();
        if (live is null) return VideoStreamDenial.SessionEnded;
        return live.Permissions.View ? VideoStreamDenial.None : VideoStreamDenial.PermissionChanged;
    }
}
