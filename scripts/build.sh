#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bash scripts/build.sh [--package] [--skip-install] [--runtime RID] [--adhoc]

Publish a self-contained host and build the desktop on macOS/Linux.
  --package       Also create a macOS DMG or Linux AppImage and Debian package.
  --skip-install  Reuse existing apps/desktop/node_modules (run npm ci first).
  --adhoc         macOS local preview: ad-hoc signing, no notarization.
  --runtime RID   Same-OS osx-arm64/osx-x64 or linux-arm64/linux-x64 target.
                  Defaults to the architecture reported by uname -m.

Native packages must be built on the target operating system.
USAGE
}

package=false
skip_install=false
adhoc=false
runtime=""
while (($#)); do
  case "$1" in
    --package) package=true; shift ;;
    --skip-install) skip_install=true; shift ;;
    --adhoc) adhoc=true; shift ;;
    --runtime)
      if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
        printf '%s\n' '--runtime requires a runtime identifier.' >&2; exit 2
      fi
      runtime="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) runtime_os=osx; builder_os=--mac ;;
  Linux) runtime_os=linux; builder_os=--linux ;;
  *) printf 'Use scripts/build.ps1 on Windows.\n' >&2; exit 1 ;;
esac
if "$adhoc"; then
  if [[ "$runtime_os" != osx ]]; then
    printf '%s\n' '--adhoc is available only on macOS.' >&2; exit 2
  fi
  export ORBIT_MAC_ADHOC_SIGN=1
fi
case "$(uname -m)" in
  arm64|aarch64) native_arch=arm64 ;;
  x86_64|amd64) native_arch=x64 ;;
  *) printf 'Unsupported architecture: %s\n' "$(uname -m)" >&2; exit 1 ;;
esac
runtime="${runtime:-$runtime_os-$native_arch}"
case "$runtime" in
  "$runtime_os-arm64") target_arch=arm64 ;;
  "$runtime_os-x64") target_arch=x64 ;;
  *) printf 'Runtime %s cannot be packaged on this OS. Use %s-arm64 or %s-x64.\n' "$runtime" "$runtime_os" "$runtime_os" >&2; exit 2 ;;
esac

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$repo_root"
for executable in dotnet node npm; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'Missing %s. Install the prerequisites in docs/MACOS.md.\n' "$executable" >&2
    exit 1
  fi
done

dotnet --version
host_output="$repo_root/artifacts/host/$runtime"
# Verify package versions and content hashes against packages.lock.json before publishing.
dotnet restore src/Orbit.Host/Orbit.Host.csproj --locked-mode
dotnet publish src/Orbit.Host/Orbit.Host.csproj --configuration Release --runtime "$runtime" --self-contained true --output "$host_output" --nologo
cp -- "$repo_root/THIRD_PARTY_NOTICES.md" "$host_output/THIRD_PARTY_NOTICES.md"
node -e 'const fs = require("node:fs"); const [manifest, output, runtime] = process.argv.slice(1); const { version } = JSON.parse(fs.readFileSync(manifest, "utf8")); fs.writeFileSync(output, JSON.stringify({ runtime, version, configuration: "Release", selfContained: true }, null, 2) + "\n");' "$repo_root/apps/desktop/package.json" "$host_output/build-info.json" "$runtime"

export ORBIT_HOST_RUNTIME="$runtime"
if [[ "${ORBIT_UNFUSED_TEST_BUILD:-}" == 1 ]]; then
  echo 'ORBIT_UNFUSED_TEST_BUILD=1 builds a test-only app without security fuses; unset it for a release build.' >&2
  exit 1
fi
cd -- "$repo_root/apps/desktop"
if ! "$skip_install"; then
  npm ci --no-audit --no-fund
fi
npm run build
if "$package"; then
  if [[ "$runtime_os" == osx ]]; then
    npm exec -- electron-builder "$builder_os" dmg "--$target_arch" --publish never
  else
    npm exec -- electron-builder "$builder_os" AppImage deb "--$target_arch" --publish never
  fi
fi
printf 'Host published to %s\n' "$host_output"
