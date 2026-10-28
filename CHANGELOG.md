# Changelog

Changes are documented by preview release. Application/package version `0.1.0` identifies the current development line; `v0.1.0-preview.1` identifies its initial preview distribution. The [validation record](docs/VALIDATION.md) is the source for completed checks, and [TODO.md](TODO.md) tracks remaining work.

## Unreleased

Changes on the development line since 0.1.0-preview.6. None yet.

## 0.1.0-preview.6 — 2026-10-28

Windows x64 development preview. The application and package version stay `0.1.0`.

### Security

An internal security review of the host, the desktop app and the build found no Critical or High findings. Both Medium findings are fixed, and so are most Low ones. Every finding, its fix and the remaining limits are in [the October 2026 security review](docs/SECURITY-REVIEW.md). Releases up to and including preview.5 do not contain these fixes. preview.2 to preview.4 were built without the Electron fuses and are marked Outdated on GitHub.

- **Paired-host data is checked (Medium, D-1):** names, addresses and other values a paired computer sends are checked for type, length and characters before Orbit stores or shows them. Saved connections are repaired on load. A rendering error shows a recovery screen instead of a blank window.
- **Debug switches are refused (Medium on macOS, D-2):** the installed app exits with a message if it is started with a Chromium debugging or sandbox-weakening switch, such as `--remote-debugging-port`. It also ignores the test variables that move its profile or put its host into test mode, and gives its host no `ORBIT_*` variables. DevTools are off in release builds.
- **Desktop:** the file-transfer folder can only be chosen in the system dialog. Remote file names with bidirectional or invisible characters, or Windows device names, are refused.
- **Host:**
  - Clipboard access has a per-device budget and is recorded in Activity.
  - Work before authentication is bounded.
  - Disk, audit and session use by a paired computer is bounded.
  - Refused pairing attempts and unknown certificates are recorded.
  - Native error text no longer reaches the other computer.
  - A blocked computer can no longer read `/api/info`.
- **Runtime:** release builds now require .NET SDK 10.0.403 and bundle the .NET 10.0.14 runtime, which includes the .NET security updates since 10.0.4.
- **Build:** `build.ps1` refuses to package the unfused test build.

### Easier pairing

- **Choose a direction on first run:** instead of one "Create your first invite" button on both computers, Orbit offers **Let another computer see this one** and **See another computer from here**, and each step says which computer does what. Elsewhere the host side reads **Invite a computer** and the viewer side **Join with an invite**.
- **See only or See and control:** the invite dialog opens with this one choice, and **See only** is selected by default. Clipboard, files, and power stay separate opt-in switches. **Lock & restart** is off and disabled while See only is selected, because power needs control. A disabled **Take control** button now says why and suggests asking for a new invite with See and control.
- **Invite countdown:** the invite shows **Expires in m:ss**, offers **Create a new invite** once it has expired (the expired invite can no longer be copied), and says "*device* joined" when the other computer pairs.
- **Security code right after joining:** a successful join keeps the dialog open, shows the host's security code and where to compare it on the host, lists what was granted (for example "See only, plus clipboard"), and offers **Connect now** or **Later**. Pairing alone still never connects. The new device is checked at once, so it shows its platform and online state instead of "Not checked".
- **Get started first:** on first run, Overview opens with a **Get started** card that offers both pairing directions before the status tiles. Step 1 shows this computer's real Tailscale state (on, off, not installed, or couldn't check) and the matching fix. The Devices page's empty state offers both directions too.
- **Pairing steps:** both pairing dialogs show a three-step indicator. When the other computer joins, the invite dialog shows this computer's security code, so both sides can compare at the same moment.
- **Errors in plain language, with one next action:** timeouts, unreachable devices, expired or used invites, clocks that disagree, revoked access, unavailable remote listening, incomplete invites, and changed identities each get a plain title and a single next step. The original error text stays under **Details**. This applies to pairing and to the connect error banner.

### Clearer status

- **Re-check Tailscale without restarting Orbit:** if Tailscale was off when Orbit started, **Tailscale is on now — check again** (in the Overview network tile and the pairing dialogs) restarts the background host so it can listen. It does so at most once every 10 s, and never while another device has a session open.
- **Typed Tailscale status:** the host now reports its Tailscale state (connected, off, not found, or unknown), and the top bar shows **Tailscale off**, **Tailscale not found**, or **Tailscale status unknown** from that state instead of matching error text. Malformed Tailscale output reads as unknown.
- **Check availability contacts your devices:** the Devices page button used to reload only local state. It now runs the same network check as the top bar, reads **Checking…** while it runs, and ignores a second click.
- **Mac permission banner:** when a Mac host lacks Screen Recording or Accessibility permission, Overview names the missing permission, says to quit and reopen Orbit after allowing it, and opens the existing permission setup. The button grants nothing by itself; each macOS request still needs its own approval.
- **Plainer wording:** the Protection tile reads **Private, encrypted connection**, with the WireGuard and mutual TLS details under a disclosure. Devices read **Can see this computer** or **You can see it**, a device you blocked reads **Access paused by you**, and Settings talks about invites and this computer instead of host policy.
- **Plain words everywhere:** the rest of the app now says "this computer" or "the other computer" instead of host or device. Permissions read **Allowed** or **Not allowed** instead of granted, **Revoke** is now **Remove access…** with a confirmation that says what happens, and a removed computer reads **Access removed**. A computer's **⋯** menu opens a details dialog listing what it can do, with its address, pairing date and ID under **Connection details**. Activity events have plain names, such as **Connection started** and **Computer paired**, and Connections lists the computers that can see this one again.

### Viewer

- **Consistent colour, contrast, and shape:** buttons, button groups, and panels each have one corner shape, while status pills stay round. The selected toolbar mode is marked with the accent colour, and the keyboard-focus frame around the remote picture stays visible on top of it, including while scrolled at **1:1**. Text and control contrast is checked over black, white, and checkerboard remote pictures in every theme, and recovery screens fit a 720×480 pop-out window and a 360 px-wide window.
- **Ember theme:** a warm dark theme. Settings and the command palette now offer five appearance choices, and Ember's faint text meets the checked contrast pairs.
- **Software decode fallback:** if the hardware decoder refuses the stream or fails before its first frame, the viewer retries once with software decoding before falling back to images.
- **Input batching:** the viewer keeps one input request in flight and sends everything queued meanwhile as one batch of up to 64 events, merging consecutive mouse moves. The host applies a batch in order with the same per-event permission checks and releases held keys and buttons if a batch fails. Older hosts still receive one event per request.
- **Timing in Connection details:** new rows show the viewer's own pipeline time, from arrival to drawn (typical and slow, p50 / p95), and the control round trip. They exclude host capture, encoding, and network time, so they are not click-to-screen latency.
- **Keyframe check:** the viewer checks each video frame's keyframe flag against its H.264 content instead of trusting the host, and treats a mismatch as a stream error.
- **Image mode fix:** in image mode the session re-rendered on every received frame, a regression in preview.5. It now re-renders only when the display state changes.
- **Named toolbar buttons:** at widths up to 1000 px, where button text is hidden, every toolbar button keeps a short accessible name.
- **Newest frame first:** the viewer keeps up to three video messages in flight to its decoder instead of one. It still decodes every frame, but draws at most one frame per display refresh, always the newest. A frame replaced before the next refresh is counted as replaced, not dropped. In a generated-video bench, the p95 time from a parsed frame to the canvas draw at a paced 60 fps was 1.3 ms, against 1.2–1.6 ms for the previous code, and bursts stayed within 1 ms of the previous code. This bench is not click-to-screen latency.
- **Toolbar:**
  - While you control the other computer and the toolbar hides, a small **Controlling** pill with the release shortcut (Ctrl+Alt+Enter) stays on screen. Clicks pass through it.
  - Close screen and Disconnect sit at the end of the toolbar.
  - Fullscreen, Expand and Fit have distinct icons, and Fit and 1:1 show which one is active.
  - At 1280 px the full-window toolbar fits on one row.
- **Decoder in Connection details:** the video section shows **Decoder** (Hardware, Software, or Not confirmed), **Replaced before display**, and **Dropped frames**. Hardware is shown only after that decoder has produced a frame.

### Look and feel

- **Bolder Daylight and Graphite:** Daylight has a deep-navy sidebar, a vivid teal accent, and solid teal primary buttons. Graphite moves from grey to navy-charcoal. Both themes use solid fills, component borders at 3:1 contrast, and an opaque viewer toolbar. Midnight, Paper, and Ember are unchanged.
- **Contrast check in `npm test`:** every text pair must reach 4.5:1 and every component and focus colour 3:1. The status colours must also stay distinguishable under simulated protanopia and deuteranopia.
- **Recoloured logo and icons:** the orbital mark, the app and tray icons, and the README banner move from mint to the teal and navy of these themes. Their shapes are unchanged.
- **Appearance cards line up:** the five theme cards have one size. They wrap as 5, 3 + 2, or 2 + 2 + 1, depending on the width of the Appearance card.
- **Settings explain themselves:** **File transfer**, **Lock & restart**, and **Start Orbit at sign-in** each say what On and Off do. Unsaved edits show a save bar with **Discard changes** and **Save changes**, and nothing is sent before Save. Once saved, the bar shows the values the computer actually stored. Network and certificate details sit under disclosures, and text links underline on hover.
- **Safer removal:** **Remove access** and **Forget** send one request even after a double click, and Forget says that an open connection to that computer ends.

### Keyboard and screen readers

- **Focus stays where you are working:**
  - Shift+Tab inside a dialog stays in the dialog.
  - **Join with an invite** puts focus in the invite field, and Escape returns to the button that opened the dialog.
  - Focus lands on a live control or heading after Create invite, pairing, saving or discarding Settings, replacing the identity, Remove access, Forget, Connect, and Disconnect.
- **Announcements:**
  - Messages such as "Settings saved." come from a status region that stays mounted, so screen readers announce them. Errors stay alerts.
  - **Copy security code** in Settings confirms with "Security code copied.".
  - The viewer announces "Back to live video." once when it recovers on its own.

### Performance

- **Quieter background refresh:** a status refresh that brings no change no longer re-renders the window. Before, each refresh re-rendered every component, including all 500 Activity rows.
- **No polling while minimized:** minimized or hidden in the tray, the window stops refreshing in the background. When it is shown again, it refreshes at once.
- **Faster Activity page:** dates are formatted with two shared formatters instead of building 1000 per render.

### Reliability

- **GPU encoder binding race:** while the video encoder opened, a capture recovery at the same moment could release the GPU device under it, which could crash the stream-reopen path. The encoder now holds its own references during the open. A failed open is cleaned up at once.

### Windows on ARM

- `Start-Orbit.cmd` starts the native ARM64 package on ARM64 Windows.

### Development

- **Headless host tests:** `ORBIT_TEST_SKIP_NATIVE_DESKTOP=1` skips only the live desktop-capture checks and the four direct native-input probes, and prints each skipped check. Unset, every check runs as before.
- Colour-conversion (NV12) checks with odd and tiny sizes and unaligned data now run in the host suite on every OS.
- **Regenerated screenshots:** README screenshots now come from a generated demo with fictional names, example addresses, and a generated picture, plus a new gallery of the first-run chooser, the invite countdown, the viewer, and the display-asleep notice. The pairing diagram uses the app's current labels.
- **README matches the app:** pairing steps, settings and page names use the app's current labels. The session figure now shows releasing control with **Control enabled** instead of Esc (Esc goes to the remote computer while controlling), and the permissions figure shows the real 32 MiB transfer limit instead of 16 MiB.

- **README and results:** a rewritten introduction. [RESULTS.md](docs/RESULTS.md) and [PERFORMANCE.md](docs/PERFORMANCE.md) add the 27–28 October results: the viewer presentation bench, a stability sweep, a crash investigation, and the theme contrast check.

### Experimental and off

- **Short pairing code:** the host contains an experimental short pairing code (SRP-6a). It is off and cannot be enabled in the packaged app, which starts its host without any `ORBIT_*` variable. Pairing still uses the invitation. The host now includes Bouncy Castle C# 2.7.0 (MIT) for it, and its licence notice ships as `THIRD_PARTY_NOTICES.md`.

### Not in this release

- The bitrate safety net for very noisy content, and later work on the streaming engine and diagnostics, are still in development.

## 0.1.0-preview.5 — 2026-10-27

### Hardware video, on by default

- **GPU capture:** Windows hosts capture the screen with DXGI Desktop Duplication on the monitor's GPU: 4.4 ms per changed frame at 3024×1898, and almost nothing for an unchanged screen.
- **Hardware H.264:** frames are encoded by the GPU through Windows Media Foundation in low-latency mode with no B-frames: 2.5–2.9 ms per 1080p frame, 5.8–7.6 ms at 3024×1898.
- **Hardware decode:** the viewer decodes with WebCodecs (Chromium uses D3D11VA, VideoToolbox, or VA-API) in 0.5–0.7 ms and draws in 0.2 ms.
- **Measured live:** 59.3 fps at native 2560×1440 on a real desktop at about 300 KB/s. A 60-second synthetic test drew 3601 of 3601 frames at 60.0 fps (frame interval p95 17.7 ms), and two viewers both held 60 fps. All on one Windows PC with an NVIDIA RTX GPU; click-to-screen latency has not been measured.
- **Image fallback:** when video can't run, the session uses images. The image path now reuses connections and sends binary frames; Windows hosts pick the smaller of PNG or JPEG for each frame.
- **Recovery:** video returns about 0.45 s after a restarted host is healthy (1.9 s from stopping it), one-click **Reconnect** takes about 0.42 s, changing quality without restarting the stream about 0.13–0.15 s, and a capture reset leaves a gap of about 0.15 s.

### A better viewer

- **Full-window viewer** with **Fit** / **1:1**, native fullscreen, and pop-out viewer windows.
- **Display asleep:** when the remote display is asleep or off, the viewer says so instead of showing a frozen picture, releases held keys, and checks again every few seconds. With control permission, **Wake display** sends a wake request (not in view-only sessions; once every 5 s).
- **Smoothness meter and Connection details** from the viewer toolbar.
- **Local cursor:** the viewer draws the pointer itself; the host sends cursor shapes separately from the video.
- Updates **pause while the window is minimized**, and **Reconnect** is one click after a host restart.
- Keyboard focus is visible, reconnects are announced to screen readers, and the session toolbar no longer intercepts clicks meant for the remote screen.

### Security hardening

- **Locked-down installed app:** Electron fuses disable running as Node.js, `NODE_OPTIONS`, and inspect flags, and the app loads only from its integrity-checked archive. Packaged builds ignore a development renderer URL.
- **Received files are marked** as downloaded from the internet (Windows Zone.Identifier, macOS quarantine).
- **A changed device identity is final** and shown clearly. Session-end decisions use typed error codes, never message text.
- A device you blocked shows **Disconnected by you · Allow again**.
- The host accepts large request bodies only on upload routes, shuts down and drains within a bound, and caps streams per device and per host.

### Mac

- Modifier keys are applied to remote input on Mac hosts.
- The Mac app runs from source; there is no signed Mac download yet.

### Known limits

- Mac and Linux hosts send images, not video.
- Only an NVIDIA hardware encoder has been measured; AMD and Intel encoders are untested.
- Very busy or noisy screen content can exceed the bitrate target.
- Video between two computers and click-to-screen latency have not been measured.

### Notes

- Windows binaries only; macOS and Linux run from source.
- Evidence: see the release notes.
- Experiments, measured results, failed runs and decisions: [docs/RESULTS.md](docs/RESULTS.md).

## 0.1.0-preview.4 — 2026-10-26

### See who is on your computer

- **"Being viewed" banner:** when another device views or controls this computer, a banner names it ("Ali's MacBook is viewing this screen · 4:12"), shows whether it can use your mouse and keyboard, and offers **End session** per session or **Disconnect all**. Multiple sessions from one device are counted accurately.
- **Tray badge:** the tray icon shows when someone is connected (amber when viewing, red when controlling; macOS shows a menu-bar marker).
- **Disconnect all** now uses the host's own disconnect, which also stops queued automatic reconnects.

### Clearer devices

- Device cards show **permission chips** (View · Control · Clipboard · Files · Power, each marked granted or "Not granted") and an **In session** state.
- A device whose access was revoked by its host now says **Access revoked** with **Forget** and **Pair again**, instead of looking "offline".
- The sidebar uses the real Orbit wordmark.

### Reliability and security

- File transfers up to **32 MiB**, matching the host, with timeouts that grow with file size and a clear message for larger files.
- The app now **proves the local host is its own child process** before sending it any token: a per-launch secret over the process pipe and a fresh challenge on every local connection, bound to that exact connection. It also finds the Tailscale tool itself instead of running a path reported by the host.
- Status reports the real listening port.

### Notes

- Windows binaries only; macOS and Linux run from source.
- Evidence: 211 host checks, 76 desktop checks, 51 UI-lab checks, production build, and the real Windows Electron end-to-end test.

## 0.1.0-preview.3 — 2026-10-26

### A new interface

- New themes: **Daylight** (bright default) and **Graphite** (neutral dark), plus refreshed Midnight and Paper. The green "Orbit" theme is retired; a saved Orbit preference now follows the system (Daylight in light mode, Graphite in dark mode).
- Larger, clearer type (nothing below 12 px), stronger surface separation, and WCAG AA text contrast in every theme.
- Redesigned Overview: real-state tiles for network, protection (layer chips and the security code), and sessions; device cards with one-click Connect / View only; a guided first pairing.
- Redesigned Devices, Activity, and Settings pages with search, filters, and keyboard-visible focus.
- **Command palette (Ctrl/⌘ K):** jump to any page, connect to a device, add or join a device, copy the security code, or switch theme.
- **Session HUD:** a floating, auto-hiding toolbar with a link-quality meter measured from real screen updates, an encryption chip, and Reconnecting / Ended overlays. Input is paused while the stream fails.

### Weaker networks (host side)

- **Unchanged screens cost almost nothing:** the viewer asks with the last frame's validator and the host answers `304 Not Modified` when the screen hasn't changed, so the viewer reuses its cached image. An optional clamped `scale` (0.33–1) can shrink frames. Windows hosts support both; macOS and Linux hosts keep full-scale frames. This saves transferred bytes, not capture time.
- **Fairer sharing:** each paired device may hold at most 2 sessions (pop-out windows share one), and ending a view-only session no longer interrupts whoever is in control.

### Notes

- Windows binaries only. macOS and Linux run from source; this interface has not yet been validated on macOS.
- Evidence: 194 host checks, 54 desktop checks, production build, and the real Windows Electron end-to-end test. On macOS, native capture/control and the frame fallback were exercised separately; this interface itself is not yet validated there.

## 0.1.0-preview.2 — 2026-10-26

- Enforce TLS 1.3 or TLS 1.2 with ECDHE and AEAD on both peers; show measured encryption and comparable device security codes.
- Persist automatic-resume authorization so a host-ended session stays ended through process restarts. Explicit new connections remain possible for paired devices; revocation removes their trust.
- Stop polling and disable access after a terminal host stop, with a clear reason and explicit reconnect guidance.
- Refuse pairing-ID collisions with a different pinned certificate; reject power grants without control.
- Improve small app/tray icons, responsive animated/static architecture diagrams, theme gallery, and encryption documentation.
- Expand evidence to 132 host checks, 37 desktop checks, and real Windows UI host-stop/recovery tests. macOS/Linux and physical cross-device validation remain outstanding.

## 0.1.0-preview.1 — 2026-10-26

### Desktop and appearance

- Desktop workspace for devices, connections, activity, and settings; each installation can act as host or viewer.
- Orbit, Midnight, and Paper themes with saved preferences, system appearance matching, and reduced-motion support.
- Original orbital logo, native application/tray icons, brand assets, and an About panel explaining the app and its limits.
- Fit and actual-size viewing, monitor selection, and separate windows for existing host displays within the same authenticated session. This does not create virtual monitors.

### Connections and permissions

- Tailscale-only production listener with source-node verification and no LAN/public fallback.
- Five-minute single-use invitations, pin verification before sending the invitation secret, and mutual TLS device identities.
- Viewing, control, clipboard, files, and power grants enforced on the host; new invitations default to viewing only.
- Multiple view-only sessions, one controlling session per host, explicit input activation, local revocation, and disconnect-all.
- Native screen/input adapters, explicit text clipboard operations, and a dedicated transfer folder with no overwrite on upload and a 16 MiB desktop transfer limit.
- Optional lock/restart requests requiring host policy and device grants. Request acceptance does not establish reboot recovery.

### Recovery and packaging

- Supervised child host, owner-exit shutdown, input queue limits/coalescing, held-input leases, and session renewal with fresh authorization checks.
- Windows x64 per-user installer and portable EXE packaging with bundled host/.NET runtime. Startup remains opt-in; portable startup is unavailable.
- Native macOS/Linux launch/build scripts with isolated runtime outputs and host-binary architecture checks.
- Mac handoff, architecture/trust diagrams, protocol documentation, performance measurement plan, and a separate virtual-display roadmap.

### Preview limits

Windows capture and real loopback certificate-authenticated desktop flows have local runtime evidence. macOS/Linux adapters and build scripts require native-device validation. Native input, clipboard writes, power actions, and startup registration need deliberate platform-specific checks; the automated smoke test avoids those desktop side effects.

Locked-screen/sign-in/UAC control, recovery before login, Wayland, virtual monitor creation, hardware video encoding, audio, native secret stores on macOS/Linux, signed updates, and independent security review remain unfinished. PNG polling is the current screen transport; no FPS or end-to-end latency benchmark is claimed. Windows downloads are unsigned, and no software license is currently declared.
