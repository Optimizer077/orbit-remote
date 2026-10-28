using System.Net.Sockets;
using System.Security.Authentication;
using System.Text.Json;

namespace Orbit.Host;

/// <summary>
/// EXPERIMENTAL (F33): short-code pairing routes. Nothing here is mapped, exempted
/// from certificate pinning or advertised unless ORBIT_EXPERIMENTAL_SHORT_CODE=1.
/// </summary>
internal static class ShortPairEndpoints
{
    internal const string EnvironmentFlag = "ORBIT_EXPERIMENTAL_SHORT_CODE";
    internal const string RateLimitPolicy = "short-pairing";
    internal const long MaximumBodyBytes = 4096;

    internal static bool IsEnabled(string? value) => value == "1";

    /// <summary>Exact, case-sensitive bootstrap paths. Any other spelling keeps ordinary pinning (fails closed).</summary>
    internal static bool IsBootstrapPath(PathString path) =>
        path.Value is ShortPairProtocol.StartPath or ShortPairProtocol.VerifyPath or ShortPairProtocol.ConfirmPath;

    internal static void MapShortPairing(this WebApplication app, ShortPairHost host, HostState state, HostIdentity identity,
        Func<HttpContext, bool> isLocal, Func<bool> remoteUnavailable, Func<bool> identityUnavailable, bool loopbackTest)
    {
        var outgoing = new SemaphoreSlim(1, 1);

        // Local owner routes (bearer-authenticated by the shared local middleware).
        app.MapPost("/api/short-code", (HttpContext context, InviteRequest request) =>
            !isLocal(context) ? Results.NotFound() :
            remoteUnavailable() ? Results.Conflict(new { error = "Remote listening is unavailable. Check Tailscale and identity status before pairing." }) :
            Results.Ok(host.Create(request)));
        app.MapGet("/api/short-code", (HttpContext context) => isLocal(context) ? Results.Ok(host.Status()) : Results.NotFound());
        app.MapDelete("/api/short-code", (HttpContext context) => isLocal(context) && host.Cancel() ? Results.NoContent() : Results.NotFound());

        // Local client role: the viewer's Electron main asks its own host to run SRP toward a remote host.
        app.MapPost("/api/short-code/pair", async (HttpContext context, ShortPairClientRequest request) =>
        {
            if (!isLocal(context)) return Results.NotFound();
            if (identityUnavailable()) return Results.Conflict(new { error = "This computer's identity is unavailable. Check identity status first.", code = "identity_unavailable" });
            if (!await outgoing.WaitAsync(0)) return Results.Conflict(new { error = "Another short-code pairing is already in progress.", code = "busy" });
            try
            {
                var endpoint = ShortPairClient.ParseAddress(request.Address, loopbackTest);
                var code = ShortCode.Normalize(request.Code) ?? throw new ShortPairClientException(400, "invalid_code", "Enter the eight-character code shown on the other computer.");
                var deviceName = string.IsNullOrWhiteSpace(request.DeviceName) ? state.HostName : request.DeviceName.Trim();
                if (deviceName.Length > 80 || !Security.IsSafeDisplayText(deviceName)) throw new ShortPairClientException(400, "invalid_request", "Device name must be at most 80 printable characters.");
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
                timeout.CancelAfter(TimeSpan.FromSeconds(45));
                return Results.Ok(await ShortPairClient.PairAsync(endpoint, code, identity.Certificate, deviceName, timeout.Token));
            }
            catch (ShortPairClientException ex) { return Results.Json(new { error = ex.Message, code = ex.Code }, statusCode: ex.Status); }
            catch (Exception ex) when (ex is HttpRequestException or IOException or AuthenticationException or SocketException ||
                ex is OperationCanceledException && !context.RequestAborted.IsCancellationRequested)
            { return Results.Json(new { error = "Could not complete pairing with that computer. Nothing was saved.", code = "unreachable" }, statusCode: 502); }
            finally { outgoing.Release(); }
        });

        // Remote bootstrap routes: the only routes an unknown client certificate may reach.
        app.MapPost(ShortPairProtocol.StartPath, Remote(["v", "suite", "viewerNonce", "deviceName"], (viewer, connection, body) =>
        {
            var version = body.GetProperty("v");
            if (version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number) || number != ShortPairProtocol.Version || ShortPairProtocol.String(body, "suite") != ShortPairProtocol.Suite)
                return Results.BadRequest(new { error = "Unsupported short-code pairing protocol.", code = "unsupported_suite" });
            var nonce = ShortPairProtocol.Decode(ShortPairProtocol.String(body, "viewerNonce"), ShortPairProtocol.NonceBytes);
            var name = ShortPairProtocol.String(body, "deviceName");
            if (nonce is null || string.IsNullOrWhiteSpace(name) || name.Length > 80 || !Security.IsSafeDisplayText(name)) return Invalid();
            return Results.Ok(host.Start(nonce, name.Trim(), viewer, connection));
        })).RequireRateLimiting(RateLimitPolicy);
        app.MapPost(ShortPairProtocol.VerifyPath, Remote(["attemptId", "a", "m1"], (viewer, connection, body) =>
        {
            var attemptId = ShortPairProtocol.String(body, "attemptId");
            var a = ShortPairProtocol.Decode(ShortPairProtocol.String(body, "a"), ShortPairProtocol.GroupBytes);
            var m1 = ShortPairProtocol.Decode(ShortPairProtocol.String(body, "m1"), ShortPairProtocol.HashBytes);
            if (ShortPairProtocol.Decode(attemptId, ShortPairProtocol.AttemptBytes) is null || a is null || m1 is null) return Invalid();
            return Results.Ok(host.Verify(attemptId!, a, m1, viewer, connection));
        })).RequireRateLimiting(RateLimitPolicy);
        app.MapPost(ShortPairProtocol.ConfirmPath, Remote(["attemptId", "viewerConfirmation"], (viewer, connection, body) =>
        {
            var attemptId = ShortPairProtocol.String(body, "attemptId");
            var confirmation = ShortPairProtocol.Decode(ShortPairProtocol.String(body, "viewerConfirmation"), ShortPairProtocol.HashBytes);
            if (ShortPairProtocol.Decode(attemptId, ShortPairProtocol.AttemptBytes) is null || confirmation is null) return Invalid();
            return Results.Ok(host.Confirm(attemptId!, confirmation, viewer, connection));
        })).RequireRateLimiting(RateLimitPolicy);

        // A typed Func (not RequestDelegate) so the minimal API writes the returned IResult.
        Func<HttpContext, Task<IResult>> Remote(string[] fields, Func<string, string, JsonElement, IResult> action) => context => RemoteAsync(context, fields, action);
        async Task<IResult> RemoteAsync(HttpContext context, string[] fields, Func<string, string, JsonElement, IResult> action)
        {
            if (isLocal(context)) return Results.NotFound();
            if (identityUnavailable()) return Results.StatusCode(503);
            // The viewer fingerprint is always the certificate on this TLS connection, never request JSON;
            // the Kestrel connection ID binds an unfinished attempt to this one connection.
            var certificate = await context.Connection.GetClientCertificateAsync(context.RequestAborted);
            if (!Security.IsClientCertificateUsable(certificate)) return Results.StatusCode(401);
            JsonDocument document;
            try { document = await JsonDocument.ParseAsync(context.Request.Body, new JsonDocumentOptions { MaxDepth = 4 }, context.RequestAborted); }
            catch (JsonException) { return Invalid(); }
            using (document)
            {
                if (!ShortPairProtocol.HasExactly(document.RootElement, fields)) return Invalid();
                try { return action(Security.Fingerprint(certificate!), context.Connection.Id, document.RootElement); }
                catch (ShortPairException ex) { return Results.Json(new { error = ex.Message, code = ex.Code }, statusCode: ex.Status); }
            }
        }
    }

    private static IResult Invalid() => Results.BadRequest(new { error = "Invalid short-code pairing request.", code = "invalid_request" });
}
