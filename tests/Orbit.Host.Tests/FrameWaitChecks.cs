using Orbit.Host;

public static class FrameWaitChecks
{
    public static async Task RunAsync(Action<bool, string> check, Action<Action, string> reject)
    {
        check(FrameWaitGate.ParseWait(null) == 0 && FrameWaitGate.ParseWait("10000") == 10000, "Wait is absent by default and accepts the viewer's bounded delay");
        check(FrameWaitGate.ParseWait("-10") == 0 && FrameWaitGate.ParseWait("20000") == 15000, "Host wait clamps to zero through fifteen seconds");
        foreach (var text in new[] { "", "1.5", "NaN", " 50", "50 ", "1e3", "2147483648" }) reject(() => FrameWaitGate.ParseWait(text), "Malformed wait is rejected");
        var gate = new FrameWaitGate();
        var leases = new List<IDisposable>();
        for (var i = 0; i < 4; i++) { var lease = gate.TryEnter("device-a", "session-a", "monitor" + i); check(lease is not null, "Independent monitor can hold its own wait"); leases.Add(lease!); }
        check(gate.TryEnter("device-a", "session-a", "monitor0") is null, "Duplicate wait on a session and monitor never queues");
        check(gate.TryEnter("device-a", "session-b", "monitor4") is null, "One paired device cannot consume all global wait slots");
        for (var i = 0; i < 4; i++) leases.Add(gate.TryEnter("device-b", "session-b", "monitor" + i)!);
        check(gate.TryEnter("device-c", "session-c", "monitor") is null, "Global held-frame count is bounded to eight");
        foreach (var lease in leases) { lease.Dispose(); lease.Dispose(); }
        using var after = gate.TryEnter("device-c", "session-c", "monitor");
        check(after is not null, "Wait slots are released once, including duplicate disposal paths");

        foreach (var terminal in new[] { "401 revoked", "410 host stopped", "404 expired" })
        {
            string? denial = null;
            await using var authorization = new FrameWaitAuthorization<string>(true, () => Volatile.Read(ref denial), CancellationToken.None);
            var waiting = Task.Delay(Timeout.Infinite, authorization.Token);
            Volatile.Write(ref denial, terminal);
            var cancelled = false;
            try { await waiting.WaitAsync(TimeSpan.FromSeconds(1)); } catch (OperationCanceledException) { cancelled = true; }
            check(cancelled && authorization.Failure == terminal, "Held work is independently cancelled for " + terminal + " before any304 can be returned");
        }
        using var disconnected = new CancellationTokenSource();
        await using (var authorization = new FrameWaitAuthorization<string>(true, () => null, disconnected.Token))
        {
            disconnected.Cancel();
            check(authorization.Token.IsCancellationRequested && authorization.Failure is null, "Client disconnect cancels wait without inventing a host-ended reason");
        }
    }
}
