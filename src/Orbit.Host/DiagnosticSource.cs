#if ORBIT_DIAGNOSTICS
using Orbit.Host.Platform;

namespace Orbit.Host;

/// <summary>Diagnostic configuration only; neither this selector nor its backend exists in Debug/Release.</summary>
internal static class DiagnosticSource
{
    private const string MarkerName = ".orbit-generated-source";
    private const string Marker = "Orbit diagnostic generated source v1\n";
    internal sealed record Options(string DataDirectory, int Width, int Height, string Pattern = "low-entropy");

    internal static string ParsePattern(string? pattern) => pattern switch
    {
        null or "low-entropy" => "low-entropy",
        "high-entropy" => "high-entropy",
        _ => throw new ArgumentException("Diagnostic pattern must be low-entropy or high-entropy."),
    };

    internal static Options Parse(string? enabled, bool loopbackTest, string? directory, string? width, string? height)
    {
        if (enabled != "1") throw new ArgumentException("Diagnostic source opt-in must be exactly 1.");
        if (!loopbackTest) throw new ArgumentException("Diagnostic synthetic sources require --loopback-test.");
        if (string.IsNullOrWhiteSpace(directory) || !Path.IsPathFullyQualified(directory))
            throw new ArgumentException("Diagnostic synthetic sources require an explicit absolute isolated ORBIT_DATA_DIR.");
        var canonical = Path.TrimEndingDirectorySeparator(Path.GetFullPath(directory));
        return new(canonical, Dimension(width, 1920, 320, 3840), Dimension(height, 1080, 240, 2160));
    }

    private static int Dimension(string? text, int fallback, int minimum, int maximum)
    {
        if (text is null) return fallback;
        if (!int.TryParse(text, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var value)
            || value < minimum || value > maximum || value % 2 != 0)
            throw new ArgumentException("Diagnostic source dimensions must be even integers within 320x240 .. 3840x2160.");
        return value;
    }

    internal static Options PrepareEnvironment(bool loopbackTest, string? directory)
    {
        var options = Parse(Environment.GetEnvironmentVariable("ORBIT_DIAGNOSTIC_SYNTHETIC"), loopbackTest, directory,
            Environment.GetEnvironmentVariable("ORBIT_DIAGNOSTIC_WIDTH"), Environment.GetEnvironmentVariable("ORBIT_DIAGNOSTIC_HEIGHT"))
            with { Pattern = ParsePattern(Environment.GetEnvironmentVariable("ORBIT_DIAGNOSTIC_PATTERN")) };
        if (!OperatingSystem.IsWindows()) throw new PlatformUnavailableException("diagnostic-unavailable", "Diagnostic GPU sources require Windows.");
        PrepareProfile(options.DataDirectory);
        return options;
    }

    internal static IPlatformBackend Create(Options options) => new DiagnosticSyntheticBackend(options.Width, options.Height, options.Pattern);

    private static void PrepareProfile(string directory)
    {
        var marker = Path.Combine(directory, MarkerName);
        if (Directory.Exists(directory) && Directory.EnumerateFileSystemEntries(directory).Any())
        {
            if (!File.Exists(marker) || (File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0
                || new FileInfo(marker).Length != Marker.Length || File.ReadAllText(marker) != Marker)
                throw new ArgumentException("The diagnostic profile must be empty or an existing generated-source profile.");
            return;
        }
        Security.CreatePrivateDirectory(directory);
        Security.WritePrivateNewFile(marker, System.Text.Encoding.UTF8.GetBytes(Marker));
    }

    internal static object? Status(IPlatformBackend platform) => platform is DiagnosticSyntheticBackend source
        ? new { mode = "synthetic-gpu", pattern = source.PatternName, source.GeneratedFrames, source.ProducerOpens, source.GpuEncoderOpens, source.CpuReadbacks,
            hostMonotonicMicroseconds = VideoStreamRecords.MonotonicMicroseconds(), targetFramesPerSecond = 60, source.Width, source.Height } : null;

    internal static bool IsSynthetic(IPlatformBackend platform) => platform is DiagnosticSyntheticBackend;
}
#endif
