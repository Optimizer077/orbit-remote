# Orbit Remote — next steps

The immediate handoff is **clone on the Mac, run the signed-in desktop, and prove Mac ↔ Windows sessions**. Record real results in `docs/VALIDATION.md`.

Read the [architecture](docs/ARCHITECTURE.md), [performance and benchmark plan](docs/PERFORMANCE.md), and [virtual-display design](docs/VIRTUAL_DISPLAYS.md) before changing session or display behavior. Existing-screen windows share one authenticated session; adding a virtual monitor remains separate native-provider work.

## Ready now

- [x] Public source repository and original project logo/app/tray icons.
- [x] Desktop workspace, three themes, system appearance, reduced motion, and About panel.
- [x] Windows capture and real TLS pairing/revocation checks.
- [x] Separate viewing/input/clipboard/files/power grants and constrained file transfer.
- [x] Session renewal, bounded input, held-input cleanup, process ownership, and supervision.
- [x] Native build scripts, isolated host outputs, and executable architecture checks.
- [x] Built Windows x64 installer and portable EXEs with original icons.

## P0 — start on your Mac

- [ ] Follow `docs/MACOS.md`; install Git, native Node.js 24, .NET 10 SDK, and Tailscale.
- [ ] Clone the repository. Check `uname -m`, `node -p process.arch`, and `dotnet --info` agree on Apple silicon/Intel.
- [ ] Run `bash scripts/start-dev.sh`; verify host startup, Tailscale discovery, and honest capability reporting.
- [ ] Run backend checks, desktop tests, and UI production build; record the source commit and results.
- [ ] Grant Screen Recording and Accessibility locally. Record which process macOS attributes consent to in development and packaged builds.
- [ ] Test Mac viewer → Windows host with view-only first, then explicitly authorized input.
- [ ] Test Windows viewer → Mac host using a separate invitation in that direction.
- [ ] Exercise Retina/DPI, external/rotated displays, negative origins, monitor hotplug, fit and 1:1.
- [ ] Open existing host monitors in separate windows; verify one shared session/controller, correct per-window input coordinates, focus cleanup, closing one window, and parent disconnect.
- [ ] Test keyboard layouts, Unicode/IME, modifiers, key repeat, Escape, focus loss, disconnect, and host crash.
- [ ] Check long-held keys/buttons. Independent ten-second leases currently limit holds unless renewed; design a safe explicit held-input heartbeat if needed.
- [ ] Test expired/replayed invitations, wrong certificates, and revocation during active work.
- [ ] Verify clipboard/files in both directions, denied grants, existing filenames, traversal rejection, and interrupted transfers.
- [ ] Test sleep/wake and Tailscale offline/online recovery; record direct versus relayed paths.
- [ ] Run `bash scripts/build.sh --package`; inspect and test the matching installed Mac app separately from development.

## P1 — strengthen the Mac host

- [ ] Implement a signed native helper using ScreenCaptureKit instead of CLI screenshots.
- [ ] Add a clear permission wizard with supported macOS APIs, denied/revoked states, and recovery instructions.
- [ ] Validate native pixels versus CoreGraphics points on mixed-DPI and rearranged displays.
- [ ] Integrate Keychain-backed identity storage, rotation, migration, and recovery.
- [ ] Sign the complete app and nested helper; notarize and verify the installed bundle.
- [ ] Validate launch at user sign-in, profile ownership, logout, and path/signing changes.
- [ ] Add a repeatable Mac-native smoke test; keep Windows-only tests labeled accurately.

## P1 — lock, startup, and restart recovery

These remain product requirements, not implemented support. Keep an authorized local recovery route while developing them.

- [ ] Windows: design a minimal privileged broker and separate session workers with authenticated restricted IPC.
- [ ] Windows: implement/test lock, unlock, sign-in, session switching, elevated apps, and UAC without weakening OS protections.
- [ ] macOS: establish supported login-window and pre-login connectivity on exact hardware/OS. Separate normal lock, restart, cold boot, and FileVault recovery.
- [ ] Linux: distinguish existing-desktop sharing, login-manager access, and new remote sessions.
- [ ] Prove unlocked → lock → authenticate → desktop → sign out/in → restart → reconnect on each supported platform.
- [ ] Exercise power failure, process death, network changes, and revocation throughout that sequence.
- [ ] Define supported hardware-assisted recovery where software cannot reach preboot screens.

## P2 — streaming and functional depth

- [ ] Establish the native-device baseline in [PERFORMANCE.md](docs/PERFORMANCE.md): update intervals, capture/encode time, frame bytes, resource use, input latency, and direct/DERP path; no advertised FPS before measurement.
- [x] Replace PNG polling with negotiated low-latency video and hardware encode/decode (Windows hosts, preview.5; Mac and Linux hosts still send images).
- [ ] Add congestion/backpressure handling, frame pacing, quality/resolution controls, text clarity, and measured diagnostics.
- [ ] Add audio with separate grants and visible state.
- [ ] Implement Wayland using supported portals, PipeWire/EIS, and real consent persistence.
- [ ] Improve layout, Unicode, IME, accessibility, and modifier parity across operating systems.
- [ ] Add resumable larger transfers, integrity checks, cancellation, disk-space limits, and safe naming.
- [ ] Add narrowly scoped folder capabilities and temporary guest authorization with expiry/revocation.
- [ ] Consider privacy mode and opt-in recording after defining consent and secure storage.
- [ ] Follow [VIRTUAL_DISPLAYS.md](docs/VIRTUAL_DISPLAYS.md) for any extra host monitor: separate grant/provider, optional driver distribution, quotas, ownership, cleanup, and platform validation. A viewer popout alone does not create desktop space.

## P2 — release, reliability, and security

- [ ] Independently review native adapters, pairing/TLS, main/renderer IPC, files, and privilege boundaries.
- [ ] Finish native secret stores, certificate renewal/recovery, and state migrations.
- [ ] Consider moving outgoing TLS into the host to reduce main-process key exposure.
- [ ] Sign Windows binaries; implement authenticated updates and rollback protection.
- [ ] Activate the CI template with workflow-enabled credentials and native build/test jobs.
- [ ] Run long-duration/resource tests, protocol fuzzing, and hostile/slow-peer scenarios.
- [ ] Expand all nine viewer/host combinations, architectures, layouts, and Tailscale path types.
- [ ] Validate installer/portable launch, upgrades, uninstall/profile retention, shortcuts, and startup on clean Windows machines.
- [ ] Choose and add the project's software license before defining contribution/reuse terms.

## Record completion

For native features, record exact hardware/OS, architecture, commit, permissions, monitor layout, Tailscale path, test steps, observations, and recovery. Keep unsupported states visible. Update `docs/PLAN.md` and `docs/VALIDATION.md` when gates actually pass.
