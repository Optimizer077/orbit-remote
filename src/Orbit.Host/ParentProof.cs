using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Orbit.Host;

public sealed class ParentProof : IDisposable
{
    private readonly byte[] key;
    private bool disposed;
    private ParentProof(byte[] key) => this.key = key;

    public static async Task<ParentProof> ReadBootstrapAsync(TextReader input, TimeSpan? timeout = null)
    {
        // Console.In's synchronized wrapper can block synchronously. Bound it
        // on a worker so a parent that never supplies bootstrap cannot hang startup.
        var line = await Task.Run(() =>
        {
            var value = new StringBuilder();
            while (true)
            {
                var next = input.Read();
                if (next < 0) throw new InvalidOperationException("Parent bootstrap pipe closed before authentication was configured.");
                if (next == '\n') return value.ToString().TrimEnd('\r');
                if (value.Length >= 256) throw new InvalidOperationException("Invalid parent bootstrap message.");
                value.Append((char)next);
            }
        }).WaitAsync(timeout ?? TimeSpan.FromSeconds(10));
        try
        {
            using var json = JsonDocument.Parse(line);
            if (json.RootElement.GetProperty("version").GetInt32() != 1) throw new InvalidOperationException("Unsupported parent bootstrap version.");
            return new(DecodeToken(json.RootElement.GetProperty("proofKey").GetString()));
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or FormatException or ArgumentException)
        { throw new InvalidOperationException("Invalid parent bootstrap message."); }
    }

    public object CreateResponse(string? challenge, int port, int clientPort)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        _ = DecodeToken(challenge);
        if (port is < 1024 or > 65535 || clientPort is < 1 or > 65535) throw new ArgumentException("Invalid proof socket binding.");
        var message = Encoding.UTF8.GetBytes($"orbit-child-proof-v1\n{challenge}\n{Environment.ProcessId}\n{port}\n{clientPort}");
        var proof = EncodeToken(HMACSHA256.HashData(key, message));
        return new { version = 1, pid = Environment.ProcessId, challenge, clientPort, proof };
    }
    private static byte[] DecodeToken(string? token)
    {
        if (token is null || token.Length != 43 || token.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new ArgumentException("Expected a canonical 32-byte base64url value.");
        var decoded = Convert.FromBase64String(token.Replace('-', '+').Replace('_', '/') + "=");
        if (decoded.Length != 32 || EncodeToken(decoded) != token) throw new ArgumentException("Invalid base64url value.");
        return decoded;
    }
    private static string EncodeToken(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public void Dispose() { disposed = true; CryptographicOperations.ZeroMemory(key); }
}
