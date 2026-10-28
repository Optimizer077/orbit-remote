using Orbit.Host;

/// <summary>H-4: audit append/rotation and the upload free-space floor.</summary>
internal static class ResourceLimitChecks
{
    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        AuditChecks(check, temporaryRoot);
        AuditFailureChecks(check, temporaryRoot);
        await UploadFloorChecks(check, temporaryRoot);
    }

    private static void AuditChecks(Action<bool, string> check, string root)
    {
        var directory = Path.Combine(root, "audit-append");
        var state = new HostState(directory);
        var path = Path.Combine(directory, "audit.jsonl");
        for (var index = 0; index < 600; index++) state.AddAudit("generated.event", null, "Generated event " + index + ".");
        // A rewrite of the bounded in-memory window would leave exactly 500 lines.
        check(File.ReadLines(path).Count() == 600 && state.Audit.Length == 500,
            "H-4 audit: events are appended to the file, not rewritten from the 500-entry window");

        var rotating = Path.Combine(root, "audit-rotate");
        state = new HostState(rotating) { AuditRotationLimit = 4096 };
        for (var index = 0; index < 400; index++) state.AddAudit("generated.event", null, "Generated event " + index + ".");
        var current = new FileInfo(Path.Combine(rotating, "audit.jsonl"));
        var previous = new FileInfo(Path.Combine(rotating, "audit.1.jsonl"));
        check(previous.Exists && current.Length <= 4096 && previous.Length <= 4096 && Directory.EnumerateFiles(rotating, "audit*").Count() == 2,
            "H-4 audit: the log rotates to one previous file and stays bounded on disk");
        var reloaded = new HostState(rotating);
        var expectedLines = File.ReadLines(previous.FullName).Count() + File.ReadLines(current.FullName).Count();
        check(reloaded.Audit[0].Detail == "Generated event 399." && reloaded.Audit.Length == expectedLines
            && reloaded.Audit.Select(entry => entry.Detail).SequenceEqual(Enumerable.Range(400 - expectedLines, expectedLines).Reverse().Select(index => "Generated event " + index + ".")),
            "H-4 audit: restart reloads the newest entries from both files in order");
    }

    private static void AuditFailureChecks(Action<bool, string> check, string root)
    {
        // A deleted audit.jsonl must not make rotation throw on every later event.
        var missing = Path.Combine(root, "audit-missing");
        var state = new HostState(missing);
        state.AddAudit("generated.event", null, "Generated event before deletion.");
        state.AuditRotationLimit = 1;
        File.Delete(Path.Combine(missing, "audit.jsonl"));
        var threw = false;
        try { state.AddAudit("generated.event", null, "Generated event after deletion."); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { threw = true; }
        check(!threw && File.ReadAllText(Path.Combine(missing, "audit.jsonl")).Contains("Generated event after deletion.", StringComparison.Ordinal)
            && !File.Exists(Path.Combine(missing, "audit.1.jsonl")),
            "Audit: a missing audit.jsonl is recreated instead of failing rotation");

        // A locked audit.1.jsonl delays rotation; it never fails an operation that already committed.
        var locked = Path.Combine(root, "audit-locked");
        state = new HostState(locked);
        var reports = new List<string>();
        state.AuditWriteFailed = reports.Add;
        var peer = Pair(state, "generated-audit-locked");
        state.AuditRotationLimit = 1;
        var previous = Path.Combine(locked, "audit.1.jsonl");
        File.WriteAllText(previous, "");
        RemoteSession? session = null;
        threw = false;
        using (new FileStream(previous, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            try
            {
                session = state.StartSession(peer, null, viewOnly: true);
                for (var index = 0; index < 5; index++) state.AddAudit("generated.event", null, "Generated locked event " + index + ".");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { threw = true; }
            check(!threw && session is not null && state.GetSession(session.Id, peer.Id) is not null,
                "Audit: a committed session start succeeds while audit.1.jsonl is locked");
            check(File.ReadAllText(Path.Combine(locked, "audit.jsonl")).Contains("Generated locked event 4.", StringComparison.Ordinal),
                "Audit: events keep being appended while rotation is blocked");
            if (OperatingSystem.IsWindows())
                check(reports.Count == 1 && reports[0].Contains("rotate", StringComparison.Ordinal),
                    "Audit: a blocked rotation is reported locally, at most once a minute");
        }
        state.AddAudit("generated.event", null, "Generated event after unlock.");
        check(File.ReadAllText(previous).Contains("Generated locked event 4.", StringComparison.Ordinal)
            && File.ReadAllText(Path.Combine(locked, "audit.jsonl")).Contains("Generated event after unlock.", StringComparison.Ordinal),
            "Audit: rotation resumes once the previous file is released");
    }

    private static PairedDevice Pair(HostState state, string name)
    {
        var invitation = state.CreateInvite(new(name, new(View: true)), "https://127.0.0.1:1", "generated");
        var encoded = invitation.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
        using var payload = System.Text.Json.JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
        return state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, name), name);
    }

    private static async Task UploadFloorChecks(Action<bool, string> check, string root)
    {
        var folder = Path.Combine(root, "upload-floor"); Directory.CreateDirectory(folder);
        var state = new HostState(Path.Combine(root, "upload-floor-state"));
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        const long limit = 1024;
        var free = UploadStore.MinimumFreeBytes + limit - 1;
        var store = new UploadStore(state, new NoMetadata(), availableBytes: _ => free);
        string? refused = null;
        try { await store.ReceiveAsync("generated-low.bin", new MemoryStream([1, 2, 3]), limit, () => true, default); }
        catch (InvalidOperationException ex) { refused = ex.Message; }
        check(refused == UploadStore.LowSpaceMessage && !Directory.EnumerateFileSystemEntries(folder).Any(),
            "H-4 upload: an upload that could cross the free-space floor is refused before any staging file is created");

        free = UploadStore.MinimumFreeBytes + limit + limit / 2;
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var first = store.ReceiveAsync("generated-first.bin", new HeldBody(gate.Task), limit, () => true, default);
        string? second = null;
        try { await store.ReceiveAsync("generated-second.bin", new MemoryStream([1]), limit, () => true, default); }
        catch (InvalidOperationException ex) { second = ex.Message; }
        gate.SetResult();
        var firstSize = await first;
        check(second == UploadStore.LowSpaceMessage && firstSize == 1 && File.Exists(Path.Combine(folder, "generated-first.bin")),
            "H-4 upload: in-flight uploads reserve their size limit, so parallel uploads cannot pass the floor together");
        check(await store.ReceiveAsync("generated-after.bin", new MemoryStream([1]), limit, () => true, default) == 1,
            "H-4 upload: a finished upload releases its reservation");
        check(UploadStore.AvailableBytes(folder) > 0, "H-4 upload: the native free-space query reads the transfer folder's volume");
    }

    private sealed class NoMetadata : IUploadMetadata { public void MarkAndVerify(string path) { } }

    /// <summary>A one-byte body that waits on a gate before returning it.</summary>
    private sealed class HeldBody(Task gate) : Stream
    {
        private bool done;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await gate.WaitAsync(cancellationToken);
            if (done) return 0;
            done = true; buffer.Span[0] = 7; return 1;
        }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
