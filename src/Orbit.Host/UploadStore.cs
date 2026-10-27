namespace Orbit.Host;

internal sealed class UploadStore(HostState state, IUploadMetadata metadata, Action? cleanupWarning = null)
{
    private int warnedCleanup;
    internal const string StagingPrefix = ".orbit-upload-";
    private const string StagingSuffix = ".tmp";
    internal static bool IsReservedName(string name) => name.StartsWith(StagingPrefix, StringComparison.OrdinalIgnoreCase);
    internal static bool IsOwnedStageName(string name) => name.Length == StagingPrefix.Length + 32 + StagingSuffix.Length &&
        name.StartsWith(StagingPrefix, StringComparison.Ordinal) && name.EndsWith(StagingSuffix, StringComparison.Ordinal) &&
        name.AsSpan(StagingPrefix.Length, 32).IndexOfAnyExcept("0123456789abcdef") < 0;

    internal async Task<long> ReceiveAsync(string name, Stream body, long maximumBytes,
        Func<bool> authorized, CancellationToken cancellationToken)
    {
        var destination = state.GetSafeFilePath(name);
        if (File.Exists(destination) || Directory.Exists(destination)) throw Exists();
        var staging = Path.Combine(Path.GetDirectoryName(destination)!, StagingPrefix + Guid.NewGuid().ToString("N") + StagingSuffix);
        var created = false;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!authorized()) throw new UnauthorizedAccessException();
            var options = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, BufferSize = 65536, Options = FileOptions.Asynchronous };
            if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            long total = 0;
            await using (var output = new FileStream(staging, options))
            {
                created = true;
                Security.RestrictFile(staging);
                if (OperatingSystem.IsWindows()) File.SetAttributes(staging, File.GetAttributes(staging) | FileAttributes.Hidden);
                var buffer = new byte[65536]; int read;
                while ((read = await body.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total += read;
                    if (total > maximumBytes) throw new BadHttpRequestException("File too large.", 413);
                    if (!authorized()) throw new UnauthorizedAccessException();
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                await output.FlushAsync(cancellationToken);
                output.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            if (!authorized()) throw new UnauthorizedAccessException();
            metadata.MarkAndVerify(staging);
            cancellationToken.ThrowIfCancellationRequested();
            if (OperatingSystem.IsWindows()) File.SetAttributes(staging, File.GetAttributes(staging) & ~FileAttributes.Hidden);
            // Serialize the last authorization/policy/root check and publication
            // against owner block, revocation and local settings changes.
            state.PublishUpload(name, destination, staging, () =>
            {
                cancellationToken.ThrowIfCancellationRequested(); return authorized();
            });
            return total;
        }
        finally
        {
            if (created)
            {
                try { File.Delete(staging); } // Only this request's create-new path.
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // Preserve the upload's original failure. Startup can remove
                    // this still-private crash-style leftover after the age limit.
                    if (Interlocked.Exchange(ref warnedCleanup, 1) == 0)
                    { try { cleanupWarning?.Invoke(); } catch (Exception) { /* Logging must not replace the upload failure. */ } }
                }
            }
        }
    }

    internal int CleanupStale(DateTimeOffset now, Action? warning = null)
    {
        if (!state.Settings.FileTransferEnabled) return 0;
        var removed = 0;
        try
        {
            var folder = Path.GetDirectoryName(state.GetSafeFilePath("orbit-validation"))!;
            foreach (var path in Directory.EnumerateFiles(folder, StagingPrefix + "*" + StagingSuffix))
            {
                if (!IsOwnedStageName(Path.GetFileName(path))) continue;
                try
                {
                    var attributes = File.GetAttributes(path);
                    if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0 || File.GetLastWriteTimeUtc(path) >= now.UtcDateTime.AddHours(-1)) continue;
                    File.Delete(path); removed++;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { warning?.Invoke(); }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { warning?.Invoke(); }
        return removed;
    }

    internal static InvalidOperationException Exists() => new("That file exists. Choose another file name; remote uploads never overwrite files.");
}
