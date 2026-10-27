namespace Orbit.Host;

internal static class FileEndpoints
{
    internal static void MapList(this WebApplication app, HostState state,
        Func<HttpContext, string, RemoteSession?> findSession)
    {
        app.MapGet("/api/sessions/{id}/files", (HttpContext context, string id) =>
        {
            if (findSession(context, id) is null || !state.Settings.FileTransferEnabled) return Results.NotFound();
            var folder = Path.GetDirectoryName(state.GetSafeFilePath("orbit-validation"))!;
            var files = Directory.EnumerateFiles(folder)
                .Where(path => !UploadStore.IsReservedName(Path.GetFileName(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0)
                .Take(500).Select(path => new FileInfo(path)).Select(file => new { name = file.Name, size = file.Length, modifiedAt = file.LastWriteTimeUtc }).ToArray();
            return Results.Ok(files);
        });
    }

    internal static void MapUpload(this WebApplication app, HostState state, UploadStore uploads,
        Func<HttpContext, string, RemoteSession?> findSession, long maximumBytes, HostShutdown shutdown)
    {
        app.MapPut("/api/sessions/{id}/files/{name}", async (HttpContext context, string id, string name) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, app.Lifetime.ApplicationStopping, shutdown.StoppingToken);
            try
            {
                var size = await uploads.ReceiveAsync(name, context.Request.Body, maximumBytes,
                    () => findSession(context, id) is not null && state.Settings.FileTransferEnabled, cancellation.Token);
                state.AddAudit("file.upload", session.DeviceId, "A file was uploaded to the configured transfer folder.");
                return Results.Created($"/api/sessions/{id}/files/{Uri.EscapeDataString(name)}", new { name, size });
            }
            catch (UploadMarkingException)
            {
                if (findSession(context, id) is null) return Results.NotFound();
                if (!state.Settings.FileTransferEnabled) return Results.StatusCode(403);
                return Results.Json(new { error = UploadMarkingException.UserMessage, code = UploadMarkingException.Code }, statusCode: 409);
            }
            catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested &&
                (shutdown.IsStopping || app.Lifetime.ApplicationStopping.IsCancellationRequested)) { return HostShutdown.StoppingResult(); }
        });
    }

    internal static void MapDownload(this WebApplication app, HostState state,
        Func<HttpContext, string, RemoteSession?> findSession, long maximumBytes, HostShutdown shutdown)
    {
        app.MapGet("/api/sessions/{id}/files/{name}", (HttpContext context, string id, string name) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            var path = state.GetSafeFilePath(name); if (!File.Exists(path)) return Results.NotFound();
            if (new FileInfo(path).Length > maximumBytes) return Results.BadRequest(new { error = $"Files are limited to {maximumBytes / (1024 * 1024)} MiB." });
            state.AddAudit("file.download", session.DeviceId, "A file was downloaded from the configured transfer folder.");
            bool StillAuthorized()
            {
                try { return findSession(context, id) is not null && state.Settings.FileTransferEnabled; }
                catch (UnauthorizedAccessException) when (context.Response.HasStarted) { return false; }
            }
            return new ShutdownFileResult(path, name, maximumBytes, shutdown, app.Lifetime.ApplicationStopping, StillAuthorized);
        });
    }
}
