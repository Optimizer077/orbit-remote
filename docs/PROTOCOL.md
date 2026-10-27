# Orbit Remote protocol, version 0.1

This is a working prototype protocol. It provides certificate-pinned desktop sharing in an existing, unlocked user session. It is not a claim of production security, universal login-screen support, or proven restart recovery. Capture and input should run as the logged-in user; do not run the entire desktop app as SYSTEM or disable OS desktop protections.

The separate optimized `Diagnostic` build supports an explicitly generated GPU
test source. Its selector/backend are absent from normal Debug and Release
assemblies and packaged builds. A Diagnostic host always refuses to start
without the exact generated-source opt-in; it never becomes a real-desktop host.
Activation requires
`ORBIT_DIAGNOSTIC_SYNTHETIC=1`, `--loopback-test`, and an explicit absolute
`ORBIT_DATA_DIR` that is empty or marked as an existing generated-source profile;
the marker is the profile-isolation guard, independent of where Electron stores
its ordinary user data. Unmarked non-empty profiles are refused. Optional `ORBIT_DIAGNOSTIC_WIDTH` and
`ORBIT_DIAGNOSTIC_HEIGHT` are even integers within 320x240 .. 3840x2160;
default 1920x1080, target 60 Hz. Optional `ORBIT_DIAGNOSTIC_PATTERN` accepts
exactly `low-entropy` or `high-entropy`; missing keeps the existing low pattern,
while empty or unknown values refuse startup. High mode changes deterministic
synthetic noise across every macroblock using the same reusable BGRA buffer.
It is a codec/transport stress workload; report actual encoded bitrate rather
than assuming its 8 Mbit/s encoder target binds. Pattern fill/upload cost is
part of source overhead. No generated pixels or access units are persisted.
Authenticated local `/api/status` exposes
`diagnosticSource:{mode:"synthetic-gpu",pattern:"low-entropy"|"high-entropy",generatedFrames,producerOpens,gpuEncoderOpens,cpuReadbacks,hostMonotonicMicroseconds,targetFramesPerSecond:60,width,height}`.
Counters accumulate successful generated publications, source creations, GPU
encoder creations and actual CPU readback deltas for this backend instance.
One active generated monitor shared by two streams should report
`producerOpens:1`, `gpuEncoderOpens>=2`, `cpuReadbacks:0`. A restart creates a
new counter lifetime. The host monotonic microsecond value is sampled on each
authenticated local status response using the same clock as stream records;
bracket the complete status round trip to bound clock offsets, without assuming
wall clocks agree. The field and all diagnostic counters are absent in normal
Debug/Release responses.
The monitor ID is `diagnostic-synthetic-1`. Only explicit view-only sessions are
accepted; input, clipboard, files and power remain unavailable. Existing TLS,
pinning, pairing, owner-block, epoch, grant and revocation checks still apply.
The source shares the existing GPU conversion/encoder/send path and never reads
the real desktop. These measurements exclude desktop capture and cannot prove
locked-screen access or physical latency.

## Processes and listeners

`Orbit.Host` is a .NET 10 executable. Configuration:

| Setting | Meaning |
| --- | --- |
| `ORBIT_CONTROL_TOKEN` | Required random local control bearer token, at least 32 characters; desktop main process keeps it out of the renderer. |
| `ORBIT_DATA_DIR` | Persistent host state directory. Default: the current user's local application data, `OrbitRemote/host`. |
| `ORBIT_CONTROL_PORT` | Local control port; default `47831`. |
| `ORBIT_REMOTE_PORT` | Remote HTTPS port; default `47832`. Ports must differ and be 1024â€“65535. |
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
| `GET /api/peers` | Paired-device array: `{id,name,fingerprint,permissions,createdAt,revokedAt,blockedByOwner}`. The owner block is separate from certificate revocation. |
| `GET /api/tailnet-peers` | Startup discovery snapshot of Tailscale peer inventory. |
| `POST /api/invites` | `{deviceName?,permissions}` â†’ `{inviteUri,expiresAt,permissions}`. Refuses if remote listener is unavailable. |
| `DELETE /api/peers/{id}` | Revoke certificate pin, clear its owner block, end sessions and release held input. `204`. A later owner-approved re-pair is a new authorization decision. |
| `POST /api/peers/{id}/block` | Block the known device until the owner allows it again, end all its sessions and release its held input. `204`, idempotent. Use the incoming row's device ID even when its session ID has expired. Unknown/revoked device: `404`. |
| `POST /api/peers/{id}/allow` | Explicit owner action to clear an owner block, rotate resume authorization and retain existing grants. Returns the paired-device DTO. Already allowed: unchanged; unknown/revoked device: `404`. |
| `GET /api/audit` | Up to 500 newest-first `{at,kind,deviceId,detail}` events. No clipboard contents, file contents, or invitation secrets. |
| `GET /api/settings` | Host settings. |
| `PUT /api/settings` | Complete host settings object â†’ validated settings. |
| `GET /api/identity/export` | Private client identity, main-process only. Alias: `/api/client-identity`. |
| `DELETE /api/sessions/{id}` | Block the receiving session's device, end all sessions of that device and release its held input. `204`. A stale session ID returns `404`; use the device block route for a stale incoming row. |
| `POST /api/disconnect-all` | End incoming sessions, rotate all non-revoked paired devices' resume epochs and persist an owner block for devices with live sessions at that instant; release input. `204`. Idle paired devices may explicitly Connect again, with their old automatic resume denied. Blocked devices require local Allow again. |

## Remote routes

All require actual TLS client authentication and an unrevoked paired certificate except `/api/pair`, which requires the valid invite instead. Session ownership is checked against that certificate's paired device.

| Method and path | Behavior / required grant |
| --- | --- |
| `POST /api/pair` | `{secret,deviceName}` â†’ pairing response above. |
| `GET /api/info` | `{hostId,hostName,platform,permissions,settings:{allowRemotePower,fileTransferEnabled}}`. |
| `POST /api/sessions` | `{monitorId:null,viewOnly:false,resumeEpoch:null}` â†’ `{id,deviceId,deviceName,monitorId,permissions,createdAt,expiresAt,lastActivityAt,lastInputAt,resumeEpoch}`. Explicit Connect omits `resumeEpoch`; automatic renewal supplies its previous value. Requires available screen capture and viewing grant. |
| `GET /api/sessions/{id}` | Session status and heartbeat. |
| `DELETE /api/sessions/{id}` | End own session and release held input. |
| `GET /api/sessions/{id}/frame?monitorId=<id>&scale=1&format=png&quality=75` | Requires viewing. PNG by default; optional JPEG permission selects the smaller PNG/JPEG body per frame on capable hosts. Optional monitor selection preserves the session default when absent. Conditional `If-None-Match` may return304 with no body. Format/geometry headers are described below. |
| `POST /api/sessions/{id}/input` | Input object below; requires control. `204`. |
| `POST /api/sessions/{id}/release-inputs` | Release held keys/buttons, requires control. Call on viewer blur, Escape, disconnect, and navigation. |
| `GET /api/sessions/{id}/clipboard` | `{text}`; requires clipboard. Explicit requests only. |
| `PUT /api/sessions/{id}/clipboard` | `{text}` up to 8192 characters, no null characters; requires clipboard. |
| `GET /api/sessions/{id}/files` | Flat transfer-directory inventory, at most 500 entries. Requires files grant and locally enabled transfer folder. |
| `GET /api/sessions/{id}/files/{name}` | Download a single plain filename, at most 32 MiB. Session authority and local transfer enablement are checked again before every 64 KiB chunk; a partial response is aborted when access ends. |
| `PUT /api/sessions/{id}/files/{name}` | Raw file bytes, at most 32 MiB; creates a new file, never overwrites. Uploads recheck authority and transfer enablement as chunks arrive, then stage, mark and verify before atomic no-overwrite publication. |

A removed session ID is not always renewable. Before looking up the ID, session
routes re-read the current decision for the actual TLS certificate. An owner's
Block, local End or Disconnect all returns HTTP403 with `code: ended_by_owner`
and the fixed owner message, including frame, stream/control, input, clipboard
and file routes. A revoked request identity returns HTTP401 (a request revoked
after initial authentication can carry `code: access_revoked`). These terminal
denials take precedence over an ordinary missing-session404, so the viewer does
not issue a protected renewal attempt. Existing grants are not restored.

For an otherwise authorized peer, a genuinely missing session after remote End,
normal host lifecycle restart or expiry still returns404 and preserves the
existing bounded resume-epoch renewal. Streaming file responses that already
started cannot change their HTTP status; authority loss aborts the partial
response before its next chunk instead of reporting successful completion.

Uploads are written to create-new `.orbit-upload-<32 lower-case hex>.tmp`
files in the configured transfer folder. The whole `.orbit-upload-` prefix is
reserved case-insensitively: remote upload/download reject it and inventory
omits it. On Windows, existing paths are resolved to their long filename and
short-name aliases are refused, including aliases of reserved stages. Download
handles permit deletion so readers cannot block publication or cleanup. The body is bounded, flushed to disk and closed before provenance
metadata is applied and read back. Windows writes exactly
`[ZoneTransfer]\r\nZoneId=3\r\n` to `Zone.Identifier`, without a source URL.
macOS writes and verifies `com.apple.quarantine`; an unsupported-volume
`ENOTSUP` preserves the file and logs one fixed warning per host process;
other metadata failures fail the upload. A Windows marking failure refuses
publication with HTTP409 and code `upload_marking_unavailable`, a fixed
folder-selection message and one bounded local warning; it never returns a
successful unmarked upload. Linux preserves uploads without a quarantine claim. These markers record provenance, not a malware scan or a
safety verdict. The macOS quarantine flags, metadata persistence and operating
system behavior still need a native Mac gate; Windows fakes and compilation
are not that evidence.

The final authorization, local transfer policy and unchanged configured
folder checks are serialized with revocation/settings changes and the final
same-folder no-overwrite rename. A collision never replaces an existing file;
refusal, cancellation, stop or metadata failure removes only the request's
create-new staging file. A failed cleanup emits one fixed warning without
replacing the original upload error; the reserved leftover remains eligible
for the startup sweep. The final name is unavailable until publication.
Startup removes only regular, non-reparse staging files matching Orbit's exact
name format whose modification time is more than one hour old. Other files,
lookalikes, directories and fresh stages are preserved. This is not a crash
transaction spanning file data, metadata and directory entries; power-loss
durability depends on the filesystem. On Unix, the runtime uses same-filesystem
rename or hard-link/unlink behavior for no-overwrite moves; unsupported cases
may fall back to copy/delete, which is not an atomic publication guarantee.
Use a compatible local filesystem for that guarantee. Peer uploads are
serialized under the state gate; this includes the final filesystem I/O and
may briefly delay other state operations on a slow volume. A hostile local
writer can still race the runtime's existence check and remains outside the
current threat model.
| `POST /api/sessions/{id}/power` | `{action:"lock"}` or `{action:"restart"}`; requires both control and power, plus local `allowRemotePower:true`. |

### Frame formats

`format` is exactly `png` (default) or `jpeg`. `quality` is one integer, default75,
clamped40..90; the older proposal's `q` alias is not accepted. Optional `scale`
is one finite number clamped0.33..1, default1. Duplicate or unknown parameters,
formats and malformed quality/scale values return400 before capture. Capability
flags in `/api/info` and local status under `platform` include `canScaleFrames`,
`canConditionalFrames`, and `canJpegFrames`. The current Windows raw backend
supports these when capture/WIC is available; encoded-only backends preserve
full-scale PNG fallback. Requesting JPEG does not require a JPEG response.

Decode using the actual `Content-Type` (`image/png` or `image/jpeg`).
`X-Orbit-Frame-Format` is `png` or `jpeg`; `X-Orbit-Frame-Quality` appears only
for JPEG. `X-Orbit-Encode-Ms` is an integer measuring resize plus encode work,
excluding capture and validator hashing; it is0 for a conditional response.
`X-Orbit-Width`, `X-Orbit-Height`, `X-Orbit-Left`, and `X-Orbit-Top` always describe
the original physical monitor for input. `X-Orbit-Encoded-Width` and
`X-Orbit-Encoded-Height` describe the image body; `X-Orbit-Scale` describes its
actual scale. `X-Orbit-Captured-At` is the fresh capture time.

The viewer cache key includes session, monitor, requested scale, format and
quality. A single bounded quoted `If-None-Match` validator may revalidate only
that representation. The v2 validator includes session/resume generation,
native monitor identity, physical/encoded geometry, scale, requested format and
quality, visible RGB and actual served format. Both PNG/JPEG candidates derive
from one raw-content hash, so matching304 requires no encoding or retained host
frame cache. It never accepts a JPEG candidate when JPEG is unavailable or not
requested. Authorization is checked before capture and after preparation before
sending either body or304. A304 carries the corresponding format and geometry
metadata; it never creates, renews or restores a session or viewing grant.

Windows capture defers PNG compression. Preparation scales raw BGRA once, then
encodes PNG only, or WIC JPEG followed by PNG with a byte budget equal to JPEG's
size. PNG compression aborts when it cannot win; complete PNG wins ties. JPEG
is lossy even when smaller. No screen pixels or validators are written to logs.

**Wait for changes:** `wait` is one integer number of milliseconds, default `0`,
clamped to `0..15000`; duplicate/malformed values return `400`. A positive wait
requires `If-None-Match`. Viewers use at most `10000` to stay below their request
deadline. A matching image is held until pixels or the drawn pointer change, or the timeout
returns `304`; changed pixels return `200`. `platform.canWaitForFrames` advertises
the capability. One wait per session and canonical monitor, four per paired
device and eight per host may be held; excess requests return `429`. Ownership,
revocation, resume epoch and expiry are rechecked at least every 250 ms by a timer
independent of capture and waiting. A host stop returns `410`, revocation `401`,
and expired/missing sessions `404`, never `304`. No capture gate is held across
the wait. Windows shares one DXGI producer per monitor, composites color,
masked-color and monochrome pointers, and publishes immutable snapshots lazily
only for versions requested by consumers. Two reusable raw buffers avoid a new
full-screen allocation for every native update. Invisible pointer changes on
other outputs do not advance the published version. Native
validators use a random producer generation plus frame version and the existing
session/geometry/negotiation context; recovery and topology changes invalidate
them. Producers dispose after a two-second idle lease, retry native failures at
most once per ten seconds, and fall back to BitBlt/RGB hashing when unavailable.
The pool is bounded to eight monitor entries and 64 megapixels of source surfaces.

Input objects:

Frame monitor IDs come from `/api/info` â†’ `platform.monitors`. A supplied ID must be one printable string, 1â€“128 characters, naming an existing host monitor. The native backend rejects unknown IDs. Selecting a monitor for one frame does not mutate the session default, recreate the session, grant additional permissions, or acquire a second controller. Multiple viewer windows may request different existing monitors using the same authenticated session; all input continues through the same serialized control gate and uses the monitor's reported physical coordinates. This maps existing remote displays into separate local windows. Creating an additional virtual remote display requires a separate OS display capability/driver and is not implemented; no display driver or kernel extension is installed.

```json
{"kind":"pointerMove","x":100,"y":100}
{"kind":"pointerButton","x":100,"y":100,"button":"left","isDown":true}
{"kind":"key","key":"KeyA","isDown":true}
{"kind":"wheel","deltaX":0,"deltaY":120}
```

Buttons are `left`, `middle`, `right`; keys are a native backend allowlist of DOM `KeyboardEvent.code` values. Coordinates must lie on a reported monitor. Wheel magnitude is bounded. These are structured events, never commands. Keyboard layout/text/IME parity is not complete.

Sessions have a two-hour absolute lifetime, 30-second inactivity expiry, and at most eight sessions per host. There is one controlling session at a time; view-only sessions may coexist. Capture and input use separate serialized gates. Revocation and ownership are checked again after queued waits; frames and clipboard reads are checked after capture/read before returning data. Every held key/button has a ten-second lease renewed only by another down event for that key/button. Frames and mouse movement cannot extend a lost key-up lease. A safety worker checks every two seconds and releases expired inputs. Long intentional holds need repeated down events. The host stops if the safety worker fails.

Each paired device has a persisted opaque resume epoch, returned by session creation and held by the viewer main process. Owner End/Block persists `blockedByOwner:true` and rotates that device's epoch. Disconnect all rotates every non-revoked pairing's epoch, blocking only devices with live sessions; idle pairings remain allowed to request an explicit new connection. The blocked device receives `403 {code:"ended_by_owner",error:"The owner ended this session. Ask them to allow you again."}` from both explicit and automatic session creation, including after host restart. Re-pairing the same certificate without revocation does not clear this decision. Only the authenticated local owner can Allow again; that action clears the block, rotates the epoch and retains the existing grants. It does not create a session or restore prior sessions. Revocation clears the block but removes certificate authorization, so revoked devices cannot be allowed again through this route. A fresh owner-approved pairing after revocation or identity rotation starts unblocked.

Normal lifecycle shutdown, crash recovery, remote DELETE of an owned session, and ordinary session expiry preserve authorized resume. An otherwise allowed device supplying a stale epoch receives `410 {error,code:"session_ended_by_host"}`; the viewer ends local access and does not retry it. A host without resume support requires an explicit reconnect after a missing session. Epochs are not a substitute for TLS identity or permissions and are omitted from renderer-facing status. Open streams retain the existing terminal wire code `session_ended_by_host` for an owner block and include the explicit owner message; this is terminal and must not trigger automatic reconnect.

Lock returns `204` when the platform operation completes. Restart uses only a fixed native executable and fixed arguments, without a shell: Windows `shutdown.exe /r /t 15 /d p:4:1`, Linux `systemctl reboot --no-ask-password`, macOS `/sbin/shutdown -r +1`. No permission escalation is attempted. `202 {state:"requested",message}` means the OS command exited successfully, not that reboot or reconnection was verified. Linux may reboot immediately. Restart capability has not been exercised by the test suite.

Usual failures: `400` invalid input, `401` unknown/missing identity, `403` forbidden/invalid pairing, `404` unavailable route/session/grant, `409` unavailable native capability/conflicting controller/settings, `410` host-ended automatic resume, `429` rate limit. Errors are `{error}` and capability/terminal errors add `code`. Authorization failures may have an empty body. Responses use `Cache-Control: no-store`.

## Video stream (decision D11: wire contract frozen for implementation)

Goal: maximum frame rate. The host captures with DXGI, encodes hardware H.264 (Media Foundation; measured 3.3â€“4.6 ms per 1080p frame on the NVIDIA MFT) and sends one continuous stream. The viewer decodes it with WebCodecs (measured 0.5â€“0.7 ms hardware decode). Per-frame PNG/JPEG stays the fallback for hosts without the capability. Reviewed by codex-host-1 (Kestrel feasibility) and codex-1 (viewer parser).

**Why chunked HTTP instead of WebSocket.** The stream is one long `GET` on the existing remote listener, so it reuses the pinned mutual-TLS connection, Kestrel's client-certificate check, and the viewer's `PinnedAgent` pin verification unchanged. The viewer needs no new TLS client or third-party WebSocket library. Upstream control is a separate small `POST` on the pooled keep-alive connection (W5).

| Method and path | Behavior |
| --- | --- |
| `GET /api/sessions/{id}/stream?monitorId=&codec=&maxFps=&bitrate=&scale=&cursor=video|local` | Requires viewing. `200`, `Content-Type: application/vnd.orbit.stream`, chunked body of records (below). `409 {code:"stream_unavailable"}` when the platform cannot encode; the viewer then uses `/frame`. At most one stream per session and monitor: a new stream ends the older one with terminal `stream_replaced`. At most 4 streams per authenticated paired device and 8 per host, including pending native opens and disposal (`429 {code:"stream_capacity"}` beyond; retry later, not a security denial). Capacity is reserved before capture/encoder allocation. Same-session/monitor replacement retains its position, ends the old stream, and waits at most 500 ms for endpoint/native disposal before opening the successor. A stalled cleanup returns the same typed429 without allocating; only one successor may wait. If the successor fails after the old stream ended, no stream remains until a later open succeeds. |
| `POST /api/sessions/{id}/stream/control` | Requires viewing. Any of `{keyframe:true}`, `{ack:sequence, decodeMs}`, `{bitrateBps, maxFps, scale}` (clamped by the host). `204`. At most 60 requests/s per stream (`429`). Keyframe on join and decoder error (viewer: â‰¤ 2/s); acks are **cumulative** (the highest access-unit sequence fully received and handed to the decoder), sent about every 33 ms while frames arrive (â‰¤ 30 Hz); settings from the adaptive controller (W4). A keyframe request also clears the in-flight window, because the viewer discards pending deltas. |

`POST /api/sessions` gains `canVideoStream:true` and `videoCodecs:["avc1.4D4028", â€¦]` (uppercase hex) when available.

**Record framing** (all integers little-endian, 24-byte header):

| Field | Size | Meaning |
| --- | --- | --- |
| `type` | u8 | 1 config, 2 video access unit, 3 heartbeat, 4 terminal, 5 cursor (only when negotiated, see below); anything else is a violation |
| `flags` | u8 | bit 0 keyframe (type 2 only); other bits 0 |
| reserved | u16 | 0 |
| `length` | u32 | payload bytes; config â‰¤ 4 KiB, access unit â‰¤ 8 MiB, heartbeat 0, terminal â‰¤ 1 KiB |
| `sequence` | u32 | 0 for the first record of a stream, +1 per record, **never wraps** (the host ends the stream with terminal `stream_restart` first) |
| `reserved2` | u32 | 0 |
| `timestamp` | u64 | host **monotonic** clock in Âµs, non-decreasing per stream; wall-clock `capturedUtc` is separate metadata in config |

- **Config** (JSON â‰¤ 4 KiB), the first record and again on any resolution/codec change, always followed by a keyframe:
  `codec` matching `^avc1\.[0-9A-F]{6}$`; `width/height` = encoded display size (decoder crop and aspect), 1..8192, `width Ã— height â‰¤ 33,554,432`;
  `codedWidth/codedHeight` â‰¥ `width/height` and â‰¤ +16; `physicalLeft/physicalTop/physicalWidth/physicalHeight` (input mapping only, as `/frame` headers);
  `scale` 0.33..1 with `|width âˆ’ round(physicalWidth Ã— scale)| â‰¤ 1` (same for height); `fps` 1..240; `monitorId` by the monitor-ID rules; `colorSpace` (BT.709 limited range by default; the viewer sets it explicitly).
- **Access unit**: Annex-B H.264 with SPS/PPS on every keyframe, so a decoder configured without `description` can join at any keyframe. The first access unit after each config must be a keyframe.
- **Cursor** (type 5, W7a; only after the viewer opened the stream with `cursor=local`, otherwise the cursor stays composited into the video): JSON â‰¤ 64 KiB `{x, y, visible, shapeId, shape?}` in **physical** desktop coordinates of the monitor (the same space as input). `shape` is sent only when `shapeId` is new: `{width â‰¤ 256, height â‰¤ 256, hotX, hotY, kind: "color"|"masked"|"mono", pngBase64, invertPngBase64?}`: `pngBase64` is the pre-rendered RGBA image of the pixels the pointer *replaces*; `invertPngBase64` (only for `mono`/`masked`) is white wherever the pointer *inverts* the screen under it (AND = 1, XOR = 1 in a monochrome pointer, or the masked-color XOR pixels). The viewer draws the invert layer first with the canvas `difference` blend (white inverts the pixels beneath it, as Windows does), then the replace layer normally. Masked-color XOR with non-white colors is approximated the same way. Pointer shapes only, never screen content. Sent on change, at most at the stream fps; `flags 0`; sequence/timestamp rules as for every record. The viewer draws the pointer locally at display refresh and hides its own system cursor over the remote surface; the host's pointer stays authoritative (the next record wins). A record outside the monitor bounds or with an unknown `shapeId` and no `shape` is a violation. Strict JSON: integer `x`/`y` (the global hotspot position), boolean `visible`, `shapeId` 1..128 printable characters (never empty; a hidden pointer uses a defined 1Ã—1 transparent shape such as `hidden-1`, sent with its `shape` on first use after each config), and optional `shape` with `width`/`height` 1..256, the hotspot inside it, and canonical base64 PNGs that decode to exactly that size; the whole JSON is â‰¤ 64 KiB. The host advertises `canLocalCursor` only when it emits these records, and the viewer sends `cursor=local` only then. When a stream falls back to composited video, the host first sends one hidden-pointer record (`visible:false` with the hidden shape id, defining that shape if it isn't known yet), and the viewer hides its pointer and drops any prediction at once. A config record or a new stream clears the shape cache. The viewer caches at most 64 shapes per config and evicts the least recently defined one; the host therefore omits `shape` only for ids among its last 64 definitions in the current config, and sends the definition again otherwise. Pointer generation/version deduplication stays on the host; the record sequence orders updates.
- **Heartbeat**: `flags 0`, `length 0`, every 2 s while nothing changes (DXGI reported no new frame). Idle screens cost ~nothing, and a dead link is detected within 5 s.
- **Terminal** (JSON `{code,error}`): the last record, sent before the host closes the stream for session end, `410` host-ended, revocation, permission change, identity rotation, host stop, `stream_replaced` or `stream_restart`. Delivery is best-effort with a bounded wait (â‰ˆ 250 ms), then the connection is aborted. `code` is exactly one of: `session_ended`, `session_ended_by_host` (410), `access_revoked` (401), `permission_changed`, `identity_rotated`, `host_stopping`, `stream_replaced`, `stream_restart`, `stream_error`, `display_asleep` (409); the viewer treats an unknown code as `stream_error`. Only `stream_restart`, `stream_error`, `host_stopping` and `display_asleep` may retry under their existing session authority. `display_asleep` keeps the image fallback and a minimum fifteen-second video retry delay; it never renews or restores authority. The other codes end the session. `error` is a human-readable string of at most 500 characters and is never parsed.

**Viewer error handling.** Framing violations (unknown type, nonzero reserved bits, out-of-bounds length or config, sequence gap/repeat/wrap, decreasing timestamp, bytes after terminal, video before config, non-keyframe after config) **tear down the transport**. They are never treated as a dropped delta. EOF without a terminal, including EOF inside a partial header or payload, is a transient failure: discard the partial record and reconnect with backoff under the resume rules (an ended host session still yields `410`). A decoder error on an otherwise valid stream, or a new frame arriving while 12 frames are already pending decode or while the oldest pending frame is older than 500 ms, resets the decoder, keeps the last frame on screen and requests a keyframe.

**Backpressure and latency.** The host never queues frames: it bounds unacknowledged access units by **count and bytes**: at most 8 in flight, and at most `bitrateBps/8 Ã— 0.1 s` bytes (about 100 ms of the target rate; at least one access unit is always allowed), so a LAN reaches the full frame rate while a slow link never queues stale frames and while the socket write is pending or the limit is reached it **skips capture and encoding** (capture-rate adaptation), so latency stays bounded on a slow link and the frame rate drops instead. One shared per-monitor producer (DXGI loop) feeds both `/frame` and `/stream`; the global capture gate is never held for a stream's lifetime. Encoder settings: low-latency mode, no B-frames, long GOP with keyframes on request, bitrate from `stream/control`.

**Security requirements (same as `/frame`).** Revocation, ownership and the viewing grant are checked when the stream opens and **re-checked at least every second by a timer independent of writes and encoding**, which cancels the linked I/O. The host ends the stream within 1 s of revocation, session end or permission loss. The viewer validates every header before allocating or decoding, and never feeds unvalidated lengths to the decoder. Glass-to-glass latency across two computers needs clock-offset estimation; the HUD labels it an estimate (W7e).

The shared production session lookup rechecks current paired authority when the session row disappears between reads. Downloads preserve typed owner/revocation JSON before any body bytes, including after attachment metadata was prepared; after streaming begins, authority loss explicitly aborts the partial transfer before another chunk.

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

## Display availability and explicit wake

Authenticated platform metadata adds `displayState` (`on`, `off`, `dimmed`, or default `unknown`) and `canWakeDisplay` (default false). Session metadata adds top-level `canWakeDisplay`; capability is not a permission grant. Windows passively observes both `GUID_SESSION_DISPLAY_STATUS` and `GUID_CONSOLE_DISPLAY_STATE`; either reporting off takes priority, followed by dimmed, on and unknown. Each unsupported/failed observation stays unknown independently. A locked or secure desktop keeps its existing unavailable behavior. Registration currently occurs synchronously once during backend startup; moving it to lazy initialization is deferred.

Only an actual failed/missing capture together with observed off and an interactive desktop returns HTTP409 `{code:"display_asleep",error:"The remote display is asleep.",displayState:"off"}`. An available frame is never replaced by this observation. An active video stream can emit bounded Type4 `display_asleep` after source failure and fresh security/stop checks. Encoder failures alone, dimmed and unknown states do not mean asleep.

`POST /api/sessions/{id}/wake-display` accepts an empty body only. It requires a live non-View-only session with current Control and an explicitly supported provider, and never creates/resumes a session. Windows sends exactly one fixed relative zero-distance mouse move, with live desktop guards and no coordinates/keys/buttons supplied remotely. Host enforcement is single-flight and at most one request per five seconds per paired device, shared across its sessions and viewer windows; session churn does not reset the limit. HTTP202 `{state:"requested"}` acknowledges the request, not a successful wake. HTTP429 `wake_rate_limited` includes `Retry-After: 5`; HTTP409 `wake_unsupported` identifies an unsupported provider. A bounded `display.wake.outcome` audit records sent or failed after the provider attempt, without content or secrets. Ordinary input still uses its existing presented-frame gate. No connect/poll/retry/stream/status action automatically wakes, and there is no execution-state/power-request/keep-awake policy change.

Implementation references: [session and console display states](https://learn.microsoft.com/windows/win32/power/power-setting-guids), [read-only callback registration](https://learn.microsoft.com/windows/win32/api/powersetting/nf-powersetting-powersettingregisternotification). New checks use fake providers and generated frames only; actual OS wake/input has not been tested here. Sleeping-display DXGI can instead time out or report display-changed/no-display, which retain their existing unavailable meaning; this feature needs a separately authorized real-hardware sleeping-display and explicit-wake check before claiming it works. No such hardware effect is implied by these fake checks.

### Viewer display-availability propagation

The Electron transport carries only its allowlisted remote error code and bounded message from authenticated HTTP error responses. `display_asleep` survives only with HTTP409 and `displayState:"off"`; generic409, contradictory status/state and unknown remote codes do not acquire the sleep retry exception. Active Type4 keeps its existing `{code,error}` schema; the main process adds the local409/off classification and a current nonsecret availability snapshot. Human messages never authorize recovery.

`wake_not_permitted` is a trusted local Control/View-only precheck result without HTTP403. It leaves the live viewing session intact. An actual remote HTTP401/403/410 remains terminal, including a response that uses the same wording or code. Canonical local certificate/identity failures also remain terminal. Delayed replies are bound to the original owner, native-window lifetime, local session, remote session and generation; an old reply cannot retire a renewed successor.

Only `Retry-After: 5` is honoured for `wake_rate_limited`: the local feedback cooldown is a fixed five seconds, while the host remains the authority for its device-wide limit. Wake202 requests one immediate full-image availability check without assuming success; if capture is still asleep, subsequent image checks are at least three seconds apart. Input cleanup and sleep readiness invalidation occur only when entering that sleep state. A current accepted presentation ends the sleep interval; metadata,304 and the wake acknowledgement do not. Sleep invalidates only that session’s ready/pending entries, preserving unrelated sessions and native window-lifetime fences.
