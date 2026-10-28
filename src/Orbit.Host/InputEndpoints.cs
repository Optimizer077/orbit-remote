using System.Text.Json;
using Microsoft.Extensions.Options;
using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>Input and shutdown cleanup share one gate and a bounded release policy.</summary>
internal sealed class InputEndpoints : IDisposable
{
    internal const int ReleaseMilliseconds = 2000;
    internal const int MaximumBatchEvents = 64;
    private readonly IPlatformBackend platform;
    private readonly SemaphoreSlim gate;
    private readonly InputLeases leases;
    private readonly Action<string> warning;
    private readonly CancellationTokenRegistration stoppingRegistration;

    internal InputEndpoints(WebApplication app, HostState state, IPlatformBackend platform,
        Func<HttpContext, string, RemoteSession?> findSession, SemaphoreSlim gate, InputLeases leases,
        HostShutdown shutdown, Action<string> warning)
    {
        this.platform = platform; this.gate = gate; this.leases = leases; this.warning = warning;
        bool Stopping() => shutdown.IsStopping || app.Lifetime.ApplicationStopping.IsCancellationRequested;
        app.MapPost("/api/sessions/{id}/input", async (HttpContext context, string id, JsonElement body) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            var options = context.RequestServices.GetRequiredService<IOptions<Microsoft.AspNetCore.Http.Json.JsonOptions>>().Value.SerializerOptions;
            var inputs = ReadInputs(body, options, out var batch);
            if (inputs is null) return Results.BadRequest();
            using var cancelled = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted,
                shutdown.StoppingToken, app.Lifetime.ApplicationStopping);
            try
            {
                await gate.WaitAsync(cancelled.Token);
                try
                {
                    if (Stopping()) return HostShutdown.StoppingResult();
                    if (findSession(context, id) is null) return Results.NotFound();
                    try
                    {
                        for (var i = 0; i < inputs.Count; i++)
                        {
                            // Each event is checked as if it were its own request: authority lost mid-batch stops here.
                            if (i > 0 && findSession(context, id) is null) { await ReleaseHeldAsync(); return Results.NotFound(); }
                            cancelled.Token.ThrowIfCancellationRequested();
                            await platform.ApplyInputAsync(inputs[i], cancelled.Token);
                            if (Stopping()) return HostShutdown.StoppingResult();
                            leases.Record(id, inputs[i], DateTimeOffset.UtcNow); state.TouchInput(id);
                        }
                    }
                    catch (Exception) when (batch && !Stopping())
                    {
                        // A batch that fails part-way leaves nothing held; the error is the single form's.
                        await ReleaseHeldAsync();
                        throw;
                    }
                    return Results.NoContent();
                }
                finally
                {
                    try
                    {
                        // Even a native operation that ignored cancellation and
                        // completed after the stop fallback gets a final release.
                        if (Stopping()) await ReleaseNativeAsync(null, ReleaseMilliseconds);
                    }
                    finally { gate.Release(); }
                }
            }
            catch (OperationCanceledException) when (Stopping()) { return HostShutdown.StoppingResult(); }
        });
        stoppingRegistration = app.Lifetime.ApplicationStopping.Register(() => ReleaseAsync().GetAwaiter().GetResult());
    }

    /// <summary>Either one input object or <c>{"events":[...]}</c> with 1..64 input objects; null when malformed.</summary>
    internal static IReadOnlyList<RemoteInput>? ReadInputs(JsonElement body, JsonSerializerOptions options, out bool batch)
    {
        batch = body.ValueKind == JsonValueKind.Object
            && body.EnumerateObject().Any(property => property.Name.Equals("events", StringComparison.OrdinalIgnoreCase));
        try
        {
            if (!batch) return body.Deserialize<RemoteInput>(options) is { } single ? [single] : null;
            var events = body.Deserialize<InputBatchRequest>(options)?.Events;
            if (events is not { Count: > 0 and <= MaximumBatchEvents } || events.Any(input => input is null)) return null;
            return events.Select(input => input!).ToArray();
        }
        catch (JsonException) { return null; }
    }

    public async Task ReleaseAsync()
    {
        var started = Environment.TickCount64;
        var acquired = await gate.WaitAsync(ReleaseMilliseconds);
        if (!acquired) warning("Input cleanup gate remained busy; requesting a best-effort release without waiting further.");
        await ReleaseNativeAsync(acquired ? () => gate.Release() : null,
            (int)Math.Max(0, ReleaseMilliseconds - (Environment.TickCount64 - started)));
    }

    // Releases inside the held gate, so a late lease clear cannot erase input applied by the next request.
    private async Task ReleaseHeldAsync()
    {
        try { await platform.ReleaseInputsAsync(CancellationToken.None); leases.Clear(); }
        catch (Exception) { warning("Native input release after a failed input batch failed."); }
    }

    private async Task ReleaseNativeAsync(Action? finished, int remainingMilliseconds)
    {
        // Invoke native code off the stopping-callback thread: a backend that
        // blocks synchronously must not prevent Kestrel from cancelling requests.
        var pending = Task.Run(async () =>
        {
            try { await platform.ReleaseInputsAsync(); leases.Clear(); }
            finally { finished?.Invoke(); }
        });
        _ = pending.ContinueWith(task => { _ = task.Exception; warning("Best-effort native input release failed."); },
            CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        if (remainingMilliseconds == 0) return;
        try { await pending.WaitAsync(TimeSpan.FromMilliseconds(remainingMilliseconds)); }
        catch (TimeoutException) { warning("Best-effort native input release exceeded its shutdown budget."); }
        catch (Exception) { /* Observed and reported above; shutdown remains best effort. */ }
    }

    public void Dispose() => stoppingRegistration.Dispose();
}

internal sealed record InputBatchRequest(IReadOnlyList<RemoteInput?>? Events);
