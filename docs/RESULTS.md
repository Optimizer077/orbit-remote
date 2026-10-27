# Orbit Remote: experiments, results and decisions

This page records what was tested during the development of the hardware video stream and the related security work on 26 and 27 October 2026: the measured results, the runs that failed or stopped early, the approaches that were rejected, and the decisions that followed. Failed and incomplete runs are listed next to the passing ones. A later pass does not replace an earlier failure.

Short summaries of the headline numbers are in [PERFORMANCE.md](PERFORMANCE.md) and [VALIDATION.md](VALIDATION.md). This page has the detail behind them.

**Development evidence versus release contents.** This log includes experiments and development changes that postdate the preview.5 source baseline. A change marked merged below is not automatically part of that public snapshot. Software-decoder retry, the newer viewer timing panel, input batching, and the unfinished bitrate controller are outside preview.5. Release contents and the final release checks are stated in the changelog and release notes.

## Contents

1. [How results are produced](#how-results-are-produced)
2. [Test hardware](#test-hardware)
3. [Results](#results)
   - [Per-stage timings](#per-stage-timings)
   - [Live desktop stream](#live-desktop-stream)
   - [Synthetic full-pipeline runs](#synthetic-full-pipeline-runs)
   - [Two viewers](#two-viewers)
   - [Recovery times](#recovery-times)
   - [Encoder bitrate on hard-to-compress content](#encoder-bitrate-on-hard-to-compress-content)
   - [Network impairment profiles](#network-impairment-profiles)
   - [Windows on ARM](#windows-on-arm)
   - [Mac decoding](#mac-decoding)
   - [Input path](#input-path)
   - [Image path (fallback)](#image-path-fallback)
   - [Cross-device runs](#cross-device-runs)
4. [Experiments that failed or were rejected](#experiments-that-failed-or-were-rejected)
5. [Decision log](#decision-log)
6. [Security reviews](#security-reviews)
7. [Not tested and known limits](#not-tested-and-known-limits)
8. [How to reproduce](#how-to-reproduce)

## How results are produced

**Generated test source versus live desktop.** Most stream results use a generated test source. It exists only in a separate Diagnostic build of the host and is switched on with an environment variable; release builds do not contain it. It produces a moving pattern at 60 frames per second, uploads it to the GPU, and then uses the same GPU encoder, stream writer, pinned mutual-TLS link, viewer parser, decoder Worker and canvas as a real session. Because the content is known, every frame can be counted. Two patterns are used:

- **Low entropy:** a checkerboard, bars and a counter at 1920×1280. Only a small area changes, so it compresses to about 1 Mbit/s against an 8 Mbit/s target.
- **High entropy:** full-frame noise at 1920×1280. It is a deliberate worst case, far harder to compress than any normal desktop.

Live-desktop runs use the real app on a real screen. Their content was not controlled, so another screen would give other sizes and rates.

**One machine versus two.** Unless a result says "cross-device", the host and viewer ran on the same computer and connected over loopback, still through pinned mutual TLS. Those runs exclude real network latency, bandwidth limits, packet loss and Tailscale relays.

**Network impairment.** Impaired-network runs place a small proxy between viewer and host on the same computer. It forwards the encrypted bytes unchanged and never decrypts them. It can delay bytes, hold them (a blackout), stall single chunks of the byte stream, and cap bandwidth. It works on top of TCP, so it **cannot drop or reorder packets**. A "1 % stall" profile is therefore not a packet-loss test, and none of these runs is a real WAN test.

**What "pass" means.** Each run has a target written down before it starts, for example "at least 59.5 frames drawn per second" for a 60-second generated run, or "first fresh frame within 1 s after the network returns". After each run the session is ended by the host, and the viewer must stay ended and blank for 16 seconds without creating a new session. A run that stops before its measurement or this end check is reported as **incomplete**, which counts as a failure. A pass applies to that run and its conditions only; it is not a guarantee.

**Clocks.** Intervals are measured on one clock. Times are never subtracted across two computers. "Drawn" means the viewer's canvas draw completed; it is not light leaving the panel, so none of these numbers is a click-to-screen latency.

**Privacy.** Stream measurements retained counts, sizes and timings rather than private desktop pixels or encoded video. This statement concerns stream measurements; interface tests also produce controlled app screenshots.

## Test hardware

| Label used here | Hardware and software | Used for |
|---|---|---|
| Windows desktop | Windows 11 Pro x64, Intel Core Ultra desktop CPU without integrated graphics, NVIDIA RTX GPU (NVIDIA hardware H.264 encoder through Media Foundation) | Almost all stream, encoder, recovery and impairment results |
| Windows on ARM laptop | Windows on ARM, Qualcomm SoC with a Qualcomm hardware H.264 encoder | ARM host, ARM viewer and remote input results |
| Mac | Apple M2 Pro (Apple silicon) | Decoder benchmark, Mac native checks, Mac viewer in cross-device runs |
| Raspberry Pi 4 | Available | Not tested; the Pi host plan is paused |

Software: Electron 45.0.0 with Chromium 156, .NET 10, Node.js 24. The Windows desktop's display was 3024×1898 for the per-stage and image-cost runs, 2560×1440 for the live video runs and 2560×1080 for some image runs; each table states which.

No AMD or Intel GPU was available, so no AMD or Intel encoder result exists.

## Results

### Per-stage timings

Windows desktop, one machine, medians unless noted. Each stage was measured on its own. The stages overlap and use different content, so adding them up gives a rough budget, not a latency.

| Stage | Result | Conditions | Date |
|---|---|---|---|
| GPU capture (DXGI Desktop Duplication) | 4.4 ms per changed frame; checking an unchanged screen costs about 0 ms | 3024×1898. For comparison: GDI BitBlt 62 ms; the preview.4 capture path with cursor and PNG 155 ms | 2026-10-26 |
| Hardware H.264 encode, first version | 3.3–4.6 ms per 1080p frame; about 9 ms at 3024×1898; zero frames of encoder delay; delta frames 2–26 KB | NVIDIA encoder via Media Foundation, generated content. Adoption gate was ≤ 8 ms per 1080p frame | 2026-10-26 |
| Hardware H.264 encode, optimized | 2.47 ms per 1080p frame; 5.73 ms at 3024×1898 | Same encoder; reported as host CPU time per frame, which halved after removing a spin-wait | 2026-10-26 |
| Viewer decode (WebCodecs) | 0.5–0.7 ms | Windows desktop, 1080p and 3024×1898 | 2026-10-27 |
| Draw to canvas | 0.2 ms | — | 2026-10-27 |

The published range for encode is 2.5–2.9 ms at 1080p and 5.8–7.6 ms at 3024×1898 ([PERFORMANCE.md](PERFORMANCE.md)). Summed, the stages come to about 11–13 ms per frame at 3024×1898, plus network, inter-process hops and queueing.

**Stage timings inside the full pipeline.** Generated low-entropy source, 1920×1280, one viewer, 60 seconds, 2026-10-27. The host-side rows cover only the last 12.3 seconds of this run because the log rotated; the second table in [Two viewers](#two-viewers) has full coverage.

| Stage | Samples | p50 ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|
| GPU encode, including output wait | 736 | 2.844 | 3.248 | 4.572 |
| Frame acknowledgement round trip (HTTP) | 1,592 | 0.725 | 1.702 | 3.825 |
| Viewer main process to decoder Worker and back | 3,601 | 0.448 | 1.019 | 7.424 |
| Decode, input to output | 3,601 | 0.600 | 1.000 | 2.400 |
| Canvas draw | 3,601 | 0.200 | 0.300 | 1.700 |
| Stream parser | 7,203 | 0.048 | 0.078 | 1.243 |

These distributions overlap; their p95 values must not be added.

### Live desktop stream

Windows desktop, real app, real screen at native 2560×1440, host and viewer on the same machine, 30-second runs, 2026-10-26.

| Step | Drawn frames per second | Other results | What changed |
|---|---:|---|---|
| First live run | 7.3 | Decode 2 ms, about 7.6 KB per update | A fixed host cost of about 137 ms per frame (see [failures](#experiments-that-failed-or-were-rejected)) |
| After removing repeated session checks | 38.6 | 1,157 of 1,157 updates drawn, decode 0.4 ms, about 298 KB/s | — |
| After fixing stream-loop pacing | **59.3** | 1,780 frames in 30 s, decode 0.6 ms median and 1.5 ms p95, about 300 KB/s | Absolute-tick pacing and a high-resolution timer |
| Image path, same screen, for comparison | 20.8 | 12.5 MB/s | — |

### Synthetic full-pipeline runs

Windows desktop, one machine, generated source at 1920×1280 and 60 Hz, 8 Mbit/s target, one viewer, 2026-10-27.

| Run | Duration | Drawn / sent | Drawn per second | Gaps over 50 / 100 ms | Max interval | Payload | Result |
|---|---:|---:|---:|---:|---:|---:|---|
| Decoder and canvas only (recorded 1080p clip replayed at 60 Hz) | 60.0 s | 3,600 / 3,600 | 59.997 | 0 / 0 | 41 ms | — | Pass |
| Low entropy, full pipeline | 60.011 s | 3,601 / 3,601 | 60.006 | 0 / 0 | 27.9 ms | 1.094 Mbit/s | Pass |
| Low entropy, full pipeline, later build of the test source | 60.010 s | 3,600 / 3,600 | 59.990 | 0 / 0 | 31.3 ms | 1.033 Mbit/s | Pass |
| High entropy, full pipeline | 60.004 s | 1,447 drawn | 24.115 | 276 / 0 | 84.7 ms | 246.9 Mbit/s | **Fail** (gate 59.5) |
| High entropy, repeat | 60.010 s | 1,454 drawn | 24.229 | 289 / 0 | 87.8 ms | 246.9 Mbit/s | **Fail** |

In the high-entropy runs the source still produced 60 frames per second on the GPU and there was no fallback to the CPU. The viewer drew about 24 per second because each update was 0.5–1.4 MB, about 31 times the 8 Mbit/s target, and the host waited for acknowledgements before sending more. The largest measured waits (p95, overlapping) were: waiting for room in the in-flight window 36.4 ms, GPU encode 12.6 ms, stream write 16.3 ms. This failure led to the [bitrate investigation](#encoder-bitrate-on-hard-to-compress-content).

### Two viewers

Same generated source and machine, two viewers at once, 60 seconds each, 2026-10-27.

| Case | Viewer | Drawn per second | p95 / max interval | Gaps over 50 / 100 ms | Payload | Result |
|---|---|---:|---:|---:|---:|---|
| Low entropy | 1 | 60.012 | 17.6 / 29.7 ms | 0 / 0 | — | Pass |
| Low entropy | 2 | 60.012 | 17.4 / 32.2 ms | 0 / 0 | — | Pass |
| High entropy | 1 | 24.595 | — / 85.2 ms | 312 / 0 | 248.2 Mbit/s | **Fail** |
| High entropy | 2 | 24.561 | — / 105.8 ms | 319 / 1 | 247.9 Mbit/s | **Fail** |

Full-minute host stage timings for the low-entropy two-viewer run (7,200 samples per host row): GPU encode p50 2.656 ms, p95 2.945 ms; acknowledgement round trip p50 0.590 ms, p95 0.895 ms; decode p50 0.500 ms, p95 0.800 ms; draw p95 0.300 ms. Both viewers shared one capture source and used one GPU encoder each.

Earlier the same day, with a 60 Hz test animation captured from the real desktop (60 s), the real app drew 59.60 and 59.68 frames per second with two windows of one app, and 59.96 and 59.79 with two separate apps, with no gap over 100 ms.

### Recovery times

Windows desktop, one machine, generated or live source as noted, 2026-10-27. Each row lists every measured attempt in order.

| Event | Target | Attempts and results | Status |
|---|---|---|---|
| Host process killed and restarted by the app | Video within 1 s after the restarted host reports healthy | (1) Images returned after 2.4 s, but **video did not return within 61.7 s**. (2) After a fix: video 3.04 s after the kill, 1.65 s after healthy. (3) 1.71 s after healthy. (4) After a second fix: **470 ms** after healthy, 1.96 s after the kill. (5) 474 ms / 1.90 s. (6) 445 ms / 1.87 s | Pass since attempt 4. Each passing run used one image frame while video restarted |
| One-click **Reconnect** after the host stopped | — | 418 ms and 424 ms from click to fresh video (two runs). No request before the click and exactly one new session after it | Pass |
| Change quality without restarting the stream | — | 150 / 239 / 138 ms (first run); 151 / 127 / 148 ms (second run), for Full to 0.5, 0.75 and 1. About 105 ms gaps during the switches | Pass |
| Capture reset (injected) | No freeze over 300 ms | 147.9 ms gap in drawn frames; 59.43 frames per second around it; GPU encoder kept. Component test: 149 ms from reset to the first new update, of which 89 ms opening a new GPU encoder | Pass for an injected reset. A spontaneous capture loss is untested |
| Window minimized, then restored | — | 0 frames drawn while minimized; first fresh video 313 ms after restore | Pass |

### Encoder bitrate on hard-to-compress content

The high-entropy failure raised the question whether the encoder holds its configured bitrate at all. These runs measure the encoder alone, without a viewer.

**Settings read back from the running encoder** (NVIDIA, 2026-10-27): rate control CBR; mean bitrate 8,000,000 bit/s; maximum QP 30; minimum QP 0; buffer size 2,000,000 (the documented unit is bytes, so 2 seconds at 8 Mbit/s); GOP 3,600 pictures; low-latency mode on. Reading a setting back does not prove the encoder enforces it.

**Baseline, encoder only.** 1920×1280, 60 Hz, 8 Mbit/s, 8-second warm-up then a fixed 60-second window, 2026-10-27.

| Measure | Low entropy | High entropy |
|---|---:|---:|
| Encoded updates per second | 59.98 | 59.98 |
| Mean payload | 1.079 Mbit/s | 688.5 Mbit/s (86 times the target) |
| Highest 1-second window | 1.139 Mbit/s | 701.4 Mbit/s |
| Startup keyframe | 6,459 bytes | 1,437,408 bytes |
| Requested refresh keyframe | 7,743 bytes | 1,437,826 bytes |
| Budget (mean ≤ 110 %, 1 s peak ≤ 150 %, keyframe ≤ 1 s of budget) | Pass | **Fail on all three** |

Every high-entropy update was about 1.44 MB, which means the encoder sat at its QP 30 ceiling and could not compress further. The full pipeline's 247 Mbit/s above is lower than 688 Mbit/s because the viewer path slowed the stream to about 24 frames per second.

Two follow-up experiments, the first bitrate safety net and a QP calibration, are described under [failures](#experiments-that-failed-or-were-rejected). The current direction is in the [decision log](#decision-log).

**Text sharpness.** On 2026-10-26 a generated text test (1920×1080, 30 fps, 4 Mbit/s, 91 frames with a card change at frame 30) measured static text at 50.6 dB PSNR within 15 frames (0.5 s) with maximum QP 30, against 46.3 dB before the change. The highest 1-second window was 0.94 times the target on text and 1.12 times on generated video. This is why QP 30 is the default.

### Network impairment profiles

Windows desktop, one machine, byte-level proxy (see [method](#how-results-are-produced)), generated source at 1920×1280, one viewer, 2026-10-27. Each run had 15 s of normal operation, the impairment, at least 15 s after the network returned, and the 16-second end check. "Fresh frame after restore" is the first drawn frame that the host encoded after the network returned; it is a bounded range because it comes from two clocks with a measured offset.

| Profile | What it simulates | Runs and results | Status |
|---|---|---|---|
| Delay | 40 ms ± 15 ms one-way delay in each direction, 30 s | Run 1: 42.4 drawn per second during delay, 123 gaps over 50 ms, 19 over 100 ms, max 141.7 ms; 60.1 per second after; fresh frame 19.7–21.9 ms after restore. Run 2 (later build): 42.1 per second, 125 gaps over 50 ms, 15 over 100 ms, max 147.4 ms; 60.2 per second after; fresh frame 26.6–28.7 ms after restore. No fallback, no new session | **Pass** for continuity; not smooth at 60 fps under this delay |
| Chunk stalls | 1 % of byte-stream chunks held an extra 200 ms, each direction, 30 s | Run 1: the stream fell back to images and the run stopped early; the cause was not found. Run 2: 56.4 per second, max gap 232.9 ms; 60.0 after. Runs 3–5 (three different seeds): 55.4 / 54.6 / 54.7 per second, max gaps 330.7 / 234.8 / 238.0 ms; 60.0 after, one 64 ms gap after restore in one run. No fallback in runs 2–5 | **Partial:** four passes, one unexplained failure that was not reproduced |
| 2 s blackout | All forwarding held for 2 s, connections kept open | No frames for 2.0 s; fresh frame 32.6–34.8 ms after restore (target 1 s); 60.1 per second after; same stream, no fallback | **Pass** |
| 10 s blackout | All forwarding held for 10 s; client timeouts may close connections | Fresh frame from a replacement stream 1.63 s after restore (target 3 s); one fallback to images and one stream reopen, no new session; 208 queued bytes on the closed connection were discarded | **Pass** for recovery; not seamless |
| 8 Mbit/s cap | Bandwidth limited to 8 Mbit/s each direction, 20 s, high-entropy content | Run 1: 9 frames drawn in 20 s (0.45 per second), max gap 2.56 s, 4.8 Mbit/s of video delivered; the host fell back from GPU to CPU encoding and the run stopped. Run 2 (later build): 8 frames (0.40 per second), max gap 2.62 s, 4.58 Mbit/s forwarded; the host recorded a CPU fallback with reason "encode budget". In both runs the restore phase and end check did not run | **Fail / incomplete** |

The cap result is expected to some degree: the high-entropy source produces far more than 8 Mbit/s. The open problem is that the stream did not adapt; it fell back instead. Encoder-side overshoot control (above) is a different mechanism from congestion control and is not expected to fix this case by itself.

### Windows on ARM

**Live host, viewed from the Windows desktop** over a direct Tailscale path (about 7 ms round trip), 26–27 October 2026. The ARM laptop showed a 60 Hz animation in a test window; each row is a 12-second run.

| Version | Encode path | Drawn per second | ARM stage timings (p50) |
|---|---|---:|---|
| Before fixes | GPU | about 15 | GPU encode 66 ms = video processor 32.4 + encoder submit 33.4; capture wait 32.8 ms |
| Timer change + automatic CPU fallback | CPU after 15 frames | 29.9 | CPU source 16.3 + encode 17.0 ms |
| Capture wait in 1 ms slices | GPU | 39.7 | GPU encode 18.8 = video processor 0.04 + encoder submit 17.5 ms |
| All of the above, fallback budget raised to 40 ms | GPU | **57.1** | 3 gaps over 50 ms, none over 100 ms |
| Encoder waits for at most one output (2026-10-27) | GPU | **59.3** (was 47) | 2,607 frames; capture spacing p50 17.6 ms, p99 19.0 ms |

**Encoder only** (1920×1280, 60 s, 2026-10-27): one Qualcomm encoder reached 54.65 encoded frames per second; two at once reached 53.30 and 53.12 (about 106 combined). Forcing one extra frame in flight gave 54.72, without it 54.23, so pipelining made no difference. One encoder instance is limited to about 18 ms per frame at this size.

**ARM viewer decoding**, one machine, 60-second runs, 2026-10-27:

| Run | Result |
|---|---|
| One viewer, early build | 59.92 drawn per second, no gap over 50 ms (two recoveries at startup) |
| One viewer, later build | **19.33** per second: 41 queue-overflow and 11 decoder-error recoveries, then images, then a 23.3 s freeze at the end |
| Two viewers, same build | 49.82 per second each, no gap over 50 ms |
| Candidate decoder-admission fix, one / two viewers | **39.88** per second with a 10.2 s gap / **1.13** per second with 20 s gaps. Rejected |
| Decoder and canvas only, recorded Qualcomm clip (1920×1080, 8 Mbit/s), hardware decoding / candidate hardware / candidate software | All 3,600 of 3,600 at 60 per second; gaps over 50 ms: 6 / 3 / 0; max 89 / 128 / 30.3 ms; renderer CPU (one core) 4.4 % / 3.8 % / 17.5 % |

The decoder-only replay and the [cross-device run](#cross-device-runs) did not reproduce the failure, and its cause is not established. See [failures](#experiments-that-failed-or-were-rejected).

**Pairing persistence:** the ARM host was paired once and reconnected across six host restarts without a new invitation.

### Mac decoding

Apple M2 Pro, Electron 45 WebCodecs, 2026-10-26. A benchmark encoded generated text and moving-gradient content in the browser, then replayed 240 frames to the decoder at 60 per second (8 Mbit/s, High profile; the first 10 frames excluded). Hardware decoding was requested; Chromium reported hardware video decode enabled, but the engine actually used was not independently confirmed.

| Size and content | Decoded / submitted | Decode median / p95 | Updates per second |
|---|---:|---:|---:|
| 1920×1080 text | 240 / 240 | 2.5 / 3.9 ms | 60.16 |
| 1920×1080 video | 240 / 240 | 3.0 / 4.0 ms | 60.15 |
| 3024×1964 text | 234 / 234 | 2.4 / 4.2 ms | 60.20 |
| 3024×1964 video | 238 / 238 | 3.3 / 5.4 ms | 60.13 |
| 3840×2160 text | 228 / 228 | 2.7 / 4.9 ms | 60.17 |
| 3840×2160 video | 234 / 234 | 4.3 / 5.1 ms | 60.18 |

Software decoding took 3.5 / 5.1 ms at 1080p, 6.2 / 8.5 ms at Retina size and 6.5 / 9.4 ms at 4K (median, text / video). The short range "2.4–3.3 ms" in [PERFORMANCE.md](PERFORMANCE.md) covers the 1080p and Retina medians. The browser's own encoder did not deliver every frame (234–238 of 240 at Retina, 228–234 at 4K) and took about 203 ms from submit to output at 4K, so this benchmark says nothing about a Mac encoder pipeline. Windows-encoded video on a Mac viewer is covered under [cross-device runs](#cross-device-runs).

Native Mac checks on 2026-10-27 passed 150 of 150, including real capture and input on two displays, Shift and Command shortcuts, clipboard restore, crash recovery, session end and revocation. Full detail: [MACOS-VALIDATION.md](MACOS-VALIDATION.md).

### Input path

No operating-system input tests were run on the Windows desktop, because it is the developer's working machine. Input was tested on the ARM laptop and the Mac, only inside test-owned windows.

| Test | Result | Date |
|---|---|---|
| Pointer moves, Windows desktop viewer to ARM host (direct path, about 7 ms round trip) | 59.6 moves per second delivered; request acknowledgement p50 7.1 ms, p95 10.2 ms | 2026-10-26 |
| Dragging an element on the ARM host, 5 s | 48.1 frames drawn per second (straight line), 47.4 (circle) | 2026-10-26 |
| Dragging for 15 s | 42.8 frames per second, 30 gaps over 50 ms; the longest gap between received moves on the ARM side was 249 ms | 2026-10-26 |
| Clicks, typing and scrolling on the ARM host | Not tested. Paused after an invalid run (see [failures](#experiments-that-failed-or-were-rejected)) | — |
| Input batching on the Mac host | 22 key events delivered in the expected order in two requests (up to 21 events per request, one request in flight), on each of two displays | 2026-10-27 |
| Click-to-screen latency | **Not measured.** A method is designed (click sent and matching frame drawn, both timed on the viewer's own clock) but not run | — |

Drag smoothness is rated **partial**: 45–53 frames per second while dragging, with occasional stalls up to about 250 ms.

### Image path (fallback)

Images are used when video cannot run, and by Mac and Linux hosts. All on the Windows desktop unless noted.

**Encoding options**, normal desktop content at 2560×1080, 2026-10-26:

| Encoding | Bytes per frame | Time per frame at 2 Mbit/s |
|---|---:|---:|
| Full resolution, 24-bit PNG (fastest setting, the default then) | 881 KiB | 3.6 s |
| Full resolution, PNG maximum compression | 594 KiB | 2.4 s |
| Full resolution, PNG with 5 bits per channel | 720 KiB | 3.0 s |
| Half resolution, 24-bit PNG | 323 KiB | 1.3 s |
| Full resolution, JPEG quality 80 | 293 KiB | 1.2 s |
| Half resolution, JPEG quality 60 | 55 KiB | 0.23 s |

Reducing colour depth saved only 18 %; a lossy codec at half resolution saved about 16 times.

**Changes and their measured effect**, 2026-10-26:

| Change | Before → after | Conditions |
|---|---|---|
| Reuse pinned connections instead of a new TLS handshake per frame | About 1.2 s of handshake round trips per frame removed | Estimated from a throttled run at 150 ms round trip |
| Binary frames to a canvas, no fixed 260 ms pause | 2.0 → 3.75 updates per second | Loopback |
| Pick the smaller of PNG and JPEG per frame | 1,044 → 497 KiB at full scale; 5.2 → 2.5 s per full frame through a 2 Mbit/s, +150 ms, 1 % simulated-loss proxy (1.2 s at half scale) | 3024×1898 |

The loopback cost of one full-scale PNG frame before these changes was 996 KiB and 148 ms median at 3024×1898 (30 requests; [PERFORMANCE.md](PERFORMANCE.md) has the full generated table).

**Mac viewing the Windows desktop, image mode**, 2560×1080, 30 requests per mode, 2026-10-26:

| Requested mode | Request median / p95 | Body median | Formats served |
|---|---:|---:|---|
| PNG, scale 1 | 1,492 / 3,325 ms | 424,785 bytes | 30 PNG |
| PNG, scale 0.5 | 759 / 1,293 ms | 185,272 bytes | 30 PNG |
| JPEG allowed (q75), scale 1 | 908 / 1,403 ms | 269,366 bytes | 25 PNG, 5 JPEG |
| JPEG allowed (q75), scale 0.5 | 415 / 555 ms | 75,385 bytes | 10 PNG, 20 JPEG |

The default-PNG viewer drew a median of 0.6 updates per second in a 30-second run. The reverse direction and end checks were not run because the session was interrupted.

### Cross-device runs

Every attempt between two computers, in order, including those that stopped early.

| Date | Direction and source | Outcome | Reason |
|---|---|---|---|
| 2026-10-26 | Mac viewer → Windows host, images, relayed Tailscale path, view only | **Completed.** 30 frames: request median 1.86 s, p95 2.69 s; about 940 KB PNG; TLS 1.3 | Image baseline from preview.4 |
| 2026-10-26 | Windows viewer → Mac host, images, relayed path, view only | **Completed.** 30 frames: request median 1.77 s, p95 6.16 s; about 1.36 MB PNG; TLS 1.2 with forward secrecy. **Disconnect all** ended both sessions. Two interface defects: the ended state disappeared from the Mac main view, and the Windows pop-out closed instead of explaining that the session ended. The Mac test's automated pre-pairing comparison guard did not stop pairing | Image baseline from preview.4 |
| 2026-10-26 | Mac viewer, planned 10 s network interruption | **Not run.** The test-only interruption failed in its instrumentation before injecting a fault | Instrumentation failure |
| 2026-10-26 / 27 | Windows desktop viewer → ARM host, live, direct path | **Completed** in parts; numbers under [Windows on ARM](#windows-on-arm) and [Input path](#input-path). One group of runs was invalid: after the host was switched, the test window was not visible and clicks reached the desktop instead of the target. The user was told, and further clicks were paused | Live control testing |
| 2026-10-27 | Windows desktop generated video → ARM viewer, two attempts | **Aborted before pairing** (an input stream closed; the ARM side was not ready) | Harness and readiness |
| 2026-10-27 | Windows desktop generated video (low entropy) → ARM viewer, 60 s | 3,600 of 3,600 received and drawn at 60 per second; no drops or recoveries; 38 gaps over 50 ms, max 89 ms. **Not a pass:** the session-create counter went from 1 to 2 before the end check, and the cause was not recorded. The ARM screen was locked during the run, so this is not an unlocked-desktop result | Session counter and locked screen |
| 2026-10-27 | Further ARM runs (reverse direction, two viewers, high entropy) | **Not run.** The ARM laptop went offline | Device offline |
| 2026-10-27 | Windows desktop generated video → Mac viewer, attempt 1 | **Failed handoff.** The Mac side never launched; no frames | Manual coordination missed |
| 2026-10-27 | Same, attempt 2 | **Incomplete.** The Mac received video over TLS 1.3 and drew five frames at 1920×1280. The Windows host then stopped because its CPU-readback counter reached three; the cause of those readbacks is unknown. The 30-second measurement and end check did not run | Unexplained CPU readbacks |
| 2026-10-27 | Same, attempt 3 (automated handoff) | **Incomplete.** Seven frames drawn on the Mac over TLS 1.3, AES-256-GCM, X25519; the Windows host showed zero CPU readbacks. The run stopped at a pre-measurement check that wrongly counted a metadata field as an extra permission. This was a test defect; no product permission check changed | Test defect |
| 2026-10-27 | Same, attempt 4 | **Aborted before pairing.** The Mac watcher timed out a Git fetch and published an abort before the Windows controller bootstrapped. Windows read the abort after starting, then stopped within 22.3 s. No accepted peer connection, frames or measurement; both sides reported cleanup complete | Coordination-read timeout and a pre-bootstrap terminal-state race in the harness |

Sustained video between two unlocked computers has therefore **not** been measured yet.

## Experiments that failed or were rejected

Each entry gives what was tried, the numbers, and what was learned. Dates are 2026-10-26 or 2026-10-27.

1. **First live video run: 7.3 frames per second (2026-10-26).** A fixed host cost of about 137 ms per frame. Timing showed each of three session checks took 23–25 ms, because each created a new process object to read the session ID (9.6 ms each, twice per call), and the checks ran repeatedly per capture. Removing the repeated lookups gave 38.6 frames per second; fixing the stream loop's pacing (absolute-tick pacing and a high-resolution timer) gave 59.3. Learned: profile the host per stage before blaming the encoder or network.

2. **Video did not return after a host restart (2026-10-27).** After an abrupt restart, images came back in 2.4 s, but video had not returned after 61.7 s. Fixed in two steps (3.04 s, then 0.45–0.47 s after the host was healthy). See [Recovery times](#recovery-times).

3. **A capture reset moved the stream to the CPU permanently.** The first recovery rule reopened the encoder on the CPU. Changed to reopen a GPU encoder, falling back to the CPU only after two failures in 10 seconds; the measured gap is now 147.9 ms.

4. **Qualcomm GPU path at 66 ms per frame (ARM, 2026-10-27).** The graphics driver held a shared device lock for the whole capture wait, so the video processor stalled for 32 ms per frame. Waiting in 1 ms slices removed the stall (32.4 → 0.04 ms). A timer-resolution change alone did not move these stages. Separately, the Qualcomm encoder holds two pictures; waiting for a third cost a 50 ms timeout per frame. Waiting for at most one output raised the rate from 47 to 59.3 frames per second. Keeping one extra frame in flight made no difference (54.72 vs 54.23 encoder-only).

5. **The first automatic GPU-to-CPU fallback judged startup frames.** It moved a stream to the CPU when the median of the first 15 GPU encodes exceeded the budget, and kept new streams on the CPU for 10 minutes. Startup keyframes and warm-up are slow, so healthy ARM streams fell to the CPU (44–45 frames per second instead of about 57). Changed to skip the first 30 encodes and all keyframes, require at least 15 samples over at least 1 s, and hold for 2 minutes.

6. **Video fell back to images when the pointer shape changed back (ARM, 2026-10-26).** The host sends each cursor shape once per configuration and then refers to it by number; the viewer kept only the latest shape, so arrow → text cursor → arrow was a protocol error. Fixed by keeping up to 64 shapes per configuration. Hover on the ARM host went from image fallback to 49.8 frames per second with no stream errors.

7. **Live-desktop timing runs could not start (2026-10-27).** Three attempts to time the pipeline on the real desktop aborted before measurement because the test windows failed a visibility check at all five sample points. The cause was not established; a covered desktop is a plausible explanation. Decision: use the generated test source for timing, and keep real-desktop tests separate.

8. **ARM viewer decoder backpressure (2026-10-27).** One ARM viewer on the same machine fell to 19.3 frames per second, with 41 queue overflows and 11 decoder errors, while two viewers ran at 49.8. A candidate change to how frames are admitted to the decoder made it worse: 39.9 frames per second with a 10.2 s gap for one viewer and 1.1 for two. Analysis found that the decoder held about five pictures, so the stricter admission starved it, and that the candidate could deadlock on a paused connection. The candidate was rejected and not merged. A decoder-only replay on the ARM laptop and a cross-device ARM viewer both ran at 60 frames per second, so the original failure is not reproduced, and its cause remains open. On the Windows desktop, the same comparison produced failures in both the old and the candidate version (52.0–54.0 frames per second) and one pass (59.995); those gaps were most likely caused by covered test windows rather than either version, but window coverage was not measured in those runs.

9. **Decoder-reordering hypothesis rejected (ARM, 2026-10-27).** The ARM decoder appeared to hold 4–5 pictures, suspected to be caused by the stream not declaring "no reordering". Inspection of the stream header from the Qualcomm encoder showed it already declares zero reorder frames and one buffered picture. The hypothesis was dropped; no encoder change was made.

10. **Encoder buffer size: wrong unit.** The buffer was meant to hold 0.25 s of video and was set to one quarter of the bitrate in bits. The Media Foundation H.264 property is documented in bytes, so the driver reported 2,000,000 bytes, which is 2 seconds at 8 Mbit/s. A corrected, smaller buffer is planned as its own experiment so its effect can be measured separately.

11. **The first bitrate safety net failed its high-entropy gate (2026-10-27).** Design: measure the encoder's real output each second; after two consecutive 1-second windows above 150 % of the target, step down at most once every 2 s: scale 1 → 0.75 → 0.5 → 0.33, then 60 → 30 → 15 frames per second; restore everything when a window falls below 50 %. Results (1920×1280, 8 Mbit/s, 60 s):

    | Gate | Low entropy | High entropy |
    |---|---|---|
    | Mean ≤ 110 % of target | Pass (1.096 Mbit/s) | **Fail** (13.36 Mbit/s) |
    | Highest 1-second window ≤ 150 % | Pass (1.307 Mbit/s) | **Fail** (43.82 Mbit/s) |
    | Keyframes ≤ 1 s of budget (1,000,000 bytes) | Pass (6,441–7,763 bytes) | **Fail** (1,437,767 bytes) |
    | Under 150 % within 6 s and staying there | Not applicable | **Fail**: first window under 150 % after 13 s, then 53 more windows over |

    The ladder stepped through widths 1920, 1440, 960 and 634 at 60 fps, then 634 at 30 and 15 fps. Even at the lowest step, 57 full 1-second windows averaged 12.48 Mbit/s, above the 12 Mbit/s limit. Learned: three separate problems. The opening keyframe is over budget before any reaction is possible; one step per 2 s is too slow to reach the floor in 6 s; and the floor still overshoots at QP 30. The safety net was not merged.

12. **Changing the maximum QP on a running encoder did not take effect.** Setting maximum QP to 51 on a running NVIDIA encoder returned success, but reading it back immediately still returned 30. The test then stopped before encoding a frame, restored 30 and confirmed it. Microsoft documents this property as static, to be set before encoding starts, so this matches the documented behaviour rather than indicating a driver defect. Learned: a QP change needs a fresh encoder, a new configuration and a keyframe.

13. **Initial-QP calibration (2026-10-27).** Six fresh encoders, each created with a fixed maximum QP: 2 s warm-up, then a fixed 10 s window at 1920×1280, 60 fps configured, 8 Mbit/s target. One run per condition.

    | Maximum QP | Content | Encoded per second | Mean | Highest 1 s window | Startup keyframe | Budget |
    |---:|---|---:|---:|---:|---:|---|
    | 30 | Low | 59.6 | 1.06 Mbit/s | 1.12 Mbit/s | 6,313 B | Pass |
    | 30 | High | 59.8 | 686.0 Mbit/s | 701.4 Mbit/s | 1,437,553 B | Fail mean, peak and keyframe |
    | 38 | Low | 59.7 | 1.07 Mbit/s | 1.14 Mbit/s | 5,662 B | Pass |
    | 38 | High | 59.8 | 392.9 Mbit/s | 402.5 Mbit/s | 844,433 B | Fail mean and peak; keyframe passes |
    | 51 | Low | 59.8 | 1.05 Mbit/s | 1.10 Mbit/s | 5,662 B | Pass |
    | 51 | High | 59.7 | 33.4 Mbit/s | 35.1 Mbit/s | 200,099 B | Fail mean and peak; keyframe passes |

    Learned: a higher QP ceiling cuts the high-entropy rate by about 20 times, but even QP 51 at full resolution stays above the target. No image quality was measured in these runs. This led to the current ladder (QP first, then scale, then frame rate; see the [decision log](#decision-log)).

14. **Avoiding the copy from the Electron main process to the window: rejected.** Each video update is copied when the main process passes it to the viewer window. Electron's `MessagePortMain.postMessage` accepts only message ports in its transfer list, not data buffers, so this copy cannot be avoided with the current design. The window also performs validation, timing and cursor work, so bypassing it is not planned. The later hop from the window to the decoder Worker already transfers the buffer without copying.

15. **Network chunk-stall run 1 and bandwidth-cap runs.** See [Network impairment profiles](#network-impairment-profiles). The chunk-stall failure was not reproduced in four later runs and its cause is unknown. Both bandwidth-cap runs fell back to the CPU encoder and stopped.

16. **Impairment proxy, first version: bandwidth limit per connection.** The first proxy applied its bandwidth limit to each TCP connection separately, so parallel connections could exceed the configured cap. It was corrected to share one limit per direction before any app run, and a test that fails on the old version was added.

17. **Short pairing code: library pairs that do not interoperate.** Candidate password-authenticated key exchange (PAKE) libraries were reviewed for the short pairing code. The C# SRP-6a implementation and the npm SRP package compute their proofs differently, and another .NET SRP library documents the same incompatibility, so they are not drop-in compatible. The available CPace libraries are pre-1.0 or experimental, and the CPace specification is still a draft. Relying on Tailscale plus trust on first use was rejected because it does not prove the code independently. The resulting design is in the [decision log](#decision-log).

18. **Real-desktop capture checks failing on the build machine.** Five of five real-capture checks failed with no first frame within 5 s while the session was unlocked. A read-only check showed the display was off. This led to the release-verification decision below.

19. **Windows integration fixture updates (2026-10-27).** These were development-app tests, not packaged-app tests. Runtime product code stayed unchanged. Earlier failures were retained:

    | Attempt | Outcome | What the evidence established |
    |---|---|---|
    | Command configuration | Failed before app launch | The wrapper passed literal quotes around its configuration filename |
    | Hidden-window mode | Failed after 89.74 s | Delivery was correctly paused for a hidden native window; this mode could not satisfy a live-stream assertion |
    | Original visible fixture | Failed after 15.67 s | The fresh-screen gate denied input before the older expected View-only denial |
    | First correction | Failed after 19.96 s | The popout probe lacked its required monitor binding and was denied before reaching the grant check |
    | Second correction | Failed after 15.11 s | Grant denial passed; the fixture still expected a thrown error where current IPC returns typed terminal metadata |
    | Third correction | Failed after 16.86 s | Typed status/code and non-retryable checks passed; the older owner-end text expectation was stale |
    | Fourth correction | Failed after 16.81 s | The cached ended popout uses a documented generic terminal message; that candidate's exact owner-text assertion was too strict |
    | Corrected full flow | **Passed**, 35.98 s overall | Native frames, host restart recovery, independent window gates, specific View-only denial, typed terminal responses, 16-second main/popout ended-state hold, no authorized sessions, denied reconnect before deliberate local Allow, unchanged five grants, multiple viewers, revocation and invitation-replay denial |

    The corrected fixture accepts only the finite source-defined terminal messages and exact terminal status/code pairs, requires non-retryable errors without frame data, and preserves the original UI and no-auto-resume checks. Automatic traces, screenshots and video are disabled for the native flow; controlled dashboard screenshots occur before pairing. This passing development flow does not establish packaged, cross-device or real-input validation.

## Decision log

Status: **decided** (agreed and in effect or merged), **in progress** (agreed, not finished), **paused**, **rejected**.

| Date | Decision | Reason | Status |
|---|---|---|---|
| 2026-10-26 | Remote TLS must be TLS 1.3, or TLS 1.2 only with ECDHE and AEAD ciphers | .NET on macOS may not serve TLS 1.3; CBC and static-RSA suites are refused | Decided |
| 2026-10-26 | A session ended by the host is final (HTTP 410) and is never resumed automatically | **Disconnect all** must hold, also across restarts | Decided |
| 2026-10-26 | Two repositories: a private one for development, a public one that receives only verified stable releases and product files | A stable public face, and a separate place for development and teaching | Decided |
| 2026-10-26 | Skip unchanged image frames (HTTP 304) and allow a smaller scale before choosing a lossy codec | Independent of the codec question and adds no dependency | Decided |
| 2026-10-26 | Lossy image compression through each OS's built-in encoder (Windows WIC, macOS ImageIO); no third-party codec | Keeps the dependency and supply-chain surface small | Decided |
| 2026-10-26 | Move from images to a hardware H.264 video stream: DXGI capture and Media Foundation encoding on Windows, one stream inside the same pinned mutual-TLS link, WebCodecs decoding; images stay as the fallback | Frame rate was the top priority. Adoption gate ≤ 8 ms per 1080p frame; measured 3.3–4.6 ms | Decided; video on by default in preview.5 |
| 2026-10-26 | The stream uses chunked HTTP records on the existing listener, not WebSocket | Reuses the existing certificate-pin check unchanged; no new client | Decided |
| 2026-10-26 | Build the viewer's decode pipeline on WebCodecs (VideoToolbox on Mac) instead of writing a decoder | A hand-written decoder would be slower, and parsing network input in new code is a memory-safety risk. A native Mac helper only if WebCodecs measures worse; it did not (2.4–4.3 ms) | Decided |
| 2026-10-26 | Maximum QP 30 on the NVIDIA encoder for sharp text | Static text 50.6 dB vs 46.3 dB within 0.5 s, within budget | Decided; kept on 2026-10-27 |
| 2026-10-26 | Keep TCP with mutual TLS; consider QUIC or WebTransport only if measured TCP misses the loss target | WebTransport has no client certificates, so it would need a security redesign, and a Mac host would need a new native library | Decided. Real packet loss has not been measured yet, so this stays open for review |
| 2026-10-27 | Timing runs use the generated test source; real-desktop tests are separate | Real-desktop runs could not start reliably; generated frames can be counted; the source is absent from release builds | Decided |
| 2026-10-27 | No operating-system input tests on the Windows development desktop; input is tested on the ARM laptop and Mac in test-owned windows | The desktop is the developer's working machine | Decided |
| 2026-10-27 | Per-device stream limits: 4 per device, 8 per host | Bound resource use | Decided |
| 2026-10-27 | Release verification on the build machine skips the real-desktop capture group and the four direct native-input probes, and prints each skipped name and the count | The build machine's display was asleep (capture checks cannot get a frame), and the input probes would touch the real input system. A later development checkout passed 1,165 remaining host checks; this count is not the frozen preview.5 baseline. An earlier retained-check runner on that release baseline passed 1,145 host checks. The Windows development-app UI fixture initially failed, then its corrected full flow passed in 35.98 s including the 16-second ended-session hold. Packaged-app validation is a separate release gate | Decided |
| 2026-10-27 | Windows encoders stay on Media Foundation, which already reaches the NVIDIA, Intel and AMD hardware encoders; encoders are chosen by probed capabilities, not vendor names | Avoids three vendor SDKs. A vendor SDK only if a measured Media Foundation limit blocks a goal | Decided; capability probing in progress |
| 2026-10-27 | H.264 first; HEVC and then AV1 only after H.264 meets its gates and both ends report support | Codec support differs per device and must be probed | Decided |
| 2026-10-27 | Viewer tries software decoding before falling back to images, and reports which decoder is active without claiming hardware when unknown | A hardware decoder error should not drop straight to images | Decided; merged |
| 2026-10-27 | Avoid the main-process-to-window copy | Electron cannot transfer data buffers there | Rejected |
| 2026-10-27 | Static maximum QP 51 as the default | Would lower text quality in normal use | Rejected |
| 2026-10-27 | Change maximum QP on a running encoder | Documented as static; the readback did not change | Rejected; QP changes reopen the encoder |
| 2026-10-27 | Bitrate overshoot ladder: start at QP 30; under sustained overshoot, reopen at QP 51 at the current size and rate, then scale 0.5, then 0.33, then 30 fps, then 15 fps, each with a fresh configuration and keyframe; at 4 times the target or more, jump straight to the first step predicted to fit. When recovering step by step, frame rate is restored first, then scale, then QP 30 | Based on the calibration above. Gate revision: the opening high-entropy keyframe at QP 30 is reported as a known limit rather than blocking the change, and the first window after each reopen is excluded from the overshoot count; all bytes still count in the reported mean and peak. Remaining gates: under 150 % within 6 s, low entropy unchanged, no text-quality loss, sharp text within 1 s after noise | In progress; not merged |
| 2026-10-27 | Short pairing code: 8 characters of base32 (40 random bits), single use, 10-minute expiry, cancelled after 5 failed attempts, plus a per-source rate limit; the long invitation stays | A code a person can read aloud. A password-authenticated exchange is required so that an attacker in the middle gets one online guess per attempt and no offline check | In progress |
| 2026-10-27 | One active short code per host | A host cannot tell which of several codes a viewer is using without a selector that would weaken the code | Decided |
| 2026-10-27 | PAKE: SRP-6a (RFC 5054 3072-bit group, SHA-256) with both roles run in the .NET host, using one library; the viewer's app delegates its role to its own local host. Both sides confirm with HMAC-SHA256 over a transcript that includes both TLS certificate fingerprints before anything is pinned or granted | One implementation on both sides avoids the interoperability problem | Decided as design. The library version is not pinned yet: the current release lacks a newer upstream hardening for SRP; no code written |
| 2026-10-27 | Tailscale plus trust on first use instead of a PAKE | Does not independently prove the code | Rejected |
| 2026-10-27 | Raspberry Pi host (Linux ARM64, image frames first, then hardware video) | Paused by the user | Paused |

## Security reviews

**26 October 2026.** Link policy: CBC-only and static-RSA clients are refused, and the viewer re-checks the negotiated suite after each handshake. A readable security code (the first 128 bits of the certificate's SHA-256) can be compared after pairing. Pairing refuses to overwrite a saved host with a different certificate. A host-ended session is final. The production npm dependencies had zero known vulnerabilities when checked; that is a database result, not an audit.

**27 October 2026, internal review of the app and host.** Every item was closed with tests that fail on the old code. In user terms:

- **Hardened installed app:** the packaged app cannot be run as Node.js, ignores `NODE_OPTIONS` and inspect flags, and loads only from its integrity-checked archive. Checked on a packaged build.
- **Received files are marked** as downloaded from the internet (Windows Zone.Identifier, macOS quarantine), staged before they appear, and checked against Windows short-name aliases.
- **Request body limits:** large request bodies are accepted only on upload routes.
- **Bounded shutdown:** the host stops and drains within a fixed time, and held input is released.
- **Stream caps:** 4 streams per device and 8 per host.
- **Blocking a device:** a device the host owner blocks shows **Disconnected by you · Allow again**, and **Disconnect all** targets only connected devices.
- **Identity changes are final:** if a host's certificate changes, the viewer stops, shows a clear message and does not reconnect.
- **Typed error codes:** session-end and denial decisions use typed codes, never error message text.
- One item was closed as not applicable after a check.

**27 October 2026, short pairing code design review.** Findings that changed the design before any code: pick one active code per host; define the exact transcript, including both certificate fingerprints taken from the live TLS connection; finish mutual confirmation before pinning or granting; keep unknown certificates confined to the pairing route; count attempts atomically across concurrent requests; keep 40 random bits with no modulo bias; and keep the code only in memory. For one code and five guesses, the chance of guessing is at most 5 in 2⁴⁰, about 4.55 × 10⁻¹². That bound is a calculation, not a proof of the whole implementation.

No independent security audit has been done. The threat model and remaining release requirements are in [SECURITY.md](../SECURITY.md).

## Not tested and known limits

- **AMD and Intel hardware encoders.** No such hardware was available.
- **Video from Mac and Linux hosts.** They send images. A Mac helper protocol and managed parser exist; the Swift capture producer and VideoToolbox encoder have not been implemented.
- **Linux at all.** The Linux backend has not run on real hardware; hardware decoding on a Linux viewer is untested.
- **Click-to-screen latency**, on one machine or between two.
- **Sustained video between two unlocked computers**, and direct versus relayed Tailscale paths for video.
- **Real packet loss.** The impairment proxy cannot drop packets.
- **Adapting to a slow link.** The 8 Mbit/s cap runs fell back instead of adapting.
- **Busy or noisy content** can exceed the bitrate target many times over; the overshoot response is not merged.
- **Long runs.** No soak test longer than a few minutes; no resource-use (CPU, GPU, memory) tracking over time.
- **Several monitors streaming at once**, mixed DPI, hot-plugging.
- **Spontaneous capture loss** (only injected resets were tested), sleep and wake, lock and sign-in screens.
- **Clicks, typing and scrolling** on the ARM host; operating-system input on the Windows development desktop.
- **Image quality** of the bitrate ladder, and 4:4:4-equivalent text.
- **Real-desktop capture checks and native input probes** were not part of the automated release checks on the build machine.
- **Audio** is not implemented.

## How to reproduce

The internal measurement harnesses (numeric collectors, the byte-level impairment proxy and the encoder-only bitrate harness) are not published. Their results are stated on this page. The public pieces are:

- [docs/PERFORMANCE.md](PERFORMANCE.md): pipeline description, method notes and a repeatable measurement checklist.
- [scripts/perf/measure-frames.mjs](../scripts/perf/measure-frames.mjs) and its [README](../scripts/perf/README.md): image-path frame cost against the real host on loopback.
- [scripts/perf/throttle-proxy.mjs](../scripts/perf/throttle-proxy.mjs) and [scripts/perf/STABILITY.md](../scripts/perf/STABILITY.md): a public loopback proxy with bandwidth, latency, stall and drop settings. It is similar to, but not the same tool as, the proxy used for the impairment profiles above.
- [src/Orbit.Host/DiagnosticSource.cs](../src/Orbit.Host/DiagnosticSource.cs): the generated test source. Build the host in the `Diagnostic` configuration and set `ORBIT_DIAGNOSTIC_SYNTHETIC`; `ORBIT_DIAGNOSTIC_PATTERN`, `ORBIT_DIAGNOSTIC_WIDTH` and `ORBIT_DIAGNOSTIC_HEIGHT` select the pattern and size. Checks: [tests/Orbit.Host.Tests/DiagnosticSourceChecks.cs](../tests/Orbit.Host.Tests/DiagnosticSourceChecks.cs).
- [tests/Orbit.Host.Tests/H264EncoderChecks.cs](../tests/Orbit.Host.Tests/H264EncoderChecks.cs) and [tests/Orbit.Host.Tests/TextSharpnessSpike.cs](../tests/Orbit.Host.Tests/TextSharpnessSpike.cs): hardware encoder checks and the generated text-sharpness test.
- [tests/Orbit.Host.Tests/Program.cs](../tests/Orbit.Host.Tests/Program.cs): the host test suite. `ORBIT_TEST_SKIP_NATIVE_DESKTOP=1` skips only the real-desktop capture group and the four direct native-input probes, and prints their names.
- [scripts/check.ps1](../scripts/check.ps1): host checks, desktop tests and build.
- [docs/VALIDATION.md](VALIDATION.md) and [docs/MACOS-VALIDATION.md](MACOS-VALIDATION.md): the validation records.
