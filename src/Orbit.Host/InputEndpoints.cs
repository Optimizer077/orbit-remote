using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>Input and shutdown cleanup share one gate and a bounded release policy.</summary>
internal sealed class InputEndpoints : IDisposable
{
    internal const int ReleaseMilliseconds = 2000;
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
        app.MapPost("/api/sessions/{id}/input", async (HttpContext context, string id, RemoteInput input) =>
        {
            var session = findSession(context, id); if (session is null) return Results.NotFound();
            using var cancelled = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted,
                shutdown.StoppingToken, app.Lifetime.ApplicationStopping);
            try
            {
                await gate.WaitAsync(cancelled.Token);
                try
                {
                    if (Stopping()) return HostShutdown.StoppingResult();
                    if (findSession(context, id) is null) return Results.NotFound();
                    await platform.ApplyInputAsync(input, cancelled.Token);
                    if (Stopping()) return HostShutdown.StoppingResult();
                    leases.Record(id, input, DateTimeOffset.UtcNow); state.TouchInput(id);
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

    public async Task ReleaseAsync()
    {
        var started = Environment.TickCount64;
        var acquired = await gate.WaitAsync(ReleaseMilliseconds);
        if (!acquired) warning("Input cleanup gate remained busy; requesting a best-effort release without waiting further.");
        await ReleaseNativeAsync(acquired ? () => gate.Release() : null,
            (int)Math.Max(0, ReleaseMilliseconds - (Environment.TickCount64 - started)));
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
