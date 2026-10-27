using Microsoft.AspNetCore.Http;

namespace Orbit.Host;

internal static class RequestBodyPolicy
{
    internal const long OrdinaryMaximumBytes = 16384;

    internal static long LimitFor(string method, PathString path, long uploadMaximumBytes)
    {
        if (!HttpMethods.IsPut(method)) return OrdinaryMaximumBytes;
        var parts = (path.Value ?? "").Split('/');
        return parts.Length == 6 && parts[0].Length == 0
            && parts[1].Equals("api", StringComparison.OrdinalIgnoreCase)
            && parts[2].Equals("sessions", StringComparison.OrdinalIgnoreCase)
            && parts[3].Length > 0
            && parts[4].Equals("files", StringComparison.OrdinalIgnoreCase)
            && parts[5].Length > 0 ? uploadMaximumBytes : OrdinaryMaximumBytes;
    }
}
