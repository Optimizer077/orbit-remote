param([ValidateSet('win-x64','win-arm64','osx-arm64','osx-x64','linux-x64','linux-arm64')][string]$Runtime, [switch]$Package, [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use bash scripts/build.sh on macOS or Linux.' }
if (-not $Runtime) { $Runtime = 'win-' + [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant() }
if ($Runtime -notmatch '^(win|osx|linux)-(x64|arm64)$') { throw 'Only x64 and arm64 builds are supported.' }
if ($Package -and -not $Runtime.StartsWith('win-')) { throw 'Build macOS and Linux desktop packages on their native OS using scripts/build.sh.' }
$taskPreviousRuntime = $env:ORBIT_HOST_RUNTIME
Push-Location -LiteralPath $taskRoot
try {
    $taskHostOutput = Join-Path $taskRoot ('artifacts/host/' + $Runtime)
    & dotnet publish 'src/Orbit.Host/Orbit.Host.csproj' -c Release -r $Runtime --self-contained true -o $taskHostOutput --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Host publish failed.' }
    $taskVersion = (Get-Content -LiteralPath 'apps/desktop/package.json' -Raw | ConvertFrom-Json).version
    @{ runtime = $Runtime; version = $taskVersion; configuration = 'Release'; selfContained = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskHostOutput 'build-info.json') -Encoding UTF8
    $env:ORBIT_HOST_RUNTIME = $Runtime
    Push-Location -LiteralPath (Join-Path $taskRoot 'apps/desktop')
    try {
        if (-not $SkipInstall) {
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
        }
        if ($Package) {
            $taskBuilderArch = '--' + $Runtime.Split('-')[1]
            & npm.cmd run package:win -- $taskBuilderArch
            if ($LASTEXITCODE -ne 0) { throw 'Desktop packaging failed.' }
        } else {
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
        }
    } finally { Pop-Location }
} finally {
    $env:ORBIT_HOST_RUNTIME = $taskPreviousRuntime
    Pop-Location
}
