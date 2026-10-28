# Orbit Remote performance

Since preview.5, Windows hosts send the screen as hardware H.264 video by default. Mac and Linux hosts, and any session where video can't run, send images instead. This page records what has been measured, how it was measured, and what has not been measured yet.

Every stream result here comes from one Windows PC. Click-to-screen latency and video between two computers have not been measured. The [architecture](ARCHITECTURE.md) describes process and trust boundaries, the [protocol](PROTOCOL.md) defines the stream records, and [VALIDATION.md](VALIDATION.md) records completed checks. [RESULTS.md](RESULTS.md) is the full record of experiments, including failed and incomplete runs, rejected approaches, and the decision log.

## Streaming pipeline

<p align="center">
  <picture>
    <source media="(max-width: 767px) and (prefers-color-scheme: dark)" srcset="assets/diagrams/pipeline-narrow.svg">
    <source media="(max-width: 767px)" srcset="assets/diagrams/pipeline-narrow-light.svg">
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/pipeline.svg">
    <img src="assets/diagrams/pipeline-light.svg" width="1000" alt="The hardware streaming pipeline, measured per stage at 3024 by 1898: GPU capture 4.4 ms per changed frame, hardware H.264 encode 5.8 to 7.6 ms (2.5 to 2.9 ms at 1080p), one stream of 2 to 26 KB per update inside the pinned mutual-TLS link, hardware decode 0.5 to 0.7 ms (2.4 to 3.3 ms on a Mac), and drawing in 0.2 ms. Measured live on one PC: 59.3 frames per second at native 2560 by 1440 with about 300 KB/s. Click-to-screen latency is not measured yet.">
  </picture>
</p>

1. **Capture.** The host duplicates the chosen monitor on that monitor's GPU (DXGI Desktop Duplication). An unchanged screen produces no new frame.
2. **Encode.** The GPU's H.264 encoder, reached through Windows Media Foundation, runs in low-latency mode with no B-frames. Keyframes are sent when a viewer joins or asks for one.
3. **Send.** One long-lived request on the pinned mutual-TLS listener carries a sequence of stream records: configuration, video, cursor, and a final record that says why the stream ended. The host keeps at most 8 unacknowledged frames, and at most about 100 ms of the target bitrate, in flight. When the link can't keep up, it skips capture and encoding instead of queueing old frames, so the frame rate drops and latency stays bounded.
4. **Decode.** The viewer decodes with WebCodecs. Chromium backs it with D3D11VA on Windows, VideoToolbox on macOS, and VA-API on Linux; if no hardware decoder accepts the stream, or the hardware decoder fails before its first frame, the software decoder takes over. Connection details shows *Hardware* only after a hardware-only decoder has produced a frame, *Software* for the software decoder, and *Not confirmed* otherwise. The main process keeps at most three records on their way to the decoder. If 12 frames are already waiting to be decoded, or the oldest has waited more than 500 ms, the viewer resets the decoder, keeps the last picture on screen, and asks for a keyframe.
5. **Present.** Every frame is decoded, but at most two are drawn per display refresh. A decoded frame is drawn at once when nothing newer is still in the decoder or waiting to enter it and no frame was drawn at once yet in this refresh; otherwise it waits for the next refresh, where only the newest waiting frame is drawn. A burst's last frame is therefore drawn as soon as it is decoded. Decoders that keep several frames queued (Windows on ARM) wait at most one refresh. Replaced frames are released immediately and counted apart from dropped frames, so they do not lower the smoothness rating. The viewer draws the pointer itself from cursor shapes the host sends separately.

**Fallback.** If the host can't stream video, or the stream fails, the viewer asks for single images and retries video automatically. Images travel over reused pinned connections as binary frames. Windows hosts send PNG or JPEG, whichever is smaller, and can also send smaller images and skip unchanged ones ([image fallback](#image-fallback)).

## Measured results

Environment: Windows 11 Pro x64, Intel Core Ultra 7 265F, NVIDIA RTX 5060 Ti. Samples are small and, outside the synthetic runs, screen content was not controlled. Treat the numbers as direction, not guarantees.

### Per stage

Medians from separate measurements of each stage, on synthetic content unless noted.

| Stage | Result | Conditions |
|---|---|---|
| GPU capture | 4.4 ms per changed frame; checking an unchanged screen costs about 0 ms | 3024×1898. For comparison: 62 ms for a GDI BitBlt, and 155 ms for preview.4's whole capture path with cursor and PNG |
| Hardware encode | 2.5–2.9 ms per 1080p frame; 5.8–7.6 ms at 3024×1898; updates of 2–26 KB | NVIDIA encoder, Release build; no frames of encoder delay |
| Viewer decode | 0.5–0.7 ms on Windows; 2.4–3.3 ms on an Apple-silicon Mac | 1080p and 3024×1898; 60 and 120 fps with no dropped frames |
| Draw | 0.2 ms | Canvas |

The stage times add up to about 11–13 ms per frame at 3024×1898, plus network, IPC, and queueing. This is a sum of separate measurements, not an end-to-end result.

### Whole stream

| Run | Result | Method |
|---|---|---|
| **Live desktop** | **59.3 fps at native 2560×1440** (1,780 frames in 30 s); decode 0.6 ms median, 1.5 ms p95; about 300 KB/s | The real app on a real desktop, host and viewer on the same PC over pinned mutual TLS on loopback. The image path on the same screen: about 20.8 fps at 12.5 MB/s |
| Synthetic, one viewer | 3601 of 3601 frames drawn in 60 s, 60.0 fps; frame interval p95 17.7 ms | A generated 60 fps test source through the full pipeline on one PC |
| Synthetic, two viewers | Both viewers held 60 fps | The same test with two viewers at once |

### Viewer presentation

Measured on 2026-10-28 for the credit window of three and newest-frame presentation described above.

| Delivery | p95 from parsed frame to canvas draw | Dropped | Method |
|---|---|---:|---|
| Paced, 60 fps | 1.3 ms, against 1.2–1.6 ms for the previous code (equal within noise) | 0 | An Electron 45 bench: generated content encoded with the browser's software H.264 encoder, replayed through the real stream client, decoder Worker and canvas; old and new code run in interleaved pairs |
| Burst (three frames at once every third interval) | 0.2–0.8 ms above the previous code (gate: at most +1 ms) | 0 | Same bench |

In burst delivery fewer frames are drawn per second than before, because frames replaced before the next refresh are skipped by design; they are still decoded and are counted as replaced, not dropped. The bench stops at the canvas draw, not at the display; the hop from the main process to the window is simulated; and the machine was shared with other work. Details: [RESULTS.md](RESULTS.md#viewer-presentation-bench).

### Bitrate on very noisy content (in development)

A safety net for content that overshoots the bitrate target is in development and **not merged**. Component measurements of the host's stream loop and GPU encoder alone, without a viewer or network, on the NVIDIA RTX 5060 Ti x64 PC (1920×1280 generated source, 60 fps, 8 Mbit/s target, 60-second window), 2026-10-27:

| Content | Without the safety net | With the safety net |
|---|---|---|
| Full-frame noise | 688.5 Mbit/s mean (encoder only) | 7.98 Mbit/s mean, 8.27 Mbit/s highest 1 s; under 150 % of the target 2 s after the first over-budget window; reduced to QP 51 at one third of the size |
| Low-entropy pattern | 1.079 Mbit/s mean, 59.98 frames per second (encoder only) | 1.08 Mbit/s mean, 60.0 frames per second; the safety net never stepped in |

The opening keyframe on noisy content (about 1.44 MB) is still over the keyframe budget, and image quality has not been measured yet. These are not end-to-end viewer results. Details: [RESULTS.md](RESULTS.md#bitrate-safety-net-native-component-results).

### Recovery

| Event | Time | Notes |
|---|---|---|
| Host restart | About 0.45 s | From the restarted host reporting healthy to video on screen; 1.9 s from stopping the host |
| One-click **Reconnect** | About 0.42 s | — |
| Quality change | About 0.13–0.15 s | Without restarting the stream |
| Capture reset | About 0.15 s | Gap in drawn frames |

### Method notes

- **Synthetic source versus live desktop.** The synthetic source produces a known animation at 60 fps, so every frame can be counted: 3601 of 3601 means none was lost. It is simple content that compresses well, so it says little about bitrate on busy screens. The live run used whatever was on the desktop; content was not controlled, and a different screen would give different sizes.
- **One PC.** Host and viewer ran on the same computer. The runs exclude real network latency, bandwidth limits, packet loss, and Tailscale relays.
- **Stage timings** come from separate measurements of each stage. They show where time goes; they are not a latency measurement.
- **Viewer timing in Connection details.** For video, the viewer keeps the last two seconds (at most 240 frames) of per-frame timings and reports p50/p95/p99. *Viewer pipeline* is the sum of two durations, each timed on its own clock: from the frame's arrival stamp in the viewer window to its hand-off to the decoder Worker, and from the Worker receiving it to the draw on the canvas, including any wait for the display refresh. The hop from window to Worker is not measured. Within the Worker, *decode* runs from the `VideoDecoder.decode()` call to the decoded frame, so it includes the decoder's internal queue, which WebCodecs does not expose separately; the wait before that call is reported on its own. The main process separately reports how long a parsed frame waited for decoder credit before it was posted to the window. The hop from main to the renderer, and any wait in the renderer's task queue before the arrival stamp, are not measured. *Control round trip* is the time from sending one of this app's existing stream control (acknowledgement) requests to receiving its response, in the main process: it includes host request handling, connection setup or socket wait on the pooled connection, and main event-loop delay, so its minimum is the best estimate of the link round trip. None of these includes host capture, encoding, or one-way network time. No timestamp is subtracted across processes, across the window and the Worker, or from host timestamps.

### Not measured yet

- **Click-to-screen latency.** This needs an instrumented loop or a high-speed recording with a documented method. The viewer pipeline and round-trip figures in Connection details cover only part of it (see the method notes).
- **Video between two computers.** Windows-generated video has reached a Mac viewer ([Mac handoff](MACOS.md)), but sustained cross-device playback, direct versus relayed paths, and lossy links have not been measured.
- **AMD and Intel encoders.** Only an NVIDIA hardware encoder has been measured.
- **Mac and Linux hosts.** They have no video stream and send images. Hardware decode on a Linux viewer is untested.
- **Busy screens.** Very busy or noisy content can exceed the bitrate target. The safety net above is measured only as a component; its effect on image quality and on a real viewer is not measured.
- **Long runs, several monitors, and resource use** (CPU, GPU, memory) over time.

Targets, set against published figures from leading tools: 1080p60 on a LAN; ≤ 10–16 ms added LAN latency (Parsec reports 7 ms); at 1 % loss no freeze longer than 100 ms; text as sharp as 4:4:4. These are targets, not results.

## Image fallback

Mac and Linux hosts, and Windows sessions where video can't run, send one image per update. In preview.5 this path reuses pinned mutual-TLS connections and sends binary frames to a canvas without a fixed pause. Windows hosts also pick the smaller of PNG or JPEG for each frame, accept a smaller `scale` (0.33 to 1), and answer an unchanged screen with `304 Not Modified` and no image. Mac and Linux hosts send full-scale PNG.

| Change | What it fixes | Measured effect |
|---|---|---|
| Connection reuse | A pinned mutual-TLS handshake for every frame | ~1.2 s of handshake round trips per frame removed at 150 ms RTT (estimated from a throttled run; the certificate pin is still checked on every new connection) |
| Binary frames on a canvas, no fixed 260 ms pause | Stop-and-wait polling, base64 over IPC | Viewer updates 2.0 → 3.75 per second on loopback (~1.85×) |
| Smaller of PNG or JPEG per frame | ~1 MB PNG per frame | Full-scale 1044 → 497 KiB. Through a 2 Mbit/s, +150 ms, 1 % loss proxy: 5.2 → 2.5 s per full frame, 1.2 s at half scale. Text-heavy frames still choose lossless PNG |

**Cross-device image baseline (preview.4, Tailscale relayed, view-only, 30 frames):** Mac viewing Windows, median 1.86 s / p95 2.69 s per frame (~940 KB PNG, TLS 1.3); Windows viewing Mac, 1.77 s / 6.16 s (~1.36 MB Retina PNG, TLS 1.2). This predates every change on this page. See [VALIDATION.md](VALIDATION.md).

### Loopback frame-cost baseline

The block below is generated by [scripts/perf/measure-frames.mjs](../scripts/perf/measure-frames.mjs) against the real host in `--loopback-test` mode. It records image size and host-side request cost on one machine. It was recorded on 2026-10-26, before the image-path changes above. It is not a network, latency, or frame-rate benchmark. Regenerate it with `node scripts/perf/measure-frames.mjs --write`; edits inside the markers are overwritten.

<!-- perf:start -->
Measured 2026-10-26 with `node scripts/perf/measure-frames.mjs` (see [scripts/perf/README.md](../scripts/perf/README.md)).

- Machine: Windows 11 Pro x64, Intel(R) Core(TM) Ultra 7 265F, 20 logical processors
- Display: 3024×1898 captured (session default display; primary display 3024×1898, 1 display attached)
- Host: commit `d7d264f`, Release build
- Method: 30 timed requests per mode after 2 discarded warm-up requests, 260 ms pause between requests (the viewer's poll delay), view-only session, one new pinned mutual-TLS connection per request (as the viewer does today).

| Mode | Requests | 304 ratio | Encoded size | Body bytes median | Body bytes p95 | Request ms median | Request ms p95 | Median body at 2 Mbit/s |
|---|---|---|---|---|---|---|---|---|
| Full scale, no validator | 30 | 0/30 | 3024×1898 | 996.0 KiB | 1009.1 KiB | 148.1 | 181.0 | 4.08 s |
| Full scale, If-None-Match | 30 | 0/30 | 3024×1898 | 992.4 KiB | 996.6 KiB | 145.6 | 176.5 | 4.06 s |
| Scale 0.75, no validator | 30 | 0/30 | 2268×1424 | 706.1 KiB | 710.5 KiB | 204.4 | 228.9 | 2.89 s |
| Scale 0.5, no validator | 30 | 0/30 | 1512×949 | 380.8 KiB | 403.5 KiB | 168.4 | 191.3 | 1.56 s |

No 304 responses in this run: the screen changed between every poll (for example an animated terminal, clock or cursor), so this run did not observe idle-screen savings. Same-pixel 304 behaviour is covered by the host unit checks in `tests/Orbit.Host.Tests/FrameQualityChecks.cs`.

Caveats:

- Loopback only. Request time covers TLS setup, host capture, hashing, scaling and PNG encoding, and local transfer. It excludes real network latency, bandwidth limits, DERP relays, Electron IPC, base64 conversion and image decode.
- "Body bytes" counts the HTTP response body only (a 304 has none); headers and TLS overhead are not included. The 2 Mbit/s column is arithmetic, not a measurement.
- The 304 ratio depends on screen activity during the run: a clock, cursor blink or animation changes the pixels and forces a full frame. PNG sizes depend on what was on screen. Screen content was not controlled.
- One machine, one run. No Mac, Linux, multi-monitor or real-network result follows from these numbers.
<!-- perf:end -->

## Tailscale path matters

A direct Tailscale path generally offers lower latency and more throughput than DERP relay traffic. Peer relay is another possible path. A connection may change paths, so record the actual path during each run rather than assuming that a successful pairing means a direct connection. [Tailscale connection types](https://tailscale.com/docs/reference/connection-types)

While the devices communicate, inspect:

```bash
tailscale status
tailscale ping <peer-tailscale-ip>
```

Record `direct`, DERP `relay`, or `peer-relay` as reported, together with network location and round-trip observations. Keep raw diagnostic output private if it identifies devices or users. Tailscale's status/ping commands help distinguish transport limitations from application work; they do not measure Orbit's capture-to-screen latency. [Tailscale path diagnostics](https://tailscale.com/docs/reference/connection-types#determine-your-connection-type)

## Repeatable measurement checklist

Use a local recovery route, view-only first, and explicit input approval. Do not include lock, restart, clipboard writes, or file transfers in a passive capture benchmark without deliberately enabling those operations.

1. **Record the environment.** Source commit and build mode; host/viewer OS and architecture; CPU/GPU and encoder; power state; monitor pixels, scale, rotation, and layout; OS permissions; Tailscale version/path; approximate available link bandwidth.
2. **Use repeatable screen content.** Idle desktop, text scrolling, dragging a window, and a motion-heavy scene. Record the same actions for every candidate implementation.
3. **Measure stages.** Capture and encode time, encoded bytes, decode and draw time, drawn-frame intervals, fallbacks to images, input response, and disconnect/recovery time. The viewer's **Connection details** panel shows smoothness, late frames, decode time, and encryption. Record host/viewer CPU, memory, and GPU use where available.
4. **Compare one and multiple displays.** Start with one viewer window, then two existing monitors in the same session. Include mixed-DPI and headless/disconnected-display cases where supported. Record skipped/error frames and queue growth.
5. **Test impaired paths.** Include direct and relayed paths, interruptions, sleep/wake, slower bandwidth, and a peer that stops reading. Keep pending work and memory bounded; denial and revocation must still take effect.
6. **Publish distributions and limits.** State sample count, run duration, workload, median/tail values, failure count, and test method. Enter actual observations in [VALIDATION.md](VALIDATION.md); leave unmeasured fields unmeasured.

Use a single monotonic clock for local stage timings. Host capture timestamps and viewer wall-clock times cannot establish one-way latency unless their clocks are synchronized and the synchronization error is stated. For end-to-end input-to-image latency, use an instrumented loop or high-speed recording with a documented method. A local loopback test cannot establish internet, DERP, Mac, or Linux performance.

## Next measurements

1. **Click-to-screen latency** on one PC and between two computers, with a documented method.
2. **Cross-device video** on direct and relayed Tailscale paths, with Windows, Apple-silicon Mac, and Windows on ARM viewers.
3. **Other encoders:** AMD and Intel hardware H.264 on Windows hosts.
4. **Busy content** against the bitrate target, and behavior on slow and lossy links.
5. **Long runs and resource use**, including several monitors streaming at once.
6. **Video from Mac and Linux hosts.** Evaluate ScreenCaptureKit on macOS and supported portal/PipeWire capture on Wayland; validate cursor, privacy permissions, display changes, and device-loss recovery on each platform.

Audio needs its own capture, transport, permission state, buffering, and synchronization work; there is no audio channel in the preview. Adding a [virtual monitor](VIRTUAL_DISPLAYS.md) creates desktop space only; it does not make the stream faster or provide an additional independent user session.
