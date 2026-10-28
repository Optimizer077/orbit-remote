using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Agreement.Srp;
using Org.BouncyCastle.Security;
using Orbit.Host;
using BigInteger = Org.BouncyCastle.Math.BigInteger;

/// <summary>EXPERIMENTAL F33 short-code pairing checks. No screen capture, input or session is started.</summary>
public static class ShortPairChecks
{
    private static readonly DevicePermissions ViewControl = new(View: true, Control: true);

    public static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        CodeFormat(check);
        await StateAsync(check, Path.Combine(temporaryRoot, "short-pair-state"));
        await IntegrationAsync(check, Path.Combine(temporaryRoot, "short-pair-http"));
        await ShortPairClientChecks.RunAsync(check);
    }

    private static void CodeFormat(Action<bool, string> check)
    {
        var codes = Enumerable.Range(0, 4000).Select(_ => ShortCode.Generate()).ToArray();
        check(codes.All(code => code.Length == 8 && code.All(symbol => ShortCode.Alphabet.Contains(symbol))), "F33 code: eight Crockford base32 symbols from the CSPRNG");
        check(!codes.Any(code => code.IndexOfAny(['I', 'L', 'O', 'U']) >= 0), "F33 code: never contains I, L, O or U");
        check(ShortCode.Alphabet.All(symbol => codes.Any(code => code.Contains(symbol))) && codes.Distinct().Count() > 3990, "F33 code: every symbol occurs and codes do not repeat in a small sample");
        check(ShortCode.Format("K7QF2M9X") == "K7QF-2M9X", "F33 code: displayed as XXXX-XXXX");
        check(ShortCode.Normalize("k7qf-2m9x") == "K7QF2M9X" && ShortCode.Normalize(" K7QF 2M9X ") == "K7QF2M9X" && ShortCode.Normalize("K7QF2M9X") == "K7QF2M9X",
            "F33 normalisation: case-insensitive, ignores spaces and hyphens");
        check(ShortCode.Normalize("oiL0-0000") == "01100000", "F33 normalisation: Crockford O->0 and I/L->1");
        foreach (var invalid in new[] { null, "", "K7QF-2M9", "K7QF-2M9XZ", "U7QF-2M9X", "K7QF_2M9X", "Κ7QF-2M9X", "ı7QF-2M9X", "K7QF-2M9X\0", new string(' ', 33) + "K7QF2M9X" })
            check(ShortCode.Normalize(invalid) is null, "F33 normalisation rejects: " + (invalid is null ? "null" : invalid.Replace("\0", "\\0")));
        check(new[] { "/api/short-pair/start", "/api/short-pair/verify", "/api/short-pair/confirm", "/api/short-code", "/api/short-code/pair" }
            .All(path => RequestBodyPolicy.LimitFor("POST", path, 32L * 1024 * 1024) == ShortPairEndpoints.MaximumBodyBytes), "F33 bounds: short-code request bodies are limited to 4 KiB");
        check(ShortPairEndpoints.IsBootstrapPath("/api/short-pair/start") && !ShortPairEndpoints.IsBootstrapPath("/api/short-pair/START")
            && !ShortPairEndpoints.IsBootstrapPath("/api/short-pair/start/") && !ShortPairEndpoints.IsBootstrapPath("/api/short-code") && !ShortPairEndpoints.IsBootstrapPath("/api/info"),
            "F33 bounds: the pinning exemption covers exactly the three bootstrap paths");
    }

    private static async Task StateAsync(Action<bool, string> check, string directory)
    {
        var clock = new TestClock(DateTimeOffset.Parse("2026-10-27T12:00:00Z"));
        var state = new HostState(directory, clock);
        var hostFingerprint = RandomFingerprint();
        var host = new ShortPairHost(state, () => hostFingerprint, clock);
        check(host.Status().State == "none", "F33 state: no code is active by default");
        check(Throws(() => host.Start(new byte[32], "Viewer", RandomFingerprint(), "connection"), "short_code_unavailable"), "F33 state: start without a code is refused");
        check(Throws<ArgumentException>(() => host.Create(new("Viewer", new()))), "F33 state: a code requires explicit view permission");
        foreach (var disguised in new[] { "invoice\u202Eexe.txt", "a\u202Ab", "a\u202Bb", "a\u202Cb", "a\u202Db", "a\u2066b", "a\u2067b", "a\u2068b", "a\u2069b", "bell\u0007" })
            check(!Security.IsSafeDisplayText(disguised), "Display names: control and bidi embedding/override/isolate characters are refused: U+" + ((int)disguised.First(c => char.IsControl(c) || c >= '\u2000')).ToString("X4"));
        check(Security.IsSafeDisplayText("Ana's laptop") && Security.IsSafeDisplayText("Caf\u00E9 \u0645\u0643\u062A\u0628") && Security.IsSafeDisplayText("\u200E"),
            "Display names: ordinary names, right-to-left scripts and plain direction marks stay allowed");
        foreach (var hidden in new[] { "a\u200Bb", "a\u2060b", "a\uFEFFb", "a\u061Cb", "a\u00ADb", "a\u2028b", "a\u2029b", "a\uDB40\uDC01b", "a\uD800b" })
            check(!Security.IsSafeDisplayText(hidden), "Display names: format characters (Cf), line/paragraph separators and invalid UTF-16 are refused: " + string.Join(" ", hidden.Select(c => ((int)c).ToString("X4"))));
        check(Security.IsSafeDisplayText("\u200Ename\u200F") && Security.IsSafeDisplayText("Laptop \uD83D\uDCBB"), "Display names: LRM/RLM marks and supplementary-plane emoji stay allowed");
        check(Security.IsSafeDisplayText("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645") && Security.IsSafeDisplayText("\uD83D\uDC69\u200D\uD83D\uDCBB laptop"),
            "Display names: ZWNJ (Persian words) and ZWJ (emoji sequences, Indic scripts) stay allowed");
        const long Now = 1_800_000_000;
        check(ShortPairProtocol.IsPlausibleExpiry(Now + 3600, Now) && ShortPairProtocol.IsPlausibleExpiry(Now - 3600, Now) && !ShortPairProtocol.IsPlausibleExpiry(Now + 3601, Now) && !ShortPairProtocol.IsPlausibleExpiry(Now - 3601, Now),
            "F33 client: the host expiry must lie within one hour of now, boundaries included");
        check(!ShortPairProtocol.IsPlausibleExpiry(long.MinValue, Now) && !ShortPairProtocol.IsPlausibleExpiry(long.MaxValue, Now) && !ShortPairProtocol.IsPlausibleExpiry(unchecked(Now + long.MinValue), Now),
            "F33 client: extreme expiry values are refused without overflow");
        check(Throws<ArgumentException>(() => state.UpdateSettings(new(HostName: "Ana\u202Elaptop"))) && Throws<ArgumentException>(() => state.UpdateSettings(new(HostName: "Ana\u200Blaptop"))) && state.HostName != "Ana",
            "Host name: settings refuse bidi-override and zero-width characters");
        check(Throws<ArgumentException>(() => host.Create(new("invoice\u202Eexe", ViewControl))), "F33 names: a short code refuses a bidi-override device name");
        check(Throws<ArgumentException>(() => state.PairShortCode(RandomFingerprint(), "a\u2066b", ViewControl)), "F33 names: short-code pinning refuses a bidi-isolate device name");
        check(Throws<ArgumentException>(() => state.CreateInvite(new("invoice\u202Eexe", ViewControl), "https://127.0.0.1:47832", "pin")), "Long invite: creation refuses a bidi-override device name");
        var bidiInvite = state.CreateInvite(new(null, ViewControl), "https://127.0.0.1:47832", "pin").InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        var bidiSecret = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(bidiInvite.PadRight((bidiInvite.Length + 3) / 4 * 4, '='))).GetProperty("secret").GetString()!;
        var bidiFingerprint = RandomFingerprint();
        check(Throws<ArgumentException>(() => state.Pair(new(bidiSecret, "evil\u202Dname"), bidiFingerprint)) && state.FindDevice(bidiFingerprint) is null && state.Pair(new(bidiSecret, "Plain name"), bidiFingerprint).Name == "Plain name",
            "Long invite: pairing refuses a bidi-override requested device name before consuming the invite");

        // A failed save must not leave a certificate trusted in memory.
        var saveFailure = new IOException("Simulated failed state write.");
        var longInvite = state.CreateInvite(new(null, ViewControl), "https://127.0.0.1:47832", "pin").InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        var longSecret = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(longInvite.PadRight((longInvite.Length + 3) / 4 * 4, '='))).GetProperty("secret").GetString()!;
        var unsavedFingerprint = RandomFingerprint();
        var before = state.Devices.Length;
        state.BeforeSave = () => throw saveFailure;
        check(ThrowsExactly(() => state.Pair(new(longSecret, "Unsaved"), unsavedFingerprint), saveFailure) && state.FindDevice(unsavedFingerprint) is null && state.Devices.Length == before,
            "Long invite: a failed save leaves the device untrusted");
        state.BeforeSave = null;
        var trustedFingerprint = RandomFingerprint();
        var trusted = state.PairShortCode(trustedFingerprint, "Trusted", new DevicePermissions(View: true));
        state.BeforeSave = () => throw saveFailure;
        check(ThrowsExactly(() => state.PairShortCode(trustedFingerprint, "Trusted", ViewControl), saveFailure) && state.FindDevice(trustedFingerprint) == trusted,
            "Re-pairing: a failed save keeps the previous pairing and grants unchanged");
        state.BeforeSave = null;
        var unsavedCode = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var unsaved = new Viewer(host, RandomFingerprint());
        var unsavedVerify = unsaved.Verify(unsavedCode);
        unsaved.Finish(unsavedVerify, hostFingerprint, out var unsavedConfirmation);
        state.BeforeSave = () => throw saveFailure;
        check(ThrowsExactly(() => host.Confirm(unsaved.AttemptId, unsavedConfirmation, unsaved.Fingerprint, unsaved.Connection), saveFailure)
            && state.FindDevice(unsaved.Fingerprint) is null && host.Status().State == "used",
            "F33 state: a failed save after both confirmations consumes the code and leaves the device untrusted");
        state.BeforeSave = null;

        // A legacy saved host name with unsafe text cannot create a code (it would make a one-sided pairing).
        var legacyDirectory = directory + "-legacy-name";
        _ = new HostState(legacyDirectory, clock);
        var legacyPath = Path.Combine(legacyDirectory, "host.json");
        File.WriteAllText(legacyPath, File.ReadAllText(legacyPath).Replace("\"hostName\": null", "\"hostName\": \"Ana\\u202Elaptop\""));
        var legacy = new HostState(legacyDirectory, clock);
        check(legacy.HostName != "Ana" && Throws<ArgumentException>(() => new ShortPairHost(legacy, () => hostFingerprint, clock).Create(new(null, ViewControl))),
            "F33 names: a short code is refused while the saved host name is unsafe");

        // Successful exchange, idempotent completion, single use.
        var created = host.Create(new(null, ViewControl));
        var code = ShortCode.Normalize(created.Code)!;
        check(created.Code.Length == 9 && created.Code[4] == '-' && created.ExpiresAt == clock.GetUtcNow() + TimeSpan.FromMinutes(10), "F33 state: ten-minute code shown as XXXX-XXXX");
        var viewerFingerprint = RandomFingerprint();
        var viewer = new Viewer(host, viewerFingerprint);
        var verified = viewer.Verify(code);
        check(viewer.Finish(verified, hostFingerprint, out var confirmation), "F33 state: viewer verifies the host confirmation over the shared transcript");
        check(state.FindDevice(viewerFingerprint) is null, "F33 state: nothing is pinned before the viewer confirmation");
        var receipt = host.Confirm(viewer.AttemptId, confirmation, viewerFingerprint, viewer.Connection);
        var paired = state.FindDevice(viewerFingerprint);
        check(paired is not null && paired.Permissions == ViewControl && receipt.Permissions.ToPermissions() == ViewControl && paired.Name == "Viewer" && receipt.DeviceId == paired.Id && receipt.CertificateFingerprint == hostFingerprint,
            "F33 state: both confirmations pin the actual viewer certificate with the code's grants");
        var devices = state.Devices.Length;
        var again = host.Confirm(viewer.AttemptId, confirmation, viewerFingerprint, viewer.Connection);
        check(again == receipt && state.Devices.Length == devices, "F33 state: a repeated final confirmation returns the same receipt without a second grant");
        check(Throws(() => host.Confirm(viewer.AttemptId, confirmation, RandomFingerprint(), viewer.Connection), "short_code_rejected"), "F33 state: the receipt is bound to the same viewer certificate");
        var altered = confirmation.ToArray(); altered[0] ^= 1;
        check(Throws(() => host.Confirm(viewer.AttemptId, altered, viewerFingerprint, viewer.Connection), "short_code_rejected"), "F33 state: the receipt is bound to the same confirmation");
        check(host.Status().State == "used" && Throws(() => new Viewer(host, RandomFingerprint()), "short_code_unavailable"), "F33 state: a code is single use");
        check(Throws(() => host.Verify(viewer.AttemptId, viewer.A, viewer.M1, viewerFingerprint, viewer.Connection), "short_code_unavailable"), "F33 state: replayed SRP proof after completion is refused");
        const string newSocket = "another-connection";
        check(host.Confirm(viewer.AttemptId, confirmation, viewerFingerprint, newSocket) == receipt && state.Devices.Length == devices,
            "F33 connection: a COMPLETED attempt re-fetches its identical receipt on a new connection");
        check(Throws(() => host.Confirm(viewer.AttemptId, confirmation, RandomFingerprint(), newSocket), "short_code_rejected"), "F33 connection: receipt re-fetch with a different certificate is refused");
        check(Throws(() => host.Confirm(viewer.AttemptId, altered, viewerFingerprint, newSocket), "short_code_rejected"), "F33 connection: receipt re-fetch with a different confirmation is refused");
        // Literal times on purpose: the window is part of the contract, not whatever the constant says.
        clock.Advance(TimeSpan.FromSeconds(119));
        check(host.Confirm(viewer.AttemptId, confirmation, viewerFingerprint, newSocket) == receipt, "F33 connection: receipt re-fetch still works at 1:59");
        clock.Advance(TimeSpan.FromSeconds(2));
        check(Throws(() => host.Confirm(viewer.AttemptId, confirmation, viewerFingerprint, newSocket), "short_code_unavailable") && state.Devices.Length == devices,
            "F33 connection: receipt re-fetch after the two-minute window (2:01) is refused");

        // Wrong code: rejected, counted, nothing pinned.
        code = ShortCode.Normalize(host.Create(new("Named by owner", ViewControl)).Code)!;
        var wrongFingerprint = RandomFingerprint();
        var wrong = new Viewer(host, wrongFingerprint);
        check(Throws(() => wrong.Verify(WrongCode(code)), "short_code_rejected") && state.FindDevice(wrongFingerprint) is null && host.Status().AttemptsRemaining == 4,
            "F33 state: a wrong code fails SRP evidence, counts an attempt and pins nothing");

        // Changed host certificate (viewer saw a man in the middle's server certificate).
        var mitmHost = new Viewer(host, RandomFingerprint());
        var mitmVerify = mitmHost.Verify(code);
        check(!mitmHost.Finish(mitmVerify, RandomFingerprint(), out var mitmConfirmation), "F33 transcript: a different host certificate fails the host confirmation at the viewer");
        check(Throws(() => host.Confirm(mitmHost.AttemptId, mitmConfirmation, mitmHost.Fingerprint, mitmHost.Connection), "short_code_rejected") && state.FindDevice(mitmHost.Fingerprint) is null,
            "F33 transcript: the viewer confirmation over the other host certificate is rejected and nothing is pinned");

        // Changed viewer certificate (host saw a man in the middle's client certificate).
        var relayFingerprint = RandomFingerprint();
        var relayed = new Viewer(host, relayFingerprint);
        var relayedVerify = relayed.Verify(code);
        var realViewerFingerprint = RandomFingerprint();
        check(!relayed.Finish(relayedVerify, hostFingerprint, out var realViewerConfirmation, realViewerFingerprint), "F33 transcript: a relayed client certificate fails the host confirmation at the real viewer");
        check(Throws(() => host.Confirm(relayed.AttemptId, realViewerConfirmation, relayFingerprint, relayed.Connection), "short_code_rejected")
            && state.FindDevice(relayFingerprint) is null && state.FindDevice(realViewerFingerprint) is null,
            "F33 transcript: a confirmation over a different viewer certificate is rejected and nothing is pinned");
        check(host.Status().AttemptsRemaining == 2, "F33 state: transcript failures spend the shared attempt budget");

        // Reflection and replay.
        code = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var reflector = new Viewer(host, RandomFingerprint());
        var reflectedVerify = reflector.Verify(code);
        check(Throws(() => host.Verify(reflector.AttemptId, reflector.A, reflector.M1, reflector.Fingerprint, reflector.Connection), "short_code_rejected"), "F33 replay: a second SRP proof for one attempt is refused");
        check(Throws(() => host.Confirm(reflector.AttemptId, ShortPairProtocol.Decode(reflectedVerify.HostConfirmation, 32)!, reflector.Fingerprint, reflector.Connection), "short_code_rejected")
            && state.FindDevice(reflector.Fingerprint) is null, "F33 reflection: the host's own confirmation is not accepted as the viewer's");
        var early = new Viewer(host, RandomFingerprint());
        check(Throws(() => host.Confirm(early.AttemptId, new byte[32], early.Fingerprint, early.Connection), "short_code_rejected"), "F33 replay: confirmation before SRP verification is refused");
        var switched = new Viewer(host, RandomFingerprint());
        check(Throws(() => host.Verify(switched.AttemptId, new byte[384], new byte[32], RandomFingerprint(), switched.Connection), "short_code_rejected"), "F33 state: a different TLS certificate cannot continue an attempt");
        var fourth = new Viewer(host, RandomFingerprint());
        var fifth = new Viewer(host, RandomFingerprint());
        check(Throws(() => fourth.Verify(WrongCode(code)), "short_code_rejected") && Throws(() => fifth.Verify(WrongCode(code)), "short_code_rejected"), "F33 state: further wrong guesses are rejected");
        check(Throws(() => host.Start(new byte[32], "Viewer", RandomFingerprint(), "connection"), "short_code_locked") && host.Status().State == "active",
            "F33 lockout: no sixth attempt can start while a reserved attempt is still pending");
        check(Throws(() => early.Verify(WrongCode(code)), "short_code_rejected") && host.Status().State == "locked", "F33 lockout: five failed attempts cancel the code");
        check(Throws(() => host.Verify(early.AttemptId, early.A, early.M1, early.Fingerprint, early.Connection), "short_code_locked"), "F33 lockout: a locked code refuses every pending or replayed message");

        // Concurrent wrong guesses cannot exceed the budget.
        code = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var guesses = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() =>
        {
            try { new Viewer(host, RandomFingerprint()).Verify(WrongCode(code)); return "accepted"; }
            catch (ShortPairException ex) { return ex.Code; }
        })));
        check(guesses.Count(result => result == "short_code_rejected") == 5 && guesses.Count(result => result == "short_code_locked") == 7 && guesses.All(result => result != "accepted"),
            "F33 lockout: twelve concurrent wrong guesses get exactly five SRP checks");
        check(Throws(() => new Viewer(host, RandomFingerprint()), "short_code_locked"), "F33 lockout: the correct code cannot start after lockout");

        // Concurrent starts reserve slots atomically; a reserved correct attempt still succeeds.
        code = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var starts = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
        {
            try { return new Viewer(host, RandomFingerprint()); } catch (ShortPairException) { return null; }
        })));
        check(starts.Count(started => started is not null) == 5, "F33 lockout: concurrent starts reserve at most five attempts");
        var survivor = starts.First(started => started is not null)!;
        var survivorVerify = survivor.Verify(code);
        check(survivor.Finish(survivorVerify, hostFingerprint, out var survivorConfirmation) && host.Confirm(survivor.AttemptId, survivorConfirmation, survivor.Fingerprint, survivor.Connection).DeviceId.Length > 0,
            "F33 lockout: a reserved correct attempt completes within the budget");

        // Abandoned attempts expire as failures.
        host.Create(new(null, ViewControl));
        for (var index = 0; index < 5; index++) _ = new Viewer(host, RandomFingerprint());
        clock.Advance(ShortPairHost.AttemptLifetime + TimeSpan.FromSeconds(1));
        check(host.Status().State == "locked", "F33 lockout: five abandoned attempts count as failures after their deadline");

        // Expiry during confirmation invalidates the pending completion.
        code = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var late = new Viewer(host, RandomFingerprint());
        var lateVerify = late.Verify(code);
        late.Finish(lateVerify, hostFingerprint, out var lateConfirmation);
        clock.Advance(TimeSpan.FromSeconds(59));
        check(host.Status().State == "active", "F33 expiry: the code stays active inside its attempt deadline");
        clock.Advance(ShortPairHost.CodeLifetime);
        check(Throws(() => host.Confirm(late.AttemptId, lateConfirmation, late.Fingerprint, late.Connection), "short_code_unavailable") && state.FindDevice(late.Fingerprint) is null && host.Status().State == "expired",
            "F33 expiry: an expired code refuses confirmation and pins nothing");

        // Cancel and replacement invalidate outstanding attempts.
        code = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var cancelled = new Viewer(host, RandomFingerprint());
        check(host.Cancel() && host.Status().State == "cancelled" && Throws(() => cancelled.Verify(code), "short_code_unavailable"), "F33 cancel: cancelling invalidates outstanding attempts");
        code = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        var replaced = new Viewer(host, RandomFingerprint());
        var replacement = ShortCode.Normalize(host.Create(new(null, ViewControl)).Code)!;
        check(Throws(() => replaced.Verify(code), "short_code_rejected") && host.Status().AttemptsRemaining == 5, "F33 state: one active code; a new code invalidates the old code's attempts");
        var invalid = new Viewer(host, RandomFingerprint());
        check(Throws(() => host.Verify(invalid.AttemptId, new byte[384], invalid.M1Placeholder, invalid.Fingerprint, invalid.Connection), "short_code_rejected") && host.Status().AttemptsRemaining == 4,
            "F33 state: an invalid SRP public value is rejected and counted");
        var n = ShortPairProtocol.Unsigned(ShortPairProtocol.Group.N, 384);
        var nPlusOne = ShortPairProtocol.Unsigned(ShortPairProtocol.Group.N.Add(BigInteger.One), 384);
        var nMinusOne = ShortPairProtocol.Unsigned(ShortPairProtocol.Group.N.Subtract(BigInteger.One), 384);
        check(!ShortPairProtocol.IsCanonicalElement(new byte[384]) && !ShortPairProtocol.IsCanonicalElement(n) && !ShortPairProtocol.IsCanonicalElement(nPlusOne)
            && !ShortPairProtocol.IsCanonicalElement(Enumerable.Repeat((byte)0xFF, 384).ToArray()) && !ShortPairProtocol.IsCanonicalElement(new byte[383])
            && ShortPairProtocol.IsCanonicalElement(ShortPairProtocol.Unsigned(BigInteger.One, 384)) && ShortPairProtocol.IsCanonicalElement(nMinusOne),
            "F33 canonical: SRP public values A and B must satisfy 0 < value < N (B = N and B = N + 1 refused by the same check the client runs)");
        var atN = new Viewer(host, RandomFingerprint());
        check(Throws(() => host.Verify(atN.AttemptId, n, atN.M1Placeholder, atN.Fingerprint, atN.Connection), "short_code_rejected"), "F33 canonical: A = N is rejected");
        var aboveN = new Viewer(host, RandomFingerprint());
        check(Throws(() => host.Verify(aboveN.AttemptId, nPlusOne, aboveN.M1Placeholder, aboveN.Fingerprint, aboveN.Connection), "short_code_rejected") && host.Status().AttemptsRemaining == 2,
            "F33 canonical: A = N + 1 is rejected and counted");
        var moved = new Viewer(host, RandomFingerprint());
        check(Throws(() => moved.Verify(replacement, "a-new-socket"), "short_code_rejected") && host.Status().AttemptsRemaining == 1,
            "F33 connection: a correct proof for an unfinished attempt on a new socket is rejected (attempt spent)");
        var movedLater = new Viewer(host, RandomFingerprint());
        var movedVerify = movedLater.Verify(replacement);
        check(movedLater.Finish(movedVerify, hostFingerprint, out var movedConfirmation)
            && Throws(() => host.Confirm(movedLater.AttemptId, movedConfirmation, movedLater.Fingerprint, "a-new-socket"), "short_code_rejected") && state.FindDevice(movedLater.Fingerprint) is null,
            "F33 connection: a valid final confirmation for an unfinished attempt on a new socket is rejected; nothing is pinned");
        check(Throws(() => host.Confirm(movedLater.AttemptId, movedConfirmation, movedLater.Fingerprint, movedLater.Connection), "short_code_locked") && host.Status().State == "locked",
            "F33 connection: the socket change aborted the attempt, spending its budget");

        var persisted = File.ReadAllText(Path.Combine(directory, "host.json")) + File.ReadAllText(Path.Combine(directory, "audit.jsonl"));
        check(!persisted.Contains(code, StringComparison.OrdinalIgnoreCase) && !persisted.Contains(replacement, StringComparison.OrdinalIgnoreCase) && persisted.Contains("shortcode.locked"),
            "F33 secrets: codes never reach persisted state or audit; lockout is audited");
    }

    private static async Task IntegrationAsync(Action<bool, string> check, string directory)
    {
        await using var codeHost = await TestHost.StartAsync(Path.Combine(directory, "code-host"), shortCode: true);
        await using var viewerHost = await TestHost.StartAsync(Path.Combine(directory, "viewer-host"), shortCode: true);
        var codeStatus = await codeHost.Local.GetFromJsonAsync<JsonElement>("/api/status");
        var viewerStatus = await viewerHost.Local.GetFromJsonAsync<JsonElement>("/api/status");
        var hostPin = codeStatus.GetProperty("certificateFingerprint").GetString()!;
        var viewerPin = viewerStatus.GetProperty("certificateFingerprint").GetString()!;
        check(codeStatus.GetProperty("experimentalShortCode").GetBoolean(), "F33 flag on: local status advertises the experimental capability");
        var address = $"https://127.0.0.1:{codeHost.RemotePort}";

        using var strangerCertificate = ClientCertificate("CN=F33 stranger");
        using var otherCertificate = ClientCertificate("CN=F33 other");
        using var stranger = Remote(strangerCertificate, codeHost.RemotePort, out _);
        check((await stranger.GetAsync("/api/info")).StatusCode == HttpStatusCode.Unauthorized, "F33 flag on: unknown certificates are still refused on ordinary routes");
        check((await stranger.PostAsJsonAsync("/api/short-pair/START", new { })).StatusCode == HttpStatusCode.Unauthorized, "F33 flag on: only the exact bootstrap path spelling bypasses pinning");
        check((await stranger.GetAsync("/api/short-code")).StatusCode == HttpStatusCode.Unauthorized && (await stranger.GetAsync("/api/identity/export")).StatusCode == HttpStatusCode.Unauthorized,
            "F33 flag on: unknown certificates cannot reach local owner or admin routes");
        check((await stranger.PostAsync(ShortPairProtocol.StartPath, new StringContent(new string('x', 5000), Encoding.UTF8, "application/json"))).StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.RequestEntityTooLarge,
            "F33 flag on: bootstrap request bodies are bounded");
        check((await stranger.PostAsJsonAsync(ShortPairProtocol.StartPath, new { v = 1, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(new byte[32]), deviceName = "x" })).StatusCode == HttpStatusCode.Forbidden,
            "F33 flag on: bootstrap without an active code is refused");

        var created = await (await codeHost.Local.PostAsJsonAsync("/api/short-code", new { permissions = new { view = true, control = true } })).Content.ReadFromJsonAsync<JsonElement>();
        var code = created.GetProperty("code").GetString()!;
        var wrongResponse = await viewerHost.Local.PostAsJsonAsync("/api/short-code/pair", new { address, code = WrongCode(ShortCode.Normalize(code)!) });
        var wrongBody = await wrongResponse.Content.ReadAsStringAsync();
        check(wrongResponse.StatusCode == HttpStatusCode.Forbidden && JsonSerializer.Deserialize<JsonElement>(wrongBody).GetProperty("code").GetString() == "short_code_rejected"
            && !(await codeHost.Local.GetStringAsync("/api/peers")).Contains(viewerPin), $"F33 real TLS: a wrong code is rejected and nothing is pinned (got {(int)wrongResponse.StatusCode} {wrongBody})");

        // The host reads the viewer fingerprint from each TLS connection, not from JSON.
        using (var first = Remote(strangerCertificate, codeHost.RemotePort, out _))
        using (var second = Remote(otherCertificate, codeHost.RemotePort, out _))
        {
            var start = await (await first.PostAsJsonAsync(ShortPairProtocol.StartPath, new { v = 1, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(RandomNumberGenerator.GetBytes(32)), deviceName = "Switcher" })).Content.ReadFromJsonAsync<JsonElement>();
            var switched = await second.PostAsJsonAsync(ShortPairProtocol.VerifyPath, new { attemptId = start.GetProperty("attemptId").GetString(), a = ShortPairProtocol.Encode(new byte[384]), m1 = ShortPairProtocol.Encode(new byte[32]) });
            check(switched.StatusCode == HttpStatusCode.Forbidden, "F33 real TLS: another client certificate cannot continue an attempt");
        }
        using (var first = Remote(strangerCertificate, codeHost.RemotePort, out _))
        using (var sameCertificateNewSocket = Remote(strangerCertificate, codeHost.RemotePort, out _))
        {
            var start = await (await first.PostAsJsonAsync(ShortPairProtocol.StartPath, new { v = 1, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(RandomNumberGenerator.GetBytes(32)), deviceName = "Mover" })).Content.ReadFromJsonAsync<JsonElement>();
            var (a, m1) = Proof(start, ShortCode.Normalize(code)!);
            var moved = await sameCertificateNewSocket.PostAsJsonAsync(ShortPairProtocol.VerifyPath, new { attemptId = start.GetProperty("attemptId").GetString(), a, m1 });
            check(moved.StatusCode == HttpStatusCode.Forbidden, "F33 real TLS: a correct proof from the same certificate on a new socket cannot continue an unfinished attempt");
        }
        var downgrade = await stranger.PostAsJsonAsync(ShortPairProtocol.StartPath, new { v = 1, suite = "SRP6a-RFC5054-1024-SHA1/HMAC-SHA256", viewerNonce = ShortPairProtocol.Encode(new byte[32]), deviceName = "x" });
        check(downgrade.StatusCode == HttpStatusCode.BadRequest && (await downgrade.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "unsupported_suite",
            "F33 real TLS: a different suite is refused rather than negotiated down");
        var extra = await stranger.PostAsJsonAsync(ShortPairProtocol.StartPath, new { v = 1, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(new byte[32]), deviceName = "x", fingerprint = viewerPin });
        check(extra.StatusCode == HttpStatusCode.BadRequest, "F33 real TLS: unknown fields such as a claimed fingerprint are refused");

        var pairResponse = await viewerHost.Local.PostAsJsonAsync("/api/short-code/pair", new { address, code = code.ToLowerInvariant(), deviceName = "Viewer laptop" });
        var paired = await pairResponse.Content.ReadFromJsonAsync<JsonElement>();
        check(pairResponse.IsSuccessStatusCode && paired.GetProperty("certificateFingerprint").GetString() == hostPin && paired.GetProperty("address").GetString() == address
            && paired.GetProperty("permissions").GetProperty("control").GetBoolean() && paired.GetProperty("hostId").GetString() == codeStatus.GetProperty("hostId").GetString(),
            "F33 real TLS: the viewer's local host returns the host certificate proven inside the PAKE");
        var peers = await codeHost.Local.GetFromJsonAsync<JsonElement>("/api/peers");
        var peer = peers.EnumerateArray().SingleOrDefault(item => item.GetProperty("fingerprint").GetString() == viewerPin);
        check(peer.ValueKind == JsonValueKind.Object && peer.GetProperty("name").GetString() == "Viewer laptop" && peer.GetProperty("permissions").GetProperty("control").GetBoolean()
            && !peer.GetProperty("permissions").GetProperty("files").GetBoolean(), "F33 real TLS: the code host pins the viewer host's actual certificate with the code's grants");
        var exported = await viewerHost.Local.GetFromJsonAsync<JsonElement>("/api/identity/export");
        using (var pem = X509Certificate2.CreateFromPem(exported.GetProperty("certificatePem").GetString()!, exported.GetProperty("privateKeyPem").GetString()!))
        using (var viewerIdentity = X509CertificateLoader.LoadPkcs12(pem.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet))
        using (var pinned = Remote(viewerIdentity, codeHost.RemotePort, out var seen))
        {
            check((await pinned.GetAsync("/api/info")).IsSuccessStatusCode && seen() == hostPin, "F33 real TLS: the new pairing authorizes ordinary pinned access");
        }
        using (var viewerHostStranger = Remote(strangerCertificate, viewerHost.RemotePort, out _))
        {
            var disguised = await viewerHostStranger.PostAsJsonAsync(ShortPairProtocol.StartPath, new { v = 1, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(new byte[32]), deviceName = "invoice\u202Eexe" });
            check(disguised.StatusCode == HttpStatusCode.BadRequest, "F33 real TLS: a bidi-override device name is refused at start");
        }
        var reuse = await viewerHost.Local.PostAsJsonAsync("/api/short-code/pair", new { address, code });
        check(reuse.StatusCode == HttpStatusCode.Forbidden && (await reuse.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString() == "short_code_unavailable",
            "F33 real TLS: a used code cannot pair again");
        var badAddress = await viewerHost.Local.PostAsJsonAsync("/api/short-code/pair", new { address = "https://192.168.1.10:47832", code });
        check(badAddress.StatusCode == HttpStatusCode.BadRequest, "F33 client role: only the allowed network target is contacted");
        check((await stranger.PostAsJsonAsync("/api/short-code/pair", new { address, code })).StatusCode == HttpStatusCode.Unauthorized, "F33 client role: the remote listener cannot drive the local client role");
        var audit = await codeHost.Local.GetStringAsync("/api/audit") + await viewerHost.Local.GetStringAsync("/api/audit");
        check(!audit.Contains(ShortCode.Normalize(code)!, StringComparison.OrdinalIgnoreCase) && !audit.Contains(code, StringComparison.OrdinalIgnoreCase), "F33 secrets: the code is absent from both audits");

        // The long invite path is unchanged with the flag on.
        var inviteJson = await (await codeHost.Local.PostAsJsonAsync("/api/invites", new { permissions = new { view = true } })).Content.ReadFromJsonAsync<JsonElement>();
        var uri = inviteJson.GetProperty("inviteUri").GetString()!;
        var payload = uri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        var secret = JsonSerializer.Deserialize<JsonElement>(Convert.FromBase64String(payload.PadRight((payload.Length + 3) / 4 * 4, '='))).GetProperty("secret").GetString();
        check((await stranger.PostAsJsonAsync("/api/pair", new { secret, deviceName = "Long invite" })).IsSuccessStatusCode && (await stranger.GetAsync("/api/info")).IsSuccessStatusCode,
            "F33 flag on: the long invite path still pairs and authorizes");
    }

    /// <summary>Flag-off checks for the main integration host: nothing is mapped or advertised.</summary>
    public static async Task FlagOffAsync(Action<bool, string> check, HttpClient local, HttpClient paired, HttpClient unpaired)
    {
        var status = await local.GetFromJsonAsync<JsonElement>("/api/status");
        check(!status.TryGetProperty("experimentalShortCode", out _), "F33 flag off: status does not advertise short-code pairing");
        check((await local.GetAsync("/api/short-code")).StatusCode == HttpStatusCode.NotFound && (await local.PostAsJsonAsync("/api/short-code", new { permissions = new { view = true } })).StatusCode == HttpStatusCode.NotFound
            && (await local.PostAsJsonAsync("/api/short-code/pair", new { address = "https://127.0.0.1:1", code = "00000000" })).StatusCode == HttpStatusCode.NotFound,
            "F33 flag off: local short-code routes are absent");
        var start = new { v = 1, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(new byte[32]), deviceName = "x" };
        check((await unpaired.PostAsJsonAsync(ShortPairProtocol.StartPath, start)).StatusCode == HttpStatusCode.Unauthorized, "F33 flag off: unknown certificates get no bootstrap exemption");
        check((await paired.PostAsJsonAsync(ShortPairProtocol.StartPath, start)).StatusCode == HttpStatusCode.NotFound, "F33 flag off: remote bootstrap routes are absent");
    }

    /// <summary>An honest SRP client proof for a real-TLS start response.</summary>
    private static (string A, string M1) Proof(JsonElement start, string code)
    {
        var client = new Srp6Client();
        client.Init(ShortPairProtocol.Group, ShortPairProtocol.Digest(), new SecureRandom());
        var a = client.GenerateClientCredentials(ShortPairProtocol.Decode(start.GetProperty("salt").GetString(), 32)!, ShortPairProtocol.Identity(), Encoding.ASCII.GetBytes(code));
        client.CalculateSecret(new BigInteger(1, ShortPairProtocol.Decode(start.GetProperty("b").GetString(), 384)!));
        return (ShortPairProtocol.Encode(ShortPairProtocol.Unsigned(a, 384)), ShortPairProtocol.Encode(ShortPairProtocol.Unsigned(client.CalculateClientEvidenceMessage(), 32)));
    }
    private static string WrongCode(string code) => (code[0] == '0' ? "1" : "0") + code[1..];
    private static string RandomFingerprint() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private static bool Throws(Action action, string code)
    {
        try { action(); return false; } catch (ShortPairException ex) { return ex.Code == code; }
    }
    private static bool ThrowsExactly(Action action, Exception expected)
    {
        try { action(); return false; } catch (Exception ex) { return ReferenceEquals(ex, expected); }
    }
    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); return false; } catch (T) { return true; }
    }

    /// <summary>In-process SRP client role, used to drive the host state machine directly.</summary>
    private sealed class Viewer
    {
        private readonly ShortPairHost host;
        private readonly byte[] nonce = RandomNumberGenerator.GetBytes(32);
        private readonly ShortPairStartResponse start;
        private Srp6Client? client;
        public string Fingerprint { get; }
        /// <summary>Stands for the TLS connection the attempt started on.</summary>
        public string Connection { get; } = Guid.NewGuid().ToString("N");
        public string AttemptId => start.AttemptId;
        public byte[] A { get; private set; } = new byte[384];
        public byte[] M1 { get; private set; } = new byte[32];
        public byte[] M1Placeholder { get; } = new byte[32];
        public Viewer(ShortPairHost host, string fingerprint)
        {
            this.host = host; Fingerprint = fingerprint;
            start = host.Start(nonce, "Viewer", fingerprint, Connection);
        }
        public ShortPairVerifyResponse Verify(string code, string? connection = null)
        {
            client = new Srp6Client();
            client.Init(ShortPairProtocol.Group, ShortPairProtocol.Digest(), new SecureRandom());
            var a = client.GenerateClientCredentials(ShortPairProtocol.Decode(start.Salt, 32)!, ShortPairProtocol.Identity(), Encoding.ASCII.GetBytes(code));
            client.CalculateSecret(new BigInteger(1, ShortPairProtocol.Decode(start.B, 384)!));
            A = ShortPairProtocol.Unsigned(a, 384); M1 = ShortPairProtocol.Unsigned(client.CalculateClientEvidenceMessage(), 32);
            return host.Verify(start.AttemptId, A, M1, Fingerprint, connection ?? Connection);
        }
        public bool Finish(ShortPairVerifyResponse verify, string hostFingerprintSeen, out byte[] viewerConfirmation, string? viewerFingerprintSeen = null)
        {
            viewerConfirmation = new byte[32];
            if (client is null || !client.VerifyServerEvidenceMessage(new BigInteger(1, ShortPairProtocol.Decode(verify.M2, 32)!))) return false;
            var key = ShortPairProtocol.Unsigned(client.CalculateSessionKey(), 32);
            var transcript = ShortPairProtocol.Transcript(new(ShortPairProtocol.Decode(start.InstanceId, 16)!, ShortPairProtocol.Decode(start.AttemptId, 16)!, nonce,
                ShortPairProtocol.Decode(start.HostNonce, 32)!, start.ExpiresAt, start.Grants.ToPermissions(), ShortPairProtocol.Decode(start.Salt, 32)!, A,
                ShortPairProtocol.Decode(start.B, 384)!, ShortPairProtocol.FingerprintFromHex(hostFingerprintSeen), ShortPairProtocol.FingerprintFromHex(viewerFingerprintSeen ?? Fingerprint)));
            viewerConfirmation = ShortPairProtocol.Confirmation(key, hostToViewer: false, transcript);
            return CryptographicOperations.FixedTimeEquals(ShortPairProtocol.Confirmation(key, hostToViewer: true, transcript), ShortPairProtocol.Decode(verify.HostConfirmation, 32));
        }
    }

    private sealed class TestClock(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset now = now;
        public override DateTimeOffset GetUtcNow() => now;
        public void Advance(TimeSpan by) => now += by;
    }

    private static X509Certificate2 ClientCertificate(string subject)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new("1.3.6.1.5.5.7.3.2") }, false));
        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
        return X509CertificateLoader.LoadPkcs12(created.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
    }

    private static HttpClient Remote(X509Certificate2 certificate, int port, out Func<string?> seenFingerprint)
    {
        string? seen = null;
        var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, server, _, _) => { seen = server is null ? null : Security.Fingerprint(server); return server is not null; } };
        handler.ClientCertificates.Add(certificate);
        seenFingerprint = () => seen;
        return new HttpClient(handler) { BaseAddress = new Uri($"https://127.0.0.1:{port}"), Timeout = TimeSpan.FromSeconds(30) };
    }

    private sealed class TestHost : IAsyncDisposable
    {
        private readonly Process process;
        private readonly Task<string> output, error;
        public HttpClient Local { get; }
        public int RemotePort { get; }
        private TestHost(Process process, HttpClient local, int remotePort)
        {
            this.process = process; Local = local; RemotePort = remotePort;
            output = process.StandardOutput.ReadToEndAsync(); error = process.StandardError.ReadToEndAsync();
        }
        public static async Task<TestHost> StartAsync(string directory, bool shortCode)
        {
            var token = Security.RandomToken();
            var localPort = FreePort(); var remotePort = FreePort();
            while (remotePort == localPort) remotePort = FreePort();
            var info = new ProcessStartInfo("dotnet") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            info.ArgumentList.Add(typeof(HostState).Assembly.Location); info.ArgumentList.Add("--loopback-test");
            info.Environment["ORBIT_CONTROL_TOKEN"] = token; info.Environment["ORBIT_DATA_DIR"] = directory;
            info.Environment["ORBIT_CONTROL_PORT"] = localPort.ToString(); info.Environment["ORBIT_REMOTE_PORT"] = remotePort.ToString();
            info.Environment["ORBIT_PARENT_PROOF"] = "0"; info.Environment["ORBIT_PARENT_WATCH"] = "1";
            if (shortCode) info.Environment[ShortPairEndpoints.EnvironmentFlag] = "1"; else info.Environment.Remove(ShortPairEndpoints.EnvironmentFlag);
            var process = Process.Start(info) ?? throw new InvalidOperationException("F33 test host did not start.");
            var local = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{localPort}"), Timeout = TimeSpan.FromSeconds(60) };
            local.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var host = new TestHost(process, local, remotePort);
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (process.HasExited) throw new InvalidOperationException("F33 test host exited early: " + await host.error);
                try { using var response = await local.GetAsync("/api/status"); if (response.IsSuccessStatusCode) return host; } catch (HttpRequestException) { }
                await Task.Delay(100);
            }
            await host.DisposeAsync();
            throw new InvalidOperationException("F33 test host did not become ready.");
        }
        public async ValueTask DisposeAsync()
        {
            Local.Dispose();
            if (!process.HasExited)
            {
                process.StandardInput.Close();
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                try { await process.WaitForExitAsync(timeout.Token); }
                catch (OperationCanceledException) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(); }
            }
            await output; await error;
            process.Dispose();
        }
        private static int FreePort() { var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start(); var port = ((IPEndPoint)listener.LocalEndpoint).Port; listener.Stop(); return port; }
    }
}
