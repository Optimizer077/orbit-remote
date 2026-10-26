'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { OrbitController } = require('./controller.cjs');
const { request, transferDeadline, MAX_TRANSFER_BYTES, TRANSFER_IDLE_MS } = require('./transport.cjs');

const MiB = 1024 * 1024;
const httpError = status => Object.assign(new Error('Mock remote HTTP ' + status), { status });

async function tempDir(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// In-memory remote: records every call's options and answers file routes. No sockets are opened.
function transferScenario(native = {}) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test', native });
  const calls = [];
  controller.sessions.set('s', { remoteId: 'r', device: { id: 'd' }, permissions: { files: true }, closed: false });
  controller.remote = async (_device, route, options = {}) => {
    calls.push({ route, options });
    if (route === '/api/sessions/r/files') return { json: [{ name: 'small.bin', size: 5 * MiB }, { name: 'huge.bin', size: 40 * MiB }] };
    if (route.startsWith('/api/sessions/r/files/')) return { json: { ok: true }, buffer: Buffer.from('payload') };
    if (route === '/api/sessions/r/clipboard') return { json: { text: 'x' } };
    throw new Error('Unexpected mock route: ' + route);
  };
  return { controller, calls };
}

test('transfer deadline scales with size at 64 KiB/s and is capped at 10 minutes', () => {
  assert.equal(transferDeadline(0), 15000);
  assert.equal(transferDeadline(undefined), 15000);
  assert.equal(transferDeadline(64 * 1024), 16000);
  assert.equal(transferDeadline(5 * MiB), 15000 + 80000);
  assert.equal(transferDeadline(32 * MiB), 15000 + 512000);
  assert.equal(transferDeadline(1024 * MiB), 600000);
  assert.equal(MAX_TRANSFER_BYTES, 32 * MiB, 'matches maxTransferBytes in the host');
});

test('uploads use a size-scaled deadline and idle timeout; normal API calls keep the default', async t => {
  const directory = await tempDir(t, 'orbit-upload-test-');
  const file = path.join(directory, 'report.pdf');
  await fs.writeFile(file, Buffer.alloc(MiB));
  const { controller, calls } = transferScenario({ openFile: async () => file });
  await controller.invoke('files.upload', { sessionId: 's' });
  const upload = calls.find(c => c.route === '/api/sessions/r/files/report.pdf');
  assert.equal(upload.options.method, 'PUT');
  assert.equal(upload.options.timeout, transferDeadline(MiB));
  assert.equal(upload.options.idleTimeout, TRANSFER_IDLE_MS);
  await controller.invoke('clipboard.read', { sessionId: 's' });
  const clipboard = calls.find(c => c.route === '/api/sessions/r/clipboard');
  assert.equal(clipboard.options.timeout, undefined, 'non-transfer calls fall back to the 15 s transport default');
});

test('an upload above the host limit is refused with the file name and limit, before any request', async t => {
  const directory = await tempDir(t, 'orbit-upload-limit-test-');
  const file = path.join(directory, 'video.mov');
  const handle = await fs.open(file, 'w');
  await handle.truncate(MAX_TRANSFER_BYTES + 1);
  await handle.close();
  const { controller, calls } = transferScenario({ openFile: async () => file });
  await assert.rejects(controller.invoke('files.upload', { sessionId: 's' }), /^Error: video\.mov is larger than 32 MiB, Orbit’s transfer limit\.$/);
  assert.equal(calls.length, 0);
});

test('a file exactly at the host limit is accepted for upload', async t => {
  const directory = await tempDir(t, 'orbit-upload-edge-test-');
  const file = path.join(directory, 'edge.bin');
  const handle = await fs.open(file, 'w');
  await handle.truncate(MAX_TRANSFER_BYTES);
  await handle.close();
  const { controller, calls } = transferScenario({ openFile: async () => file });
  await controller.invoke('files.upload', { sessionId: 's' });
  assert.equal(calls[0].options.timeout, transferDeadline(MAX_TRANSFER_BYTES));
});

test('downloads scale their deadline from the listed size and allow the host limit', async t => {
  const directory = await tempDir(t, 'orbit-download-test-');
  const { controller, calls } = transferScenario({ saveFile: async name => path.join(directory, name) });
  const listing = await controller.invoke('files.list', { sessionId: 's' });
  assert.deepEqual(listing.entries.map(e => e.name), ['small.bin', 'huge.bin']);
  await controller.invoke('files.download', { sessionId: 's', name: 'small.bin' });
  const download = calls.find(c => c.route === '/api/sessions/r/files/small.bin');
  assert.equal(download.options.timeout, transferDeadline(5 * MiB));
  assert.equal(download.options.idleTimeout, TRANSFER_IDLE_MS);
  assert.equal(download.options.maxBytes, MAX_TRANSFER_BYTES);
  assert.equal(download.options.tooLargeMessage, 'small.bin is larger than 32 MiB, Orbit’s transfer limit.');
  assert.equal(await fs.readFile(path.join(directory, 'small.bin'), 'utf8'), 'payload');
});

test('a listed file above the limit is refused by name before the save dialog opens', async () => {
  let dialogs = 0;
  const { controller, calls } = transferScenario({ saveFile: async () => { dialogs++; return null; } });
  await controller.invoke('files.list', { sessionId: 's' });
  await assert.rejects(controller.invoke('files.download', { sessionId: 's', name: 'huge.bin' }), /huge\.bin is larger than 32 MiB/);
  assert.equal(dialogs, 0);
  assert.equal(calls.length, 1, 'only the listing request was sent');
});

test('a download of an unlisted file budgets for the largest file the host serves', async t => {
  const directory = await tempDir(t, 'orbit-download-unlisted-test-');
  const { controller, calls } = transferScenario({ saveFile: async name => path.join(directory, name) });
  await controller.invoke('files.download', { sessionId: 's', name: 'other.bin' });
  assert.equal(calls[0].options.timeout, transferDeadline(MAX_TRANSFER_BYTES));
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

test('a steadily progressing transfer outlives the idle timeout', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    let sent = 0;
    const timer = setInterval(() => { res.write('x'); if (++sent === 30) { clearInterval(timer); res.end(); } }, 10);
    res.once('close', () => clearInterval(timer));
  });
  const port = await listen(server, t);
  const result = await request({ url: new URL('http://127.0.0.1:' + port), timeout: 5000, idleTimeout: 100 });
  assert.equal(result.buffer.length, 30);
});

test('a stalled transfer fails on the idle timeout long before its overall deadline', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.write('x'); });
  const port = await listen(server, t);
  const started = Date.now();
  await assert.rejects(request({ url: new URL('http://127.0.0.1:' + port), timeout: 10000, idleTimeout: 150 }), /timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('an oversize response reports the caller-supplied transfer message', async t => {
  const server = http.createServer((_req, res) => { res.end(Buffer.alloc(1024)); });
  const port = await listen(server, t);
  await assert.rejects(request({ url: new URL('http://127.0.0.1:' + port), maxBytes: 32, tooLargeMessage: 'big.bin is larger than 32 MiB, Orbit’s transfer limit.' }),
    /^Error: big\.bin is larger than 32 MiB/);
});

async function refreshScenario(t) {
  const directory = await tempDir(t, 'orbit-refresh-test-');
  const controller = new OrbitController({ directory, controlToken: 'test' });
  controller.local = async route => { if (route === 'peers') return []; throw new Error('Unexpected local route: ' + route); };
  controller.connections.push({ id: 'host-1', name: 'Studio PC', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32),
    permissions: { view: true, control: true, clipboard: false, files: false, power: false }, online: true });
  let answer;
  controller.remote = async () => answer();
  const refresh = async next => { answer = next; return (await controller.invoke('network.refresh')).devices.find(d => d.id === 'host-1'); };
  return { controller, refresh, directory };
}

test('a 401 on refresh marks the device revoked with a reason, not offline', async t => {
  const { refresh, directory } = await refreshScenario(t);
  const device = await refresh(() => { throw httpError(401); });
  assert.equal(device.status, 'revoked');
  assert.equal(device.online, false);
  assert.equal(device.statusReason, 'Access revoked by the host.');
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'connections.json'), 'utf8'));
  assert.equal(saved[0].revoked, true, 'the revoked state survives a restart until the next refresh');
});

test('network errors stay offline and a later success clears revocation and refreshes permissions', async t => {
  const { refresh } = await refreshScenario(t);
  await refresh(() => { throw httpError(401); });
  const offline = await refresh(() => { throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
  assert.equal(offline.status, 'offline');
  assert.equal(offline.statusReason, undefined);
  const narrowed = { view: true, control: false, clipboard: false, files: true, power: false };
  const online = await refresh(() => ({ json: { hostId: 'host-1', hostName: 'Studio PC', permissions: narrowed } }));
  assert.equal(online.status, 'online');
  assert.equal(online.revoked, undefined);
  assert.deepEqual(online.permissions, narrowed, 'host-side permission changes are reflected');
  const legacy = await refresh(() => ({ json: { hostId: 'host-1' } }));
  assert.deepEqual(legacy.permissions, narrowed, 'an info reply without permissions keeps the saved grants');
});

function statusController(raw) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.local = async route => { if (route === 'status') return raw; throw new Error('Unexpected local route: ' + route); };
  return controller;
}

test('status reports the host remote listener port from its actual address', async () => {
  const custom = await statusController({ hostName: 'Studio', remoteEnabled: true, remoteAddress: 'https://100.64.0.7:50123', settings: {} }).invoke('status');
  assert.equal(custom.settings.listenPort, 50123);
  const standard = await statusController({ hostName: 'Studio', remoteEnabled: true, remoteAddress: 'https://100.64.0.7:47832', settings: {} }).invoke('status');
  assert.equal(standard.settings.listenPort, 47832);
  const disabled = await statusController({ hostName: 'Studio', remoteEnabled: false, remoteAddress: null, settings: {} }).invoke('status');
  assert.equal(disabled.settings.listenPort, undefined, 'no remote listener means no port to report');
});
