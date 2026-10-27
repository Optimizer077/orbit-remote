#!/usr/bin/env node
// Loopback frame-path benchmark for Orbit Remote (task W0).
//
// Launches the REAL host in --loopback-test mode on private ports with a
// throwaway data directory, pairs a view-only test viewer exactly like the host
// test harness (local invite + remote /api/pair over pinned mutual TLS, using the
// host's exported identity as the viewer certificate), then times frame requests.
//
// Privacy: frames are captured from this machine's screen into memory only. The
// script reads each response's byte length and drops the buffer. It never writes,
// prints, hashes or decodes pixel data. Nothing leaves loopback.
//
// Usage: node scripts/perf/measure-frames.mjs [--frames 30] [--warmup 2]
//        [--interval 260] [--dll <Orbit.Host.dll>] [--config Release|Debug] [--write]
//        [--throttle kbps=2000,latency=150,loss=1] [--format png|jpeg] [--quality 40..90]
//
// --throttle routes the timed frame requests (not pairing) through the W4
// throttle proxy on loopback, so weak-network targets use real frames.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const transport = require(path.join(ROOT, 'apps', 'desktop', 'electron', 'transport.cjs'));
const { createThrottleProxy } = await import('./throttle-proxy.mjs');
const DOC = path.join(ROOT, 'docs', 'PERFORMANCE.md');
const START = '<!-- perf:start -->';
const END = '<!-- perf:end -->';
const MAX_FRAME_BYTES = 24 * 1024 * 1024;

function parseArgs(argv) {
  const opts = { frames: 30, warmup: 2, interval: 260, dll: null, config: 'Release', write: false,
    controlPort: 48931, remotePort: 48932 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    const int = (min, max) => { const v = Number(next()); if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${arg} must be an integer ${min}..${max}`); return v; };
    switch (arg) {
      case '--frames': opts.frames = int(3, 1000); break;
      case '--warmup': opts.warmup = int(0, 50); break;
      case '--interval': opts.interval = int(0, 10000); break;
      case '--dll': opts.dll = path.resolve(next()); break;
      case '--config': opts.config = next(); if (!['Release', 'Debug'].includes(opts.config)) throw new Error('--config must be Release or Debug'); break;
      case '--control-port': opts.controlPort = int(1024, 65535); break;
      case '--remote-port': opts.remotePort = int(1024, 65535); break;
      case '--write': opts.write = true; break;
      case '--throttle': opts.throttle = parseThrottle(next()); break;
      case '--format': opts.format = next(); if (!['png', 'jpeg'].includes(opts.format)) throw new Error('--format must be png or jpeg'); break;
      case '--quality': opts.quality = int(40, 90); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (opts.controlPort === opts.remotePort) throw new Error('Control and remote ports must differ.');
  // The perf block records the unthrottled baseline; throttled runs print only.
  if (opts.throttle && opts.write) throw new Error('--write records the baseline and cannot be combined with --throttle.');
  return opts;
}

const THROTTLE_KEYS = { kbps: ['kbps', 0, 10_000_000], latency: ['latencyMs', 0, 60_000], loss: ['lossPct', 0, 100], seed: ['seed', 0, 2 ** 31] };
function parseThrottle(value) {
  const result = {};
  for (const part of value.split(',')) {
    const [key, raw] = part.split('=');
    const spec = THROTTLE_KEYS[key?.trim()];
    const number = Number(raw);
    if (!spec || !Number.isFinite(number) || number < spec[1] || number > spec[2]) throw new Error(`--throttle takes kbps=,latency=,loss=,seed= (got "${part}")`);
    result[spec[0]] = number;
  }
  return result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function git(args) {
  // --no-optional-locks: read-only, never refreshes or writes the index.
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = findFile(full, name); if (found) return found; }
    else if (entry.name === name) return full;
  }
  return null;
}

// Builds into the temp dir via --artifacts-path so the shared src/Orbit.Host/bin and
// obj folders (used by other tools and agents) are never touched.
function buildHost(tempRoot, config) {
  const artifacts = path.join(tempRoot, 'artifacts');
  const csproj = path.join(ROOT, 'src', 'Orbit.Host', 'Orbit.Host.csproj');
  process.stderr.write(`[perf] building host (${config}, isolated output)...\n`);
  const r = spawnSync('dotnet', ['build', csproj, '-c', config, '--artifacts-path', artifacts, '-nologo', '-v', 'q'],
    { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter(l => /error/i.test(l)).slice(0, 10).join('\n');
    throw new Error(`Host build failed (another agent may be mid-edit; retry or pass --dll).\n${tail}`);
  }
  const dll = findFile(path.join(artifacts, 'bin'), 'Orbit.Host.dll');
  if (!dll) throw new Error('Build succeeded but Orbit.Host.dll was not found in the isolated output.');
  return dll;
}

function quantile(sorted, q) {
  // Nearest-rank: the smallest sample with at least q of the samples at or below it.
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function summarize(samples) {
  const bytes = samples.map(s => s.bytes).sort((a, b) => a - b);
  const ms = samples.map(s => s.ms).sort((a, b) => a - b);
  const dims = [...new Set(samples.filter(s => s.width).map(s => `${s.width}×${s.height}`))];
  return {
    n: samples.length,
    notModified: samples.filter(s => s.status === 304).length,
    bytesMedian: quantile(bytes, 0.5), bytesP95: quantile(bytes, 0.95),
    msMedian: quantile(ms, 0.5), msP95: quantile(ms, 0.95),
    dims: dims.join(', ') || 'n/a',
    // Served format per 200 response; with --format jpeg the host picks the smaller one per frame (W2b).
    formats: Object.entries(samples.filter(s => s.status === 200).reduce((acc, s) => ({ ...acc, [s.format]: (acc[s.format] || 0) + 1 }), {}))
      .map(([format, count]) => `${format} ${count}`).join(', ') || 'n/a',
    encodeMedian: quantile(samples.filter(s => Number.isFinite(s.encodeMs)).map(s => s.encodeMs).sort((a, b) => a - b), 0.5),
  };
}

const kib = b => (b / 1024).toFixed(1);
const at2Mbit = b => (b * 8 / 2_000_000).toFixed(2);

function renderBlock(meta, results, opts) {
  const lines = [];
  lines.push(`Measured ${meta.date} with \`node scripts/perf/measure-frames.mjs\` (see [scripts/perf/README.md](../scripts/perf/README.md)).`);
  lines.push('');
  lines.push(`- Machine: ${meta.machine}`);
  lines.push(`- Display: ${meta.display}`);
  lines.push(`- Host: commit \`${meta.commit}\`${meta.dirty ? ' plus uncommitted host changes in the working tree' : ''}, ${meta.build}`);
  lines.push(`- Method: ${opts.frames} timed requests per mode after ${opts.warmup} discarded warm-up requests, ${opts.interval} ms pause between requests (the viewer's poll delay), view-only session, pinned mutual-TLS keep-alive connections reused between requests (W5 pooling, as the viewer does since commit f87d3f8).`);
  lines.push('');
  lines.push('| Mode | Requests | 304 ratio | Encoded size | Served format | Host encode ms median | Body bytes median | Body bytes p95 | Request ms median | Request ms p95 | Median body at 2 Mbit/s |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { label, s } of results) {
    lines.push(`| ${label} | ${s.n} | ${s.notModified}/${s.n} | ${s.dims} | ${s.formats} | ${Number.isFinite(s.encodeMedian) ? s.encodeMedian : 'n/a'} | ${kib(s.bytesMedian)} KiB | ${kib(s.bytesP95)} KiB | ${s.msMedian.toFixed(1)} | ${s.msP95.toFixed(1)} | ${at2Mbit(s.bytesMedian)} s |`);
  }
  const conditional = results.find(r => r.conditional);
  if (conditional) {
    const { notModified, n } = conditional.s;
    lines.push('');
    lines.push(notModified === 0
      ? `No 304 responses in this run: the screen changed between every poll (for example an animated terminal, clock or cursor), so this run did not observe idle-screen savings. Same-pixel 304 behaviour is covered by the host unit checks in \`tests/Orbit.Host.Tests/FrameQualityChecks.cs\`.`
      : `${notModified} of ${n} conditional polls returned 304 with no body; the rest found changed pixels and received a full frame.`);
  }
  lines.push('');
  lines.push('Caveats:');
  lines.push('');
  lines.push('- Loopback only. Request time covers TLS setup, host capture, hashing, scaling and PNG encoding, and local transfer. It excludes real network latency, bandwidth limits, DERP relays, Electron IPC, base64 conversion and image decode.');
  lines.push('- "Body bytes" counts the HTTP response body only (a 304 has none); headers and TLS overhead are not included. The 2 Mbit/s column is arithmetic, not a measurement.');
  lines.push('- The 304 ratio depends on screen activity during the run: a clock, cursor blink or animation changes the pixels and forces a full frame. PNG sizes depend on what was on screen. Screen content was not controlled.');
  lines.push('- One machine, one run. No Mac, Linux, multi-monitor or real-network result follows from these numbers.');
  return lines.join('\n');
}

function writeDoc(block) {
  const text = fs.readFileSync(DOC, 'utf8');
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) throw new Error(`Markers ${START} / ${END} not found in docs/PERFORMANCE.md.`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const body = block.replace(/\r?\n/g, eol);
  fs.writeFileSync(DOC, text.slice(0, start + START.length) + eol + body + eol + text.slice(end));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('node scripts/perf/measure-frames.mjs [--frames 30] [--warmup 2] [--interval 260] [--dll path] [--config Release|Debug] [--control-port 48931] [--remote-port 48932] [--write] [--throttle kbps=2000,latency=150,loss=1] [--format png|jpeg] [--quality 40..90]');
    return 0;
  }
  for (const port of [opts.controlPort, opts.remotePort]) {
    if (!(await portFree(port))) throw new Error(`Port ${port} is in use. Stop whatever owns it or pass --control-port/--remote-port.`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-perf-'));
  const token = crypto.randomBytes(32).toString('base64url');
  const localBase = `http://127.0.0.1:${opts.controlPort}`;
  const local = (route, options = {}) => transport.request({ ...options, url: new URL(route, localBase),
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) }, timeout: 10000 });
  let host = null;
  let hostLog = [];
  let device = null; let identity = null; let deviceId = null; let sessionId = null; let proxy = null;
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return; cleaned = true;
    if (proxy) { try { await proxy.close(); } catch { /* best effort */ } }
    if (sessionId && device) { try { await transport.remoteRequest(device, identity, `/api/sessions/${sessionId}`, { method: 'DELETE', timeout: 5000 }, true); } catch { /* host may be gone */ } }
    if (deviceId && host && host.exitCode === null) { try { await local(`/api/peers/${deviceId}`, { method: 'DELETE' }); } catch { /* host may be gone */ } }
    if (host && host.exitCode === null) {
      const exited = new Promise(resolve => host.once('exit', resolve));
      host.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (error) { process.stderr.write(`[perf] warning: could not delete temp dir: ${error.code || error.message}\n`); }
  };
  const onSignal = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);

  try {
    const dll = opts.dll ?? buildHost(tempRoot, opts.config);
    if (!fs.existsSync(dll)) throw new Error('Host DLL not found: ' + dll);
    const env = { ...process.env, ORBIT_CONTROL_TOKEN: token, ORBIT_DATA_DIR: path.join(tempRoot, 'data'),
      ORBIT_CONTROL_PORT: String(opts.controlPort), ORBIT_REMOTE_PORT: String(opts.remotePort) };
    // Standalone mode: no parent proof (bearer-only local API) and no stdin owner watch.
    delete env.ORBIT_PARENT_PROOF; delete env.ORBIT_PARENT_WATCH;
    host = spawn('dotnet', [dll, '--loopback-test'], { cwd: tempRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const keep = chunk => { hostLog.push(...String(chunk).split(/\r?\n/).filter(Boolean)); hostLog = hostLog.slice(-20); };
    host.stdout.on('data', keep); host.stderr.on('data', keep);

    let status = null;
    for (let i = 0; i < 150 && !status; i++) {
      if (host.exitCode !== null) throw new Error(`Host exited early (code ${host.exitCode}):\n${hostLog.join('\n')}`);
      try { status = (await local('/api/status')).json; } catch { await sleep(200); }
    }
    if (!status) throw new Error('Host did not become ready within 30 s.');
    if (status.transport?.mode !== 'loopback-test' || status.remoteAddress !== `https://127.0.0.1:${opts.remotePort}`)
      throw new Error('Host is not in loopback-test mode on the expected port; refusing to continue.');
    const platform = status.platform || {};
    if (!platform.canCapture) throw new Error('Host reports screen capture unavailable in this desktop session.');

    identity = (await local('/api/identity/export')).json;
    const invite = (await local('/api/invites', { method: 'POST', body: { deviceName: 'Perf viewer',
      permissions: { view: true, control: false, clipboard: false, files: false, power: false } } })).json;
    const parsed = transport.parseInvite(invite.inviteUri, true);
    if (new URL(parsed.address).hostname !== '127.0.0.1') throw new Error('Invite does not point at loopback; refusing to continue.');
    device = { address: parsed.address, fingerprint: parsed.fingerprint };
    const remote = (route, options = {}) => transport.remoteRequest(device, identity, route, options, true);
    deviceId = (await remote('/api/pair', { method: 'POST', body: { secret: parsed.secret, deviceName: 'Perf viewer' } })).json.deviceId;
    sessionId = (await remote('/api/sessions', { method: 'POST', body: { viewOnly: true } })).json.id;

    let frameDevice = device;
    if (opts.throttle) {
      proxy = createThrottleProxy({ targetPort: opts.remotePort, ...opts.throttle });
      const { port } = await proxy.start();
      frameDevice = { ...device, address: `https://127.0.0.1:${port}` };
      process.stderr.write(`[perf] frames go through the throttle proxy: ${JSON.stringify(opts.throttle)}
`);
    }
    const frameRoute = scale => {
      const query = new URLSearchParams();
      if (scale !== 1) query.set('scale', String(scale));
      if (opts.format) query.set('format', opts.format);
      if (opts.quality) query.set('quality', String(opts.quality));
      return `/api/sessions/${sessionId}/frame${query.size ? `?${query}` : ''}`;
    };
    const fetchFrame = async (scale, etag) => {
      const t0 = performance.now();
      const res = await transport.remoteRequest(frameDevice, identity, frameRoute(scale), { headers: etag ? { 'If-None-Match': etag } : {}, maxBytes: MAX_FRAME_BYTES, timeout: 120000 }, true);
      const ms = performance.now() - t0;
      // Only the length is kept; the pixel buffer goes out of scope here.
      const sample = { ms, bytes: res.buffer.length, status: res.status,
        width: Number(res.headers['x-orbit-encoded-width']) || 0, height: Number(res.headers['x-orbit-encoded-height']) || 0,
        srcWidth: Number(res.headers['x-orbit-width']) || 0, srcHeight: Number(res.headers['x-orbit-height']) || 0,
        etag: res.headers.etag || null,
        format: res.headers['x-orbit-frame-format'] || 'png',
        encodeMs: res.headers['x-orbit-encode-ms'] === undefined ? NaN : Number(res.headers['x-orbit-encode-ms']) };
      return sample;
    };

    const modes = [
      { label: 'Full scale, no validator', scale: 1, conditional: false },
      { label: 'Full scale, If-None-Match', scale: 1, conditional: true },
      { label: 'Scale 0.75, no validator', scale: 0.75, conditional: false },
      { label: 'Scale 0.5, no validator', scale: 0.5, conditional: false },
    ];
    const results = [];
    let source = null;
    for (const mode of modes) {
      process.stderr.write(`[perf] ${mode.label}: ${opts.warmup} warm-up + ${opts.frames} timed...\n`);
      let etag = null;
      for (let i = 0; i < opts.warmup; i++) { const s = await fetchFrame(mode.scale, null); etag = s.etag; await sleep(opts.interval); }
      if (mode.conditional && !etag) { const s = await fetchFrame(mode.scale, null); etag = s.etag; await sleep(opts.interval); }
      if (mode.conditional && !etag) throw new Error('Host returned no ETag; the conditional path is unavailable on this backend.');
      const samples = [];
      for (let i = 0; i < opts.frames; i++) {
        const s = await fetchFrame(mode.scale, mode.conditional ? etag : null);
        if (mode.conditional && s.status === 200 && s.etag) etag = s.etag;
        if (!source && s.srcWidth) source = `${s.srcWidth}×${s.srcHeight}`;
        samples.push(s);
        if (i + 1 < opts.frames) await sleep(opts.interval);
      }
      results.push({ label: mode.label, conditional: mode.conditional, s: summarize(samples) });
    }

    const monitors = platform.monitors || [];
    const primary = monitors.find(m => m.primary) || monitors[0];
    const cpu = (os.cpus()[0]?.model || 'unknown CPU').replace(/\s+/g, ' ').trim();
    const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
    const dirty = git(['status', '--porcelain', '--', 'src/Orbit.Host']).length > 0;
    const meta = {
      date: new Date().toISOString().slice(0, 10),
      machine: `${os.version()} ${os.arch()}, ${cpu}, ${os.cpus().length} logical processors`,
      display: `${source ?? 'unknown'} captured (session default display${primary ? `; primary display ${primary.width}×${primary.height}` : ''}, ${monitors.length} display${monitors.length === 1 ? '' : 's'} attached)`,
      commit, dirty,
      build: opts.dll ? 'prebuilt host DLL passed with --dll' : `${opts.config} build`,
    };
    let block = renderBlock(meta, results, opts);
    if (opts.throttle) block = `Throttled through the loopback proxy: ${JSON.stringify(opts.throttle)}. Not a baseline.\n\n` + block;
    console.log(block);
    if (opts.write) { writeDoc(block); process.stderr.write('[perf] updated the perf block in docs/PERFORMANCE.md\n'); }
    return 0;
  } finally {
    await cleanup();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

main().then(code => { process.exitCode = code; }, error => {
  process.stderr.write(`[perf] failed: ${error.message}\n`);
  process.exitCode = 1;
});
