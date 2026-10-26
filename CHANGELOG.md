# Changelog

Changes are documented by preview release. Application/package version `0.1.0` identifies the current development line; `v0.1.0-preview.1` identifies its initial preview distribution. The [validation record](docs/VALIDATION.md) is the source for completed checks, and [TODO.md](TODO.md) tracks remaining work.

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
