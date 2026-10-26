#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/start-dev.sh [--skip-install] [--loopback-test]

Build the .NET Debug host and desktop renderer, then launch Orbit on macOS/Linux.
  --skip-install   Reuse existing apps/desktop/node_modules (run npm ci first).
  --loopback-test  Explicit local-only test mode; remote listening is disabled.
USAGE
}

skip_install=false
loopback_test=false
for argument in "$@"; do
  case "$argument" in
    --skip-install) skip_install=true ;;
    --loopback-test) loopback_test=true ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) printf 'Use scripts/start-dev.ps1 on Windows.\n' >&2; exit 1 ;;
esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_root"
for executable in dotnet node npm; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'Missing %s. Install the prerequisites in docs/MACOS.md.\n' "$executable" >&2
    exit 1
  fi
done

# Resolve global.json here so a missing matching SDK fails before dependency work.
dotnet --version
dotnet build src/Orbit.Host/Orbit.Host.csproj --configuration Debug --framework net10.0 --nologo
cd -- "$repo_root/apps/desktop"
if ! "$skip_install"; then
  npm ci --no-audit --no-fund
fi
npm run build

# Electron creates its own host control token and data directory. Never copy a
# second computer's identity or persist a token in this launcher.
if "$loopback_test"; then
  export ORBIT_LOOPBACK_TEST=1
else
  unset ORBIT_LOOPBACK_TEST
fi
npm start
