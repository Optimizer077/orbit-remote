#!/usr/bin/env node
// Weak-network simulator for Orbit Remote: a plain TCP proxy that shapes traffic.
//
// TLS passthrough: bytes are forwarded opaquely. The proxy never terminates or
// inspects TLS, so certificate pinning and mutual TLS work end to end unchanged.
//
// Model, per direction (client->target = up, target->client = down):
//   bandwidth  token bucket shared by all connections (kbit/s, small burst)
//   latency    one-way delay added to every slice (ms)
//   loss       per-packet probability; a lost slice stalls its connection for a
//              retransmit timeout (head-of-line blocking, like TCP) and is charged
//              to the bucket twice. Bytes are never actually dropped or reordered.
//   handshake  the first upstream slice of a connection waits one extra RTT (SYN/SYN-ACK)
//   drops      at scripted times, every connection is closed and new connections are
//              refused (mode "reset") or held silently (mode "stall") for a window.
//
// Usage:
//   node scripts/perf/throttle-proxy.mjs --listen 127.0.0.1:48952 --target 127.0.0.1:48932 \
//     --kbps 2000 --latency 150 --loss 1 --drop-at 20 --drop-for 10
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MSS = 1460;
const END = Symbol('end of stream');

/** Small seeded PRNG (mulberry32) so loss patterns are reproducible. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Token bucket in virtual time. take(n, now) returns when n bytes may start. Debt queues later senders. */
export function createBucket(kbps, burstBytes) {
  if (!(kbps > 0)) return { take: (_n, now) => now };
  const bytesPerMs = (kbps * 1000) / 8 / 1000;
  let tokens = burstBytes;
  let last = 0;
  return {
    take(n, now) {
      if (now > last) { tokens = Math.min(burstBytes, tokens + (now - last) * bytesPerMs); last = now; }
      tokens -= n;
      return tokens >= 0 ? last : last + -tokens / bytesPerMs;
    },
  };
}

function parseHostPort(value, name) {
  const m = /^(.*):(\d+)$/.exec(value || '');
  const port = m ? Number(m[2]) : NaN;
  if (!m || !m[1] || !(port >= 0 && port <= 65535)) throw new Error(`${name} must be host:port`);
  return { host: m[1].replace(/^\[|\]$/g, ''), port };
}

export function createThrottleProxy(options) {
  const o = {
    listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: undefined,
    kbps: 0, upKbps: undefined, downKbps: undefined, latencyMs: 0, lossPct: 0, lossStallMs: undefined,
    burstBytes: 16 * 1024, sliceBytes: 4096, handshakeRtt: true, dropAtMs: [], dropForMs: 0, dropMode: 'reset',
    seed: 1, highWaterBytes: 1024 * 1024, log: () => {}, now: () => performance.now(), ...options,
  };
  if (!Number.isInteger(o.targetPort)) throw new Error('targetPort is required');
  if (!['reset', 'stall'].includes(o.dropMode)) throw new Error('dropMode must be reset or stall');
  const stallMs = o.lossStallMs ?? 200 + 2 * o.latencyMs; // One RTT plus a minimum RTO.
  const packetLoss = Math.min(1, Math.max(0, o.lossPct / 100));
  const random = seededRandom(o.seed);
  const buckets = { up: createBucket(o.upKbps ?? o.kbps, o.burstBytes), down: createBucket(o.downKbps ?? o.kbps, o.burstBytes) };
  const conns = new Set();
  const timers = new Set();
  const stats = { accepted: 0, refused: 0, closedByDrop: 0, bytesUp: 0, bytesDown: 0, lossEvents: 0, drops: 0 };
  let server = null;
  let startedAt = 0;
  let dropUntil = -Infinity;
  let closing = false;
  let boundPort = o.listenPort;

  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, Math.max(0, ms)); timers.add(t); return t; };
  const dropping = () => o.now() < dropUntil;

  function shape(conn, dir, chunk) {
    const src = dir === 'up' ? conn.client : conn.target;
    const lane = conn[dir];
    for (let off = 0; off < chunk.length; off += o.sliceBytes) {
      const slice = chunk.subarray(off, Math.min(chunk.length, off + o.sliceBytes));
      const now = o.now();
      const packets = Math.ceil(slice.length / MSS);
      const lost = packetLoss > 0 && random() < 1 - (1 - packetLoss) ** packets;
      let start = buckets[dir].take(slice.length, now);
      if (lost) { stats.lossEvents++; start = buckets[dir].take(slice.length, start) + stallMs; } // Retransmit.
      let at = start + o.latencyMs;
      if (dir === 'up' && lane.first && o.handshakeRtt) at += 2 * o.latencyMs;
      lane.first = false;
      if (o.dropMode === 'stall' && dropping()) at = Math.max(at, dropUntil + o.latencyMs);
      at = Math.max(at, lane.lastAt); // In-order delivery: a stalled slice blocks the ones behind it.
      lane.lastAt = at;
      lane.queued += slice.length;
      enqueue(conn, dir, at, slice);
    }
    if (lane.queued > o.highWaterBytes) src.pause(); // Backpressure: never buffer without bound.
  }

  // Each direction delivers through one FIFO queue and one timer. A timer per slice
  // reorders bytes: after a loss stall several slices share a deadline but land in
  // different Node timer lists, whose relative firing order is not guaranteed.
  function enqueue(conn, dir, at, item) {
    const lane = conn[dir];
    lane.queue.push({ at, item });
    if (!lane.timer) pump(conn, dir);
  }

  function pump(conn, dir) {
    const lane = conn[dir];
    const src = dir === 'up' ? conn.client : conn.target;
    const dst = dir === 'up' ? conn.target : conn.client;
    lane.timer = null;
    if (conn.dead) { lane.queue.length = 0; return; }
    while (lane.queue.length && lane.queue[0].at <= o.now()) {
      const { item } = lane.queue.shift();
      if (item === END) { dst.end(); continue; }
      lane.queued -= item.length;
      stats[dir === 'up' ? 'bytesUp' : 'bytesDown'] += item.length;
      dst.write(item);
      if (lane.queued < o.highWaterBytes / 2 && src.isPaused()) src.resume();
    }
    if (lane.queue.length) lane.timer = later(() => pump(conn, dir), lane.queue[0].at - o.now());
  }

  function finish(conn, dir) { // Half-close only after queued data in that direction is delivered.
    enqueue(conn, dir, conn[dir].lastAt, END);
  }

  function kill(conn) {
    if (conn.dead) return;
    conn.dead = true;
    conns.delete(conn);
    conn.client.destroy();
    conn.target.destroy();
  }

  function onConnection(client) {
    if (closing || (o.dropMode === 'reset' && dropping())) { stats.refused++; client.destroy(); return; }
    stats.accepted++;
    const target = net.connect({ host: o.targetHost, port: o.targetPort, allowHalfOpen: true });
    const conn = { client, target, dead: false, up: { lastAt: 0, queued: 0, first: true, queue: [], timer: null },
      down: { lastAt: 0, queued: 0, first: true, queue: [], timer: null } };
    conns.add(conn);
    client.setNoDelay(true); target.setNoDelay(true);
    client.on('data', d => shape(conn, 'up', d));
    target.on('data', d => shape(conn, 'down', d));
    client.on('end', () => finish(conn, 'up'));
    target.on('end', () => finish(conn, 'down'));
    for (const s of [client, target]) {
      s.on('error', () => kill(conn));
      s.on('close', () => { // Let in-flight data drain before tearing down the other side.
        const wait = Math.max(conn.up.lastAt, conn.down.lastAt) - o.now() + 1;
        later(() => kill(conn), wait);
      });
    }
  }

  function listen() {
    return new Promise((resolve, reject) => {
      const candidate = net.createServer({ allowHalfOpen: true }, onConnection);
      candidate.once('error', reject);
      candidate.listen(boundPort, o.listenHost, () => {
        candidate.off('error', reject);
        server = candidate;
        boundPort = candidate.address().port;
        resolve();
      });
    });
  }

  /** Closes every connection now and refuses (reset) or stalls (stall) for durationMs. */
  async function drop(durationMs) {
    stats.drops++;
    dropUntil = o.now() + durationMs;
    o.log(`drop: ${o.dropMode} for ${durationMs} ms`);
    if (o.dropMode === 'stall') return; // Existing connections freeze via shape(); nothing is closed.
    for (const conn of [...conns]) { stats.closedByDrop++; kill(conn); }
    const old = server;
    server = null;
    await new Promise(resolve => old.close(() => resolve())); // Port closed: connect() is refused.
    later(async () => {
      for (let i = 0; i < 50 && !closing && !server; i++) {
        try { await listen(); o.log('drop over: accepting again'); return; }
        catch { await new Promise(r => later(r, 100)); }
      }
    }, durationMs);
  }

  return {
    get port() { return boundPort; },
    stats,
    drop,
    async start() {
      await listen();
      startedAt = o.now();
      for (const at of o.dropAtMs) later(() => { if (!closing) drop(o.dropForMs); }, startedAt + at - o.now());
      return { host: o.listenHost, port: boundPort };
    },
    async close() {
      closing = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const conn of [...conns]) kill(conn);
      if (server) await new Promise(resolve => server.close(() => resolve()));
      server = null;
    },
  };
}

function parseArgs(argv) {
  const opts = { dropAtMs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    const num = (min, max) => { const v = Number(next()); if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${arg} must be ${min}..${max}`); return v; };
    switch (arg) {
      case '--listen': { const a = parseHostPort(next(), arg); opts.listenHost = a.host; opts.listenPort = a.port; break; }
      case '--target': { const a = parseHostPort(next(), arg); opts.targetHost = a.host; opts.targetPort = a.port; break; }
      case '--kbps': opts.kbps = num(0, 10_000_000); break;
      case '--up-kbps': opts.upKbps = num(0, 10_000_000); break;
      case '--down-kbps': opts.downKbps = num(0, 10_000_000); break;
      case '--latency': opts.latencyMs = num(0, 60_000); break;
      case '--loss': opts.lossPct = num(0, 100); break;
      case '--loss-stall': opts.lossStallMs = num(0, 60_000); break;
      case '--burst': opts.burstBytes = num(0, 64 * 1024 * 1024); break;
      case '--drop-at': opts.dropAtMs = next().split(',').map(s => { const v = Number(s); if (!(v >= 0)) throw new Error('--drop-at takes seconds, e.g. 20 or 20,60'); return v * 1000; }); break;
      case '--drop-for': opts.dropForMs = num(0, 3600) * 1000; break;
      case '--drop-mode': opts.dropMode = next(); break;
      case '--seed': opts.seed = num(0, 2 ** 32 - 1); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.targetPort) {
    console.log('node scripts/perf/throttle-proxy.mjs --listen 127.0.0.1:48952 --target 127.0.0.1:48932 [--kbps 2000] [--up-kbps N] [--down-kbps N]\n' +
      '  [--latency 150 (ms each way)] [--loss 1 (%)] [--loss-stall ms] [--burst bytes] [--drop-at 20[,60] (s)] [--drop-for 10 (s)]\n' +
      '  [--drop-mode reset|stall] [--seed N]');
    process.exitCode = opts.help ? 0 : 2;
    return;
  }
  const t0 = performance.now();
  const stamp = () => `[${((performance.now() - t0) / 1000).toFixed(1)} s]`;
  const proxy = createThrottleProxy({ ...opts, log: msg => console.log(stamp(), msg) });
  const { host, port } = await proxy.start();
  console.log(stamp(), `proxy ${host}:${port} -> ${opts.targetHost}:${opts.targetPort} · ${opts.kbps || 'unlimited'} kbit/s · +${opts.latencyMs || 0} ms each way · ${opts.lossPct || 0} % loss` +
    (opts.dropAtMs.length ? ` · drop at ${opts.dropAtMs.map(v => v / 1000).join(',')} s for ${(opts.dropForMs || 0) / 1000} s (${opts.dropMode || 'reset'})` : ''));
  const report = setInterval(() => console.log(stamp(), JSON.stringify(proxy.stats)), 5000);
  const stop = async () => { clearInterval(report); await proxy.close(); console.log(stamp(), 'closed', JSON.stringify(proxy.stats)); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
if (process.argv[1] && same(fileURLToPath(import.meta.url), process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
