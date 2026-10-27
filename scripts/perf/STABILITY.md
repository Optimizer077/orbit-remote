# Weak-network stability testing

How to examine the workloads described in [the performance guide](../../docs/PERFORMANCE.md) on one computer, using
the real host over loopback and `throttle-proxy.mjs` in front of it.

## The pieces

| File | Role |
|---|---|
| `scripts/perf/throttle-proxy.mjs` | TCP proxy that limits bandwidth, adds latency, simulates loss, and drops the link on a schedule. It passes TLS through untouched, so pinning and mutual TLS work end to end. |
| `scripts/perf/measure-frames.mjs` | Starts the real host in `--loopback-test` mode (control 48931, remote 48932), pairs a view-only viewer, and times frame requests. |
| `apps/desktop/electron/quality.cjs` | The viewer's adaptive state machine (presets, step down/up, idle refine, backoff). It is pure, so it can also be replayed offline from a recorded timeline. |

```
measure-frames / viewer ──TLS──▶ proxy 127.0.0.1:48952 ──TLS (opaque)──▶ host 127.0.0.1:48932
                                  kbit/s · latency · loss · drops
```

## Proxy model

- **Bandwidth:** one token bucket per direction, shared by all connections (one link). `--kbps` sets both directions; `--up-kbps` and `--down-kbps` override each. The default burst is 16 KiB (`--burst`).
- **Latency:** `--latency` is one-way, so RTT = 2 × latency. The first upstream bytes of each connection wait one extra RTT to stand in for the TCP handshake.
- **Loss:** `--loss` is a per-packet percentage (1460-byte packets). A lost 4 KiB slice is charged to the bucket twice and stalls its connection by `--loss-stall` (default 200 ms + RTT). Later slices queue behind it, the way TCP head-of-line blocking works. Bytes are never dropped, corrupted or reordered. `--seed` makes the loss pattern repeatable.
- **Drops:** `--drop-at 20[,60]` (seconds after start) and `--drop-for 10`. There are two modes:
  - `reset` (default): closes every connection and closes the listening port, so new connects are **refused**. Windows retries a refused loopback connect for about 2 s before it reports ECONNREFUSED.
  - `stall`: closes nothing and refuses nothing. Data is held until the window ends, the way a Wi-Fi blackout looks: requests hang instead of failing.
- Every 5 s the proxy prints counters (`accepted`, `closedByDrop`, `bytesUp/Down`, `lossEvents`, `drops`).

## Run: 2 Mbit/s, 300 ms RTT, 1 % loss

```bash
# Terminal 1: the shaped link. Start it before the host so the timeline begins at 0.
node scripts/perf/throttle-proxy.mjs --listen 127.0.0.1:48952 --target 127.0.0.1:48932 \
  --kbps 2000 --latency 150 --loss 1 --seed 7

# Terminal 2: the real host plus the frame timer, routed through the proxy
node scripts/perf/measure-frames.mjs --via 127.0.0.1:48952 --frames 60
```

**`--via` does not exist yet.** It is the one change `measure-frames.mjs` needs, and its owner (claude-perf) should make it. After `parseInvite`, set `device.address = 'https://' + via` and leave the loopback check and the pinned fingerprint as they are. TLS validation is by fingerprint, not hostname, so pairing and frames then run through the proxy with no other change. Until then, the proxy and `quality.cjs` are covered only by their own tests (below).

Never pass `--write` on a shaped run. It would overwrite the loopback baseline in `docs/PERFORMANCE.md`.

What to read from the output, against the plan's targets:

| Target | Pass if |
|---|---|
| Idle screen ≤ 5 KB/s | In the If-None-Match mode, 304 ratio ≈ 100 % and bytes/s = median bytes × updates/s ≤ 5 KB/s. Proxy `bytesDown` over the run gives the same figure, TLS overhead included. |
| ≥ 2 updates/s at Balanced while typing | Median request ms + 260 ms poll ≤ 500 ms at `scale=0.75` (plus `format=jpeg&q=75` once D10 lands). At 2 Mbit/s a full-size PNG takes about 3.6 s, so this needs JPEG. |
| Controls never freeze during video | p95 request ms stays bounded (no growing queue); proxy `lossEvents` > 0 shows loss actually happened. |
| Good LAN: Auto picks Sharp | Run once without shaping (`--kbps 0 --latency 0`): p95 request ms stays under the 350 ms budget, so `quality.cjs` never steps down (2026-10-26 loopback p95: 181 ms). There, 0.75 PNG (204 ms) is slower than full PNG (148 ms) because capture and encode dominate. Step-up therefore uses a predicted time from learned sizes and throughput, not "is the current level fast" (see the `CPU-bound LAN` test). |

## Run: 10 s drop and recovery

```bash
node scripts/perf/throttle-proxy.mjs --listen 127.0.0.1:48952 --target 127.0.0.1:48932 \
  --kbps 2000 --latency 150 --drop-at 20 --drop-for 10              # then repeat with --drop-mode stall
node scripts/perf/measure-frames.mjs --via 127.0.0.1:48952 --frames 120 --interval 260
```

Pass if: frames fail during 20–30 s, start succeeding again **without restarting anything** after 30 s, and the session is the same one (no re-pair, no 401/410). For the full viewer (once W3 wires `quality.cjs`), also check by eye that the last image stays visible and dimmed, the bar shows `Reconnecting… (n)`, and no input is sent while down.

Expected recovery delay: with the 0.5 → 1 → 2 → 4 → 8 s backoff and fast failures (`reset` mode), retries land about 0.5, 1.5, 3.5, 7.5 and 15.5 s after the drop starts. A 10 s outage is therefore noticed as over about **5–6 s after the link returns** (jitter only shortens it). If that is too slow, cap the backoff at 4 s, or reset it on an OS network-change event. In `stall` mode, nothing fails. The in-flight request finishes late (about 10 s), because the 15 s transport deadline is longer than the outage.

## Proven by unit tests (no host needed)

```bash
node --test apps/desktop/electron/quality.test.cjs      # presets, capabilities, fast down / slow up, hysteresis, idle refine, backoff, terminal codes, jitter
node --test scripts/perf/throttle-proxy.test.mjs        # bandwidth ±20 % both ways, latency, TLS passthrough, loss integrity, reset + stall drops, recovery
```

## What this cannot prove

- **Real Wi-Fi and mobile links.** They lose packets in bursts, jitter, reorder and suffer bufferbloat. The proxy uses fixed latency and independent per-slice loss.
- **Real TCP behavior under loss.** Loopback TCP never loses a packet. The proxy adds a stall but does not reproduce congestion-window collapse, slow start after idle, or RTO backoff.
- **Tailscale DERP relays.** Relay latency and fairness, path switches between direct and relayed, NAT rebinding, MTU problems, and Tailscale's own reconnects are all missing. That needs the manual relayed run recorded in `docs/VALIDATION.md` (plan Q4).
- **Asymmetric or changing bandwidth over time.** Each run uses one fixed rate per direction.
- **Capture and encode cost on slower machines.** The host runs on this computer.
- **Renderer smoothness.** IPC, base64 and image decode time are outside the proxy. The viewer's HUD measures them.
