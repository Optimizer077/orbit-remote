using System.Diagnostics;
using System.Text;

namespace Orbit.Host.Platform;

/// <summary>Runs only fixed OS utility paths with separate arguments, bounded output and a deadline.</summary>
internal static class NativeProcess
{
    public static string? Find(params string[] paths) => paths.FirstOrDefault(File.Exists);

    public static async Task<byte[]> RunAsync(string executable, IEnumerable<string> arguments,
        CancellationToken cancellationToken, int maximumOutput = PlatformLimits.MaximumFrameBytes,
        string? input = null, int timeoutSeconds = 12)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromSeconds(timeoutSeconds));
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = new Process { StartInfo = start };
        try
        {
            if (!process.Start()) throw new PlatformUnavailableException("tool-failed", "The desktop utility could not start.");
            var output = ReadBoundedAsync(process.StandardOutput.BaseStream, maximumOutput, deadline.Token);
            var errors = ReadBoundedAsync(process.StandardError.BaseStream, 16_384, deadline.Token);
            var write = WriteInputAsync(process, input, deadline.Token);
            // Observe both readers even on cancellation or an oversized output; neither pipe may block the utility.
            await Task.WhenAll(output, errors, write, process.WaitForExitAsync(deadline.Token));
            var bytes = await output;
            var error = await errors;
            if (process.ExitCode != 0) throw new PlatformUnavailableException("tool-failed",
                $"{Path.GetFileName(executable)} failed (exit {process.ExitCode}): {Encoding.UTF8.GetString(error).Trim()}");
            return bytes;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new PlatformUnavailableException("tool-timeout", "The desktop utility did not respond within its deadline."); }
        finally
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
        }
    }

    private static async Task WriteInputAsync(Process process, string? input, CancellationToken cancellationToken)
    {
        try { if (input is not null) await process.StandardInput.WriteAsync(input.AsMemory(), cancellationToken); }
        finally { process.StandardInput.Close(); }
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream stream, int maximum, CancellationToken cancellationToken)
    {
        using var data = new MemoryStream();
        var buffer = new byte[16_384];
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0) return data.ToArray();
            if (data.Length + read > maximum) throw new PlatformUnavailableException("tool-output-too-large", "Desktop utility output exceeded its limit.");
            data.Write(buffer, 0, read);
        }
    }
}
