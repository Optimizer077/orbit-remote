using System.Diagnostics;

namespace Orbit.Host;

public static class PowerActions
{
    public static async Task RequestRestartAsync(CancellationToken cancellationToken)
    {
        // Fixed OS executables and fixed arguments only. No shell or caller-provided command.
        var path = OperatingSystem.IsWindows() ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "shutdown.exe") : OperatingSystem.IsMacOS() ? "/sbin/shutdown" : "/usr/bin/systemctl";
        if (!File.Exists(path)) throw new InvalidOperationException("The operating system restart command is unavailable.");
        var info = new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        var arguments = OperatingSystem.IsWindows() ? new[] { "/r", "/t", "15", "/d", "p:4:1" } : OperatingSystem.IsMacOS() ? ["-r", "+1"] : ["reboot", "--no-ask-password"];
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("The restart command could not be started.");
        var output = process.StandardOutput.ReadToEndAsync(cancellationToken);
        var error = process.StandardError.ReadToEndAsync(cancellationToken);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(TimeSpan.FromSeconds(5));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new InvalidOperationException("The operating system did not confirm the restart command. Check the remote computer locally.");
        }
        await output; await error;
        if (process.ExitCode != 0) throw new InvalidOperationException("The operating system rejected the restart command. The current account may lack permission; no privilege elevation was attempted.");
    }
}
