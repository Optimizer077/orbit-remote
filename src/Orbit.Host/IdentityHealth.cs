using System.Security.Cryptography.X509Certificates;

namespace Orbit.Host;

public sealed record IdentityHealth(DateTimeOffset ExpiresAt, int DaysRemaining, bool Warning, bool Expired)
{
    public static IdentityHealth FromCertificate(X509Certificate2 certificate, DateTimeOffset? now = null)
    {
        var expires = new DateTimeOffset(certificate.NotAfter.ToUniversalTime());
        var remaining = expires - (now ?? DateTimeOffset.UtcNow);
        return new(expires, Math.Max(0, (int)Math.Ceiling(remaining.TotalDays)), remaining <= TimeSpan.FromDays(30), remaining <= TimeSpan.Zero);
    }
}

public sealed record IdentityRotationRequest(bool ConfirmRePair, string? ExpectedFingerprint);
