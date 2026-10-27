using System.Reflection;
using Orbit.Host;
using Orbit.Host.Platform;

public static class DiagnosticSourceChecks
{
    public static async Task RunAsync(Action<bool, string> check, string tempRoot)
    {
        var assembly = typeof(HostState).Assembly;
        var configuration = assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration;
        var source = assembly.GetType("Orbit.Host.DiagnosticSource");
        var backend = assembly.GetType("Orbit.Host.Platform.DiagnosticSyntheticBackend");
        check((source is not null && backend is not null) == (configuration == "Diagnostic"),
            $"Diagnostic source: actual {configuration} assembly contains selector/backend only in Diagnostic configuration");
        if (configuration != "Diagnostic")
        {
            check(source is null && backend is null && !assembly.GetTypes().Any(type => type.FullName?.Contains("DiagnosticSyntheticBackend", StringComparison.Ordinal) == true),
                "Diagnostic source: normal build excludes the generated backend and all its nested implementation types");
            return;
        }
        if (source is null || backend is null) return;
        var parsePattern = source.GetMethod("ParsePattern", BindingFlags.Static | BindingFlags.NonPublic)!;
        check((string)parsePattern.Invoke(null, [null])! == "low-entropy"
            && (string)parsePattern.Invoke(null, ["low-entropy"])! == "low-entropy"
            && (string)parsePattern.Invoke(null, ["high-entropy"])! == "high-entropy",
            "Diagnostic pattern: missing selects existing low mode and both exact names are accepted");
        foreach (var invalid in new[] { "", "High-Entropy", "high-entropy ", " low-entropy", "random", "1" })
            Reject(() => parsePattern.Invoke(null, [invalid]), "Diagnostic pattern: malformed selection is rejected: " + invalid);
        var parse = source.GetMethod("Parse", BindingFlags.Static | BindingFlags.NonPublic)!;
        var directory = Path.Combine(tempRoot, "generated-diagnostic-profile");
        object? Parse(string? enabled = "1", bool loopback = true, string? path = null, string? width = null, string? height = null) =>
            parse.Invoke(null, [enabled, loopback, path ?? directory, width, height]);
        Reject(() => Parse(enabled: null), "Diagnostic source: missing opt-in cannot start a real desktop host");
        Reject(() => Parse(enabled: ""), "Diagnostic source: empty opt-in cannot start a real desktop host");
        Reject(() => Parse(enabled: "true"), "Diagnostic source: malformed opt-in cannot silently choose a real desktop");
        Reject(() => Parse(loopback: false), "Diagnostic source: non-loopback activation is rejected");
        Reject(() => parse.Invoke(null, ["1", true, null, null, null]), "Diagnostic source: missing explicit profile is rejected");
        Reject(() => Parse(path: "relative-profile"), "Diagnostic source: relative profile is rejected");
        var defaults = Parse()!;
        check((int)defaults.GetType().GetProperty("Width")!.GetValue(defaults)! == 1920
            && (int)defaults.GetType().GetProperty("Height")!.GetValue(defaults)! == 1080,
            "Diagnostic source: fixed default workload is1920x1080");
        check(Parse(width: "320", height: "240") is not null && Parse(width: "3840", height: "2160") is not null,
            "Diagnostic source: both agreed even dimension boundaries are accepted");
        foreach (var width in new[] { "", "319", "321", "3842", "-320", "NaN", "1e3", " 320", "320 " })
            Reject(() => Parse(width: width), "Diagnostic source: invalid width rejected: " + width);
        foreach (var height in new[] { "239", "241", "2162", "0" })
            Reject(() => Parse(height: height), "Diagnostic source: invalid height rejected: " + height);

        var prepare = source.GetMethod("PrepareProfile", BindingFlags.Static | BindingFlags.NonPublic)!;
        var ordinary = Path.Combine(tempRoot, "existing-nondiagnostic-profile"); Directory.CreateDirectory(ordinary);
        await File.WriteAllTextAsync(Path.Combine(ordinary, "host.json"), "generated existing identity placeholder");
        Reject(() => prepare.Invoke(null, [ordinary]), "Diagnostic source: an unmarked existing identity directory is not reused");
        check(Directory.GetFiles(ordinary).Length == 1, "Diagnostic source: rejected identity directory is not modified");
        prepare.Invoke(null, [directory]);
        await File.WriteAllTextAsync(Path.Combine(directory, "host.json"), "generated diagnostic state placeholder");
        prepare.Invoke(null, [directory]);
        check(await File.ReadAllTextAsync(Path.Combine(directory, "host.json")) == "generated diagnostic state placeholder",
            "Diagnostic source: marked profile can restart without replacing its own state");

        var patternType = backend.GetNestedType("Pattern", BindingFlags.NonPublic)!;
        var pattern = Activator.CreateInstance(patternType, BindingFlags.Instance | BindingFlags.NonPublic, null, [320, 240], null)!;
        var explicitLow = Activator.CreateInstance(patternType, BindingFlags.Instance | BindingFlags.NonPublic, null, [320, 240, "low-entropy"], null)!;
        var next = patternType.GetMethod("Next", BindingFlags.Instance | BindingFlags.NonPublic)!;
        byte[]? previous = null; var changed = true; var bounded = true; var defaultEquivalent = true;
        for (long frame = 1; frame <= 32; frame++)
        {
            var generated = (byte[])next.Invoke(pattern, [frame])!;
            bounded &= generated.Length == 320 * 240 * 4 && Enumerable.Range(0, 320 * 240).All(pixel => generated[pixel * 4 + 3] == 255);
            changed &= previous is null || !previous.SequenceEqual(generated);
            defaultEquivalent &= generated.SequenceEqual((byte[])next.Invoke(explicitLow, [frame])!);
            previous = generated.ToArray();
        }
        check(bounded && changed, "Diagnostic source: generated BGRA is bounded/opaque and changes every frame, including counter transitions");
        check(defaultEquivalent, "Diagnostic pattern: existing default and explicit low mode have identical generated bytes");
        var highA = Activator.CreateInstance(patternType, BindingFlags.Instance | BindingFlags.NonPublic, null, [320, 240, "high-entropy"], null)!;
        var highB = Activator.CreateInstance(patternType, BindingFlags.Instance | BindingFlags.NonPublic, null, [320, 240, "high-entropy"], null)!;
        var nextA = next.CreateDelegate<Func<long, byte[]>>(highA); var nextB = next.CreateDelegate<Func<long, byte[]>>(highB);
        byte[]? oldHigh = null; byte[]? reused = null;
        var deterministic = true; var opaque = true; var fullChange = true; var reuse = true; var blockChange = true;
        for (long frame = 1; frame <= 32; frame++)
        {
            var pixels = nextA(frame); deterministic &= pixels.SequenceEqual(nextB(frame));
            opaque &= pixels.Length == 320 * 240 * 4 && Enumerable.Range(0, 320 * 240).All(p => pixels[p * 4 + 3] == 255);
            reuse &= reused is null || ReferenceEquals(reused, pixels); reused = pixels;
            if (oldHigh is not null)
            {
                var changedPixels = 0;
                for (var p = 0; p < pixels.Length; p += 4)
                    if (pixels[p] != oldHigh[p] || pixels[p + 1] != oldHigh[p + 1] || pixels[p + 2] != oldHigh[p + 2]) changedPixels++;
                fullChange &= changedPixels == 320 * 240;
                for (var y = 0; y < 240; y += 16) for (var x = 0; x < 320; x += 16)
                {
                    var at = (y * 320 + x) * 4;
                    blockChange &= pixels[at] != oldHigh[at] || pixels[at + 1] != oldHigh[at + 1] || pixels[at + 2] != oldHigh[at + 2];
                }
            }
            oldHigh = pixels.ToArray();
        }
        check(deterministic && opaque, "Diagnostic high pattern: deterministic bounded BGRA with opaque alpha");
        check(fullChange && blockChange, "Diagnostic high pattern: every pixel and sampled16x16 macroblock changes across32 frames");
        check(reuse && reused!.Where((_, i) => i % 4 == 0).Distinct().Count() > 240,
            "Diagnostic high pattern: reuses one buffer and has broad spatial channel variation");
        for (long frame = 100; frame < 108; frame++) nextA(frame);
        var allocated = GC.GetAllocatedBytesForCurrentThread();
        for (long frame = 1000; frame < 1010; frame++) nextA(frame);
        check(GC.GetAllocatedBytesForCurrentThread() == allocated, "Diagnostic high pattern: warmed generation allocates no per-frame managed buffer");
        var disabled = (IPlatformBackend)Activator.CreateInstance(backend, BindingFlags.Instance | BindingFlags.NonPublic, null, [320, 240], null)!;
        await using (disabled)
        {
            await Disabled(() => disabled.ApplyInputAsync(new("key", Key: "KeyA", IsDown: true)), "input");
            await Disabled(() => disabled.ReadClipboardAsync(), "clipboard read");
            await Disabled(() => disabled.WriteClipboardAsync("generated"), "clipboard write");
            await Disabled(() => disabled.LockAsync(), "power");
        }

        void Reject(Action action, string message)
        {
            try { action(); check(false, message); }
            catch (TargetInvocationException ex) when (ex.InnerException is ArgumentException) { check(true, message); }
        }
        async Task Disabled(Func<Task> action, string name)
        {
            try { await action(); check(false, "Diagnostic source: " + name + " must be unavailable without OS action"); }
            catch (PlatformUnavailableException ex) { check(ex.Code == "diagnostic-view-only", "Diagnostic source: " + name + " is unavailable without OS action"); }
        }
    }

    public static async Task CaptureBusyAsync(Action<bool, string> check)
    {
        if (!OperatingSystem.IsWindows() || typeof(HostState).Assembly.GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration != "Diagnostic") return;
        var type = typeof(HostState).Assembly.GetType("Orbit.Host.Platform.DiagnosticSyntheticBackend")!;
        await using var backend = (IPlatformBackend)Activator.CreateInstance(type, BindingFlags.Instance | BindingFlags.NonPublic, null, [640, 360], null)!;
        var monitor = (await backend.GetStatusAsync()).Monitors.Single();
        using var encoder = ((IGpuVideoSource)backend).TryOpenEncoder(monitor, 640, 360, 60, 4_000_000)
            ?? throw new InvalidOperationException("Generated pressure fixture requires its real GPU encoder.");
        var frames = type.GetField("frames", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(backend)!;
        var entries = (System.Collections.IDictionary)frames.GetType().GetField("entries", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(frames)!;
        var entry = entries.Values.Cast<object>().Single();
        var wrapper = entry.GetType().GetField("nativeCapture", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(entry)!;
        var capture = (GpuMonitorCapture)wrapper.GetType().GetField("capture", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(wrapper)!;
        long Generated() => (long)type.GetProperty("GeneratedFrames", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(backend)!;
        var holds = new List<GpuFrameLease>(); var version = -1L;
        try
        {
            var deadline = Environment.TickCount64 + 2000;
            while (holds.Count < GpuMonitorCapture.MaximumSlots && Environment.TickCount64 < deadline)
            {
                var lease = capture.Latest();
                if (lease is not null && lease.Version != version) { version = lease.Version; holds.Add(lease); }
                else lease?.Dispose();
                await Task.Delay(2);
            }
            var stalled = Generated(); await Task.Delay(150);
            check(holds.Count == GpuMonitorCapture.MaximumSlots && Generated() == stalled,
                "Diagnostic source: all ten generated GPU slots can be held without publishing another image");
            foreach (var hold in holds) hold.Dispose(); holds.Clear();
            deadline = Environment.TickCount64 + 700;
            while (Generated() == stalled && Environment.TickCount64 < deadline) await Task.Delay(5);
            check(Generated() > stalled && (long)type.GetProperty("ProducerOpens", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(backend)! == 1,
                "Diagnostic source: capture-busy skips frames and resumes the same producer without a ten-second failure cooldown");
        }
        finally { foreach (var hold in holds) hold.Dispose(); }
    }
}
