using System.Net;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto;
using Org.BouncyCastle.Crypto.Agreement.Srp;
using Org.BouncyCastle.Security;
using BigInteger = Org.BouncyCastle.Math.BigInteger;

namespace Orbit.Host;

internal sealed class ShortPairClientException(int status, string code, string message) : Exception(message)
{
    internal int Status { get; } = status;
    internal string Code { get; } = code;
}

internal sealed record ShortPairClientRequest(string? Address, string? Code, string? DeviceName);
internal sealed record ShortPairClientResult(string HostId, string HostName, string DeviceId, string DeviceName, ShortPairGrants Permissions, string CertificateFingerprint, string Address);

/// <summary>
/// EXPERIMENTAL (F33, disabled by default): the SRP client role. The viewer's
/// Electron main asks its own local host to run this toward a remote host. The
/// remote certificate is accepted only for this bootstrap exchange and is
/// returned for pinning only after both confirmations verify. One attempt uses
/// exactly one TLS connection: a second connection aborts the attempt.
/// </summary>
internal static class ShortPairClient
{
    private const int MaximumResponseBytes = 16384;

    internal static IPEndPoint ParseAddress(string? address, bool loopbackTest)
    {
        if (address is null || address.Length > 128 || !Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            uri.HostNameType is not (UriHostNameType.IPv4 or UriHostNameType.IPv6) || uri.UserInfo.Length > 0 || uri.PathAndQuery != "/" || uri.Fragment.Length > 0 ||
            !IPAddress.TryParse(uri.DnsSafeHost, out var ip) || uri.Port is < 1024 or > 65535)
            throw new ShortPairClientException(400, "invalid_address", "Use the remote host's https://<Tailscale address>:<port> origin.");
        if (loopbackTest ? !IPAddress.IsLoopback(ip) : !Security.IsTailscaleAddress(ip))
            throw new ShortPairClientException(400, "invalid_address", "Short-code pairing only connects to a Tailscale address.");
        return new IPEndPoint(ip, uri.Port);
    }

    internal static async Task<ShortPairClientResult> PairAsync(IPEndPoint endpoint, string canonicalCode, X509Certificate2 clientCertificate, string deviceName, CancellationToken cancellationToken)
    {
        string? observed = null;
        var connections = 0;
        var viewerFingerprint = Security.Fingerprint(clientCertificate);
        using var handler = new SocketsHttpHandler
        {
            UseProxy = false, AllowAutoRedirect = false, UseCookies = false, MaxConnectionsPerServer = 1,
            ConnectTimeout = TimeSpan.FromSeconds(10), MaxResponseHeadersLength = 16,
            ConnectCallback = async (_, token) =>
            {
                // One unfinished attempt, one connection: never reconnect (the host would
                // refuse it anyway). Start a new attempt instead.
                if (Interlocked.Increment(ref connections) > 1) throw new AuthenticationException("The pairing connection closed; start a new attempt.");
                // Always the validated endpoint; the request URI cannot redirect the socket.
                var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
                SslStream? ssl = null;
                try
                {
                    await socket.ConnectAsync(endpoint, token);
                    ssl = new SslStream(new NetworkStream(socket, ownsSocket: true), leaveInnerStreamOpen: false);
                    await ssl.AuthenticateAsClientAsync(new SslClientAuthenticationOptions
                    {
                        TargetHost = endpoint.Address.ToString(),
                        EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                        CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                        LocalCertificateSelectionCallback = (_, _, _, _, _) => clientCertificate,
                        // Bootstrap only: this certificate is authenticated by the PAKE
                        // transcript below and is never trusted for any other request.
                        RemoteCertificateValidationCallback = (_, certificate, _, _) => certificate is not null,
                    }, token);
                    if (!Security.IsStrongTls(ssl.SslProtocol, ssl.NegotiatedCipherSuite)) throw new AuthenticationException("The host negotiated TLS below Orbit's link policy.");
                    Volatile.Write(ref observed, ssl.RemoteCertificate?.GetCertHashString(HashAlgorithmName.SHA256) ?? throw new AuthenticationException("The host presented no certificate."));
                    return ssl;
                }
                catch
                {
                    if (ssl is not null) await ssl.DisposeAsync(); else socket.Dispose();
                    throw;
                }
            },
        };
        var origin = new UriBuilder(Uri.UriSchemeHttp, endpoint.Address.ToString(), endpoint.Port).Uri;
        using var http = new HttpClient(handler) { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(15) };

        var viewerNonce = RandomNumberGenerator.GetBytes(ShortPairProtocol.NonceBytes);
        using var startDocument = await PostAsync(http, ShortPairProtocol.StartPath, new { v = (int)ShortPairProtocol.Version, suite = ShortPairProtocol.Suite, viewerNonce = ShortPairProtocol.Encode(viewerNonce), deviceName }, cancellationToken);
        var start = startDocument.RootElement;
        if (!ShortPairProtocol.HasExactly(start, "v", "suite", "attemptId", "instanceId", "hostNonce", "expiresAt", "grants", "salt", "b")) throw Protocol("start fields");
        // Reject a different version or suite instead of negotiating down.
        if (start.GetProperty("v").ValueKind != JsonValueKind.Number || !start.GetProperty("v").TryGetInt32(out var version) || version != ShortPairProtocol.Version ||
            ShortPairProtocol.String(start, "suite") != ShortPairProtocol.Suite) throw new ShortPairClientException(502, "unsupported_suite", "The host offered an unsupported pairing protocol.");
        var attemptId = ShortPairProtocol.String(start, "attemptId");
        var attemptBytes = ShortPairProtocol.Decode(attemptId, ShortPairProtocol.AttemptBytes);
        var instanceId = ShortPairProtocol.Decode(ShortPairProtocol.String(start, "instanceId"), ShortPairProtocol.InstanceBytes);
        var hostNonce = ShortPairProtocol.Decode(ShortPairProtocol.String(start, "hostNonce"), ShortPairProtocol.NonceBytes);
        var salt = ShortPairProtocol.Decode(ShortPairProtocol.String(start, "salt"), ShortPairProtocol.SaltBytes);
        var b = ShortPairProtocol.Decode(ShortPairProtocol.String(start, "b"), ShortPairProtocol.GroupBytes);
        var grants = ShortPairProtocol.Grants(start.GetProperty("grants"));
        if (attemptBytes is null || instanceId is null || hostNonce is null || salt is null || b is null || grants is null ||
            start.GetProperty("expiresAt").ValueKind != JsonValueKind.Number || !start.GetProperty("expiresAt").TryGetInt64(out var expiresAt) ||
            !ShortPairProtocol.IsPlausibleExpiry(expiresAt, DateTimeOffset.UtcNow.ToUnixTimeSeconds())) throw Protocol("start values");
        // Canonical encoding only: 0 < B < N.
        if (!ShortPairProtocol.IsCanonicalElement(b)) throw Protocol("host public value");

        var client = new Srp6Client();
        client.Init(ShortPairProtocol.Group, ShortPairProtocol.Digest(), new SecureRandom());
        var password = Encoding.ASCII.GetBytes(canonicalCode);
        byte[] a; BigInteger m1;
        try
        {
            a = ShortPairProtocol.Unsigned(client.GenerateClientCredentials(salt, ShortPairProtocol.Identity(), password), ShortPairProtocol.GroupBytes);
            client.CalculateSecret(new BigInteger(1, b));
            m1 = client.CalculateClientEvidenceMessage();
        }
        catch (CryptoException) { throw Protocol("host public value"); }
        finally { CryptographicOperations.ZeroMemory(password); }

        using var verifyDocument = await PostAsync(http, ShortPairProtocol.VerifyPath, new { attemptId,
            a = ShortPairProtocol.Encode(a), m1 = ShortPairProtocol.Encode(ShortPairProtocol.Unsigned(m1, ShortPairProtocol.HashBytes)) }, cancellationToken);
        var verify = verifyDocument.RootElement;
        if (!ShortPairProtocol.HasExactly(verify, "m2", "hostConfirmation")) throw Protocol("verify fields");
        var m2 = ShortPairProtocol.Decode(ShortPairProtocol.String(verify, "m2"), ShortPairProtocol.HashBytes);
        var hostConfirmation = ShortPairProtocol.Decode(ShortPairProtocol.String(verify, "hostConfirmation"), ShortPairProtocol.HashBytes);
        if (m2 is null || hostConfirmation is null) throw Protocol("verify values");
        string hostFingerprint;
        hostFingerprint = Volatile.Read(ref observed) ?? throw Protocol("no certificate");
        byte[] viewerConfirmation;
        var key = Array.Empty<byte>();
        try
        {
            if (!client.VerifyServerEvidenceMessage(new BigInteger(1, m2))) throw Mismatch();
            key = ShortPairProtocol.Unsigned(client.CalculateSessionKey(), ShortPairProtocol.HashBytes);
            var transcript = ShortPairProtocol.Transcript(new(instanceId, attemptBytes, viewerNonce, hostNonce, expiresAt, grants, salt, a, b,
                ShortPairProtocol.FingerprintFromHex(hostFingerprint), ShortPairProtocol.FingerprintFromHex(viewerFingerprint)));
            // A different certificate on either side of the connection changes the transcript.
            if (!CryptographicOperations.FixedTimeEquals(ShortPairProtocol.Confirmation(key, hostToViewer: true, transcript), hostConfirmation)) throw Mismatch();
            viewerConfirmation = ShortPairProtocol.Confirmation(key, hostToViewer: false, transcript);
        }
        catch (CryptoException) { throw Mismatch(); }
        finally { CryptographicOperations.ZeroMemory(key); }

        // No retry on this connection-bound attempt. (The host can re-issue a completed
        // attempt's receipt on a new connection; this client does not use that path.)
        using (var receiptDocument = await PostAsync(http, ShortPairProtocol.ConfirmPath, new { attemptId, viewerConfirmation = ShortPairProtocol.Encode(viewerConfirmation) }, cancellationToken))
        {
            var receipt = receiptDocument.RootElement;
            if (!ShortPairProtocol.HasExactly(receipt, "deviceId", "deviceName", "hostId", "hostName", "permissions", "certificateFingerprint")) throw Protocol("receipt fields");
            var hostId = ShortPairProtocol.String(receipt, "hostId"); var hostName = ShortPairProtocol.String(receipt, "hostName");
            var deviceId = ShortPairProtocol.String(receipt, "deviceId"); var pairedName = ShortPairProtocol.String(receipt, "deviceName");
            if (hostId is not { Length: > 0 and <= 128 } || hostName is not { Length: > 0 and <= 80 } || deviceId is not { Length: > 0 and <= 128 } || pairedName is not { Length: > 0 and <= 80 } ||
                !Security.IsSafeDisplayText(hostId) || !Security.IsSafeDisplayText(hostName) || !Security.IsSafeDisplayText(deviceId) || !Security.IsSafeDisplayText(pairedName) ||
                ShortPairProtocol.Grants(receipt.GetProperty("permissions")) != grants ||
                !string.Equals(ShortPairProtocol.String(receipt, "certificateFingerprint"), hostFingerprint, StringComparison.Ordinal)) throw Protocol("receipt values");
            return new(hostId, hostName, deviceId, pairedName, ShortPairGrants.From(grants), hostFingerprint, $"https://{origin.Authority}");
        }
    }

    private static async Task<JsonDocument> PostAsync(HttpClient http, string path, object body, CancellationToken cancellationToken)
    {
        using var content = new ByteArrayContent(JsonSerializer.SerializeToUtf8Bytes(body, JsonSerializerOptions.Web));
        content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        using var response = await http.PostAsync(path, content, cancellationToken);
        if (response.Content.Headers.ContentLength is > MaximumResponseBytes) throw Protocol("response size");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var buffer = new MemoryStream();
        var chunk = new byte[4096];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > MaximumResponseBytes) throw Protocol("response size");
            buffer.Write(chunk, 0, read);
        }
        JsonDocument? document = null;
        try { document = JsonDocument.Parse(buffer.ToArray(), new JsonDocumentOptions { MaxDepth = 4 }); }
        catch (JsonException) { if (response.IsSuccessStatusCode) throw Protocol("response JSON"); }
        if (response.IsSuccessStatusCode) return document!;
        using (document)
        {
            var code = document?.RootElement is { ValueKind: JsonValueKind.Object } root && root.TryGetProperty("code", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            throw (int)response.StatusCode switch
            {
                429 => new ShortPairClientException(429, "rate_limited", "The host is rate limiting pairing attempts. Wait a minute and try again."),
                403 when code is "short_code_unavailable" => new ShortPairClientException(403, code, "That computer has no active short code. Ask its owner for a new code."),
                403 when code is "short_code_locked" => new ShortPairClientException(403, code, "Too many failed attempts. Ask the owner for a new code."),
                403 when code is "short_code_rejected" => new ShortPairClientException(403, code, "The code was not accepted. Check it and try again."),
                404 => new ShortPairClientException(502, "short_code_unsupported", "That computer does not offer short-code pairing."),
                _ => Protocol("HTTP " + (int)response.StatusCode + (code is null ? "" : " " + code)),
            };
        }
    }

    // The reason names only the failed step or status, never secret material.
    private static ShortPairClientException Protocol(string reason) => new(502, "protocol_error", $"The host returned an invalid short-code pairing response ({reason}).");
    private static ShortPairClientException Mismatch() => new(403, "host_identity_mismatch", "The host could not prove the code over this connection. Nothing was saved.");
}
