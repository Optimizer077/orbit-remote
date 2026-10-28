using Orbit.Host;

/// <summary>H-8: failed pairing and unknown-certificate probes are audited, coalesced and bounded.</summary>
internal static class RejectionAuditChecks
{
    internal static void Run(Action<bool, string> check, string temporaryRoot)
    {
        var clock = new Clock();
        var state = new HostState(Path.Combine(temporaryRoot, "rejection-audit"), clock);
        var audit = new RejectionAudit(state, clock);
        int Count(string kind) => state.Audit.Count(entry => entry.Kind == kind);

        var first = audit.Record("pair.rejected", "100.64.0.7", "Pairing refused: the invite expired, was already used, or is invalid.");
        for (var i = 0; i < 9; i++) audit.Record("pair.rejected", "100.64.0.7", "Pairing refused: the invite expired, was already used, or is invalid.");
        check(first && Count("pair.rejected") == 1, "H-8: repeated rejections from one source within a minute write one audit entry");
        var entry = state.Audit.First(value => value.Kind == "pair.rejected");
        check(entry.Detail.Contains("100.64.0.7", StringComparison.Ordinal) && entry.DeviceId is null,
            "H-8: the rejection entry records the source address and no device");
        check(audit.Record("auth.unknown_certificate", "100.64.0.7", "A request presented a certificate that is not paired or was revoked.") && Count("auth.unknown_certificate") == 1,
            "H-8: a different rejection kind from the same source is recorded separately");

        clock.Now += RejectionAudit.Window;
        audit.Record("pair.rejected", "100.64.0.7", "Pairing refused: the invite expired, was already used, or is invalid.");
        var later = state.Audit.First(value => value.Kind == "pair.rejected");
        check(Count("pair.rejected") == 2 && later.Detail.Contains("9 earlier similar rejections", StringComparison.Ordinal),
            "H-8: after the window the next entry reports how many repeats were coalesced");

        clock.Now += RejectionAudit.Window;
        var before = state.Audit.Length;
        for (var i = 0; i < RejectionAudit.MaximumPerWindow * 3; i++)
            audit.Record("auth.unknown_certificate", "100.64.1." + i, "A request presented a certificate that is not paired or was revoked.");
        check(state.Audit.Length - before == RejectionAudit.MaximumPerWindow,
            "H-8: many distinct sources cannot write more than the per-minute rejection budget");
        PruneChecks(check, temporaryRoot);
    }

    /// <summary>Over the tracking bound, only entries past their window are dropped.</summary>
    private static void PruneChecks(Action<bool, string> check, string temporaryRoot)
    {
        var clock = new Clock();
        var state = new HostState(Path.Combine(temporaryRoot, "rejection-prune"), clock);
        var audit = new RejectionAudit(state, clock);
        var start = clock.Now;
        const string kind = "auth.unknown_certificate", reason = "Generated rejection.";
        // Stale entries that still carry repeat counts survive ordinary pruning.
        var stale = RejectionAudit.MaximumTrackedSources - 6;
        for (var index = 0; index < stale; index++)
        {
            clock.Now = start + RejectionAudit.Window * (index / RejectionAudit.MaximumPerWindow);
            audit.Record(kind, "100.65.0." + index, reason); audit.Record(kind, "100.65.0." + index, reason);
        }
        var windowStart = start + RejectionAudit.Window * (stale / RejectionAudit.MaximumPerWindow + 1);
        clock.Now = windowStart; audit.Record(kind, "100.66.0.1", reason);
        clock.Now = windowStart + TimeSpan.FromSeconds(50);
        for (var index = 0; index < 10; index++) audit.Record(kind, "100.67.0." + index, reason);
        check(audit.TrackedSources > RejectionAudit.MaximumTrackedSources, "H-8 prune fixture: tracked sources exceed the bound");
        // The next window opens 10 s after the 100.67.0.x entries: they are still inside their own window.
        clock.Now = windowStart + RejectionAudit.Window;
        var recordedAgain = audit.Record(kind, "100.67.0.0", reason);
        check(!recordedAgain && audit.TrackedSources <= RejectionAudit.MaximumPerWindow,
            "H-8: pruning drops only entries past their window, so a recent source cannot write again early");
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
