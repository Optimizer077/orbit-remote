namespace Orbit.Host;

public sealed class FrameWaitGate
{
    public const int MaximumWaitMilliseconds = 15000;
    private readonly object gate = new();
    private readonly HashSet<(string Session, string Monitor)> held = [];
    private readonly Dictionary<string, int> deviceCounts = [];

    public static int ParseWait(string? value)
    {
        if (value is null) return 0;
        if (value.Length is 0 or > 12 || !int.TryParse(value, System.Globalization.NumberStyles.AllowLeadingSign, System.Globalization.CultureInfo.InvariantCulture, out var milliseconds))
            throw new ArgumentException("wait must be one integer number of milliseconds.");
        return Math.Clamp(milliseconds, 0, MaximumWaitMilliseconds);
    }

    public IDisposable? TryEnter(string deviceId, string sessionId, string monitorId)
    {
        lock (gate)
        {
            var key = (sessionId, monitorId);
            var count = deviceCounts.GetValueOrDefault(deviceId);
            if (held.Count >= 8 || count >= 4 || !held.Add(key)) return null;
            deviceCounts[deviceId] = count + 1;
            return new Lease(() => { lock (gate) { held.Remove(key); if (deviceCounts[deviceId] == 1) deviceCounts.Remove(deviceId); else deviceCounts[deviceId]--; } });
        }
    }

    private sealed class Lease(Action release) : IDisposable
    {
        private Action? action = release;
        public void Dispose() => Interlocked.Exchange(ref action, null)?.Invoke();
    }
}

internal sealed class FrameWaitAuthorization<T> : IAsyncDisposable where T : class
{
    private readonly CancellationTokenSource cancellation;
    private readonly Task watcher;
    private T? failure;
    public CancellationToken Token => cancellation.Token;
    public T? Failure => Volatile.Read(ref failure);
    public FrameWaitAuthorization(bool enabled, Func<T?> check, CancellationToken requestAborted)
    {
        cancellation = CancellationTokenSource.CreateLinkedTokenSource(requestAborted);
        watcher = enabled ? WatchAsync(check) : Task.CompletedTask;
    }
    private async Task WatchAsync(Func<T?> check)
    {
        try
        {
            while (true)
            {
                await Task.Delay(250, cancellation.Token);
                var denied = check();
                if (denied is not null) { Volatile.Write(ref failure, denied); cancellation.Cancel(); return; }
            }
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        catch { cancellation.Cancel(); throw; }
    }
    public async ValueTask DisposeAsync() { cancellation.Cancel(); try { await watcher; } finally { cancellation.Dispose(); } }
}
