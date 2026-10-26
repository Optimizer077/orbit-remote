# Security model

Orbit 0.1.0 is a development preview. Automated tests cover specific properties; they do not establish that this application is secure enough for every unattended deployment. No independent security audit has been completed.

## Trust boundaries

1. **Network:** normal remote listening is bound to a Tailscale IPv4 address discovered from the local installed Tailscale CLI. Incoming source identity is checked through `tailscale whois --json`, cached briefly. Tailscale unavailability fails closed. No all-interface listener, public relay, Funnel, or router port mapping is configured.
   **Link policy:** remote TLS must be TLS 1.3, or TLS 1.2 with ECDHE + AES-GCM/ChaCha20-Poly1305. The viewer offers only those suites and re-checks the negotiated suite after each handshake. The host drops any other connection after the handshake and before HTTP parsing, because platform TLS stacks such as Schannel would otherwise accept CBC and static-RSA suites. See [ENCRYPTION.md](docs/ENCRYPTION.md).
2. **Application identity:** every host has a generated RSA certificate with client/server authentication use. Pairing uses a cryptographically random five-minute single-use invitation. The viewer pins the full SHA-256 certificate fingerprint before transmitting HTTP request bytes. Remote requests present a client certificate; the actual TLS certificate must match a current pairing record. Claimed device IDs do not authorize access.
3. **Authorization:** view, input, clipboard, files, and power are separate grants. Input and power require additional relevant permissions. Invitations that grant power without control are rejected at creation. File transfer and power also require explicit local host policy. Permission and revocation checks happen on the host, not only in the GUI. Only one controller may be active.
4. **Desktop:** the host runs with the signed-in user's rights. It does not bypass UAC, screen lock, macOS privacy consent, disk encryption, or Wayland's permission system. Unsupported environments return capability errors rather than implying successful control.
5. **Local GUI:** Electron uses context isolation, sandboxing, disabled Node integration, denied web permissions, navigation restrictions, a strict content security policy, and an action-specific IPC bridge. Remote desktops are PNG data, not executable HTML. File paths are selected through native dialogs.
6. **Lifecycle:** closing the window leaves the main process and host in the tray. The host monitors an owner-held stdin pipe and exits on EOF. The main process restarts failed hosts with backoff. Revocation/disconnect releases held input; independent input leases provide an additional bounded cleanup mechanism.

New desktop invitations start with viewing only. The host owner must explicitly grant keyboard/mouse, clipboard, file, or power access. A viewer must additionally choose **Take control** before sending input. Startup at sign-in is opt-in and does not provide access before sign-in.

Separate screen windows share one authenticated session. Each registered window is bound in the main process to a fixed session and monitor, and cannot manage devices, settings, invitations, or the parent session. Sender checks require the exact bundled page and its main frame. Frame geometry is stored per monitor; late responses from a replaced session are rejected before they can enable input. These windows share the same host desktop and do not provide per-monitor security isolation.

An explicit host stop rotates persisted automatic-resume authorization. The viewer treats stale renewal as terminal, clears access and queued input, and requires a new explicit connection. Normal host lifecycle recovery preserves authorization. This controls automatic recovery; use certificate revocation to prevent a paired device from explicitly connecting again. Internal resume epochs stay out of renderer-facing status. Pairing also refuses a saved host-ID collision with a different pinned certificate.

## Data protection

- Windows certificate bundles use current-user DPAPI. Restoring them under another account fails.
- macOS/Linux key bundles and state folders use user-only modes; integration with native secret stores is not yet implemented.
- The authenticated local main process can obtain the host private key for outgoing mTLS. It is never sent to the renderer, included in invitations, or logged. Moving all outgoing TLS into the host is a future hardening option.
- The fresh local control secret is passed to the owned child through its environment. Processes with same-user debugging/environment access are not contained by this design.
- Pairing invitations are bearer secrets and must be shared through a trusted channel. Verify the host with its owner; an invitation from an attacker identifies that attacker's host correctly.
- Logs record event types and device IDs, not invitation secrets, clipboard text, passwords, or screen contents. The host audit history is bounded; it is local and not tamper-evident.
- Certificate expiry currently requires deliberate identity rotation and re-pairing. Automatic rotation, key recovery, and signed update delivery are not implemented.

## Files and input

Remote file access is confined to one locally configured existing absolute directory. Root folders, directory traversal, invalid/reserved names, and symlink/reparse-point paths are rejected. Uploads use create-new semantics and bounded sizes; existing files are never remotely overwritten. The local directory should be private to the user: malicious local mutation of paths during file operations is outside the current threat model.

Remote keyboard/mouse support uses fixed typed events and static key mappings. There is no general command-execution API. Unsaved work can still be affected by an authorized controller. Lock/restart requests require explicit grants and opt-in policy; successful request acceptance is not proof of reboot recovery.

## Required before a production release

- Independently review the host, Electron bridge, native adapters, pairing design, and dependencies.
- Test real two-computer sessions on each supported OS, keyboard layout, DPI scale, monitor topology, and network type, including relayed Tailscale paths.
- Implement and validate a separately privileged broker/session worker design before claiming Windows sign-in/UAC or system-boot operation.
- Validate macOS privacy permissions and pre-login network reachability on the exact supported hardware/OS versions; provide supported recovery paths.
- Implement Wayland through compositor-supported portals/EIS with real consent and persistence behavior.
- Ship signed Windows binaries, signed/notarized macOS applications, signed update metadata and rollback protections.
- Complete native secret storage, certificate rotation/recovery, dependency monitoring, and resource/load testing.
- Test lock, sign-out, restart, power failure, Tailscale disconnection, host/main crashes, missing displays, and revocation during active work.

Security concerns should be reported privately to the repository owner. No hosted reporting address has been configured.
