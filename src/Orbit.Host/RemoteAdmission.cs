using System.Collections.Concurrent;
using System.Net;

namespace Orbit.Host;

/// <summary>
/// Caps open remote connections in total and per source address (H-3). It runs before the
/// TLS handshake, so a peer without an invite cannot hold unbounded sockets or handshakes.
/// Sizing: one viewer device keeps up to 8 pooled HTTP/1.1 connections, one per open video
/// stream (at most 4) and a short-lived retry, 13 at worst; the per-source cap leaves room
/// above that. Two hostile source addresses at the per-source cap can fill every remote slot
/// until their connections close; the local control listener is not affected.
/// </summary>
internal sealed class ConnectionBudget(int total = ConnectionBudget.RemoteTotal, int perSource = ConnectionBudget.RemotePerSource,
    Action<string, int>? refused = null, TimeProvider? timeProvider = null)
{
    internal const int RemoteTotal = 128;
    internal const int RemotePerSource = 32;
    /// <summary>Refusals are reported at most once per interval, with the count since the last report.</summary>
    internal static readonly TimeSpan RefusalReportInterval = TimeSpan.FromSeconds(30);
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly Dictionary<string, int> bySource = new(StringComparer.Ordinal);
    private int active;
    private int refusedSinceReport;
    private DateTimeOffset nextReport = DateTimeOffset.MinValue;

    internal bool TryEnter(string source)
    {
        int report;
        lock (bySource)
        {
            var current = bySource.GetValueOrDefault(source);
            if (active < total && current < perSource)
            {
                active++; bySource[source] = current + 1;
                return true;
            }
            refusedSinceReport++;
            var now = clock.GetUtcNow();
            if (now < nextReport) return false;
            report = refusedSinceReport; refusedSinceReport = 0; nextReport = now + RefusalReportInterval;
        }
        refused?.Invoke(source, report);
        return false;
    }

    internal void Exit(string source)
    {
        lock (bySource)
        {
            active--;
            if (bySource.TryGetValue(source, out var current) && current > 1) bySource[source] = current - 1;
            else bySource.Remove(source);
        }
    }
}

/// <summary>
/// Single-flight, cached Tailscale source verification (H-3). Concurrent requests from one
/// address share one `tailscale whois` lookup; a verified source is cached for
/// <see cref="VerifiedFor"/> and a rejected one for <see cref="RejectedFor"/>, so a burst
/// of requests cannot spawn one CLI process each. Every rejected request is reported to
/// <paramref name="rejected"/> (H-8), which is expected to coalesce.
/// </summary>
internal sealed class RemoteSourceVerifier(Func<IPAddress, CancellationToken, Task<bool>> verify, TimeProvider? timeProvider = null,
    Action<string>? rejected = null)
{
    internal static readonly TimeSpan VerifiedFor = TimeSpan.FromSeconds(10);
    internal static readonly TimeSpan RejectedFor = TimeSpan.FromSeconds(3);
    private const int MaximumEntries = 1024;
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, (bool Verified, DateTimeOffset Until)> cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<bool>>> pending = new(StringComparer.Ordinal);

    internal async Task<bool> IsVerifiedAsync(IPAddress? address, CancellationToken cancellationToken)
    {
        if (address is null) return false;
        var verified = await CheckAsync(address, cancellationToken);
        if (!verified) rejected?.Invoke(address.ToString());
        return verified;
    }

    private Task<bool> CheckAsync(IPAddress address, CancellationToken cancellationToken)
    {
        var key = address.ToString();
        if (cache.TryGetValue(key, out var known) && known.Until > clock.GetUtcNow()) return Task.FromResult(known.Verified);
        // The shared lookup is not tied to one request: a caller that gives up only stops waiting.
        var lookup = pending.GetOrAdd(key, _ => new Lazy<Task<bool>>(() => LookupAsync(key, address)));
        return lookup.Value.WaitAsync(cancellationToken);
    }

    private async Task<bool> LookupAsync(string key, IPAddress address)
    {
        try
        {
            var verified = await verify(address, CancellationToken.None);
            if (cache.Count >= MaximumEntries) cache.Clear();
            cache[key] = (verified, clock.GetUtcNow() + (verified ? VerifiedFor : RejectedFor));
            return verified;
        }
        finally { pending.TryRemove(key, out _); }
    }
}
