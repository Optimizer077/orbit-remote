using System.Diagnostics;
using System.Net;
using System.Text.Json;

namespace Orbit.Host;

public sealed record TailnetPeer(string Id, string HostName, string? DnsName, string? OperatingSystem, bool Online, string[] Addresses);
public sealed record TailscaleNetwork(string Mode, string? Address, string? NodeName, string? Error, IReadOnlyList<TailnetPeer> Peers, string? Executable)
{
    public static async Task<TailscaleNetwork> DiscoverAsync(bool loopbackTest, CancellationToken cancellationToken = default)
    {
        if (loopbackTest) return new("loopback-test", "127.0.0.1", "Local integration test", null, [], null);
        var executable = FindExecutable();
        if (executable is null) return new("offline", null, null, "Tailscale CLI was not found. Remote listening is disabled.", [], null);
        try
        {
            using var document = JsonDocument.Parse(await RunAsync(executable, ["status", "--json"], cancellationToken));
            var root = document.RootElement;
            if (root.GetProperty("BackendState").GetString() != "Running") return new("offline", null, null, "Tailscale is not running or signed in. Remote listening is disabled.", [], executable);
            var self = root.GetProperty("Self");
            var ip = self.GetProperty("TailscaleIPs").EnumerateArray().Select(x => x.GetString()).FirstOrDefault(x => IPAddress.TryParse(x, out var parsed) && parsed.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && Security.IsTailscaleAddress(parsed));
            if (ip is null) return new("offline", null, null, "No valid Tailscale IPv4 address. Remote listening is disabled.", [], executable);
            var peers = new List<TailnetPeer>();
            if (root.TryGetProperty("Peer", out var peerRoot) && peerRoot.ValueKind == JsonValueKind.Object)
                foreach (var entry in peerRoot.EnumerateObject())
                {
                    var peer = entry.Value;
                    peers.Add(new(entry.Name, String(peer, "HostName") ?? "Unknown device", String(peer, "DNSName"), String(peer, "OS"), peer.TryGetProperty("Online", out var online) && online.ValueKind == JsonValueKind.True, peer.TryGetProperty("TailscaleIPs", out var addresses) ? addresses.EnumerateArray().Select(x => x.GetString() ?? "").ToArray() : []));
                }
            return new("tailscale", ip, String(self, "DNSName") ?? String(self, "HostName"), null, peers, executable);
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or JsonException or System.ComponentModel.Win32Exception or OperationCanceledException)
        { return new("offline", null, null, "Could not verify Tailscale status. Remote listening is disabled.", [], executable); }
    }

    public async Task<bool> VerifyRemoteAsync(IPAddress? remoteAddress, CancellationToken cancellationToken)
    {
        if (remoteAddress is null) return false;
        if (Mode == "loopback-test") return IPAddress.IsLoopback(remoteAddress);
        if (!Security.IsTailscaleAddress(remoteAddress) || Executable is null) return false;
        try
        {
            using var json = JsonDocument.Parse(await RunAsync(Executable, ["whois", "--json", remoteAddress.ToString()], cancellationToken));
            return json.RootElement.TryGetProperty("Node", out var node) && node.ValueKind == JsonValueKind.Object && node.TryGetProperty("ID", out var id) && id.GetRawText() is not "0" and not "null";
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or JsonException or System.ComponentModel.Win32Exception or OperationCanceledException) { return false; }
    }

    private static string? String(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
    private static string? FindExecutable()
    {
        var paths = (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Select(p => Path.Combine(p, OperatingSystem.IsWindows() ? "tailscale.exe" : "tailscale")).ToList();
        if (OperatingSystem.IsWindows()) paths.Insert(0, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", "tailscale.exe"));
        else paths.AddRange(["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
        return paths.FirstOrDefault(File.Exists);
    }
    private static async Task<string> RunAsync(string executable, string[] arguments, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken); timeout.CancelAfter(TimeSpan.FromSeconds(4));
        var info = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new InvalidOperationException("Tailscale CLI did not start.");
        try
        {
            var outputTask = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            var output = await outputTask; await errorTask;
            if (process.ExitCode != 0 || output.Length > 4 * 1024 * 1024) throw new InvalidOperationException("Tailscale identity lookup failed.");
            return output;
        }
        finally { if (!process.HasExited) process.Kill(entireProcessTree: true); }
    }
}
