$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $taskRoot
try {
    & dotnet run --project 'tests/Orbit.Host.Tests/Orbit.Host.Tests.csproj'
    if ($LASTEXITCODE -ne 0) { throw 'Host security checks failed.' }
    Push-Location -LiteralPath (Join-Path $taskRoot 'apps/desktop')
    try {
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw 'Desktop transport checks failed.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    } finally { Pop-Location }
} finally { Pop-Location }
