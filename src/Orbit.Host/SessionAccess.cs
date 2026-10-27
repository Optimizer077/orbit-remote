using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>Distinguishes terminal authority loss from an authorized missing session.</summary>
internal static class SessionAccess
{
    internal static PairedDevice? CurrentPeer(HostState state, PairedDevice? requestPeer)
    {
        if (requestPeer is null) return null;
        // The cached request peer identifies the actual TLS certificate. Re-read
        // its current decision before looking up a possibly removed session ID.
        var current = state.FindDevice(requestPeer.Fingerprint);
        if (current is null) throw new SessionRevokedException();
        if (current.BlockedByOwner) throw new OwnerEndedException();
        return current;
    }

    internal static RemoteSession? FindSession(HostState state, PairedDevice? requestPeer, string id,
        Func<DevicePermissions, bool> permission, bool identityUnavailable = false,
        bool stopping = false, bool allowStopping = false, Func<string, string, RemoteSession?>? lookup = null)
    {
        if (identityUnavailable) return null;
        var peer = CurrentPeer(state, requestPeer);
        if (peer is null || !permission(peer.Permissions)) return null;
        if (stopping && !allowStopping) return null;
        var session = (lookup ?? state.GetSession)(id, peer.Id);
        if (session is null)
        {
            // Owner block/revoke can remove the row between the authority and
            // session reads. Preserve a terminal denial instead of renewal404.
            CurrentPeer(state, requestPeer);
            return null;
        }
        return Security.TokenEquals(peer.ResumeEpoch, session.ResumeEpoch) && permission(session.Permissions) ? session : null;
    }

    internal static async Task InvokeWithErrorsAsync(HttpContext context, RequestDelegate next, ILogger logger)
    {
        try { await next(context); }
        catch (OwnerEndedException ex) { if (!context.Response.HasStarted) { await WriteAuthorityErrorAsync(context, 403, ex.Message, OwnerEndedException.Code); } }
        catch (SessionRevokedException ex) { if (!context.Response.HasStarted) { await WriteAuthorityErrorAsync(context, 401, ex.Message, SessionRevokedException.Code); } }
        catch (SessionEndedException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 410; await context.Response.WriteAsJsonAsync(new { error = ex.Message, code = "session_ended_by_host" }); } }
        catch (PlatformUnavailableException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 409; await context.Response.WriteAsJsonAsync(new { error = ex.Message, code = ex.Code }); } }
        catch (ArgumentException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 400; await context.Response.WriteAsJsonAsync(new { error = ex.Message }); } }
        catch (UnauthorizedAccessException) { if (!context.Response.HasStarted) { context.Response.StatusCode = 403; await context.Response.WriteAsJsonAsync(new { error = "Access denied or pairing invite invalid." }); } }
        catch (InvalidOperationException ex) { if (!context.Response.HasStarted) { context.Response.StatusCode = 409; await context.Response.WriteAsJsonAsync(new { error = ex.Message }); } }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
        catch (BadHttpRequestException) { if (!context.Response.HasStarted) context.Response.StatusCode = 400; }
        catch (Exception ex)
        {
            logger.LogError("Request failed ({ExceptionType}).", ex.GetType().Name);
            if (!context.Response.HasStarted) { context.Response.StatusCode = 500; await context.Response.WriteAsJsonAsync(new { error = "The host could not complete this operation. Check local status and audit events." }); }
        }
    }

    private static async Task WriteAuthorityErrorAsync(HttpContext context, int status, string message, string code)
    {
        // A file may have set attachment headers before its first body write.
        // Typed denials before bytes must remain complete JSON responses.
        context.Response.ContentLength = null;
        context.Response.Headers.Remove("Content-Disposition");
        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new { error = message, code });
    }

}

internal sealed class SessionRevokedException() : UnauthorizedAccessException(UserMessage)
{
    internal const string Code = "access_revoked";
    internal const string UserMessage = "This device is no longer paired with the host.";
}
