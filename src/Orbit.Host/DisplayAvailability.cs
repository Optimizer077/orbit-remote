using Orbit.Host.Platform;

namespace Orbit.Host;

internal static class DisplayAvailability
{
    internal const string AsleepCode = "display_asleep";
    internal const string AsleepMessage = "The remote display is asleep.";
    internal static bool CanWake(IPlatformBackend platform) => platform is IDisplayAvailability { CanWakeDisplay: true };
    internal static string State(IPlatformBackend platform) => platform is IDisplayAvailability display
        && display.DisplayState is "on" or "off" or "dimmed" ? display.DisplayState : "unknown";

    // This is queried only after a capture has failed or returned no frame.
    // A lock/secure-desktop failure must keep its truthful unavailable state.
    internal static async Task<bool> IsAsleepAsync(IPlatformBackend platform, CancellationToken token)
    {
        if (State(platform) != "off") return false;
        try
        {
            var status = await platform.GetStatusAsync(token);
            return status.SessionState == "interactive" && State(platform) == "off";
        }
        catch (PlatformUnavailableException) { return false; }
    }

    internal static bool IsCaptureFailure(PlatformUnavailableException failure) => failure.Code is
        "capture-failed" or "capture-unavailable" or "capture-lost" or "capture-reset";

    internal static IResult AsleepResult() => Results.Json(new
    { error = AsleepMessage, code = AsleepCode, displayState = "off" }, statusCode: 409);
}
