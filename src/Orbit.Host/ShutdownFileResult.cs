using Microsoft.Net.Http.Headers;

namespace Orbit.Host;

/// <summary>Bounded file streaming that also stops before transport teardown.</summary>
internal sealed class ShutdownFileResult(string path, string name, long maximumBytes, HostShutdown shutdown, CancellationToken applicationStopping, Func<bool>? authorized = null) : IResult
{
    public async Task ExecuteAsync(HttpContext context)
    {
        using var cancelled = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, applicationStopping, shutdown.StoppingToken);
        if (cancelled.IsCancellationRequested)
        {
            await HostShutdown.StoppingResult().ExecuteAsync(context); return;
        }
        if (authorized is not null && !authorized()) { await Results.NotFound().ExecuteAsync(context); return; }
        await using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 65536, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (input.Length > maximumBytes)
        {
            await Results.BadRequest(new { error = $"Files are limited to {maximumBytes / (1024 * 1024)} MiB." }).ExecuteAsync(context); return;
        }
        context.Response.ContentType = "application/octet-stream";
        var remaining = input.Length;
        context.Response.ContentLength = remaining;
        var disposition = new ContentDispositionHeaderValue("attachment"); disposition.SetHttpFileName(name);
        context.Response.GetTypedHeaders().ContentDisposition = disposition;
        var buffer = new byte[65536];
        try
        {
            int read;
            while (remaining > 0 && (read = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, remaining)), cancelled.Token)) > 0)
            {
                cancelled.Token.ThrowIfCancellationRequested();
                if (authorized is not null && !authorized()) { context.Abort(); return; }
                await context.Response.Body.WriteAsync(buffer.AsMemory(0, read), cancelled.Token);
                remaining -= read;
            }
            if (remaining > 0) context.Abort();
        }
        catch (OperationCanceledException) when (cancelled.IsCancellationRequested)
        {
            // A partial download must be visibly incomplete, never a successful
            // truncated attachment. The declared content length and abort do that.
            context.Abort();
        }
    }
}
