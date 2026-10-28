namespace Orbit.Host;

/// <summary>
/// Audits rejected pairing attempts and unknown-certificate probes (H-8) without letting
/// a prober flood the bounded audit history. Each (kind, source) pair is recorded at most
/// once per window, with a count of the repeats it absorbed, and the whole host records at
/// most <see cref="MaximumPerWindow"/> such entries per window. Entries hold the socket
/// source address and a fixed reason; never an invite, code, certificate or request body.
/// </summary>
internal sealed class RejectionAudit(HostState state, TimeProvider? timeProvider = null)
{
    internal static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    internal const int MaximumPerWindow = 20;
    internal const int MaximumTrackedSources = 256;
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private readonly object gate = new();
    private readonly Dictionary<string, Source> sources = new(StringComparer.Ordinal);
    private DateTimeOffset windowStart = DateTimeOffset.MinValue;
    private int recordedInWindow;

    /// <summary>Returns true when an audit entry was written.</summary>
    internal bool Record(string kind, string source, string reason)
    {
        string detail;
        lock (gate)
        {
            var now = clock.GetUtcNow();
            if (now - windowStart >= Window)
            {
                windowStart = now; recordedInWindow = 0;
                foreach (var stale in sources.Where(entry => now - entry.Value.RecordedAt >= Window && entry.Value.Suppressed == 0).Select(entry => entry.Key).ToArray())
                    sources.Remove(stale);
                // Over the bound, drop only entries whose window has passed (losing their
                // repeat counts). Entries still inside their window stay, so a wipe never
                // lets a source write again early; at most MaximumPerWindow of them exist.
                if (sources.Count > MaximumTrackedSources)
                    foreach (var stale in sources.Where(entry => now - entry.Value.RecordedAt >= Window).Select(entry => entry.Key).ToArray())
                        sources.Remove(stale);
            }
            var key = kind + "|" + source;
            if (sources.TryGetValue(key, out var known) && now - known.RecordedAt < Window || recordedInWindow >= MaximumPerWindow)
            {
                if (known is not null) known.Suppressed++;
                return false;
            }
            var repeats = known?.Suppressed ?? 0;
            sources[key] = new Source { RecordedAt = now };
            recordedInWindow++;
            detail = repeats > 0
                ? $"{reason} Source {source}; {repeats} earlier similar rejections from this source were not recorded individually."
                : $"{reason} Source {source}.";
        }
        state.AddAudit(kind, null, detail);
        return true;
    }

    /// <summary>Test seam: number of tracked (kind, source) entries.</summary>
    internal int TrackedSources { get { lock (gate) return sources.Count; } }

    private sealed class Source { internal DateTimeOffset RecordedAt; internal int Suppressed; }
}
