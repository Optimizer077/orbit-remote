using System.Net;
using Orbit.Host;

/// <summary>H-3: pre-authentication admission (connection budget, single-flight whois).</summary>
internal static class RemoteAdmissionChecks
{
    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        BudgetChecks(check);
        RefusalReportChecks(check);
        await VerifierChecks(check);
        await RejectedSourceAuditChecks(check, temporaryRoot);
    }

    private static void RefusalReportChecks(Action<bool, string> check)
    {
        var clock = new Clock();
        var reports = new List<(string Source, int Count)>();
        var budget = new ConnectionBudget(total: 4, perSource: 1, refused: (source, count) => reports.Add((source, count)), timeProvider: clock);
        budget.TryEnter("100.64.2.1");
        for (var attempt = 0; attempt < 6; attempt++) budget.TryEnter("100.64.2.1");
        check(reports.Count == 1 && reports[0] == ("100.64.2.1", 1), "H-3: the first refused connection is reported with its source");
        clock.Now += ConnectionBudget.RefusalReportInterval;
        budget.TryEnter("100.64.2.2"); budget.TryEnter("100.64.2.2");
        check(reports.Count == 2 && reports[1] == ("100.64.2.2", 6),
            "H-3: later refusals are reported at most once per interval, with the count since the last report");
    }

    private static async Task RejectedSourceAuditChecks(Action<bool, string> check, string temporaryRoot)
    {
        var state = new HostState(Path.Combine(temporaryRoot, "rejected-source-audit"));
        var audit = new RejectionAudit(state);
        var verifier = new RemoteSourceVerifier((_, _) => Task.FromResult(false),
            rejected: source => audit.Record("auth.source_rejected", source, "Tailscale did not verify the source address."));
        var address = IPAddress.Parse("100.64.3.3");
        var results = await Task.WhenAll(Enumerable.Range(0, 30).Select(_ => verifier.IsVerifiedAsync(address, CancellationToken.None)));
        var entries = state.Audit.Where(entry => entry.Kind == "auth.source_rejected").ToArray();
        check(results.All(value => !value) && entries.Length == 1 && entries[0].Detail.Contains("100.64.3.3", StringComparison.Ordinal),
            "H-8: whois-rejected sources are audited with their address, coalesced to one entry");
    }

    private static void BudgetChecks(Action<bool, string> check)
    {
        var budget = new ConnectionBudget(total: 5, perSource: 3);
        var first = Enumerable.Range(0, 4).Count(_ => budget.TryEnter("100.64.0.1"));
        check(first == 3, "H-3 budget: one source cannot hold more than its per-source connections");
        check(budget.TryEnter("100.64.0.2") && budget.TryEnter("100.64.0.2") && !budget.TryEnter("100.64.0.3"),
            "H-3 budget: the total connection cap holds across sources");
        budget.Exit("100.64.0.1");
        check(budget.TryEnter("100.64.0.3") && !budget.TryEnter("100.64.0.1"), "H-3 budget: a closed connection frees exactly one slot");
        check(ConnectionBudget.RemotePerSource == 32 && ConnectionBudget.RemotePerSource < ConnectionBudget.RemoteTotal,
            "H-3 budget: the per-source cap is 32, well above one viewer's worst case of 13 connections");
    }

    private static async Task VerifierChecks(Action<bool, string> check)
    {
        var clock = new Clock();
        var calls = 0;
        var release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var verifier = new RemoteSourceVerifier(async (_, _) => { Interlocked.Increment(ref calls); return await release.Task; }, clock);
        var address = IPAddress.Parse("100.64.0.9");
        var concurrent = Enumerable.Range(0, 50).Select(_ => verifier.IsVerifiedAsync(address, CancellationToken.None)).ToArray();
        release.SetResult(false);
        var results = await Task.WhenAll(concurrent);
        check(Volatile.Read(ref calls) == 1 && results.All(value => !value),
            "H-3 whois: fifty concurrent requests from one source share one lookup");
        check(!await verifier.IsVerifiedAsync(address, CancellationToken.None) && Volatile.Read(ref calls) == 1,
            "H-3 whois: a failed lookup is cached briefly instead of spawning another process");
        clock.Now += RemoteSourceVerifier.RejectedFor;
        release = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        release.SetResult(true);
        check(await verifier.IsVerifiedAsync(address, CancellationToken.None) && Volatile.Read(ref calls) == 2,
            "H-3 whois: a cached failure expires and the source is looked up again");
        clock.Now += RemoteSourceVerifier.VerifiedFor - TimeSpan.FromSeconds(1);
        check(await verifier.IsVerifiedAsync(address, CancellationToken.None) && Volatile.Read(ref calls) == 2,
            "H-3 whois: a verified source stays cached for its window");

        var slow = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var slowCalls = 0;
        var slowVerifier = new RemoteSourceVerifier(async (_, _) => { Interlocked.Increment(ref slowCalls); return await slow.Task; }, clock);
        using (var cancelled = new CancellationTokenSource())
        {
            var abandoned = slowVerifier.IsVerifiedAsync(address, cancelled.Token);
            cancelled.Cancel();
            var gaveUp = false;
            try { await abandoned; } catch (OperationCanceledException) { gaveUp = true; }
            var waiting = slowVerifier.IsVerifiedAsync(address, CancellationToken.None);
            slow.SetResult(true);
            check(gaveUp && await waiting && Volatile.Read(ref slowCalls) == 1,
                "H-3 whois: a cancelled request stops waiting without restarting the shared lookup");
        }
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
