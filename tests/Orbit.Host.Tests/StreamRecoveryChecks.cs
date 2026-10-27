using Orbit.Host;
using Orbit.Host.Platform;

public static class StreamRecoveryChecks
{
    public static void Run(Action<bool, string> check)
    {
        var failures = new GpuReopenFailureWindow();
        check(!failures.Record(0) && failures.Count == 1, "GPU recovery: one failed reopen retains the GPU retry allowance");
        check(failures.Record(10_000_000) && failures.Count == 2, "GPU recovery: two failed reopens within ten seconds request CPU fallback");
        failures = new();
        check(!failures.Record(0) && !failures.Record(10_000_001) && failures.Count == 1,
            "GPU recovery: a failure older than ten seconds cannot poison a later recovery");
        for (var i = 0; i < 10_000; i++) failures.Record(20_000_000 + i);
        check(failures.Count == 2, "GPU recovery: retained failure history stays bounded to two timestamps");
    }
}

internal sealed class DeferredRecoveryPointerFeed : IPointerFeed
{
    private readonly VideoStreamChecks.FakePointerFeed inner = new();
    private readonly TaskCompletionSource<PointerSnapshot?> result = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int armed;
    public readonly TaskCompletionSource Started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public void Arm() => Interlocked.Exchange(ref armed, 1);
    public void CompleteStaleNull() => result.TrySetResult(null);
    public Task<PointerSnapshot?> GetPointerAsync(MonitorInfo monitor, string? knownShapeId, CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref armed, 0) == 1) { Started.TrySetResult(); return result.Task.WaitAsync(cancellationToken); }
        return inner.GetPointerAsync(monitor, knownShapeId, cancellationToken);
    }
}
