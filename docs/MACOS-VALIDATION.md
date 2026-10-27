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

The T22 checks establish local Apple silicon behavior. Cross-device follow-up
is recorded below. Direct versus DERP comparisons,
sleep/wake, monitor hotplug/rotation, non-US layouts/IME, and actual sign-in startup
remain separate checks. No lock, reboot, login-window, FileVault or pre-login test
was performed. Intel execution remains unverified.

The local DMG is ad-hoc signed, not Developer ID signed or notarized. No Apple
Developer credential is supplied. Keychain-backed durable identity storage,
authenticated updates and independent security review remain release work.

## T25 integration checkpoint

The current-source run includes UI v2, viewer 304/scale support, per-device
session limits and parent/child local-control authentication. This is additional
source validation; the original T22 installed DMG above was built earlier.

- Standalone Mac checks: **26/26** with the currently connected Retina display,
  host security checks **210/210**, desktop tests **76/76**, production build and
  production audit pass, and both Mac Electron tests pass. The earlier
  two-display native route run passed **29/29**; display-dependent checks change
  count with the number of connected monitors.
- The real Mac HTTPS frame route reports no scale/conditional capability.
  Repeated requests with `scale=0.33` and a bounded conditional validator return
  **200**, full backing-pixel PNG dimensions, scale **1**, and **no ETag**.
- Native app-scoped light/dark appearance updates select Daylight/Graphite after
  removing Playwright's default color-scheme override. All four themes were
  captured and inspected at 2× with a sanitized loopback profile. The test does
  not change the user's global macOS appearance.
- Cmd+K opens and runs the palette. The controlled-viewer shortcut probe spies
  only on its own test session's input IPC to prevent same-desktop keyboard
  feedback. Real native input is tested separately in dedicated test windows.
  The live-frame HUD, shared-session screen window, popup status-bar layout and
  terminal host-stop UI are exercised.
- A read-only Security framework query counts login-keychain certificates, keys,
  identities and Orbit-subject certificates. It requests opaque references,
  never key data, and restricts the search to the login keychain. Counts were
  **15 / 5 / 1 / 0** before launch, while running, after **SIGKILL** of the test
  host and supervised restart, and after final quit. No login-keychain residue
  was observed in this lifecycle. This does not claim an audit of every OS
  temporary file or every keychain on the machine.
- The menu template is **16 points**, supplies **1× and 2×** representations and
  is installed as a native template status item. **Live glyph/light-dark visual
  signoff remains pending**: its reported screen rectangle produced an OS
  overflow/chevron rather than identifiable Orbit glyph pixels. That crop is
  not accepted as icon evidence. The optional menu-position probe is diagnostic
  only; it does not make the visual gate pass.
- Windows/Mac cross-device follow-up is recorded below. No new public Mac
  promotion is claimed.

## Packaged preview.4 Mac checkpoint

An isolated worktree at `b59e97e96400d067a6e22bdfc6ba6688613ec2f5`
(`v0.1.0-preview.4`) produced a self-contained ARM64 host and ad-hoc signed
`Orbit-Remote-0.1.0-arm64.dmg`. The app version remains `0.1.0`; the source
commit distinguishes this build from the earlier T22 package. Its SHA-256 is
`2c55b041496637de8dc232e44db416c5344dd35a9de535bcf647fee2554efc19`.

Deep strict code-signature validation and the DMG container checksum pass.
Both Mac Electron tests pass against this packaged app (**17.7 seconds**),
including real native input on the current Retina display, clipboard restoration,
host SIGKILL/restart and final quit. Login-keychain counts remain **15 / 5 / 1 / 0**
at all four lifecycle observations. The new bundle has not replaced the user's
normal installed app or profile. It remains a local preview without notarization.

The current-source browser lab suite passes **64/64** on Mac after its owner
corrected the palette-reopen fixture to use Cmd+K on macOS.

## Cross-device baseline: Mac viewing Windows

Both computers ran isolated packaged preview.4 builds from `b59e97e`, with
temporary profiles and dedicated test ports. A single-use invitation moved by
Taildrop and was deleted after pairing. The current Windows security-code prefix
was confirmed after its test instance restarted; the earlier code was superseded.
Only view access was granted. No remote input, clipboard, files or power action
was used in this cross-device pass, and no real-screen image was saved.

The Mac displayed the actual **3024 × 1898** Windows desktop. The link reported
**TLS 1.3 / AES-256-GCM / X25519**, over a **relayed** Tailscale path.

| Measurement | Result |
|---|---|
| Frame requests | 30, full-scale PNG |
| Request duration, median / p95 | 1861.6 / 2691.5 ms |
| Body size, median / p95 | 961520 / 997753 bytes |
| Unchanged replies | 0/30 on a changing desktop |

These durations include the controller request and Electron IPC, with concurrent
UI polling. They are not a display FPS or end-to-end input-latency measurement.
The sample does not establish idle-screen 304 behavior. Preview.4 predates the
later pinned keep-alive change, so this is a baseline for that follow-up.

Windows test-host **Disconnect all** produced **Connection ended** on the Mac.
Controller sessions remained **zero** after 15 seconds and on the next check;
no session resumed automatically. The heading was no longer visible on a later
poll, so only the immediate ended display and continued absence of a session
are asserted. This was the main Connections view; the finding was sent to the
renderer owner for a lasting-ended-state regression check.

## Cross-device baseline: Windows viewing Mac

The Windows agent reported an actual Mac desktop image displayed in its screen
window, using a separate Taildrop invitation to the same isolated Mac test host.
This direction negotiated **TLS 1.2 / AES-256-GCM / ECDHE**, with forward secrecy,
over the **relayed** path. It used the same view-only restrictions.

| Measurement reported by the Windows agent | Result |
|---|---|
| Frame requests | 30, full-scale Retina PNG |
| Request duration, median / p95 | 1774 / 6159 ms |
| Body size, median / p95 | 1356477 / 3168046 bytes |
| Unchanged replies | 0/30; Mac does not advertise conditional frames |

This sample used sequential controller IPC without concurrent viewer polling;
the 260 ms delay between samples is excluded. Its timing method differs from
the first direction. The Windows screen window displayed a decoded image after
the timing run. No real-screen image was saved on either computer.

The Mac test host executed **Disconnect all** and reported zero sessions. The
Windows agent confirmed its outgoing session disappeared and no session resumed.
Its pop-out closed automatically: it cannot claim a persistent ended explanation.
A separate inspection of only its test profile found one main window, no pop-outs
and zero outgoing sessions. This UI issue was sent to the renderer owner.
Both active test apps were closed and their active temporary profiles removed.
The Windows agent retained two inert earlier cache directories after removing
their known Orbit identity/state/log files. The Mac's temporary identity,
pairings, local driver credential and invitation files were removed. The normal
user installation was preserved.

No transient network outage, cross-device input, sleep/wake or physical display
change was tested in this pass. An attempted scoped-outage helper failed before
injecting any fault. Local packaged crash-recovery and native-input results above
remain separate evidence.

## Latest source follow-up

On the source checkpoint including D8.1 (`6aee424`) and pinned keep-alive (`f87d3f8`),
Mac channel `verify --quick` passes: **252/252 host checks**, **105/105 desktop
checks**, zero build warnings/errors, production build, audit and privacy scan.
The Unix owner-only state-file assertion actually ran on this Mac. Native Mac
checks pass **26/26**, and both Mac Electron tests pass (**11.5 seconds**).

One preceding input run received no typing in its temporary textarea. The Mac
test now waits for both native window focus and textarea document focus before
injecting real keys, and checks focus before each letter. Its focused rerun and
the full two-test sequence pass, including native input, clipboard restoration
and SIGKILL/restart. Login-keychain counts remain **15 / 5 / 1 / 0** throughout.
This adds a test precondition; no production input behavior was changed.

A second isolated ARM64 DMG at `2dc8f84c414189127ccfd8f47351b024bc7ec9aa`
includes D8.1 and pinned keep-alive. Deep strict signature validation and the DMG
checksum pass; both tests also pass against this **packaged** app in **15.0
seconds**, including real native control, clipboard restoration and forced host
restart. All four login-keychain observations remain **15 / 5 / 1 / 0**. Its
SHA-256 is `03e12ff06df46b455dc8114a359f694620dbd602c7c58b264cbc88b1e679ddd8`.
This `0.1.0` local ad-hoc preview is distinguished by its source commit and
adjacent build metadata; it is not a new public release or a cross-device W5
performance measurement. The normal installed app/profile was not replaced.

## W2c-a native ImageIO encoder

The encoder-only ImageIO component uses OS frameworks and in-memory top-down
BGRA, ignoring its undefined alpha byte. Its 23 native synthetic checks cover
JPEG decode, channel order/orientation, minimum geometry, source immutability,
quality, malformed bounds, pre-cancellation and eight simultaneous encodes.
With the existing Mac/frame-route checks, `--imageio --frame-fallback
--expect-interactive` passes **49/49**. Channel `verify --quick` also passes
host **252/252**, desktop **105/105**, build, audit and privacy checks.

A seeded synthetic 1920 × 1080 gradient/noise image produced these measurements
after warm-up (10 encodes per quality; no screen capture or saved pixels):

| Quality | JPEG bytes | Median / p95 encode time |
|---|---:|---:|
| 40 | 83905 | 4.17 / 4.45 ms |
| 75 | 509732 | 10.14 / 10.38 ms |
| 90 | 778960 | 13.45 / 13.54 ms |

The same synthetic input produced 6326719 PNG bytes in a single 96.74 ms encode.
That one PNG timing is not a distribution or a general content benchmark.
This does not establish live capture, network FPS, hardware JPEG encoding or
equal perceptual quality across operating-system codecs. JPEG may be larger
than PNG on text-heavy content. No capture backend, frame route or capability
flag was changed; Mac still advertises the existing full-scale PNG fallback.

## W6b-mac framing slice

The first capture-helper slice adds a managed reader and independent 64-byte
big-endian fixture. `--capture-pipe --expect-interactive` passes **72/72** combined
checks (57 framing/credit fixtures plus the existing 15 basic Mac checks).
Channel quick verification passes host **252/252**, desktop **105/105**, build,
audit and privacy checks on this pre-W2b/W6c source checkpoint.

The fixtures cover fragmented headers/body, truncated/oversized records,
generation/sequence/timestamp rejection, immutable stream geometry, bounded
credits, unknown flags/codecs/slots, permission/display/error retirement, EOF,
cancellation and concurrent-reader rejection. A generated black **3840 × 2160**
BGRA payload was read with two 4K display bindings configured. H.264/HEVC cases
test the bounded Annex-B envelope only; they do not decode video. No real screen
pixels were read or stored by these fixtures.

This slice launches no helper and changes no capture backend, capability or OS
permission. Actual Swift producer, ScreenCaptureKit/TCC attribution, frame
delivery performance, native pipe exchange and capture fallback remain later
gates in the approved plan.

## W2b/W6c Mac integration

The integrated JPEG-negotiation and binary/canvas source passed Mac channel
quick verification: **288/288 host**, **112/112 desktop**, build, audit and privacy.
The combined native run (`--imageio --capture-pipe --frame-fallback
--expect-interactive`) passed **114/114** with two displays connected. Both Mac
Electron tests passed in **12.8 seconds**, including actual native control/typing
on both displays, clipboard restoration and host SIGKILL/restart. Login-keychain
counts remained **15 / 5 / 1 / 0** throughout.

The tests decode the real binary IPC payload inside the renderer and return only
geometry/format/link evidence. They require full native-pixel dimensions, PNG
MIME, a Uint8Array and absence of the old base64 data URL. Main and pop-out canvas
geometry is checked; saved UI screenshots hide both image and canvas surfaces.
The actual Mac HTTPS route still advertises no JPEG/raw-frame capability, and an
explicit JPEG request correctly returns PNG with matching served-format metadata,
no JPEG-quality header and no reusable ETag.

## D11-mac synthetic H.264 component benchmark

Hardware: Apple M2 Pro, arm64, macOS 27.2, Electron 45.0.0 and Chromium
156.0.8078.48. The unchanged `119a31c` benchmark generated glyph-like text and
moving-gradient content, encoded first and then replayed the available chunks
to the decoder at 60 per second. Each pass requested 240 input frames, an 8 Mbit/s
encoder target and High profile. Ten startup frames were excluded from latency
statistics. Temporary user-data directories were removed after each run; no
capture, network or real-screen pixels were involved.

These are **hardware-preferred API passes**. Chromium reports video encode/decode
enabled and output NV12, but the actual engine selection was not independently
instrumented. WebCodecs defines hardware acceleration as a preference which
implementations may ignore. [WebCodecs specification](https://www.w3.org/TR/webcodecs/#hardware-acceleration).

| Size / content | Decoder output / submitted chunks | Median / p95 callback latency | Paced updates/s |
|---|---:|---:|---:|
| 1920 × 1080 text | 240 / 240 | 2.5 / 3.9 ms | 60.16 |
| 1920 × 1080 video | 240 / 240 | 3.0 / 4.0 ms | 60.15 |
| 3024 × 1964 text | 234 / 234 | 2.4 / 4.2 ms | 60.20 |
| 3024 × 1964 video | 238 / 238 | 3.3 / 5.4 ms | 60.13 |
| 3840 × 2160 text | 228 / 228 | 2.7 / 4.9 ms | 60.17 |
| 3840 × 2160 video | 234 / 234 | 4.3 / 5.1 ms | 60.18 |

All decoder passes had zero dropped **submitted chunks** and no reported errors
or child-process failures. This does not mean the encoder preserved all input
frames: it produced 234/238 of 240 at Retina and 228/234 at 4K. At 4K, encoder
wall times were **4.96 / 5.11 seconds**, with **677 / 727 queue waits** and
submit-to-chunk medians **203.0 / 203.5 ms** (p95 **216.9 / 218.7 ms**). This
browser encoder configuration does not establish a low-latency 4K60 pipeline.

2D drawing CPU medians were 0.2–0.3 ms. WebGL readback/sync call medians were
1.9–4.1 ms; these exclude preceding draw submission work. Decoder output
callbacks can precede GPU completion. No-draw burst rates are not presentation
FPS or proof of completed hardware work. Software-preferred decode medians were
3.5/5.1 ms at 1080p, 6.2/8.5 ms at Retina and 6.5/9.4 ms at 4K (text/video).

This demonstrates decoder-component feasibility for the available synthetic
chunks, not live sharing, Windows-encoder compatibility, network behavior,
glass-to-glass latency, 4:4:4 text fidelity or an integrated Mac encoder pipeline.
The actual Windows MF synthetic sample remains a separate interoperability check.

## 2026-10-27 current source and locked-desktop regression

Apple M2 Pro, arm64, macOS 27.2; Electron 45.0.0. Frozen source
`e48af15` contains the accepted product changes through `ae2d20e`, before the
unlanded C1 encoder candidate. The new locked-desktop test is a later test-only
change; it does not alter the packaged product.

| Check | Actual result |
|---|---|
| Mac harness/host build | Pass, zero warnings/errors |
| Native ImageIO/helper-pipe checks with `--expect-interactive` | 91/92; the interactive precondition failed because the actual desktop was locked |
| `verify --quick --no-record` | Overall **FAIL**: host 1052/1053; desktop 552/552, desktop build, production audit (zero vulnerabilities) and privacy scan passed |
| Standalone host repeat | Same 1052/1053; `VideoStreamChecks.cs` incorrectly expects two Windows timer-resolution users on macOS, where the lease is uncounted; reported to its owner |
| Private timer-fixture proposal | 1053/1053 standalone with only the expected platform delta corrected; accepted host-test source remains unchanged, owner preparing the landing |
| Source Electron suite with new locked test | One passed, two interactive-only tests explicitly skipped, 10.2 seconds |
| Locked desktop | No capture/input/clipboard capability or monitors; both session modes refused; revocation checked; no real input, capture or clipboard operation |
| Login keychain | Before/after source tests and before/during/after packaged smoke: 15 certificates, 5 keys, 1 identity, 0 Orbit certificates |
| ARM64 local DMG | Build, strict deep signature and `hdiutil verify` passed |
| Fused packaged startup | Started with Node/.NET SDK locations absent from child PATH; unauthenticated controller request 401, browser Origin and unexpected Host requests 403 |
| Package cleanup | Exact test-bundle processes zero, own profile removed; test listeners checked separately |

Follow-up: the exact handed-off timer fixture, preimage `c9a2d4ad` to postimage
`2f4316c5`, passed the actual isolated `verify --quick --no-record`: host
**1053/1053**, desktop **552/552**, zero build warnings/errors, production
audit zero and privacy scan pass. The one-line test change is published on
`codex-mac/timer-platform-fixture-20261027` for the coordinator to land. This
proof covers the corrected branch; the earlier accepted-baseline failure above
remains recorded. No product/runtime code or installer bytes changed.

Local artifact: `OrbitRemoteBuilds/e48af15/Orbit-Remote-0.1.0-arm64.dmg`,
version **0.1.0**, SHA-256
`b53fd26d489c0f3f4da2a6046ff71acae281e5069254ebfaf2487368fdde58a1`.
The default security fuses were read back: RunAsNode, NodeOptions and inspector
disabled; embedded ASAR integrity and ASAR-only loading enabled. This is an
ad-hoc signed local preview with no Developer ID or notarization. It has not
been promoted publicly or substituted for the user's installed app.

Interactive capture, control, clipboard, UI appearance and live menu-glyph
signoff remain pending a locally unlocked session on this source. The successful
earlier interactive runs above are historical evidence, not a current pass.

## Interrupted T35 outbound measurements (historical source)

The `97fdb15` Mac viewer completed four view-only, 30-request matrices against
the Windows host's actual 2560 × 1080 display. All requests returned changed
frames. These are image-mode measurements from before the current video stream.

| Requested mode | Median / p95 request latency | Median / p95 body bytes | Served format |
|---|---|---|---|
| PNG, scale 1 | 1492.1 / 3325.0 ms | 424785 / 438106 | 30 PNG |
| PNG, scale 0.5 | 758.5 / 1292.7 ms | 185272 / 195461 | 30 PNG |
| JPEG allowed, quality 75, scale 1 | 908.3 / 1402.6 ms | 269366 / 271603 | 25 PNG, 5 JPEG |
| JPEG allowed, quality 75, scale 0.5 | 415.4 / 555.2 ms | 75385 / 81422 | 10 PNG, 20 JPEG |

The actual default-PNG canvas/HUD run lasted 30.184 seconds and reported median
**0.6 updates/s**, p95 **0.9 updates/s**. The JPEG-allowed results include PNG
fallback and must not be described as all-JPEG. The TLS 1.3 first frame decoded;
no remote input or data grants were enabled. Reverse direction and terminal
checks were **not run** after interruption. On resumption, the stale driver's
closed-page state was detected; its exact owned bundle/driver were terminated,
both test listeners were zero, and its temporary profile and credential file
were removed. The earlier timing hold was released. Sanitized numeric evidence
remains in ignored local artifacts; no desktop images or invitations were
committed.

## 2026-10-27 unlocked Mac regression and current ARM64 package

The user unlocked the same M2 Pro Mac. Product checkpoint `fa5928c` includes
the Mac modifier fix `6c35d09` and the landed platform-specific timer fixture.
Its Electron and renderer source matches `ae2d20e`; it excludes the unlanded
C1/C2 encoder experiments. Later harness changes wait for asynchronous macOS
selection and refresh the session lease during clipboard checks.

| Check | Actual result |
|---|---|
| Native Mac checks | **150/150 passed**, including 31 modifier-flag checks, real capture on both displays, ImageIO and helper-pipe checks |
| Source UI | Passed in 11.2 s |
| Source native-session case | Passed in 8.5 s; both-display cursor/click/type, five immediate Shift/release bursts per display, Command+A/release/type, clipboard restoration, native-host crash/restart and session end/revocation |
| Initial `verify --quick --no-record` on `fa5928c` | **FAIL**, host 1097/1098; desktop 552/552, build, production audit zero and privacy scan passed. The harness did not retain the failing host assertion, so its cause remains unknown |
| Standalone host repeat with raw output | **1098/1098 passed**. This repeat does not turn the initial quick verification into a pass |
| Packaged test companion | UI passed in 10.5 s; native-session case passed in 9.1 s after the clipboard harness gained eager snapshots and session-lease refresh |
| Fused shipping bundle | Strict deep signature, DMG verification, security-fuse readback, startup without SDK paths, controller authentication and cleanup checks passed |
| Login keychain | Source, companion, crash and fused-bundle checks kept the same 15 certificates, 5 keys, 1 identity and zero Orbit certificates |
| Cleanup | Own test processes and listeners zero; temporary profiles and credentials removed |

The real modifier defect produced `orbitAB` when the second character followed
an immediate Shift/release sequence intended to produce `orbitAb`. Native
events now compose momentary modifier flags from the held remote keys and the
pending key transition, preserving unrelated event flags. Forced releases clear
the momentary flags. The regression checks use owned test text areas and restore
the clipboard; no private screen or clipboard content is retained in Git.

The first packaged clipboard attempt also failed after a roughly 60-second
delay and session expiry. Its cause was not instrumented. With eager clipboard
snapshots, frame renewal before clipboard actions and timing instrumentation,
the subsequent snapshot took about 6 ms, write 39 ms and read 44 ms. No macOS
permission-dialog explanation is claimed for the earlier delay.

Current local artifact: `OrbitRemoteBuilds/fa5928c/Orbit-Remote-0.1.0-arm64.dmg`,
version **0.1.0**, SHA-256
`6c49de29a3dec264138484990825cedbb388241c81480f29b33d10900fde126c`.
It is an ad-hoc signed local preview, without Developer ID or notarization.
RunAsNode, NodeOptions and inspector are disabled; ASAR integrity and ASAR-only
loading are enabled. Real packaged input was exercised in a separate, unfused
test companion containing the same product host and renderer. The fused bundle
received the startup/security/cleanup checks above. Neither replaced the user's
normal installed application or was promoted publicly.

Intel execution, actual lock/sleep/wake/prelogin behavior, notarization and
visual menu-glyph signoff remain open.

An additional quick verification retained each subprocess's raw output and
again returned 1097/1098. This time the sole failure was identified:
`Cursor: hidden-1 is referenced by id once known`. The fake cursor's preceding
timed movement can already leave it at the requested hidden-move coordinate;
the test then reads the first hidden record before any new movement. A
deterministic forced-position fixture reproduced exactly that failure, with
15 other cursor checks passing. An isolated test correction chooses a different
coordinate and waits for a new record; both the forced and alternate-coordinate
fixtures passed 16/16. No cursor product code was changed. The original full
quick failure and its unknown assertion remain recorded separately; the
test-only correction is being handed to the host-test owner.

The isolated correction subsequently passed the actual quick verification:
host **1098/1098**, desktop **552/552**, zero build warnings/errors,
production audit zero and privacy scan pass. Raw subprocess output is retained.
The exact one-file change is published as `df22b58` on private branch
`codex-mac/cursor-platform-fixture-20261027` for owner review/landing. This is a
corrected test-branch pass; it does not change the original `fa5928c` result or
the packaged product bytes.

## 2026-10-27 Windows-generated video to Mac: partial result

Fresh private run `mac-low-20261027-r2` paired the Mac viewer to the Windows
Diagnostic source over the tailnet. The source generated LOW-pattern
1920 × 1280 video at a configured 60 Hz. All grants except viewing were false;
neither computer captured a real desktop or sent input, clipboard, files or
power actions in this cross-device run.

The Mac received video and recorded five initial draw callbacks at 1920 × 1280,
with a visible viewer. Session creation negotiated TLS 1.3,
TLS_AES_256_GCM_SHA384 and X25519. This establishes encrypted video startup,
not measured playback FPS, latency or physical display presentation.

Windows stopped when its diagnostic CPU-readback counter reached three. That
counter covers shared pixel readback and cannot alone distinguish image-mode
polling from a video encoder fallback. The Windows retained tail and the Mac's
initial snapshot do not establish the cause. No root READY arrived; the planned
30-second measurement and 16-second terminal observation were **not run**.
Both sides reported graceful cleanup with zero owned processes/listeners and
removed temporary profiles. The prior `mac-low-2931ede2` attempt never launched
the Mac viewer because its manual handoff was missed; it is a failed handoff.

A fresh diagnostic attempt is being prepared with automated Git-channel phases,
first-pair work deadlines and saved numeric request/decoder/fallback telemetry.
It has not yet run. The earlier partial results remain separate.

## 2026-10-27 latest viewer fix and refreshed Mac installer

After private main landed `a8ff2d3` (the cursor test correction) and `02e6a15`
(repeated asleep reports and receipt fences), the Mac pulled both and tested a
separate `02e6a15` worktree. The Windows comparison keeps its agreed `fa5928c`
Mac checkpoint / `ae2d20e` common frontend; these results do not change that run.

| Check on `02e6a15` | Actual result |
|---|---|
| Desktop tests | 569 passed, zero failed, one Windows NTFS Zone.Identifier test skipped; 570 total |
| Host/Mac harness build, TypeScript and renderer build | Passed, zero build warnings/errors |
| Source Mac UI and native-session cases | Both passed: 6.8 s and 9.5 s, 16.7 s total |
| Packaged test companion UI and native-session cases | Both passed: 10.1 s and 9.4 s, 19.8 s total |
| Real native-session scope | Capture and cursor/input on two displays, Shift/release and Command shortcuts, restored clipboard, forced own-host crash/restart, session end and revocation |
| Keychain lifecycle | Unchanged 15 certificates, 5 keys, 1 identity, zero Orbit certificates, including crash/restart and shutdown |
| Shipping bundle | Strict deep signature, DMG checksum, fuse readback and startup without SDK paths passed; control 401, Origin/Host 403 |
| Cleanup | Own test apps quit and profiles removed; test listeners zero |

The refreshed local ARM64 DMG is
`OrbitRemoteBuilds/02e6a15/Orbit-Remote-0.1.0-arm64.dmg`, version **0.1.0**,
SHA-256 `ece64cbc046e28656496f86a337c7c13a10f41aa35c5c0a4754fef6f0a2bfbd6`.
Source metadata and SHA256SUMS are saved alongside it. Its native host reuses
the earlier validated self-contained ARM64 output: the `src/Orbit.Host` tree is
identical (`e85c2257b3b872150676cc7ed5bfce5db1e8079f`) at both checkpoints,
and the native source trees have no differences. The desktop contains the new
viewer code. This package remains ad-hoc signed and unnotarized. Real packaged
control was tested in the separate unfused companion; the shipping bundle has
its security fuses enabled. The user's installed app was not replaced.

These checks do not establish actual OS sleep/wake or a visual menu-glyph
signoff. The fresh Windows diagnostic run is still pending its two-sided
automation/preflight preparation.
