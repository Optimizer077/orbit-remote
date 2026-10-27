using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Logging;
using Orbit.Host;

public static class RequestBodyPolicyChecks
{
    private const long UploadMaximumBytes = 32L * 1024 * 1024;

    public static async Task RunAsync(Action<bool, string> check)
    {
        foreach (var path in new[] { "/api/sessions/one/files/generated.bin", "/api/sessions/files/files/generated.bin", "/API/SESSIONS/one/FILES/generated.bin" })
            check(RequestBodyPolicy.LimitFor("PUT", path, UploadMaximumBytes) == UploadMaximumBytes, "Body limit: canonical upload PUT shape receives32MiB: " + path);
        foreach (var path in new[] { "/api/sessions/files/input", "/api/sessions/files/frame", "/api/sessions/one/files", "/api/sessions/one/files/", "/api/sessions//files/name", "/api/sessions/one/files/name/extra", "/api/sessions/one/files/name/", "/api/other/files/name", "/files/name", "/api/sessions/one//files/name", "/api/sessions/one/files//name" })
            check(RequestBodyPolicy.LimitFor("PUT", path, UploadMaximumBytes) == 16384, "Body limit: lookalike or malformed paths retain16KiB: " + path);
        foreach (var method in new[] { "POST", "GET", "HEAD", "DELETE", "PATCH", "OPTIONS" })
            check(RequestBodyPolicy.LimitFor(method, "/api/sessions/one/files/name", UploadMaximumBytes) == 16384, "Body limit: upload-shaped " + method + " retains16KiB");
        check(RequestBodyPolicy.LimitFor("POST", "/api/sessions/files/input", UploadMaximumBytes) == 16384,
            "Body limit: session ID files cannot promote an input request into the upload allowance");

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.Use(async (context, next) =>
        {
            var size = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
            if (size is { IsReadOnly: false }) size.MaxRequestBodySize = RequestBodyPolicy.LimitFor(context.Request.Method, context.Request.Path, UploadMaximumBytes);
            try { await next(context); }
            catch (BadHttpRequestException ex) { context.Response.StatusCode = ex.StatusCode; }
        });
        static async Task<IResult> ReadGeneratedBody(HttpContext context)
        {
            await context.Request.Body.CopyToAsync(Stream.Null, context.RequestAborted); return Results.NoContent();
        }
        app.MapPost("/api/sessions/{id}/input", (Func<HttpContext, Task<IResult>>)ReadGeneratedBody);
        app.MapMethods("/api/sessions/{id}/files/{name}", ["PUT", "POST", "GET"], (Func<HttpContext, Task<IResult>>)ReadGeneratedBody);
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new Uri(app.Urls.First()) };
        try
        {
            foreach (var item in new[]
            {
                (HttpMethod.Post, "/api/sessions/files/input", HttpStatusCode.RequestEntityTooLarge),
                (HttpMethod.Post, "/api/sessions/ordinary/input", HttpStatusCode.RequestEntityTooLarge),
                (HttpMethod.Post, "/api/sessions/ordinary/files/generated.bin", HttpStatusCode.RequestEntityTooLarge),
                (HttpMethod.Get, "/api/sessions/ordinary/files/generated.bin", HttpStatusCode.RequestEntityTooLarge),
                (HttpMethod.Put, "/api/sessions/ordinary/files/generated.bin", HttpStatusCode.NoContent),
                (HttpMethod.Put, "/api/sessions/files/files/generated.bin", HttpStatusCode.NoContent),
            })
            {
                using var request = new HttpRequestMessage(item.Item1, item.Item2) { Content = new ByteArrayContent(new byte[20 * 1024]) };
                using var response = await client.SendAsync(request);
                check(response.StatusCode == item.Item3, $"Body limit real Kestrel: generated20KiB {item.Item1} {item.Item2} returns{(int)item.Item3}");
            }
        }
        finally { await app.StopAsync(); }
    }
}
