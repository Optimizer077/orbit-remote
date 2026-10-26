# Validation record — 26 October 2026

Environment: Windows x64, .NET SDK 10.0.200, Node.js 24.20.0, Electron 45.0.0, installed Tailscale 1.104.2. Dates use the user's Asia/Seoul context.

## Verified locally

- Native host Debug/Release compilation with warnings treated as errors.
- Self-contained Windows x64 host publish, Electron unpacked application packaging, and unsigned per-user NSIS installer/portable EXE generation. Clean-machine installation and portable extraction/lifecycle remain separate validation tasks.
- Backend harness: **132/132 checks passed** for the updated source. Includes a real temporary TLS server, client certificates, pairing/replay, revocation, permissions, safe file paths, input leases, PNG integrity, DPAPI persistence, owner-pipe shutdown, monitor selection, strong TLS policy, and durable host-stop/resume semantics.
- Desktop tests: **37/37 checks passed**. Includes pin verification before sending a pairing secret, address/invite validation, bounded responses, view-only denial, independent monitor geometry, end/reconnect races, shared renewal, stale frames, bounded input, revoked identities, packaging guards, weak TLS refusal, hostile pairing-ID collisions, terminal host stops, and omission of internal resume epochs from renderer status.
- Actual Electron development application and unpacked Windows application exercised end to end with isolated test data and loopback-only TLS. The test creates an invitation, pairs two roles, captures the real Windows desktop, checks view-only rejection, changes the display name, ends sessions, revokes authorization, and rejects invitation replay.
- Packaged application test deliberately terminates only its own host subprocess, verifies supervised restart, verifies identity persistence, and obtains a fresh desktop frame through session renewal.
- Renderer type checking and optimized production build.
- Orbit, Midnight and Paper theme selection, persistence through renderer reload, and light/dark system appearance changes exercised in the real desktop application. Theme screenshots were visually inspected.
- Existing-display screen windows exercised with real PNG frames on the local Windows desktop: fixed monitor selection, restricted IPC, rejection of a different session/monitor, independent close, and parent-session cleanup. Synthetic two-monitor tests verify concurrent geometry mapping; this is not evidence of physical dual-monitor or virtual-driver validation.
- About diagram, keyboard tab navigation, reduced-motion behavior, and view-only invitation defaults exercised through the desktop application. Bash handoff scripts pass syntax checks; they have not been executed on macOS/Linux here.
- Link encryption policy: the current suites above include allowlist/refusal checks and weak TLS 1.2 servers that never receive a pairing secret. Live probe of the real Windows host in loopback mode, Node 24 client: TLS 1.3 AES-256-GCM/X25519 and TLS 1.2 ECDHE-RSA-AES256-GCM/P-384 are served; CBC-only (`ECDHE-RSA-AES256-SHA`) and static-RSA (`AES256-GCM-SHA384`) clients are refused, although both were served before the policy. Electron's BoringSSL client was probed against Node TLS servers with the same policy and results. Schannel negotiated classical X25519, not `X25519MLKEM768`. Refusal logging is rate-limited to avoid a log flood.
- Electron end-to-end checks accept allowed TLS 1.2/1.3 with forward secrecy, show the measured link, and compare the self-paired host's security code with its device-dialog code. TLS 1.3 was observed in this Windows loopback run. This is not a human comparison between two physical computers.
- Durable stop checks: 28 deterministic state checks include resume expiry, migration, persistence, normal restart, and rejected power-without-control grants. Seven actual mTLS API checks verify host-issued epochs, disconnect-all and single-session host-end returning terminal 410 on stale renewal, and explicitly authorized new connections. Client tests verify no further automatic renewal and safe closing of an ended viewer.
- The development Electron UI opens a view-only session, ends its actual incoming host session, observes terminal 410, disables access, clears the old image, and confirms no replacement session appears for 650 ms. Disconnect returns cleanly to the workspace. Normal supervised crash recovery still succeeds.
- Production npm dependency audit reported zero known vulnerabilities at the time of checking. This is a package-database result, not a security audit of Orbit or Electron.

## Not established by these checks

- Real sessions between two separate physical computers or over a DERP relay.
- Valid native keyboard/mouse injection, clipboard writes, actual lock, actual OS restart, or startup-at-sign-in registration. The tests intentionally avoid these desktop side effects.
- Locked/sign-in/UAC screen support or reboot recovery before a user logs in. These are unsupported in this build.
- macOS or Linux runtime correctness, permission UX, packaging/signing, or any Wayland support.
- Creating, resizing, or removing virtual host monitors. No virtual display provider/driver is implemented or installed.
- Hardware video encoding, audio, long-run stability, large-scale performance, independent security review, or production suitability.

Future device validation should record exact OS/hardware, monitor/DPI layout, keyboard layout, source commit, Tailscale connection type, permission state, tests performed, failures, and recovery steps. See `PLAN.md` for the release gates.
