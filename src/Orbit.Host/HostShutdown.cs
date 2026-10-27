using System.Diagnostics;

namespace Orbit.Host;

/// <summary>Drains stream terminals before hosted servers stop, within one shared grace budget.</summary>
internal sealed class HostShutdown : IHostedLifecycleService, IDisposable
{
    internal const int GraceMilliseconds = 500;
    // Includes initializing/replaced requests awaiting cleanup, beyond the eight
    // current session/monitor slots. It is metadata only and remains bounded.
    internal const int MaximumTrackedStreams = 128;
    private readonly object gate = new();
    private readonly HashSet<VideoStreamRun> streams = [];
    private readonly CancellationTokenSource stoppingSource = new();
    private readonly CancellationTokenRegistration stoppingRegistration;
    private volatile bool stopping;
    private long startedAt;
    private Task drain = Task.CompletedTask;

    public HostShutdown(IHostApplicationLifetime lifetime) =>
        stoppingRegistration = lifetime.ApplicationStopping.Register(() => Begin());

    public bool IsStopping => stopping;
    public CancellationToken StoppingToken => stoppingSource.Token;

    // Session creation and the stop transition are mutually exclusive.
    public IResult WhileRunning(Func<IResult> action)
    {
        lock (gate) return stopping ? StoppingResult() : action();
    }

    public static void Add(IServiceCollection services)
    {
        services.AddSingleton<HostShutdown>();
        services.AddSingleton<IHostedService>(provider => provider.GetRequiredService<HostShutdown>());
    }

    public bool TryTrack(VideoStreamRun run)
    {
        lock (gate)
        {
            if (stopping || streams.Count >= MaximumTrackedStreams) return false;
            return streams.Add(run);
        }
    }

    public void Remove(VideoStreamRun run) { lock (gate) streams.Remove(run); }

    private Task Begin()
    {
        Task pending;
        lock (gate)
        {
            if (stopping) return drain;
            stopping = true; startedAt = Stopwatch.GetTimestamp();
            drain = Task.WhenAll(streams.Select(run => run.EndAsync("host_stopping", "The host is stopping.")));
            // A failed or blocked transport cannot turn shutdown into an unobserved exception.
            _ = drain.ContinueWith(task => _ = task.Exception, CancellationToken.None,
                TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            pending = drain;
        }
        // Publish the drain first; cancellation callbacks must never run while
        // holding the coordinator lock or prevent stream terminals from starting.
        try { stoppingSource.Cancel(); }
        catch (AggregateException) { }
        return pending;
    }

    public async Task StoppingAsync(CancellationToken cancellationToken)
    {
        var pending = Begin();
        var remaining = TimeSpan.FromMilliseconds(GraceMilliseconds) - Stopwatch.GetElapsedTime(startedAt);
        if (remaining <= TimeSpan.Zero) return;
        try { await pending.WaitAsync(remaining, cancellationToken); }
        catch (Exception ex) when (ex is TimeoutException or OperationCanceledException or IOException or InvalidOperationException) { }
    }

    public static IResult StoppingResult() => Results.Json(new { error = "The host is stopping.", code = "host_stopping" }, statusCode: 503);
    public static IResult? FrameDenial(bool stopping, bool identityUnavailable, PairedDevice? device, RemoteSession session, Func<RemoteSession?> current) =>
        VideoStreamEndpoints.Denied(HostStateStreamAccess.Classify(stopping, identityUnavailable, device, session, current));
    public Task StartingAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StartedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public Task StoppedAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    public void Dispose() { stoppingRegistration.Dispose(); stoppingSource.Dispose(); }
}
