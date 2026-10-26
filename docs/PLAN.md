# Orbit Remote implementation and release plan

The requested product is a private, capable remote desktop service with a GUI on Windows, macOS, and Linux. Each computer may act as host or viewer. Shared access is explicitly authorized, scoped, and revocable. Locked-screen control, startup, restart, and reconnection are first-class requirements.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current processes, trust boundaries, pairing sequence, and shared-session screen windows. [PERFORMANCE.md](PERFORMANCE.md) defines the current PNG pipeline and measurement work; [VIRTUAL_DISPLAYS.md](VIRTUAL_DISPLAYS.md) covers the separate native work to create extra host monitors. The actionable handoff is [TODO.md](../TODO.md).

## Implemented foundation

- Separate native host and isolated desktop renderer.
- Tailscale-only network exposure, real source-node verification, pinned mutual TLS, expiring one-time invitations, per-feature grants, and local revocation.
- Real desktop capture, monitor enumeration, typed native input, text clipboard, constrained file transfer, audit records, and opt-in power operations.
- One controlling session, concurrent view-only sessions, session renewal, bounded/coalesced input, independent input cleanup leases, host supervision, and owner-death cleanup.
- Polished five-page desktop application, explicit control focus, safe disconnect, native file selection, diagnostics, and honest unavailable states.
- Actual Windows native capture and real TLS end-to-end validation. Other native backends compile, with capability guards and documented runtime dependencies.

## Gate 1 — prove cross-platform sessions

Build and test native packages on Windows, Apple silicon macOS, and a supported Linux X11 desktop. Verify all nine viewer/host OS combinations. Exercise keyboard layouts, Unicode entry, modifier combinations, macOS points vs pixels, negative monitor origins, Retina/DPI scaling, headless and disconnected displays, clipboard behavior, file permissions, direct/DERP paths, and network interruptions.

Validate existing-display windows within one authenticated session: simultaneous monitor views, per-window frame geometry, a single control gate, focus/input cleanup, closing one screen without ending other views, and parent-session shutdown. This is display viewing within the existing desktop; no virtual display driver/provider is implemented.

Done means a repeatable manual/automated matrix with source versions, exact hardware/OS, performance results, and recorded limitations. Compilation alone does not pass this gate.

## Gate 2 — unattended lifecycle

The current user-session host cannot provide locked/sign-in access. Windows needs a minimal system broker and authenticated session workers, restricted IPC, authenticated local control, appropriate secure-desktop handling, and installation/uninstallation with recovery. Never run the full GUI as SYSTEM or weaken UAC to make control work.

macOS needs approved persistent startup and permission handling, verified Tailscale connectivity across user sessions, and tested login-window behavior. FileVault cold boot and authenticated restart are distinct cases; use only supported OS recovery mechanisms. Linux needs separate tested X11/login-manager and compositor-supported Wayland designs. Wake from sleep requires supported hardware or a separate always-on helper.

Required lifecycle sequence per target: connect unlocked → lock → authenticate at sign-in → return to same desktop → sign out → sign in → restart → recover before login where supported. Also test cold boot, power failure, crash recovery, and revoked controllers during every transition. Label software-only gaps and optional hardware recovery explicitly.

## Gate 3 — video and functional depth

Replace PNG polling with a negotiated low-latency video transport and established codecs. Add hardware encode/decode adapters, frame pacing, backpressure, congestion adaptation, resolution/quality controls, text clarity modes, cursor separation, audio, multiple display views, and explicit quality/latency diagnostics. Benchmark rather than advertise an unverified frame rate.

Start with the stage and workload measurements in [PERFORMANCE.md](PERFORMANCE.md). The current viewer waits approximately 260 ms after each completed frame request, with capture/encode, transport, and presentation costs in addition. Additional screen windows increase work; virtual monitors do not remove these costs. Implement extra host displays only through the separate provider, policy, installation, and cleanup gates in [VIRTUAL_DISPLAYS.md](VIRTUAL_DISPLAYS.md).

Then add resumable larger file transfers, narrowly scoped folder access, bidirectional clipboard rules, optional privacy modes where supported, session recording with explicit local policy, and temporary guest authorization. Keep every added channel separately permissioned and revocable.

## Gate 4 — secure release

Use native secret stores everywhere, define identity rotation/recovery, harden dependency and update handling, implement code signing/notarization and authenticated updates, complete fuzzing/resource limits and long-run tests, and obtain independent security review. Add policy migrations, support bundles that redact secrets, repeatable packaging, and clean uninstall/startup recovery.

Do not mark locked-screen access, boot recovery, Wayland, hardware video, audio, or signed updates complete until their respective implementation and real-device tests pass. The current preview is intended for evaluation on trusted private devices with accessible local recovery.
