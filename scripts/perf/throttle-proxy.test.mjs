// Tests for the weak-network proxy against local TCP and TLS servers (loopback only).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { createThrottleProxy, createBucket, seededRandom } from './throttle-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'apps', 'desktop', 'electron', 'test-fixtures');
const now = () => performance.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function serve(handler, secure) {
  const server = secure
    ? tls.createServer({ key: fs.readFileSync(path.join(FIXTURES, 'test-private.pem')), cert: fs.readFileSync(path.join(FIXTURES, 'test-cert.pem')) }, handler)
    : net.createServer({ allowHalfOpen: true }, handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port, close: () => new Promise(r => server.close(r)) };
}
const echo = socket => { socket.on('error', () => {}); socket.pipe(socket); };

async function withProxy(targetPort, options, fn) {
  const proxy = createThrottleProxy({ targetPort, ...options });
  await proxy.start();
  try { return await fn(proxy); } finally { await proxy.close(); }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.off('error', reject); resolve(s); });
    s.once('error', reject);
  });
}

/** Sends `message` and resolves with the elapsed ms when the same number of bytes came back. */
function roundTrip(socket, message) {
  return new Promise((resolve, reject) => {
    const t0 = now();
    let got = 0;
    const onData = d => { got += d.length; if (got >= message.length) { socket.off('data', onData); resolve(now() - t0); } };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.write(message);
  });
}

test('token bucket and PRNG are deterministic', () => {
  const b = createBucket(800, 0); // 100 bytes/ms
  assert.equal(b.take(1000, 0), 10);
  assert.equal(b.take(1000, 0), 20, 'debt queues the next sender');
  assert.equal(b.take(1000, 100), 110, 'idle time refills only up to the burst (0): the send still costs 10 ms');
  const r1 = seededRandom(7); const r2 = seededRandom(7);
  assert.deepEqual([r1(), r1(), r1()], [r2(), r2(), r2()]);
});

test('download bandwidth is limited to the configured kbit/s (±20 %)', async () => {
  const payload = crypto.randomBytes(150 * 1024);
  const srv = await serve(socket => { socket.on('error', () => {}); socket.end(payload); });
  try {
    await withProxy(srv.port, { kbps: 1000, burstBytes: 16 * 1024, handshakeRtt: false }, async proxy => {
      const t0 = now();
      const received = await new Promise((resolve, reject) => {
        const chunks = [];
        const s = net.connect({ host: '127.0.0.1', port: proxy.port });
        s.on('data', d => chunks.push(d)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
      });
      const ms = now() - t0;
      const expected = ((payload.length - 16 * 1024) * 8) / 1000; // bits / (kbit/s) = ms
      assert.ok(received.equals(payload), 'bytes arrive intact and in order');
      assert.ok(Math.abs(ms - expected) <= 0.2 * expected, `took ${ms.toFixed(0)} ms, expected ~${expected.toFixed(0)} ms`);
    });
  } finally { await srv.close(); }
});

test('upload direction has its own bucket (--up-kbps)', async () => {
  const srv = await serve(socket => {
    let n = 0;
    socket.on('error', () => {});
    socket.on('data', d => { n += d.length; });
    socket.on('end', () => socket.end(String(n)));
  });
  try {
    await withProxy(srv.port, { upKbps: 800, downKbps: 0, burstBytes: 0, handshakeRtt: false }, async proxy => {
      const body = crypto.randomBytes(100 * 1024);
      const t0 = now();
      const reply = await new Promise((resolve, reject) => {
        let text = '';
        const s = net.connect({ host: '127.0.0.1', port: proxy.port, allowHalfOpen: true }, () => s.end(body));
        s.on('data', d => { text += d; }).on('end', () => resolve(text)).on('error', reject);
      });
      const ms = now() - t0;
      const expected = (body.length * 8) / 800;
      assert.equal(reply, String(body.length));
      assert.ok(Math.abs(ms - expected) <= 0.2 * expected, `took ${ms.toFixed(0)} ms, expected ~${expected.toFixed(0)} ms`);
    });
  } finally { await srv.close(); }
});

test('latency is added each way, plus one RTT for the first exchange (handshake)', async () => {
  const srv = await serve(echo);
  try {
    await withProxy(srv.port, { latencyMs: 100 }, async proxy => {
      const s = await connect(proxy.port);
      const first = await roundTrip(s, Buffer.from('hello'));
      const second = await roundTrip(s, Buffer.from('again'));
      s.destroy();
      assert.ok(first >= 395 && first < 600, `first round trip ${first.toFixed(0)} ms (2 x 100 + 200 handshake)`);
      assert.ok(second >= 195 && second < 320, `second round trip ${second.toFixed(0)} ms (2 x 100)`);
    });
  } finally { await srv.close(); }
});

test('TLS passes through untouched: the client sees the server certificate', async () => {
  const srv = await serve(echo, true);
  const expected = new crypto.X509Certificate(fs.readFileSync(path.join(FIXTURES, 'test-cert.pem'))).fingerprint256;
  try {
    await withProxy(srv.port, { latencyMs: 20, kbps: 4000 }, async proxy => {
      const s = await new Promise((resolve, reject) => {
        const c = tls.connect({ host: '127.0.0.1', port: proxy.port, rejectUnauthorized: false }, () => resolve(c));
        c.once('error', reject);
      });
      assert.equal(s.getPeerX509Certificate().fingerprint256, expected);
      const ms = await roundTrip(s, Buffer.from('over tls'));
      assert.ok(ms >= 38, `TLS round trip ${ms.toFixed(0)} ms includes the added latency`);
      s.destroy();
    });
  } finally { await srv.close(); }
});

test('loss stalls the stream (head-of-line) but never corrupts it; seeded and counted', async () => {
  const payload = crypto.randomBytes(256 * 1024); // 64 slices x 3 packets at 5 %: ~9 loss events.
  const srv = await serve(socket => { socket.on('error', () => {}); socket.end(payload); });
  try {
    const run = () => withProxy(srv.port, { lossPct: 5, lossStallMs: 50, seed: 42, handshakeRtt: false }, async proxy => {
      const t0 = now();
      const got = await new Promise((resolve, reject) => {
        const chunks = [];
        const s = net.connect({ host: '127.0.0.1', port: proxy.port });
        s.on('data', d => chunks.push(d)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
      });
      return { ok: got.equals(payload), losses: proxy.stats.lossEvents, ms: now() - t0 };
    });
    const a = await run();
    const b = await run();
    assert.ok(a.ok && b.ok, 'payload intact');
    assert.ok(a.losses > 0, 'some slices were "lost"');
    assert.equal(a.losses, b.losses, 'same seed, same loss pattern');
    assert.ok(a.ms >= 50, `stall visible: ${a.ms.toFixed(0)} ms`);
  } finally { await srv.close(); }
});

test('scripted drop closes connections, refuses new ones during the window, then recovers', async () => {
  const srv = await serve(echo);
  try {
    await withProxy(srv.port, { dropAtMs: [300], dropForMs: 3000 }, async proxy => {
      const t0 = now();
      const s = await connect(proxy.port);
      await roundTrip(s, Buffer.from('before'));
      const closedAt = await new Promise(resolve => { s.on('error', () => {}); s.on('close', () => resolve(now() - t0)); });
      assert.ok(closedAt >= 280 && closedAt < 800, `closed at ${closedAt.toFixed(0)} ms`);
      // Windows retries a refused loopback SYN for ~2 s before failing, so the window is 3 s.
      await assert.rejects(connect(proxy.port), e => ['ECONNREFUSED', 'ECONNRESET'].includes(e.code));
      assert.ok(now() - t0 < 3300, 'the refusal happened inside the drop window');
      const wait = 3300 + 200 - (now() - t0);
      if (wait > 0) await sleep(wait);
      const again = await connect(proxy.port);
      const ms = await roundTrip(again, Buffer.from('after'));
      again.destroy();
      assert.ok(ms < 200, 'echo works after recovery');
      assert.equal(proxy.stats.drops, 1);
      assert.equal(proxy.stats.closedByDrop, 1);
    });
  } finally { await srv.close(); }
});

test('stall-mode drop holds data silently and delivers it after the window', async () => {
  const srv = await serve(echo);
  try {
    await withProxy(srv.port, { dropMode: 'stall', handshakeRtt: false }, async proxy => {
      const s = await connect(proxy.port);
      await roundTrip(s, Buffer.from('warm'));
      await proxy.drop(500);
      const ms = await roundTrip(s, Buffer.from('held'));
      s.destroy();
      assert.ok(ms >= 480 && ms < 900, `held for ${ms.toFixed(0)} ms, connection not closed`);
    });
  } finally { await srv.close(); }
});

test('loss without latency keeps a 2 MB stream byte-exact up to the half-close (ordering regression)', async () => {
  // Per-slice timers once reordered slices that shared a post-stall deadline and
  // could end() before queued data: TLS failed with "bad record mac".
  const payload = crypto.randomBytes(2 * 1024 * 1024);
  const target = await serve(socket => { socket.on('error', () => {}); socket.end(payload); }, false);
  try {
    for (const seed of [1, 2, 3]) {
      await withProxy(target.port, { kbps: 40000, lossPct: 1, seed }, async proxy => {
        const socket = await connect(proxy.port);
        const chunks = [];
        await new Promise((resolve, reject) => { socket.on('data', d => chunks.push(d)); socket.on('end', resolve); socket.on('error', reject); });
        assert.ok(Buffer.concat(chunks).equals(payload), `seed ${seed}: stream must arrive complete and in order`);
        assert.ok(proxy.stats.lossEvents > 0, `seed ${seed}: the run must actually exercise loss`);
      });
    }
  } finally { await target.close(); }
});

test('rejects bad options', () => {
  assert.throws(() => createThrottleProxy({}), /targetPort/);
  assert.throws(() => createThrottleProxy({ targetPort: 1, dropMode: 'x' }), /dropMode/);
});
