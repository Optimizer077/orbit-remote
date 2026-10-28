using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Orbit.Host;
using Orbit.Host.Platform;

/// <summary>H-9: native and tool error text stays in the local log and never reaches a peer.</summary>
internal static class ErrorDisclosureChecks
{
    private const string Secret = "ORBIT-GENERATED-NATIVE-DETAIL";

    internal static async Task RunAsync(Action<bool, string> check)
    {
        await ToolStderrAsync(check);
        await HttpAsync(check);
    }

    private static async Task ToolStderrAsync(Action<bool, string> check)
    {
        var (shell, arguments) = OperatingSystem.IsWindows()
            ? (Path.Combine(Environment.SystemDirectory, "cmd.exe"), new[] { "/c", $"echo {Secret} 1>&2 & exit 3" })
            : ("/bin/sh", new[] { "-c", $"echo {Secret} >&2; exit 3" });
        PlatformUnavailableException? failure = null;
        try { await NativeProcess.RunAsync(shell, arguments, CancellationToken.None, timeoutSeconds: 10); }
        catch (PlatformUnavailableException ex) { failure = ex; }
        check(failure is { Code: "tool-failed" } && !failure.Message.Contains(Secret, StringComparison.Ordinal),
            "H-9: a failing desktop utility's stderr is not part of the peer-facing message");
        check(failure?.Detail?.Contains(Secret, StringComparison.Ordinal) == true && failure.Detail.Contains("exit 3", StringComparison.Ordinal),
            "H-9: the utility's stderr and exit code stay available as local-only detail");
    }

    private static async Task HttpAsync(Action<bool, string> check)
    {
        var logged = new List<string>();
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders(); builder.Logging.AddProvider(new ListLoggerProvider(logged));
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        await using var app = builder.Build();
        app.Use((context, next) => SessionAccess.InvokeWithErrorsAsync(context, next, app.Logger));
        app.MapGet("/tool", IResult () => throw new PlatformUnavailableException("tool-failed", "A desktop utility failed.", Secret + " stderr"));
        app.MapGet("/bcl-argument", IResult () => { _ = Path.GetFullPath(""); return Results.Ok(); });
        app.MapGet("/bcl-operation", IResult () => { _ = new List<int>().First(); return Results.Ok(); });
        app.MapGet("/host-argument", IResult () => { Security.ValidateFileName("CON"); return Results.Ok(); });
        await app.StartAsync();
        using var client = new HttpClient { BaseAddress = new(app.Urls.Single()), Timeout = TimeSpan.FromSeconds(4) };
        async Task<(int Status, string Body)> Get(string route)
        {
            using var response = await client.GetAsync(route);
            return ((int)response.StatusCode, await response.Content.ReadAsStringAsync());
        }
        try
        {
            var tool = await Get("/tool");
            check(tool.Status == 409 && !tool.Body.Contains(Secret, StringComparison.Ordinal)
                && JsonSerializer.Deserialize<JsonElement>(tool.Body).GetProperty("code").GetString() == "tool-failed",
                "H-9 HTTP: platform failures keep their fixed code and message without native detail");
            bool Logged(string text) { lock (logged) return logged.Any(line => line.Contains(text, StringComparison.Ordinal)); }
            check(Logged(Secret), "H-9 HTTP: platform failure detail is logged locally");
            var argument = await Get("/bcl-argument");
            check(argument.Status == 400 && JsonSerializer.Deserialize<JsonElement>(argument.Body).GetProperty("error").GetString() == "The request was not valid.",
                "H-9 HTTP: a runtime ArgumentException returns a fixed message instead of runtime text");
            var operation = await Get("/bcl-operation");
            check(operation.Status == 409 && JsonSerializer.Deserialize<JsonElement>(operation.Body).GetProperty("error").GetString() == "The host could not complete this operation.",
                "H-9 HTTP: a runtime InvalidOperationException returns a fixed message instead of runtime text");
            check(Logged(nameof(InvalidOperationException)), "H-9 HTTP: the replaced runtime exception type is logged locally");
            var host = await Get("/host-argument");
            check(host.Status == 400 && JsonSerializer.Deserialize<JsonElement>(host.Body).GetProperty("error").GetString() == "Reserved file name.",
                "H-9 HTTP: Orbit's own fixed validation messages still reach the peer unchanged");
        }
        finally { await app.StopAsync(); }
    }

    internal sealed class ListLoggerProvider(List<string> lines) : ILoggerProvider
    {
        public ILogger CreateLogger(string categoryName) => new ListLogger(lines);
        public void Dispose() { }
    }

    private sealed class ListLogger(List<string> lines) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        { lock (lines) lines.Add(formatter(state, exception)); }
    }
}
