namespace Orbit.Host;

/// <summary>
/// Token bucket keyed by paired device ID: <paramref name="burst"/> operations at once,
/// refilled at <paramref name="perSecond"/>. Keyed by device, not session, so a peer cannot
/// reset its budget by ending and creating sessions.
/// </summary>
internal sealed class DeviceRateLimiter(double perSecond, int burst, TimeProvider? timeProvider = null)
{
    private const int MaximumTrackedDevices = 256;
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly Dictionary<string, Bucket> buckets = new(StringComparer.Ordinal);

    internal int Burst => burst;

    internal bool TryAcquire(string deviceId)
    {
        lock (buckets)
        {
            var now = clock.GetUtcNow();
            if (!buckets.TryGetValue(deviceId, out var bucket))
            {
                // A full bucket is identical to no bucket, so idle entries can go.
                if (buckets.Count >= MaximumTrackedDevices)
                    foreach (var idle in buckets.Where(entry => Refill(entry.Value, now) >= burst).Select(entry => entry.Key).ToArray()) buckets.Remove(idle);
                buckets[deviceId] = bucket = new Bucket { Tokens = burst, At = now };
            }
            bucket.Tokens = Refill(bucket, now); bucket.At = now;
            if (bucket.Tokens < 1) return false;
            bucket.Tokens -= 1;
            return true;
        }
    }

    private double Refill(Bucket bucket, DateTimeOffset now) =>
        Math.Min(burst, bucket.Tokens + Math.Max(0, (now - bucket.At).TotalSeconds) * perSecond);

    private sealed class Bucket { internal double Tokens; internal DateTimeOffset At; }
}
