# Orbit Remote protocol, version 0.1

This is a working prototype protocol. It provides certificate-pinned desktop sharing in an existing, unlocked user session. It is not a claim of production security, universal login-screen support, or proven restart recovery. Capture and input should run as the logged-in user; do not run the entire desktop app as SYSTEM or disable OS desktop protections.

## Processes and listeners

`Orbit.Host` is a .NET 10 executable. Configuration:

| Setting | Meaning |
| --- | --- |
| `ORBIT_CONTROL_TOKEN` | Required random local control bearer token, at least 32 characters; desktop main process keeps it out of the renderer. |
| `ORBIT_DATA_DIR` | Persistent host state directory. Default: the current user's local application data, `OrbitRemote/host`. |
| `ORBIT_CONTROL_PORT` | Local control port; default `47831`. |
| `ORBIT_REMOTE_PORT` | Remote HTTPS port; default `47832`. Ports must differ and be 1024–65535. |
| `ORBIT_PARENT_WATCH` | When `1`, stdin is a private ownership pipe from the desktop main process. EOF or pipe failure requests graceful host shutdown. Standalone CLI leaves this unset. |
| `--loopback-test` | Explicit integration-test mode: remote HTTPS binds `127.0.0.1`; source identity verification accepts loopback. Never a wildcard listener. |

The local listener binds only `127.0.0.1`; requests require `Authorization: Bearer <token>` and a `127.0.0.1` Host header. Browser Origin and Fetch Metadata requests are refused. There is no CORS policy granting access to websites. Local administrative requests are made by the desktop main process, not renderer `fetch`.

The desktop launches its host child with piped stdin and `ORBIT_PARENT_WATCH=1`, retaining the pipe for the host's lifetime. If the desktop exits or crashes, EOF stops the host through the normal application lifetime path, which ends sessions and attempts to release held keys/buttons. Stdin data has no command semantics. The integration harness explicitly closes its ownership pipe and verifies a clean process exit. Standalone host execution does not enable this watchdog.

At startup, production mode discovers a running Tailscale node through `tailscale status --json`, selects its CGNAT IPv4 address, and binds HTTPS only to that address. If verification fails, local administration remains available and no remote listener opens. Start/restart the host after fixing Tailscale; dynamic rebinding is not implemented. Incoming remote requests must originate from a Tailscale address and pass `tailscale whois --json <actual-source-address>`; successful source checks cache for ten seconds. The source is read from the socket, never an HTTP header. Tailscale CLI is invoked with fixed argument lists, without a shell. See the [official Tailscale CLI reference](https://tailscale.com/docs/reference/tailscale-cli).

## TLS and device pairing

Every remote connection requires a client certificate, including initial pairing. TLS 1.3, or TLS 1.2 with ECDHE and AEAD only, proves private-key possession; both peers reject weaker negotiated suites. A self-signed client certificate is permitted at the TLS layer only if current, sufficiently strong, and marked for client authentication. Application routes then require its exact SHA-256 DER certificate fingerprint to match an unrevoked paired device. An HTTP device ID cannot substitute for the presented certificate. See [ENCRYPTION.md](ENCRYPTION.md) for the allowlist and measured negotiation evidence.

The durable RSA-3072 host identity has server and client authentication EKUs. Windows stores the PFX using current-user DPAPI; Schannel uses a temporary current-user key-container import, removed when its certificate is disposed. Unix persists a private PFX in a mode-0700 directory, with mode-0600 from file creation. Unix does not yet use Keychain/libsecret. Certificate renewal/rotation is not automated; certificates expire after two years. Pair devices again after rotating an identity. No certificate is added to the OS trust store.

The main process retrieves `{certificatePem,privateKeyPem,fingerprint}` through local `GET /api/identity/export`; these secrets must never be returned to the renderer, stored in connection metadata, or logged. Each device uses its own host identity when controlling another machine.

1. On the receiving computer, local `POST /api/invites` supplies the exact intended permissions.
2. The response includes `inviteUri` and `expiresAt`. The URI is `orbit://pair/<base64url-JSON>` with payload `{v:1,address,fingerprint,secret,expiresAt,hostName}`. Address is an HTTPS origin. Fingerprint is uppercase SHA-256 hex. Secret is 256 random bits.
3. The controller explicitly receives this URI. Its main process validates the address, protocol, expiry, payload limits, and server certificate fingerprint before transmitting the secret. Do not follow redirects or use the URI as arbitrary network access.
4. It performs remote `POST /api/pair` with its actual TLS client certificate and `{secret,deviceName}`.
5. Success returns `{deviceId,deviceName,hostId,hostName,permissions,certificateFingerprint}`. The receiver persists the certificate pin and approved grants. The invite is consumed atomically and cannot be replayed; unconsumed invites expire after five minutes and disappear at host restart. Only a secret hash is held in host memory. Pairing is limited to six attempts per source per minute.

Invites are bearer credentials until consumed or expired; share them privately. The host never places invite secrets in audit records or persisted state. Local device revocation removes its sessions and is checked again on requests over existing TLS connections.

## JSON shapes

JSON uses camelCase. Permissions are explicit booleans: `{view,control,clipboard,files,power}`. Pairing requires `view:true`, and `power:true` also requires `control:true`; unchecked grants default false. A view-only session strips all other grants even when the paired device is allowed to control.

Host settings: `{allowRemotePower:false,fileTransferEnabled:false,fileTransferRoot:null,hostName:null}`. Only local administration can update settings. A file root must already exist, be an absolute dedicated directory, and have no symlink/reparse-point ancestors. Disk roots are rejected.

Platform status: `{operatingSystem,sessionState,canCapture,canInput,canClipboard,canLock,monitors,limitations}`. Monitors: `{id,name,left,top,width,height,primary}`. Pointer coordinates use physical pixels in this monitor coordinate space, including negative Windows origins. macOS maps the reported native-pixel monitor coordinates to CoreGraphics points internally. Check capabilities and limitations rather than assuming every platform has every feature.

## Local administration routes

These require the local bearer token and are unavailable on the remote listener.

| Method and path | Request / response |
| --- | --- |
| `GET /api/status` | `{hostId,hostName,version,startedAt,remoteEnabled,remoteAddress,certificateFingerprint,transport,platform,settings,pairedDevices,sessions}`. `transport` includes `mode`, `address`, `error`, `peers`. |
| `GET /api/peers` | Paired-device array: `{id,name,fingerprint,permissions,createdAt,revokedAt}`. |
| `GET /api/tailnet-peers` | Startup discovery snapshot of Tailscale peer inventory. |
| `POST /api/invites` | `{deviceName?,permissions}` → `{inviteUri,expiresAt,permissions}`. Refuses if remote listener is unavailable. |
| `DELETE /api/peers/{id}` | Revoke certificate pin, end sessions and release held input. `204`. |
| `GET /api/audit` | Up to 500 newest-first `{at,kind,deviceId,detail}` events. No clipboard contents, file contents, or invitation secrets. |
| `GET /api/settings` | Host settings. |
| `PUT /api/settings` | Complete host settings object → validated settings. |
| `GET /api/identity/export` | Private client identity, main-process only. Alias: `/api/client-identity`. |
| `DELETE /api/sessions/{id}` | End a receiving session locally and release input. `204`. |
| `POST /api/disconnect-all` | End incoming sessions, invalidate old automatic-resume authorization durably, and release input. `204`. A still-paired device may explicitly Connect again; revoke it to remove trust. |

## Remote routes

All require actual TLS client authentication and an unrevoked paired certificate except `/api/pair`, which requires the valid invite instead. Session ownership is checked against that certificate's paired device.

| Method and path | Behavior / required grant |
| --- | --- |
| `POST /api/pair` | `{secret,deviceName}` → pairing response above. |
| `GET /api/info` | `{hostId,hostName,platform,permissions,settings:{allowRemotePower,fileTransferEnabled}}`. |
| `POST /api/sessions` | `{monitorId:null,viewOnly:false,resumeEpoch:null}` → `{id,deviceId,deviceName,monitorId,permissions,createdAt,expiresAt,lastActivityAt,lastInputAt,resumeEpoch}`. Explicit Connect omits `resumeEpoch`; automatic renewal supplies its previous value. Requires available screen capture and viewing grant. |
| `GET /api/sessions/{id}` | Session status and heartbeat. |
| `DELETE /api/sessions/{id}` | End own session and release held input. |
| `GET /api/sessions/{id}/frame?monitorId=<id>` | PNG. Requires viewing. Optional per-request monitor selection; absent query preserves the session's default monitor. Headers: `X-Orbit-Width`, `X-Orbit-Height`, `X-Orbit-Left`, `X-Orbit-Top`, `X-Orbit-Captured-At`. |
| `POST /api/sessions/{id}/input` | Input object below; requires control. `204`. |
| `POST /api/sessions/{id}/release-inputs` | Release held keys/buttons, requires control. Call on viewer blur, Escape, disconnect, and navigation. |
| `GET /api/sessions/{id}/clipboard` | `{text}`; requires clipboard. Explicit requests only. |
| `PUT /api/sessions/{id}/clipboard` | `{text}` up to 8192 characters, no null characters; requires clipboard. |
| `GET /api/sessions/{id}/files` | Flat transfer-directory inventory, at most 500 entries. Requires files grant and locally enabled transfer folder. |
| `GET /api/sessions/{id}/files/{name}` | Download a single plain filename, at most 32 MiB. |
| `PUT /api/sessions/{id}/files/{name}` | Raw file bytes, at most 32 MiB; creates a new file, never overwrites. Uploads recheck revocation and transfer enablement as chunks arrive. |
| `POST /api/sessions/{id}/power` | `{action:"lock"}` or `{action:"restart"}`; requires both control and power, plus local `allowRemotePower:true`. |

Input objects:

Frame monitor IDs come from `/api/info` → `platform.monitors`. A supplied ID must be one printable string, 1–128 characters, naming an existing host monitor. The native backend rejects unknown IDs. Selecting a monitor for one frame does not mutate the session default, recreate the session, grant additional permissions, or acquire a second controller. Multiple viewer windows may request different existing monitors using the same authenticated session; all input continues through the same serialized control gate and uses the monitor's reported physical coordinates. This maps existing remote displays into separate local windows. Creating an additional virtual remote display requires a separate OS display capability/driver and is not implemented; no display driver or kernel extension is installed.

```json
{"kind":"pointerMove","x":100,"y":100}
{"kind":"pointerButton","x":100,"y":100,"button":"left","isDown":true}
{"kind":"key","key":"KeyA","isDown":true}
{"kind":"wheel","deltaX":0,"deltaY":120}
```

Buttons are `left`, `middle`, `right`; keys are a native backend allowlist of DOM `KeyboardEvent.code` values. Coordinates must lie on a reported monitor. Wheel magnitude is bounded. These are structured events, never commands. Keyboard layout/text/IME parity is not complete.

Sessions have a two-hour absolute lifetime, 30-second inactivity expiry, and at most eight sessions per host. There is one controlling session at a time; view-only sessions may coexist. Capture and input use separate serialized gates. Revocation and ownership are checked again after queued waits; frames and clipboard reads are checked after capture/read before returning data. Every held key/button has a ten-second lease renewed only by another down event for that key/button. Frames and mouse movement cannot extend a lost key-up lease. A safety worker checks every two seconds and releases expired inputs. Long intentional holds need repeated down events. The host stops if the safety worker fails.

Automatic recovery is distinct from a new connection. Each paired device has a persisted opaque resume epoch, returned by session creation and held by the viewer main process. Local host-end/disconnect-all rotates the relevant epoch before acknowledging success. A stale renewal returns `410 {error,code:"session_ended_by_host"}`; the viewer ends local access and does not retry it. Normal lifecycle shutdown, crash recovery, and ordinary session expiry preserve authorized resume. A host without this capability requires an explicit reconnect after a missing session. Epochs are not a substitute for TLS identity or permissions and are omitted from renderer-facing status. This stops automatic resumption; certificate revocation remains the way to prevent a paired device from explicitly connecting again.

Lock returns `204` when the platform operation completes. Restart uses only a fixed native executable and fixed arguments, without a shell: Windows `shutdown.exe /r /t 15 /d p:4:1`, Linux `systemctl reboot --no-ask-password`, macOS `/sbin/shutdown -r +1`. No permission escalation is attempted. `202 {state:"requested",message}` means the OS command exited successfully, not that reboot or reconnection was verified. Linux may reboot immediately. Restart capability has not been exercised by the test suite.

Usual failures: `400` invalid input, `401` unknown/missing identity, `403` forbidden/invalid pairing, `404` unavailable route/session/grant, `409` unavailable native capability/conflicting controller/settings, `410` host-ended automatic resume, `429` rate limit. Errors are `{error}` and capability/terminal errors add `code`. Authorization failures may have an empty body. Responses use `Cache-Control: no-store`.

## Current native coverage and limits

| Platform | Implemented | Limitations / validation |
| --- | --- | --- |
| Windows | Monitor enumeration, GDI PNG capture, SendInput keyboard/mouse/wheel, native text clipboard, LockWorkStation; unlocked interactive desktop only. | Compiled and exercised on this Windows machine. UAC secure desktop, lock/login screen, service Session 0, elevated target control, and cold-boot recovery are unsupported. No secure-desktop switching. |
| macOS | CoreGraphics monitor discovery and input, permission preflight, native-screen capture helper, text clipboard helpers. | Compiles as part of cross-platform project; runtime not validated on a Mac. Requires Screen Recording and Accessibility consent. No login-window/FileVault coverage; lock support remains unavailable if native backend reports false. |
| Linux X11 | Display discovery, screenshot helper, xdotool input, xclip text clipboard when dependencies are available. | Runtime not validated on Linux. Requires an existing accessible X11 session and installed helper programs. No root escalation. |
| Linux Wayland | Capability detection and clear unavailable state. | Screen capture/input unsupported until a real portal/PipeWire/libei backend is implemented. |

Audio, video codecs/hardware encoding, native service installers, update signing/delivery, automatic certificate rotation, unattended consent workflows, Wake-on-LAN, remote login and encryption preboot recovery remain future work. PNG polling is functional but bandwidth/CPU heavy; it is not a high-performance streaming claim. Host file path validation does not defend against a malicious local account with permission to change the configured directory while a transfer is in progress; local administrators and the same-user main process are trusted in this prototype.

## Verification

Run `dotnet build src/Orbit.Host/Orbit.Host.csproj` and `dotnet run --project tests/Orbit.Host.Tests/Orbit.Host.Tests.csproj`.

The dependency-free executable harness covers Tailscale address boundaries, token comparison, invite consumption/replay, no secret persistence, view-only grants, single-controller concurrency, session ownership, revocation of stale device records, disabled files/traversal/reserved names/root rejection, identity persistence/Windows DPAPI, held-input leases, native PNG encoding with independent CRC and zlib pixel checks, malformed native input, and real TLS pairing/unknown certificate/forged device ID/revocation over an existing connection. Permission-denial calls do not send valid input, read clipboard, or invoke power operations. Integration hosts use isolated temporary directories, dynamically allocated ports, and explicit loopback-test mode. Mac/Linux runtime coverage and reboot behavior require separate device tests.
