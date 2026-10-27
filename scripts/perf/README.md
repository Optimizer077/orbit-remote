# scripts/perf

`measure-frames.mjs` measures what one screen update costs on the real Orbit host.
It runs on this computer only, over loopback.

## Run

Requires Node 24 and the .NET 10 SDK. It has no npm dependencies.

```bash
node scripts/perf/measure-frames.mjs            # print a Markdown table
node scripts/perf/measure-frames.mjs --write    # also update the block in docs/PERFORMANCE.md
```

| Option | Default | Meaning |
|---|---|---|
| `--frames N` | 30 | Timed requests per mode |
| `--warmup N` | 2 | Requests per mode that are discarded before timing (JIT, first capture) |
| `--interval MS` | 260 | Pause between requests (the viewer's poll delay); `0` = back to back |
| `--config Release\|Debug` | Release | Build configuration for the isolated host build |
| `--dll PATH` | (build) | Use an existing `Orbit.Host.dll` instead of building |
| `--control-port` / `--remote-port` | 48931 / 48932 | Host ports. They are kept separate from the e2e ports (47931/47932) |
| `--write` | off | Rewrite only the text between `<!-- perf:start -->` and `<!-- perf:end -->` |

A run takes about one minute. For a meaningful idle-screen 304 result, start it,
then leave the machine alone and keep animated content (spinners, video, a
seconds clock) off the captured display.

## What it does

1. Builds the host into a temp directory with `--artifacts-path`, so the shared
   `src/Orbit.Host/bin` and `obj` folders are not touched. With `--dll`, it skips the build.
2. Starts `Orbit.Host --loopback-test` with a random control token and a temp
   `ORBIT_DATA_DIR`. It runs in standalone mode with bearer-only local access: no
   `ORBIT_PARENT_PROOF` or `ORBIT_PARENT_WATCH`. It refuses to continue unless the
   host reports loopback-test mode on 127.0.0.1.
3. Pairs a view-only viewer the same way the host test harness does: a local
   invite, then remote `/api/pair` over pinned mutual TLS
   (`apps/desktop/electron/transport.cjs`). The viewer certificate is the host's
   exported identity.
4. Starts a view-only session and times `GET /api/sessions/{id}/frame` in four modes:
   full scale; full scale with `If-None-Match` (304 path); `scale=0.75`; `scale=0.5`.
5. Reports body bytes (median/p95), request time in ms (median/p95), the 304
   ratio and the encoded dimensions. It also records the date, OS and CPU model,
   captured display size and host commit.
6. Always tears down: it ends the session, revokes the device, stops the host and
   deletes the temp directory, on failure and on Ctrl+C as well.

## Privacy

The host captures this machine's screen into memory. The script keeps only each
response's length and headers. It never writes, prints, hashes or decodes
pixels. Nothing is sent beyond 127.0.0.1. The report contains no hostname, IP,
username or path.

## What it does not prove

- **No network.** Loopback excludes latency, bandwidth limits, packet loss,
  DERP relays and Tailscale path changes. The "at 2 Mbit/s" column is arithmetic.
- **Not frame rate or end-to-end latency.** It skips Electron IPC, base64
  conversion, image decode and presentation.
- **Content-dependent.** PNG size depends on what is on screen. The 304 ratio
  depends on screen activity: any change (a clock, a cursor, a terminal spinner)
  forces a full frame.
- **One machine, one run.** Results do not carry over to macOS or Linux backends,
  which do not yet support scaling or 304. They also do not carry over to
  multi-monitor setups or other hardware.
- Request time includes a new TLS handshake per request, as the viewer does
  today. A persistent connection would be faster. This script does not measure that.
