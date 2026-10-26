using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Orbit.Host;

public static class ParentProofChecks
{
    public static async Task RunAsync(Action<bool, string> check, Action<Action, string> reject)
    {
        var secret = Security.RandomToken();
        var challenge = Security.RandomToken();
        var encoded = JsonSerializer.Serialize(new { version = 1, proofKey = secret });
        using var proof = await ParentProof.ReadBootstrapAsync(new StringReader(encoded + "\n"));
        var response = JsonSerializer.SerializeToElement(proof.CreateResponse(challenge, 47831, 54321));
        var expected = Sign(secret, challenge, Environment.ProcessId, 47831, 54321);
        check(response.GetProperty("proof").GetString() == expected, "Parent proof uses the private stdin key and exact agreed HMAC context");
        check(response.GetProperty("pid").GetInt32() == Environment.ProcessId && response.GetProperty("clientPort").GetInt32() == 54321, "Proof binds actual process and client TCP port metadata");
        check(!response.ToString().Contains(secret, StringComparison.Ordinal), "Proof response never echoes the per-launch secret");
        check(JsonSerializer.SerializeToElement(proof.CreateResponse(challenge, 47831, 54322)).GetProperty("proof").GetString() != expected, "Proof cannot be reused over a different client's TCP port");
        check(JsonSerializer.SerializeToElement(proof.CreateResponse(challenge, 47832, 54321)).GetProperty("proof").GetString() != expected, "Proof binds the actual listening server port");
        check(JsonSerializer.SerializeToElement(proof.CreateResponse(Security.RandomToken(), 47831, 54321)).GetProperty("proof").GetString() != expected, "A fresh challenge cannot replay the previous proof");
        reject(() => proof.CreateResponse("short", 47831, 54321), "Malformed challenge is rejected before signing");
        reject(() => proof.CreateResponse(challenge, 47831, 0), "Invalid socket metadata is rejected");
        foreach (var input in new[] { "\n", "{}\n", "{\"version\":1,\"proofKey\":\"short\"}\n", new string('x', 257) + "\n", "" })
        {
            var denied = false;
            try { using var ignored = await ParentProof.ReadBootstrapAsync(new StringReader(input)); }
            catch (InvalidOperationException) { denied = true; }
            check(denied, "Missing, malformed or oversized bootstrap fails closed without an HTTP fallback");
        }
        var rotated = Security.RandomToken();
        using var replacement = await ParentProof.ReadBootstrapAsync(new StringReader(JsonSerializer.Serialize(new { version = 1, proofKey = rotated }) + "\n"));
        check(JsonSerializer.SerializeToElement(replacement.CreateResponse(challenge, 47831, 54321)).GetProperty("proof").GetString() != expected, "New child launch secret invalidates prior signed responses");
    }

    public static string Sign(string secret, string challenge, int pid, int port, int clientPort)
    {
        var key = Convert.FromBase64String(secret.Replace('-', '+').Replace('_', '/') + "=");
        var mac = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes($"orbit-child-proof-v1\n{challenge}\n{pid}\n{port}\n{clientPort}"));
        return Convert.ToBase64String(mac).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}
