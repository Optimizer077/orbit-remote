#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  printf '%s\n' 'This check requires macOS.' >&2
  exit 2
fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_root"
# macOS aliases /var to /private/var. The file sandbox correctly rejects linked
# ancestors; use the real temporary path rather than weakening that boundary.
export TMPDIR="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)/"
dotnet run --project tests/Orbit.Mac.Tests/Orbit.Mac.Tests.csproj -- "$@"
dotnet run --project tests/Orbit.Host.Tests/Orbit.Host.Tests.csproj
cd -- "$repo_root/apps/desktop"
npm test
npm run build
npm audit --omit=dev
npm exec -- playwright test --config playwright.mac.config.ts
