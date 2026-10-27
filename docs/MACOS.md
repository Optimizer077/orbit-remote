# Continue development on a Mac

Orbit is an evaluation preview. Native Apple silicon execution, DMG installation, both-display capture, keyboard/mouse control, clipboard, and local encrypted-session recovery have been exercised on macOS. See [the Mac validation record](MACOS-VALIDATION.md) for the exact scope. Current Windows-generated H.264 video reached the Mac, but its sustained-playback and terminal test remains incomplete. Intel execution remains untested. A Windows `.exe` cannot run natively on macOS; build the Mac application on your Mac.

## 1. Install prerequisites

- Git, available through Apple's Command Line Tools. If `git --version` prompts for the tools, complete that installation.
- [Node.js 24 LTS and npm](https://nodejs.org/en/download). Use the Arm64 build on Apple silicon and x64 on Intel.
- [.NET 10 SDK](https://learn.microsoft.com/en-us/dotnet/core/install/macos), matching the SDK policy in [`global.json`](../global.json). Install the SDK, not only the runtime. The repository requests 10.0.200 and permits later .NET 10 feature bands; `dotnet --version` from the repository must succeed.
- [Tailscale for macOS](https://tailscale.com/docs/install/mac), installed and signed in. Both computers must be authorized in the same tailnet or have explicitly shared device access allowed by its policy.

Use a native terminal session on Apple silicon. Check `uname -m`, `node -p process.arch`, and `dotnet --info`; avoid mixing an Arm64 shell with x64 development tools under Rosetta unless you are deliberately testing that configuration. Do not copy `node_modules` from Windows: `npm ci` installs the platform-specific dependencies.

## 2. Clone and launch

```bash
git clone https://github.com/Optimizer077/orbit-remote.git
cd orbit-remote
bash scripts/start-dev.sh
```

The script builds the host at `src/Orbit.Host/bin/Debug/net10.0/Orbit.Host.dll`, installs the exact npm lockfile dependencies, builds the renderer, and launches Electron. The GUI starts and supervises its host process. Closing the window leaves the menu-bar application running; use **Quit Orbit and stop remote access** to stop it before launching another build.

After the first installation, `bash scripts/start-dev.sh --skip-install` reuses installed dependencies. Run the full command again when `package-lock.json` changes. `--loopback-test` is an explicit local-only test mode; omit it for real connections.

For an isolated development profile, choose a new empty directory:

```bash
ORBIT_APP_DATA="$HOME/Library/Application Support/Orbit Remote Dev" bash scripts/start-dev.sh
```

`ORBIT_APP_DATA` sets Electron's user-data directory. The launcher sets the host's `ORBIT_DATA_DIR` to its `host` subdirectory. Set only the app variable when using the GUI. Each computer must generate its own identity; do not copy app-data directories, certificates, pairing secrets, or trusted-device records between computers, into Git, or into a package. Normal launches use Electron's standard per-user application-data location. `host.log` lives in that profile directory and can help diagnose startup failures; review and redact diagnostics before sharing them.

## 3. Check Tailscale before pairing

Orbit finds `tailscale` on `PATH` or at these existing locations: `/usr/bin/tailscale`, `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, and `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. It does not install a CLI or create a symlink.

Check the executable your installation actually supplies:

```bash
if command -v tailscale >/dev/null 2>&1; then
  tailscale status
elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
  /Applications/Tailscale.app/Contents/MacOS/Tailscale status
else
  printf '%s\n' 'Tailscale CLI not found: review the installation and CLI documentation.'
fi
```

If the CLI is elsewhere, put its real directory on `PATH` before launching the development app. Orbit keeps remote listening disabled when it cannot verify Tailscale. The remote listener uses TCP **47832**; allow only approved controllers to reach approved hosts in your Tailscale policy. The local control listener on **47831** stays on loopback. Pair through a fresh invitation and keep that invitation private. Being visible in the tailnet does not itself grant Orbit access.

## 4. Grant macOS permissions locally

Keep the Mac signed in with an unlocked desktop and a local recovery route during testing.

1. Open **Orbit Remote > Set Up Mac Permissions…** in the application menu, or the same item in Orbit's menu-bar icon. Choose **Request Screen Recording** or **Request Accessibility**. Requests follow an explicit local action; opening the app does not grant access.
2. In **System Settings > Privacy & Security > Screen & System Audio Recording** (called **Screen Recording** on some macOS versions), allow the application macOS identifies for Orbit's screen capture. See [Apple's screen permission instructions](https://support.apple.com/guide/mac-help/control-access-to-screen-and-system-audio-recording-mchld6aa7d23/mac).
3. In **System Settings > Privacy & Security > Accessibility**, allow the application macOS identifies for Orbit's keyboard/mouse control. See [Apple's Accessibility instructions](https://support.apple.com/guide/mac-help/allow-accessibility-apps-to-access-your-mac-mh43185/mac).
4. Quit Orbit from its menu-bar menu and relaunch after changing permission settings if requested by macOS. Check capture and input capability in Orbit before enabling remote control.

Development capture runs in a `dotnet` child and uses `/usr/sbin/screencapture`; input is produced by that host through CoreGraphics. Permission attribution may therefore differ between a terminal-launched build and a packaged `.app`. Approve only the actual Orbit launch chain you have inspected. The setup dialog reads the host's capabilities, can request approval, and links to the two fixed settings pages; macOS retains control of consent. A changed binary, path, signing identity, or launch method may require renewed approval.

Do not disable macOS security protections or bypass consent to make a test pass. This preview has no macOS locked-screen, login-window, FileVault preboot, or remote-lock implementation. Startup at user login is distinct from access before login. The installed app has a start-at-login option; its actual operation and permissions after login must be tested on the Mac. The development app starts manually.

## 5. Build a Mac package

```bash
bash scripts/build.sh --package
```

The script chooses `osx-arm64` on Apple silicon or `osx-x64` on Intel, publishes a self-contained host into `artifacts/host/<runtime>/`, writes build metadata, builds the renderer, and invokes the local Electron builder for a matching DMG. The installed app bundles the .NET runtime; end users do not need the SDK. Find the generated DMG under `apps/desktop/release/` (the build log prints the output path).

For a deliberate alternate architecture build on macOS, use `bash scripts/build.sh --package --runtime osx-x64` or `osx-arm64`; test it on the target architecture. The script refuses Windows/Linux runtimes on a Mac, and the packager checks that the bundled host matches the selected desktop target. Build output is ignored by Git. Do not commit generated runtimes or installers.

Creating a DMG does not establish a distributable signed release. [Electron's macOS release guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing) requires code signing and notarization for normal distribution. Configure your own signing credentials outside source control, account for the nested native host, and verify the complete installed bundle. This repository does not supply an Apple Developer identity or claim a notarized Mac release.

For a local preview without an Apple Developer identity:

```bash
ORBIT_PACKAGE_OUTPUT="$HOME/Library/Caches/OrbitRemoteBuilds" \
  bash scripts/build.sh --package --adhoc
```

`--adhoc` explicitly signs the bundle with a local identity, disables hardened runtime for that local preview, and skips notarization. It does not produce a Developer ID release or establish Gatekeeper acceptance on another Mac. The default distribution configuration retains hardened runtime and JIT entitlements for Electron and the bundled .NET host.

`ORBIT_PACKAGE_OUTPUT` optionally places generated packages outside the checkout. This is useful when Documents is managed by a File Provider that adds Finder metadata and causes `codesign` to reject generated binaries. Use a local cache output rather than stripping OS security attributes. Copy **Orbit Remote.app** from the mounted DMG into **Applications** or **~/Applications** before launching; end users do not need Node.js or .NET installed.

The same shell scripts support Linux (`linux-x64`/`linux-arm64`); `--package` requests AppImage and Debian outputs. The current Linux host supports local X11 with `systemd-logind`, `ffmpeg` with `x11grab`, `xdotool`, `xrandr`, and `xclip`. Wayland and pre-login control remain separate work.

## 6. Validate before extending

Install the locked desktop dependencies, then run the Mac checks from the repository:

```bash
npm --prefix apps/desktop ci --no-audit --no-fund
bash scripts/check-mac.sh --expect-interactive
```

The standalone launcher resolves macOS's temporary-directory alias, runs the native Mac and host harnesses, desktop tests, production build and production dependency audit, then runs the Mac Electron tests. It works in a product-only checkout without internal coordination files. Tests use isolated profiles and loopback-only pairing. The session test verifies denied Screen Recording behavior when access is unavailable; the UI/native-control checks require local approval to exercise real frames and input.

To exercise the installed app with actual pointer/keyboard and clipboard operations after local OS approval:

Playwright attaches through the inspector, which release builds disable with Electron fuses. Run these checks against a test-only build made with `ORBIT_UNFUSED_TEST_BUILD=1 npm run package:mac` (output in `apps/desktop/release/unfused-test`), never against a release build.

```bash
ORBIT_MAC_TEST_APP="$HOME/Applications/Orbit Remote.app" \
ORBIT_MAC_TEST_CONTROL=1 \
  bash scripts/check-mac.sh --expect-interactive
```

The control check clicks and types only in temporary test windows on the available displays, checks Shift/release behavior, restores the clipboard and cursor, and shuts down its host. It also tests crash recovery and deliberate host-stop enforcement. It does not save desktop images, clipboard data, invitations, or private identities to test artifacts. The Windows smoke test remains separate in `desktop.spec.ts`.

When macOS reports a locked desktop, the interactive Electron tests explicitly skip. A separate test checks that capture, input and clipboard capabilities are disabled, monitor details are absent, and both view-only and control session creation are refused. It never locks or unlocks the Mac or performs input, capture or clipboard operations. A locked-desktop pass does not establish interactive access; `--expect-interactive` still fails until a local user unlocks the desktop.

Add `--frame-fallback` to the check command to exercise the actual Mac frame endpoint with a requested scale and conditional validator. It must still return a full-resolution PNG with scale 1 and no ETag. The Mac UI test also measures the login keychain before launch, during execution, after a forced test-host termination/restart, and after quit. Only counts are returned; private key bytes and keychain labels are never requested.

Add `--imageio` to run synthetic native ImageIO JPEG round-trip checks and a 1080p encoder microbenchmark. It checks channel order, orientation, ignored alpha, bounds, cancellation and concurrent encodes. This encoder-only component does not enable JPEG on the current encoded-PNG Mac capture path; its timings are not live sharing FPS.

Add `--capture-pipe` for the proposed native helper's managed framing/credit fixtures. They use synthetic bytes, including a full 4K BGRA payload, and perform no screen capture or permission changes. They do not establish ScreenCaptureKit or native-helper execution.

See [`TODO.md`](../TODO.md), [`PLAN.md`](PLAN.md), and [`VALIDATION.md`](VALIDATION.md) for release gates and the current evidence. Prioritize real Mac/Windows pairing in both directions, permission-denied behavior, Retina and negative monitor coordinates, modifier release on disconnect, revocation during an active session, sleep/wake, and Tailscale reconnection. Record exact hardware/OS, architecture, source commit, permission attribution, direct/relay path, and failures. Locked-screen support, persistent services, a native macOS permission helper, low-latency video, signing/notarization, and native secret storage must remain explicit next steps until implemented and verified.
