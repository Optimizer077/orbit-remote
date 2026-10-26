namespace Orbit.Host;

/// <summary>A host stop invalidated an automatic reconnect; an explicit new connection is required.</summary>
public sealed class SessionEndedException : InvalidOperationException
{
    public SessionEndedException() : base("Session ended by host. Connect again explicitly.") { }
}
