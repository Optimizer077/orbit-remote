param([switch]$LoopbackTest, [switch]$SkipInstall)
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $taskRoot
try {
    & dotnet build 'src/Orbit.Host/Orbit.Host.csproj' --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Host build failed.' }
    Push-Location -LiteralPath (Join-Path $taskRoot 'apps/desktop')
    try {
        if (-not $SkipInstall) {
            & npm.cmd ci --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
        if ($LoopbackTest) { $env:ORBIT_LOOPBACK_TEST = '1' } else { Remove-Item Env:ORBIT_LOOPBACK_TEST -ErrorAction SilentlyContinue }
        & npm.cmd start
        if ($LASTEXITCODE -ne 0) { throw 'Desktop application failed.' }
    } finally { Pop-Location }
} finally { Pop-Location }
