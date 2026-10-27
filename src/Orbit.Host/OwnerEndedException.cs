namespace Orbit.Host;

public sealed class OwnerEndedException() : UnauthorizedAccessException(UserMessage)
{
    public const string Code = "ended_by_owner";
    public const string UserMessage = "The owner ended this session. Ask them to allow you again.";
}
