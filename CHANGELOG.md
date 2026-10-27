# Changelog

Changes are documented by preview release. Application/package version `0.1.0` identifies the current development line; `v0.1.0-preview.1` identifies its initial preview distribution. The [validation record](docs/VALIDATION.md) is the source for completed checks, and [TODO.md](TODO.md) tracks remaining work.

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
