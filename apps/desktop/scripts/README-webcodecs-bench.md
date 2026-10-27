# WebCodecs H.264 bench (D11 spike)

`webcodecs-bench.cjs` measures whether Electron's WebCodecs `VideoDecoder` (and `VideoEncoder`) is hardware-accelerated
on this machine and fast enough for the D11 video stream. It opens a hidden, sandboxed window, runs the benchmark in the page,
prints one JSON object to stdout and exits.

## Run

From `apps/desktop`:

```bash
# Windows (Git Bash) and macOS. Unset ELECTRON_RUN_AS_NODE if your shell sets it (VS Code terminals do).
unset ELECTRON_RUN_AS_NODE
npx electron scripts/webcodecs-bench.cjs > webcodecs.json          # defaults below, about 3.5 min
npx electron scripts/webcodecs-bench.cjs --size 1920x1080 --codecs high --content text --frames 240 --fps 60
npx electron scripts/webcodecs-bench.cjs --stream ../../artifacts/d11/synthetic-1080p.h264 [--codec avc1.64002A]
```

PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; npx electron scripts/webcodecs-bench.cjs`.
On a Mac, pass the Retina size, for example `--size 1920x1080,3024x1964`.

| Option | Default | Meaning |
|---|---|---|
| `--size` | `1920x1080,3024x1898` | Comma-separated sizes for the synthetic mode. |
| `--frames` / `--fps` | `240` / `60` | Frames per pass and the pacing rate. |
| `--bitrate` / `--keyint` | `8000000` / `120` | In-page encoder target bitrate (bit/s) and keyframe interval (frames). |
| `--content` | `text,video` | `text`: glyph-like rectangles on white, scrolling 3 px/frame, a typed line and a caret. `video`: moving gradient and blobs. |
| `--codecs` | `baseline,main,high` | Profile names (the level is derived from size and fps) or explicit `avc1.xxxxxx` strings. |
| `--stream <file>` | | Decode an Annex-B H.264 file instead of synthetic content. The codec comes from `--codec`, then `<file>.json` / `<name>.json` (`{"codec": ...}`), then the SPS. The file must start with an IDR access unit. |
| `--no-software` | | Skip the software-decoder comparison passes. |
| `--warmup` | `10` | Frames excluded from latency and draw statistics (decoder/encoder start-up). The first frame is reported separately as `firstOutputMs`. |
| `--dump <dir>` | | Write each synthetic encode as `<content>-<size>-<codec>.h264` plus a `.json` with the codec string (input for `--stream`). |
| `--out <file>` | | Also write the JSON to a file. |

## What it measures

Synthetic mode, per size × codec × content: encode in the page with `VideoEncoder` (`prefer-hardware`, falls back to
`prefer-software`; `latencyMode: 'realtime'`, Annex-B), then decode the result with `VideoDecoder` (`optimizeForLatency: true`) in these passes:

| Pass | Submission | Draw | Reported |
|---|---|---|---|
| `hardware.pacedCanvas2d` | one access unit every 1/fps | `drawImage` on a 2D canvas, `frame.close()` at once | `decodeLatencyMs`, `drawMs`, `fps`, `dropped` |
| `hardware.pacedWebgl` | paced | `texImage2D` + quad in WebGL2, then a 1-pixel `readPixels` | `drawSyncMs` = time until the GPU has really finished the upload and draw |
| `hardware.maxCanvas2d` / `maxNoDraw` | as fast as possible (queue ≤ 4) | 2D canvas / none | `fps` = maximum decode rate |
| `software.pacedCanvas2d` / `maxNoDraw` | same, with `prefer-software` | | comparison baseline |

Field notes:
- `support`: `isConfigSupported` for `prefer-hardware` and `prefer-software`, decoder and encoder. In Chromium, `prefer-hardware`
  only accepts a hardware codec, so a pass that runs under `prefer-hardware` ran on the hardware decoder.
- `decodeLatencyMs`: `decode()` call → output callback, median/p95/max after warm-up. With hardware decode the output callback can
  fire before the GPU has finished the frame; `drawSyncMs` bounds that.
- `drawMs` (2D canvas) is the CPU time of `drawImage`, not GPU time.
- `dropped`: chunks submitted minus frames output. `error`: the first decoder/encoder/draw error.
- `frameInfo.format`: `VideoFrame.format` of the first frame. `null` would mean a GPU texture that can't be mapped. `NV12` or `I420`
  does not prove where the pixels live; the script can't tell whether a frame is GPU-backed.
- `encode`: `encodeLatencyMs` (submit → chunk), `frameGenMs` (draw the synthetic frame + `new VideoFrame`), `bytesPerFrame` (key and delta),
  `actualKbps`, `queueWaits` (times the encoder queue was full), `hardwareAttempt` (why hardware encode was skipped).
- `verdict`: hardware decode used, keeps up at `--fps` with no drops, median/p95 latency under 10 ms, maximum fps without drawing.
- `gpu.featureStatus`: Chromium's `video_decode`, `video_encode`, `gpu_compositing`, `2d_canvas`. `gpu.devices`: PCI vendor/device IDs and driver versions.
  `active` can read `false` for every adapter; don't rely on it.

## Privacy and safety

- Synthetic content only. The script never captures or reads the screen (no `desktopCapturer`, no `getDisplayMedia`).
- No network. The page comes from a private `orbit-bench://` scheme in an in-memory session; every other request is cancelled and every permission request is denied.
- The page is sandboxed, with `contextIsolation` on and no Node. The JSON holds timings, sizes, codec strings, Chromium feature status and GPU PCI IDs and driver versions. It holds no pixels.
- `--dump` writes the synthetic H.264 streams only, to the folder you name. Keep them under `artifacts/` (gitignored).
