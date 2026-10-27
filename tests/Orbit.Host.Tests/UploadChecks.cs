using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Orbit.Host;

internal static class UploadChecks
{
    internal static async Task RunAsync(Action<bool, string> check, string temporaryRoot)
    {
        var root = Path.Combine(temporaryRoot, "upload-checks"); Directory.CreateDirectory(root);
        MetadataChecks(check, root);
        CleanupChecks(check, root);
        await CleanupFailureAsync(check, root);
        await DownloadAllowsDeleteAsync(check, root);
        await VisibilityAsync(check, root);
        foreach (var mode in new[] { "success", "empty", "empty-revoked", "mark-failure", "marking-unavailable", "marking-revoked", "marking-disabled", "collision", "existing", "denied", "revoked", "blocked", "disabled", "destination", "canceled", "stopping", "too-large" })
            await RouteAsync(check, root, mode);
        await CanceledReadAsync(check, root);
    }

    private static void MetadataChecks(Action<bool, string> check, string root)
    {
        var path = Path.Combine(root, "metadata-generated.bin");
        var content = Encoding.ASCII.GetBytes("Generated upload fixture, no user data."); File.WriteAllBytes(path, content);
        if (OperatingSystem.IsWindows())
        {
            new UploadMetadata(UploadMetadataPlatform.Windows).MarkAndVerify(path);
            check(File.ReadAllText(path + ":Zone.Identifier") == UploadMetadata.WindowsZone, "Upload: native Windows Internet-zone ADS matches the fixed metadata exactly");
            check(File.ReadAllBytes(path).SequenceEqual(content), "Upload: native metadata leaves generated file content unchanged");
        }
        var linux = new UploadMetadata(UploadMetadataPlatform.Linux); linux.MarkAndVerify(path);
        check(File.ReadAllBytes(path).SequenceEqual(content), "Upload: Linux policy preserves the file without a quarantine claim");
        foreach (var failure in new Exception[] { new IOException("Generated unsupported volume."), new UnauthorizedAccessException(), new NotSupportedException() })
        {
            var windowsWarnings = 0;
            var windows = new UploadMetadata(UploadMetadataPlatform.Windows, windowsAttributes: new WindowsAttributes(failure), markingWarning: () => windowsWarnings++);
            var typed = 0;
            for (var index = 0; index < 2; index++)
                try { windows.MarkAndVerify(path); } catch (UploadMarkingException) { typed++; }
            check(typed == 2 && windowsWarnings == 1 && File.ReadAllBytes(path).SequenceEqual(content), "Upload: Windows marking failure stays fail-closed with one warning and a typed error: " + failure.GetType().Name);
        }
        var attributes = new MacAttributes();
        new UploadMetadata(UploadMetadataPlatform.Mac, macAttributes: attributes).MarkAndVerify(path);
        var value = Encoding.ASCII.GetString(attributes.Value!);
        check(attributes.Sets == 1 && attributes.Reads == 1 && value.StartsWith("0081;", StringComparison.Ordinal) && value.EndsWith(";Orbit Remote;", StringComparison.Ordinal), "Upload: macOS fixture writes fixed quarantine provenance and verifies readback");
        check(!value.Contains("http", StringComparison.OrdinalIgnoreCase) && !value.Contains(path, StringComparison.Ordinal), "Upload: quarantine metadata contains no URL or path");
        var warnings = 0;
        attributes = new() { SetError = UploadMetadata.MacNotSupported };
        var unsupported = new UploadMetadata(UploadMetadataPlatform.Mac, () => warnings++, attributes);
        unsupported.MarkAndVerify(path); unsupported.MarkAndVerify(path);
        check(warnings == 1 && attributes.Reads == 0 && File.Exists(path), "Upload: macOS ENOTSUP preserves the file and warns once");
        attributes = new() { ReadError = UploadMetadata.MacNotSupported };
        new UploadMetadata(UploadMetadataPlatform.Mac, () => warnings++, attributes).MarkAndVerify(path);
        check(warnings == 2 && attributes.Reads == 1, "Upload: macOS unsupported readback follows the explicit preserve-and-warn policy");
        foreach (var failure in new[] { "write", "read", "mismatch", "short", "oversize" })
        {
            attributes = new() { SetError = failure == "write" ? 13 : 0, ReadError = failure == "read" ? 5 : 0,
                Mismatch = failure == "mismatch", LengthAdjustment = failure == "short" ? -1 : failure == "oversize" ? 1 : 0 };
            var rejected = false;
            try { new UploadMetadata(UploadMetadataPlatform.Mac, macAttributes: attributes).MarkAndVerify(path); } catch (IOException) { rejected = true; }
            check(rejected && File.Exists(path), "Upload: macOS fixture metadata failure is refused: " + failure);
        }
    }

    private static void CleanupChecks(Action<bool, string> check, string root)
    {
        var folder = Path.Combine(root, "cleanup-folder"); Directory.CreateDirectory(folder);
        var state = new HostState(Path.Combine(root, "cleanup-state"));
        state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        var now = DateTimeOffset.UtcNow;
        string Create(string name, bool old)
        {
            var path = Path.Combine(folder, name); File.WriteAllText(path, "generated");
            File.SetLastWriteTimeUtc(path, now.UtcDateTime.AddHours(old ? -2 : 0)); return path;
        }
        var stale = Create(UploadStore.StagingPrefix + new string('a', 32) + ".tmp", true);
        var fresh = Create(UploadStore.StagingPrefix + new string('b', 32) + ".tmp", false);
        var ordinary = Create("ordinary.txt", true);
        var lookalike = Create(UploadStore.StagingPrefix + "user-document.tmp", true);
        var uppercase = Create(UploadStore.StagingPrefix + new string('E', 32) + ".tmp", true);
        var directory = Path.Combine(folder, UploadStore.StagingPrefix + new string('c', 32) + ".tmp"); Directory.CreateDirectory(directory);
        var count = new UploadStore(state, new Mark()).CleanupStale(now);
        check(count == 1 && !File.Exists(stale) && File.Exists(fresh), "Upload: startup removes only expired own-format staging files, preserving fresh stages");
        check(File.Exists(ordinary) && File.Exists(lookalike) && File.Exists(uppercase) && Directory.Exists(directory), "Upload: startup preserves ordinary files, malformed lookalikes and directories");
        var disabledStale = Create(UploadStore.StagingPrefix + new string('d', 32) + ".tmp", true);
        state.UpdateSettings(state.Settings with { FileTransferEnabled = false });
        check(new UploadStore(state, new Mark()).CleanupStale(now) == 0 && File.Exists(disabledStale), "Upload: disabled transfer policy performs no staging cleanup");
        foreach (var name in new[] { UploadStore.StagingPrefix + "anything", ".ORBIT-UPLOAD-hidden.tmp" })
        {
            var rejected = false;
            try { state.GetSafeFilePath(name); } catch (ArgumentException) { rejected = true; }
            check(rejected, "Upload: the staging namespace is reserved independent of case: " + name);
        }
        HostState.ValidateResolvedFileName("Normal.txt", "NORMAL.txt");
        foreach (var pair in new[] { ("ORBIT-~1.TMP", StagingName('e')), ("NORMAL~1.TXT", "Normal-long-name.txt"), ("normal.txt", ".ORBIT-UPLOAD-stage.tmp") })
        {
            var rejected = false;
            try { HostState.ValidateResolvedFileName(pair.Item1, pair.Item2); } catch (ArgumentException) { rejected = true; }
            check(rejected, "Upload: resolved aliases and reserved long names are rejected independently of spelling");
        }
    }

    private static string StagingName(char hex) => UploadStore.StagingPrefix + new string(hex, 32) + ".tmp";

    private static async Task CleanupFailureAsync(Action<bool, string> check, string root)
    {
        if (!OperatingSystem.IsWindows()) { Console.WriteLine("SKIP Upload cleanup sharing-denial fixture: Windows-only file sharing semantics."); return; }
        var folder = Path.Combine(root, "cleanup-failure"); Directory.CreateDirectory(folder);
        var state = new HostState(Path.Combine(root, "cleanup-failure-state")); state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        var held = new List<FileStream>(); var stages = new List<string>(); var warnings = 0;
        var original = new InvalidOperationException("Generated original marking failure.");
        var store = new UploadStore(state, new Mark(path => { stages.Add(path); held.Add(new(path, FileMode.Open, FileAccess.Read, FileShare.Read)); throw original; }),
            () => { warnings++; throw new IOException("Generated logger failure."); });
        try
        {
            for (var index = 0; index < 2; index++)
            {
                Exception? observed = null;
                try { await store.ReceiveAsync("generated-" + index + ".bin", new MemoryStream([1, 2]), 1024, () => true, default); }
                catch (Exception ex) { observed = ex; }
                check(ReferenceEquals(original, observed), "Upload: cleanup sharing denial and logging failure never replace the original upload error");
            }
            check(warnings == 1 && stages.All(File.Exists), "Upload: cleanup sharing failures emit one warning and leave only private staging names");
        }
        finally { foreach (var handle in held) handle.Dispose(); }
        foreach (var stage in stages) File.SetLastWriteTimeUtc(stage, DateTime.UtcNow.AddHours(-2));
        check(store.CleanupStale(DateTimeOffset.UtcNow) == 2 && !Directory.EnumerateFiles(folder).Any(), "Upload: a later startup sweep removes failed-delete leftovers after handles close");
    }

    private static async Task DownloadAllowsDeleteAsync(Action<bool, string> check, string root)
    {
        await using var fixture = await Fixture.CreateAsync(root, "download-share-fixture", new Mark());
        var path = Path.Combine(fixture.Folder, "generated.bin"); await File.WriteAllBytesAsync(path, new byte[131072]);
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build(); using var shutdown = new HostShutdown(app.Lifetime);
        Exception? deletionFailure = null;
        app.Use(async (context, next) =>
        {
            var original = context.Response.Body;
            context.Response.Body = new OnWrite(original, () => { try { File.Delete(path); } catch (Exception ex) { deletionFailure = ex; } });
            try { await next(context); } finally { context.Response.Body = original; }
        });
        app.MapDownload(fixture.State, (_, id) => fixture.State.GetSession(id, fixture.Peer.Id), 1024 * 1024, shutdown);
        await app.StartAsync();
        try
        {
            using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(3) };
            using var response = await client.GetAsync(fixture.Route("generated.bin"));
            check(response.IsSuccessStatusCode && (await response.Content.ReadAsByteArrayAsync()).Length == 131072 && deletionFailure is null && !File.Exists(path), "Upload: a production download handle allows deletion while the bounded response is still streaming");
        }
        finally { await app.StopAsync(); }
    }

    private static async Task VisibilityAsync(Action<bool, string> check, string root)
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string? stage = null;
        var mark = new Mark(path => { stage = path; entered.TrySetResult(); release.Task.WaitAsync(TimeSpan.FromSeconds(5)).GetAwaiter().GetResult(); });
        await using var fixture = await Fixture.CreateAsync(root, "visibility", mark);
        var upload = fixture.Client.PutAsync(fixture.Route("generated.bin"), new ByteArrayContent([1, 2, 3]));
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(3));
            check(stage is not null && File.Exists(stage) && !File.Exists(Path.Combine(fixture.Folder, "generated.bin")), "Upload: no final name exists while provenance marking is pending");
            // A real second request cannot discover/read/replace the staged body.
            var stagedName = Path.GetFileName(stage!);
            using var get = await fixture.Client.GetAsync(fixture.Route(stagedName));
            using var put = await fixture.Client.PutAsync(fixture.Route(stagedName), new ByteArrayContent([9]));
            var listing = await fixture.Client.GetFromJsonAsync<JsonElement>($"/api/sessions/{fixture.Session.Id}/files");
            check(get.StatusCode == HttpStatusCode.BadRequest && put.StatusCode == HttpStatusCode.BadRequest, "Upload: actual download/upload routes reject reserved staged names");
            check(listing.GetArrayLength() == 0, "Upload: the actual inventory route excludes pending staging files");
            if (OperatingSystem.IsWindows())
            {
                var shortPath = new StringBuilder(32768);
                var length = GetShortPathName(stage!, shortPath, (uint)shortPath.Capacity);
                var alias = length > 0 && length < shortPath.Capacity ? Path.GetFileName(shortPath.ToString()) : null;
                if (alias is null || string.Equals(alias, stagedName, StringComparison.OrdinalIgnoreCase))
                    Console.WriteLine("SKIP Upload 8.3 alias route check: this volume returned no distinct short filename.");
                else
                {
                    using var aliasGet = await fixture.Client.GetAsync(fixture.Route(alias));
                    using var aliasPut = await fixture.Client.PutAsync(fixture.Route(alias), new ByteArrayContent([9]));
                    check(aliasGet.StatusCode == HttpStatusCode.BadRequest && aliasPut.StatusCode == HttpStatusCode.BadRequest, "Upload: actual Windows 8.3 alias GET/PUT cannot reach a pending stage or report an overwrite conflict");
                    check(File.ReadAllBytes(stage!).SequenceEqual(new byte[] { 1, 2, 3 }), "Upload: rejected 8.3 alias requests leave staged bytes unchanged");
                }
            }
        }
        finally { release.TrySetResult(); }
        using var result = await upload;
        check(result.StatusCode == HttpStatusCode.Created && !File.Exists(stage) && File.ReadAllBytes(Path.Combine(fixture.Folder, "generated.bin")).SequenceEqual(new byte[] { 1, 2, 3 }), "Upload: successful marking publishes unchanged bytes and removes the staging name");
    }

    private static async Task RouteAsync(Action<bool, string> check, string root, string mode)
    {
        Fixture? fixture = null; string? staging = null;
        var markedClosed = false;
        var mark = new Mark(path =>
        {
            staging = path;
            var current = fixture ?? throw new InvalidOperationException("Fixture not initialized.");
            // FileShare.None succeeds only after the body writer closed.
            using (var exclusive = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) markedClosed = true;
            if (mode == "mark-failure") throw new IOException("Generated metadata failure.");
            if (mode == "marking-unavailable") throw new UploadMarkingException();
            if (mode == "marking-revoked") { current.State.Revoke(current.Peer.Id); throw new UploadMarkingException(); }
            if (mode == "marking-disabled") { current.State.UpdateSettings(current.State.Settings with { FileTransferEnabled = false }); throw new UploadMarkingException(); }
            if (mode == "collision") File.WriteAllText(Path.Combine(current.Folder, "generated.bin"), "existing");
            if (mode is "revoked" or "empty-revoked") current.State.Revoke(current.Peer.Id);
            if (mode == "blocked") current.State.BlockDevice(current.Peer.Id, out _);
            if (mode == "disabled") current.State.UpdateSettings(current.State.Settings with { FileTransferEnabled = false });
            if (mode == "destination")
            {
                var other = Path.Combine(root, "other-destination"); Directory.CreateDirectory(other);
                current.State.UpdateSettings(current.State.Settings with { FileTransferRoot = other });
            }
            if (mode == "canceled") current.RequestCancellation.Cancel();
            if (mode == "stopping") current.Lifetime.StopApplication();
            if (mode == "success" && OperatingSystem.IsWindows()) new UploadMetadata(UploadMetadataPlatform.Windows).MarkAndVerify(path);
        });
        await using var owned = fixture = await Fixture.CreateAsync(root, mode, mark);
        if (mode == "existing") File.WriteAllText(Path.Combine(fixture.Folder, "generated.bin"), "existing");
        if (mode == "denied") fixture.State.Revoke(fixture.Peer.Id);
        var bytes = mode is "empty" or "empty-revoked" ? Array.Empty<byte>() : mode == "too-large" ? new byte[1025] : new byte[] { 9, 8, 7, 6 };
        using var response = await fixture.Client.PutAsync(fixture.Route("generated.bin"), new ByteArrayContent(bytes));
        var final = Path.Combine(fixture.Folder, "generated.bin");
        var success = mode is "success" or "empty";
        check((response.StatusCode == HttpStatusCode.Created) == success, "Upload: actual route reports completion only after safe publication: " + mode);
        check(!Directory.EnumerateFiles(fixture.Folder).Any(path => UploadStore.IsReservedName(Path.GetFileName(path))), "Upload: request-owned staging file cleaned after " + mode);
        if (mode is "collision" or "existing") check(response.StatusCode == HttpStatusCode.Conflict && File.ReadAllText(final) == "existing", "Upload: a final-name collision preserves the existing file: " + mode);
        else check(File.Exists(final) == success, "Upload: no completed artifact is left on refusal: " + mode);
        if (success)
        {
            check(markedClosed && File.ReadAllBytes(final).SequenceEqual(bytes), "Upload: closed writer and unchanged content on success: " + mode);
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            check(json.RootElement.GetProperty("size").GetInt64() == bytes.Length && !File.GetAttributes(final).HasFlag(FileAttributes.Hidden), "Upload: completion reports exact size and published files are not hidden: " + mode);
            if (mode == "success" && OperatingSystem.IsWindows()) check(File.ReadAllText(final + ":Zone.Identifier") == UploadMetadata.WindowsZone, "Upload: native Windows ADS survives the atomic no-overwrite rename");
        }
        else if (mode is not ("too-large" or "existing" or "denied")) check(markedClosed && staging is not null, "Upload: final authority/policy/metadata refusal occurs after body close: " + mode);
        if (mode == "destination") check(!File.Exists(Path.Combine(root, "other-destination", "generated.bin")), "Upload: changing the local destination cannot redirect an in-flight upload");
        if (mode == "stopping") check(response.StatusCode == HttpStatusCode.ServiceUnavailable, "Upload: host stop cancels publication and returns the typed stop result");
        if (mode == "too-large") check(mark.Calls == 0, "Upload: oversized data never reaches metadata or publication");
        if (mode == "marking-unavailable")
        {
            using var error = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            check(response.StatusCode == HttpStatusCode.Conflict && error.RootElement.GetProperty("code").GetString() == UploadMarkingException.Code && error.RootElement.GetProperty("error").GetString() == UploadMarkingException.UserMessage, "Upload: unsupported Windows marking is an actionable typed refusal, never an opaque success or completed file");
        }
        if (mode is "marking-revoked" or "marking-disabled") check(response.StatusCode == (mode == "marking-revoked" ? HttpStatusCode.NotFound : HttpStatusCode.Forbidden), "Upload: current authority and local transfer policy win over a simultaneous marking failure: " + mode);
        if (mode is "existing" or "denied") check(mark.Calls == 0 && (mode != "denied" || response.StatusCode == HttpStatusCode.NotFound), "Upload: an initially denied/existing destination performs no metadata operation: " + mode);
    }

    private static async Task CanceledReadAsync(Action<bool, string> check, string root)
    {
        var folder = Path.Combine(root, "canceled-body"); Directory.CreateDirectory(folder);
        var state = new HostState(Path.Combine(root, "canceled-body-state")); state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
        using var cancel = new CancellationTokenSource(); var mark = new Mark();
        var canceled = false;
        try { await new UploadStore(state, mark).ReceiveAsync("generated.bin", new CanceledBody(cancel), 1024, () => true, cancel.Token); }
        catch (OperationCanceledException) { canceled = true; }
        check(canceled && mark.Calls == 0 && !Directory.EnumerateFiles(folder).Any(), "Upload: cancellation during the actual body read cleans staging and never marks or publishes");
    }

    private sealed class Fixture : IAsyncDisposable
    {
        internal required HostState State; internal required PairedDevice Peer; internal required RemoteSession Session;
        internal required string Folder; internal required WebApplication App; internal required HostShutdown Shutdown;
        internal required HttpClient Client; internal required CancellationTokenSource RequestCancellation;
        internal Microsoft.Extensions.Hosting.IHostApplicationLifetime Lifetime => App.Lifetime;
        internal string Route(string name) => $"/api/sessions/{Session.Id}/files/{Uri.EscapeDataString(name)}";
        internal static async Task<Fixture> CreateAsync(string root, string mode, IUploadMetadata metadata)
        {
            var state = new HostState(Path.Combine(root, mode + "-state"));
            var invitation = state.CreateInvite(new("Generated device", new(View: true, Files: true)), "https://127.0.0.1:1", "generated");
            var encoded = invitation.InviteUri["orbit://pair/".Length..].Replace('-', '+').Replace('_', '/');
            using var payload = JsonDocument.Parse(Convert.FromBase64String(encoded.PadRight((encoded.Length + 3) / 4 * 4, '=')));
            var peer = state.Pair(new(payload.RootElement.GetProperty("secret").GetString()!, "Generated device"), "generated-upload-pin");
            var session = state.StartSession(peer, null);
            var folder = Path.Combine(root, mode + "-folder"); Directory.CreateDirectory(folder);
            state.UpdateSettings(new(FileTransferEnabled: true, FileTransferRoot: folder));
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
            builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
            var app = builder.Build(); var shutdown = new HostShutdown(app.Lifetime); var cancel = new CancellationTokenSource();
            app.Use(async (context, next) =>
            {
                if (mode == "canceled") context.RequestAborted = cancel.Token;
                try { await next(context); }
                catch (ArgumentException) { context.Response.StatusCode = 400; }
                catch (UnauthorizedAccessException) { context.Response.StatusCode = 403; }
                catch (InvalidOperationException) { context.Response.StatusCode = 409; }
                catch (BadHttpRequestException) { context.Response.StatusCode = 413; }
                catch (OperationCanceledException) { context.Response.StatusCode = 499; }
                catch (IOException) { context.Response.StatusCode = 500; }
            });
            RemoteSession? Find(HttpContext _, string id) => state.GetSession(id, peer.Id) is { Permissions.Files: true } current ? current : null;
            app.MapList(state, Find); app.MapDownload(state, Find, 1024, shutdown);
            app.MapUpload(state, new UploadStore(state, metadata), Find, 1024, shutdown);
            await app.StartAsync();
            return new() { State = state, Peer = peer, Session = session, Folder = folder, App = app, Shutdown = shutdown,
                Client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(6) }, RequestCancellation = cancel };
        }
        public async ValueTask DisposeAsync()
        { Client.Dispose(); await App.StopAsync(); Shutdown.Dispose(); await App.DisposeAsync(); RequestCancellation.Dispose(); }
    }

    private sealed class Mark(Action<string>? action = null) : IUploadMetadata
    {
        internal int Calls;
        public void MarkAndVerify(string path) { Calls++; action?.Invoke(path); }
    }
    private sealed class MacAttributes : IMacUploadAttributes
    {
        internal int SetError, ReadError, Sets, Reads, LengthAdjustment; internal bool Mismatch; internal byte[]? Value;
        public int Set(string path, byte[] value) { Sets++; Value = value.ToArray(); return SetError; }
        public (long Length, int Error) Read(string path, byte[] value)
        { Reads++; Value!.CopyTo(value, 0); if (Mismatch) value[0] ^= 1; return (Value.Length + LengthAdjustment, ReadError); }
    }
    private sealed class WindowsAttributes(Exception failure) : IWindowsUploadAttributes
    {
        public void WriteAndVerify(string path, byte[] expected) => throw failure;
    }
    [DllImport("kernel32.dll", EntryPoint = "GetShortPathNameW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathName(string path, StringBuilder buffer, uint length);
    private sealed class OnWrite(Stream inner, Action action) : Stream
    {
        private bool called;
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default)
        { await inner.WriteAsync(buffer, token); if (!called) { called = true; action(); } }
        public override bool CanRead => false; public override bool CanSeek => false; public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => inner.Flush(); public override Task FlushAsync(CancellationToken token) => inner.FlushAsync(token);
        public override void Write(byte[] buffer, int offset, int count) { inner.Write(buffer, offset, count); if (!called) { called = true; action(); } }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException();
    }
    private sealed class CanceledBody(CancellationTokenSource cancel) : MemoryStream(new byte[64])
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        { cancel.Cancel(); return ValueTask.FromCanceled<int>(cancel.Token); }
    }
}
