using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>Bounds held input even if a key-up packet is lost while frames keep polling.</summary>
public sealed class InputLeases
{
    private readonly object gate = new();
    private readonly Dictionary<string, Dictionary<string, DateTimeOffset>> held = [];
    public static readonly TimeSpan MaximumHold = TimeSpan.FromSeconds(10);

    public void Record(string sessionId, RemoteInput input, DateTimeOffset now)
    {
        var token = input.Kind switch { "key" => "key:" + input.Key, "pointerButton" => "button:" + input.Button, _ => null };
        if (token is null || input.IsDown is null) return;
        lock (gate)
        {
            if (!held.TryGetValue(sessionId, out var inputs)) held[sessionId] = inputs = [];
            if (input.IsDown.Value) inputs[token] = now; else inputs.Remove(token);
            if (inputs.Count == 0) held.Remove(sessionId);
        }
    }
    public bool HasExpired(DateTimeOffset now) { lock (gate) return held.Values.Any(inputs => inputs.Values.Any(at => now - at > MaximumHold)); }
    public void Clear() { lock (gate) held.Clear(); }
}
