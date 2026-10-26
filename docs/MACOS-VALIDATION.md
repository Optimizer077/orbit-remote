# Mac validation — 26 October 2026

Environment: physical Apple silicon Mac, arm64, macOS 27.2, Node.js 24.20.0,
.NET SDK 10.0.200, Electron 45.0.0. Baseline source includes `9f5aff5` and
the accompanying T22 Mac smoke-test/output-directory changes. Dates use Asia/Seoul.

## Completed checks

- Native host build: zero warnings or errors.
- Existing security/host harness: **131/131** after local Screen Recording
  approval, including real local mutual-TLS pairing, native frames, certificate
  pinning, session ownership and revocation. Before approval, its denied-state
  run passed **117/117**; the harness conditionally adds native capture checks.
- Mac harness: **17/17**, including actual unlocked-console detection,
  native display-mode backing pixels, identity create/reload/export and private
  file modes, plus synthetic Retina/negative-origin pointer mapping.
- Desktop checks: **41/41**; production renderer build passes.
- Channel `verify --quick`: host build/tests, desktop tests/build, production
  dependency audit and privacy scan all pass. Production audit reports zero known
  vulnerabilities; this is not an independent security review.
- Real development Electron launch, native menus, loopback mutual-TLS pairing,
  denied Screen Recording behavior, invitation replay refusal and revocation.
- Self-contained arm64 host and ad-hoc signed DMG build. Disk-image checksum
  verification succeeds. Complete app passes `codesign --verify --deep --strict`
  before and after copying from the mounted DMG into the user's Applications folder.
- Installed app with locally approved Screen Recording/Accessibility: real PNG
  frames on the Retina and external display agree with backing-pixel geometry.
  The encrypted session reports TLS 1.2/1.3 with forward secrecy under Orbit policy.
- Actual pointer clicks and keyboard input in dedicated temporary windows on both
  displays. Shift produces uppercase input; explicit release clears held Shift.
  The test restores the cursor and all available clipboard formats after its
  remote text-clipboard round trip.
- Installed host subprocess crash: the app restarts its own host, preserves the
  device identity, and renews the authorized session to obtain another real frame.
  An intentional local host stop remains terminal and cannot auto-renew.
- Test app closes, its child host exits, and temporary profiles are removed.
  No private frame, clipboard, invitation or identity is saved as test evidence.
- Normal installed-app launch with loopback-test mode disabled: Tailscale is
  connected, the remote listener is enabled, capture/input are available, and
  the installed start-at-login setting is supported. Only readiness booleans
  were recorded; no private address or machine name was published.

Reproduce with the commands in [MACOS.md](MACOS.md). The Mac-specific smoke test
is `apps/desktop/tests/mac.spec.ts`, selected by `playwright.mac.config.ts`.
`ORBIT_MAC_TEST_CONTROL=1` requires local consent and fails rather than silently
skipping control when those permissions are unavailable.

## Repairs established by these checks

- Use the SDK-defined `kCGSSessionOnConsoleKey` value; the previous spelling
  classified an unlocked Mac as non-interactive.
- Use active display-mode backing pixels instead of point-sized display dimensions.
  Map each display's protocol pixels into its own CoreGraphics point bounds.
- Import the Mac TLS identity with a supported temporary user key container;
  macOS rejects `EphemeralKeySet`. Linux retains its ephemeral import policy.
- Add explicit native permission setup and the standard Mac Edit/application menus.
- Support local ad-hoc packaging and an output directory outside synchronized
  source folders. Default distribution signing retains hardened runtime.

## Remaining device and distribution gates

These checks establish local Apple silicon behavior, not a session between two
physical computers. Mac-to-Windows, Windows-to-Mac, direct versus DERP paths,
sleep/wake, monitor hotplug/rotation, non-US layouts/IME, and actual sign-in startup
remain separate checks. No lock, reboot, login-window, FileVault or pre-login test
was performed. Intel execution remains unverified.

The local DMG is ad-hoc signed, not Developer ID signed or notarized. No Apple
Developer credential is supplied. Keychain-backed durable identity storage,
authenticated updates and independent security review remain release work.
