using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Agreement.Srp;
using Org.BouncyCastle.Security;
using Orbit.Host;

/// <summary>
/// EXPERIMENTAL F33: the client role keeps one TLS connection per unfinished attempt.
/// A local fake host answers start correctly and then closes the connection; the
/// client must abort instead of opening a second connection for verify.
/// </summary>
public static class ShortPairClientChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        using var serverCertificate = Certificate("CN=F33 fake host", "1.3.6.1.5.5.7.3.1");
        using var clientCertificate = Certificate("CN=F33 viewer", "1.3.6.1.5.5.7.3.2");
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var endpoint = (IPEndPoint)listener.LocalEndpoint;
        var connections = 0;
        using var stop = new CancellationTokenSource();
        var serving = new List<Task>();
        var accepting = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                TcpClient tcp;
                try { tcp = await listener.AcceptTcpClientAsync(stop.Token); }
                catch (Exception ex) when (ex is OperationCanceledException or SocketException or ObjectDisposedException) { return; }
                var first = Interlocked.Increment(ref connections) == 1;
                lock (serving) serving.Add(ServeAsync(tcp, serverCertificate, first));
            }
        });

        Exception? failure = null;
        using (var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20)))
        {
            try { await ShortPairClient.PairAsync(endpoint, "K7QF2M9X", clientCertificate, "Viewer", timeout.Token); }
            catch (Exception ex) { failure = ex; }
        }
        await Task.Delay(300); // Room for a reconnect to arrive if the client made one.
        stop.Cancel(); listener.Stop();
        await accepting;
        Task[] pending; lock (serving) pending = serving.ToArray();
        await Task.WhenAll(pending);
        check(failure is HttpRequestException && Volatile.Read(ref connections) == 1,
            $"F33 client role: a closed connection aborts the unfinished attempt; the client never opens a second connection (connections {Volatile.Read(ref connections)}, {failure?.GetType().Name})");
    }

    private static async Task ServeAsync(TcpClient tcp, X509Certificate2 certificate, bool first)
    {
        using (tcp)
        await using (var ssl = new SslStream(tcp.GetStream(), leaveInnerStreamOpen: false))
        {
            try
            {
                await ssl.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
                {
                    ServerCertificate = certificate, ClientCertificateRequired = true,
                    RemoteCertificateValidationCallback = (_, _, _, _) => true,
                    EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                });
                await ReadRequestAsync(ssl);
                var body = first ? JsonSerializer.SerializeToUtf8Bytes(StartResponse(), JsonSerializerOptions.Web) : Encoding.UTF8.GetBytes("{\"code\":\"second_connection\"}");
                var head = Encoding.ASCII.GetBytes($"HTTP/1.1 {(first ? "200 OK" : "403 Forbidden")}\r\nContent-Type: application/json\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
                await ssl.WriteAsync(head); await ssl.WriteAsync(body); await ssl.FlushAsync();
            }
            catch (Exception ex) when (ex is IOException or AuthenticationException or SocketException) { }
        }
    }

    /// <summary>A structurally valid start response with a real SRP B value.</summary>
    private static ShortPairStartResponse StartResponse()
    {
        var salt = RandomNumberGenerator.GetBytes(ShortPairProtocol.SaltBytes);
        var server = new Srp6Server();
        server.Init(ShortPairProtocol.Group, ShortPairProtocol.Verifier(salt, "K7QF2M9X"), ShortPairProtocol.Digest(), new SecureRandom());
        var b = ShortPairProtocol.Unsigned(server.GenerateServerCredentials(), ShortPairProtocol.GroupBytes);
        return new(ShortPairProtocol.Version, ShortPairProtocol.Suite, ShortPairProtocol.Encode(RandomNumberGenerator.GetBytes(16)), ShortPairProtocol.Encode(RandomNumberGenerator.GetBytes(16)),
            ShortPairProtocol.Encode(RandomNumberGenerator.GetBytes(32)), DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeSeconds(), new(true, false, false, false, false),
            ShortPairProtocol.Encode(salt), ShortPairProtocol.Encode(b));
    }

    private static async Task ReadRequestAsync(Stream stream)
    {
        var buffer = new List<byte>();
        var chunk = new byte[1024];
        int headerEnd;
        while ((headerEnd = IndexOfHeaderEnd(buffer)) < 0)
        {
            var read = await stream.ReadAsync(chunk);
            if (read == 0 || buffer.Count > 16384) throw new IOException("Request headers incomplete.");
            buffer.AddRange(chunk.AsSpan(0, read).ToArray());
        }
        var headers = Encoding.ASCII.GetString(buffer.ToArray(), 0, headerEnd);
        var length = headers.Split("\r\n").Select(line => line.Split(':', 2)).Where(parts => parts.Length == 2 && parts[0].Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
            .Select(parts => int.Parse(parts[1].Trim(), System.Globalization.CultureInfo.InvariantCulture)).FirstOrDefault();
        while (buffer.Count < headerEnd + 4 + length)
        {
            var read = await stream.ReadAsync(chunk);
            if (read == 0) throw new IOException("Request body incomplete.");
            buffer.AddRange(chunk.AsSpan(0, read).ToArray());
        }
    }

    private static int IndexOfHeaderEnd(List<byte> buffer)
    {
        for (var index = 0; index + 3 < buffer.Count; index++)
            if (buffer[index] == '\r' && buffer[index + 1] == '\n' && buffer[index + 2] == '\r' && buffer[index + 3] == '\n') return index;
        return -1;
    }

    private static X509Certificate2 Certificate(string subject, string usage)
    {
        using var key = RSA.Create(2048);
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new(usage) }, false));
        using var created = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow.AddDays(1));
        return X509CertificateLoader.LoadPkcs12(created.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.UserKeySet);
    }
}
