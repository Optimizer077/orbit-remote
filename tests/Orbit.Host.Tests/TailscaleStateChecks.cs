using Orbit.Host;

// The renderer reads transport.state instead of matching TailscaleNetwork error text.
// Each discovery branch must set its stable state; malformed CLI output is "unknown", never "off".
public static class TailscaleStateChecks
{
    public static void Run(Action<bool, string> check)
    {
        const string executable = "/generated/tailscale";
        var notFound = TailscaleNetwork.NotFound();
        check(notFound.State == "not-found" && notFound.Mode == "offline" && notFound.Executable is null, "Missing Tailscale CLI reports state not-found");
        var unverified = TailscaleNetwork.Unverified(executable);
        check(unverified.State == "unknown" && unverified.Mode == "offline" && unverified.Error is not null, "Failed Tailscale status call reports state unknown");
        foreach (var backend in new[] { "Stopped", "NeedsLogin", "Starting" })
            check(TailscaleNetwork.FromStatusJson($$"""{"BackendState":"{{backend}}"}""", executable).State == "off", "Tailscale backend " + backend + " reports state off");
        check(TailscaleNetwork.FromStatusJson("""{"BackendState":"Running","Self":{"TailscaleIPs":["192.168.1.2","fd7a:115c:a1e0::1"]}}""", executable).State == "off", "Running Tailscale without a tailnet IPv4 reports state off");
        var connected = TailscaleNetwork.FromStatusJson("""{"BackendState":"Running","Self":{"DNSName":"generated-host.tailnet.ts.net.","TailscaleIPs":["100.100.1.2"]},"Peer":{"p1":{"HostName":"generated-peer","OS":"linux","Online":true,"TailscaleIPs":["100.100.1.3"]}}}""", executable);
        check(connected.State == "connected" && connected.Mode == "tailscale" && connected.Address == "100.100.1.2" && connected.Peers.Count == 1 && connected.Error is null, "Running Tailscale with a tailnet IPv4 reports state connected");
        foreach (var malformed in new[] { "not json", "{}", """{"BackendState":"Running"}""", """{"BackendState":"Running","Self":{"TailscaleIPs":"100.100.1.2"}}""", """{"BackendState":7}""" })
            check(TailscaleNetwork.FromStatusJson(malformed, executable).State == "unknown", "Malformed Tailscale status reports state unknown: " + malformed);
    }
}
