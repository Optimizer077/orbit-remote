using System.Text;
using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>
/// Remote clipboard read/write (H-1). Operations are audited with their type and UTF-8 byte
/// count only, never the text, coalesced per device per minute, and each paired device is
/// held to one small token bucket shared by all its sessions.
/// </summary>
internal static class ClipboardEndpoints
{
    /// <summary>Explicit copy/paste stays well inside this; a polling or swapping peer is held to two operations a second.</summary>
    internal const double OperationsPerSecond = 2;
    internal const int Burst = 5;

    internal static DeviceRateLimiter CreateLimiter(TimeProvider? clock = null) => new(OperationsPerSecond, Burst, clock);

    internal static void MapClipboard(this WebApplication app, HostState state, IPlatformBackend platform,
        Func<HttpContext, string, RemoteSession?> findSession, SemaphoreSlim inputGate, DeviceRateLimiter limiter)
    {
        app.MapGet("/api/sessions/{id}/clipboard", async (HttpContext context, string id) =>
        {
            if (findSession(context, id) is not { } session) return Results.NotFound();
            if (!limiter.TryAcquire(session.DeviceId)) return Limited(context);
            var text = await platform.ReadClipboardAsync(context.RequestAborted);
            if (findSession(context, id) is null) return Results.NotFound();
            state.AddCoalescedAudit("clipboard.read", session.DeviceId, $"Remote clipboard read ({ByteCount(text)} bytes).");
            return Results.Ok(new { text });
        });
        app.MapPut("/api/sessions/{id}/clipboard", async (HttpContext context, string id, ClipboardRequest request) =>
        {
            if (findSession(context, id) is not { } session) return Results.NotFound();
            if (request.Text is null || request.Text.Length > 8192) return Results.BadRequest(new { error = "Clipboard text is limited to 8,192 characters." });
            if (!limiter.TryAcquire(session.DeviceId)) return Limited(context);
            await inputGate.WaitAsync(context.RequestAborted);
            try
            {
                if (findSession(context, id) is null) return Results.NotFound();
                await platform.WriteClipboardAsync(request.Text, context.RequestAborted);
                state.AddCoalescedAudit("clipboard.write", session.DeviceId, $"Remote clipboard write ({ByteCount(request.Text)} bytes).");
                return Results.NoContent();
            }
            finally { inputGate.Release(); }
        });
    }

    private static int ByteCount(string? text) => text is null ? 0 : Encoding.UTF8.GetByteCount(text);

    private static IResult Limited(HttpContext context)
    {
        context.Response.Headers.RetryAfter = "1";
        return Results.Json(new { error = "Too many clipboard requests. Wait a moment and try again.", code = "clipboard_rate_limited" }, statusCode: 429);
    }
}
