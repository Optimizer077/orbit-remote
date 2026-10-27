'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { OrbitController } = require('./controller.cjs');

test('project action cannot pass a renderer-supplied URL to the native browser opener', async () => {
  let argumentsReceived;
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test', native: {
    openProject: (...args) => { argumentsReceived = args; },
  } });
  await controller.invoke('app.open-project', { url: 'https://untrusted.example' });
  assert.deepEqual(argumentsReceived, []);
});

test('remote control cannot bypass a view-only session through IPC', async () => {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.sessions.set('view', { viewOnly: true, permissions: { control: false } });
  await assert.rejects(controller.invoke('session.input', { sessionId: 'view', event: { type: 'key', code: 'KeyA', down: true } }), /view only/);
});

test('pointer input preserves negative secondary-monitor origins and clamps to display bounds', async () => {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.sessions.set('active', { remoteId: 'remote', device: {}, permissions: { control: true },
    frame: { width: 1920, height: 1080, left: -1920, top: 0 } });
  const events = [];
  controller.remote = async (_device, _route, options) => { events.push(options.body); return {}; };
  await controller.invoke('session.input', { sessionId: 'active', event: { type: 'pointer.move', x: 0, y: 0 } });
  await controller.invoke('session.input', { sessionId: 'active', event: { type: 'pointer.move', x: 2, y: -1 } });
  assert.equal(events[0].x, -1920); assert.equal(events[0].y, 0);
  assert.equal(events[1].x, -1); assert.equal(events[1].y, 0);
});

test('tampered saved metadata cannot redirect a device to an arbitrary public server', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-metadata-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'connections.json'), JSON.stringify([{ id: 'tampered', address: 'https://example.com', fingerprint: '00'.repeat(32) }]));
  const controller = new OrbitController({ directory, controlToken: 'test' });
  await assert.rejects(controller.initialize(), /configuration is invalid/);
});

test('an invitation reusing a saved device ID with a different certificate cannot replace it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-pair-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const controller = new OrbitController({ directory, controlToken: 'test' });
  const trusted = { id: 'host-1', name: 'Studio PC', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32), serverFingerprint: 'AA'.repeat(32) };
  controller.connections.push({ ...trusted });
  controller.local = async () => ({ hostName: 'Viewer' });
  const invite = fingerprint => 'orbit://pair/' + Buffer.from(JSON.stringify({ v: 1, address: 'https://100.100.9.9:47832', fingerprint,
    secret: 'test-only-32-byte-invitation-secret-long', expiresAt: new Date(Date.now() + 60000).toISOString() })).toString('base64url');
  controller.remote = async () => ({ json: { hostId: 'host-1', hostName: 'Studio PC', permissions: { view: true } } });
  await assert.rejects(controller.invoke('pair', { invite: invite('BB'.repeat(32)) }), /different certificate/);
  assert.deepEqual(controller.connections, [trusted]);
  // Re-pairing the same certificate (for example to refresh permissions) still works.
  const repaired = await controller.invoke('pair', { invite: invite('AA'.repeat(32)) });
  assert.equal(repaired.address, 'https://100.100.9.9:47832');
  assert.equal(controller.connections.length, 1);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const httpError = status => Object.assign(new Error('Mock remote HTTP ' + status), { status });
const primary = { id: 'primary', name: 'Primary', left: 0, top: 0, width: 1920, height: 1080, primary: true };
const secondary = { id: 'secondary', name: 'Secondary', left: -1280, top: 0, width: 1280, height: 720, primary: false };

function imageResponse(monitor) {
  return { headers: { 'x-orbit-width': String(monitor.width), 'x-orbit-height': String(monitor.height),
    'x-orbit-left': String(monitor.left), 'x-orbit-top': String(monitor.top) },
  buffer: Buffer.from('synthetic-frame-' + monitor.id) };
}

// Every request is an in-memory test double. This fixture never opens a socket or injects native input.
async function scenario(intercept) {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  const permissions = { view: true, control: true, clipboard: false, files: false, power: false };
  controller.connections.push({ id: 'paired-device', name: 'Test computer', permissions });
  const calls = [];
  const remoteSessions = new Map();
  let sequence = 0;
  controller.remote = async (_device, route, options = {}, bindCleanup) => {
    bindCleanup?.(id => controller.remote({ ..._device }, '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }));
    const url = new URL(route, 'https://fixture.invalid');
    const call = { route, pathname: url.pathname, monitorId: url.searchParams.get('monitorId'), method: options.method || 'GET', body: options.body };
    calls.push(call);
    const override = intercept ? await intercept(call) : undefined;
    if (override !== undefined) return override;
    if (route === '/api/info') return { json: { platform: { monitors: [primary, secondary] }, permissions } };
    if (route === '/api/sessions' && call.method === 'POST') {
      const id = 'remote-' + ++sequence;
      remoteSessions.set(id, options.body.monitorId === 'secondary' ? secondary : primary);
      return { json: { id, permissions, resumeEpoch: 'test-resume-epoch' } };
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(frame|input|release-inputs))?$/.exec(url.pathname);
    if (!match) throw new Error('Unexpected mock route: ' + route);
    if (call.method === 'DELETE') { remoteSessions.delete(match[1]); return {}; }
    if (match[2] === 'frame') {
      const sessionMonitor = remoteSessions.get(match[1]);
      if (!sessionMonitor) throw httpError(404);
      const monitor = call.monitorId === null ? sessionMonitor : [primary, secondary].find(m => m.id === call.monitorId);
      if (!monitor) throw httpError(400);
      return imageResponse(monitor);
    }
    if (match[2] === 'input' || match[2] === 'release-inputs') return {};
    throw new Error('Unexpected mock operation: ' + route);
  };
  const { sessionId } = await controller.invoke('session.start', { deviceId: 'paired-device' });
  return { controller, sessionId, calls, remoteSessions,
    frames: monitorId => controller.invoke('session.frame', { sessionId, ...(monitorId === 'unchanged' ? {} : { monitorId }) }),
    input: (event, monitorId) => controller.invoke('session.input', { sessionId, event, ...(monitorId === undefined ? {} : { monitorId }) }),
    creations: () => calls.filter(c => c.route === '/api/sessions' && c.method === 'POST'),
    inputs: () => calls.filter(c => c.route.endsWith('/input')),
    releases: () => calls.filter(c => c.route.endsWith('/release-inputs')) };
}

test('ending a session while its frame returns 404 cannot resurrect a remote session', { timeout: 3000 }, async () => {
  const entered = deferred();
  const gate = deferred();
  const h = await scenario(call => {
    if (call.pathname.endsWith('/frame')) { entered.resolve(); return gate.promise; }
  });
  const frameOutcome = h.frames('unchanged').then(value => ({ value }), error => ({ error }));
  await entered.promise;
  const ending = h.controller.invoke('session.end', { sessionId: h.sessionId });
  await nextTurn();
  gate.reject(httpError(404));
  await ending;
  assert.ok((await frameOutcome).error, 'a closed viewer must not publish a late frame');
  assert.equal(h.creations().length, 1, 'no replacement may be created after local disconnect');
  assert.equal(h.remoteSessions.size, 0, 'the original remote session is deleted');
  await assert.rejects(h.frames('unchanged'), /ended/);
});

test('failed disconnect retains one retryable remote cleanup without restoring session authority', { timeout: 3000 }, async () => {
  const entered = deferred(), deletion = deferred(); let attempts = 0;
  const h = await scenario(call => {
    if (call.method === 'DELETE' && ++attempts === 1) { entered.resolve(); return deletion.promise; }
  });
  h.controller.local = async () => { throw new Error('Disconnect retry must not use the local session ID.'); };
  await h.frames('primary');
  const closed = h.controller.sessions.get(h.sessionId);
  const endings = [h.controller.invoke('session.end', { sessionId: h.sessionId })];
  const outcomes = Promise.allSettled(endings);
  await entered.promise;
  assert.equal(closed.closed, true);
  assert.equal(h.controller.sessions.has(h.sessionId), false, 'cleanup is not active session authority');
  await assert.rejects(h.frames('primary'), error => error.status === 410);
  await assert.rejects(h.input({ type: 'key', code: 'KeyA', down: true }), error => error.status === 410);
  h.controller.noteHostStopping(h.sessionId, 'host_stopping');
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /unavailable/);
  const concurrent = Promise.allSettled(Array.from({ length: 12 }, () => h.controller.invoke('session.end', { sessionId: h.sessionId })));
  await nextTurn();
  assert.equal(attempts, 1, 'concurrent closes share the pending DELETE');
  deletion.reject(httpError(503));
  assert.equal((await outcomes)[0].status, 'rejected');
  assert.ok((await concurrent).every(value => value.status === 'rejected'));
  assert.equal(h.remoteSessions.size, 1, 'a transient DELETE failure leaves a remote cleanup obligation');
  assert.equal(h.creations().length, 1, 'no frame or control attempt may renew the closed session');
  assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true });
  assert.equal(attempts, 2);
  assert.equal(h.remoteSessions.size, 0);
  assert.equal(h.controller.sessionCleanups.size, 0, 'successful cleanup discards the retained target');
  assert.equal(h.controller.sessions.size, 0);
});

for (const status of [401, 403, 404, 410]) test(`disconnect consumes a final HTTP ${status} cleanup without restoring authority`, async () => {
  const h = await scenario(call => { if (call.method === 'DELETE') throw httpError(status); });
  h.controller.local = async () => { throw new Error('A final remote response must not fall through to local cleanup.'); };
  assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true });
  assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(h.controller.sessions.size, 0);
  await assert.rejects(h.frames('primary'), error => error.status === 410);
  assert.equal(h.creations().length, 1);
  assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 1);
});

for (const status of [400, 429, 500]) test(`disconnect keeps HTTP ${status} cleanup retryable`, async () => {
  let attempts = 0;
  const h = await scenario(call => { if (call.method === 'DELETE' && ++attempts === 1) throw httpError(status); });
  h.controller.local = async () => { throw new Error('Retry must retain the remote target.'); };
  await assert.rejects(h.controller.invoke('session.end', { sessionId: h.sessionId }), error => error.status === status);
  assert.equal(h.controller.sessions.size, 0);
  await h.controller.invoke('session.end', { sessionId: h.sessionId });
  assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(h.remoteSessions.size, 0);
});

test('disconnect cancels queued input before draining the in-flight action and retrying cleanup', { timeout: 3000 }, async () => {
  const entered = deferred(), input = deferred(); let deletes = 0;
  const h = await scenario(call => {
    if (call.pathname.endsWith('/input')) { entered.resolve(); return input.promise; }
    if (call.method === 'DELETE' && ++deletes === 1) throw httpError(503);
  });
  h.controller.local = async () => { throw new Error('Closed input must not require local authority.'); };
  await h.frames('unchanged');
  const first = h.input({ type: 'key', code: 'KeyA', down: true });
  await entered.promise;
  const queued = [h.input({ type: 'key', code: 'KeyB', down: true }), h.input({ type: 'pointer.button', button: 0, down: true })];
  const ending = h.controller.invoke('session.end', { sessionId: h.sessionId }).then(value => ({ value }), error => ({ error }));
  await nextTurn();
  assert.equal(deletes, 0, 'DELETE follows already in-flight input');
  await assert.rejects(h.input({ type: 'key', code: 'KeyC', down: true }), error => error.status === 410);
  input.resolve({}); await Promise.all([first, ...queued]);
  assert.equal((await ending).error?.status, 503);
  assert.equal(h.inputs().length, 1, 'queued keys and buttons never reach the remote host after end');
  await h.controller.invoke('session.end', { sessionId: h.sessionId });
  assert.equal(h.inputs().length, 1);
  assert.equal(h.remoteSessions.size, 0);
  assert.equal(h.creations().length, 1);
});

test('concurrent successful disconnects issue one DELETE for the captured session', { timeout: 3000 }, async () => {
  const entered = deferred(), deletion = deferred();
  const h = await scenario(call => { if (call.method === 'DELETE') { entered.resolve(); return deletion.promise; } });
  h.controller.local = async () => { throw new Error('Concurrent closes must not call the local host.'); };
  const endings = Promise.allSettled(Array.from({ length: 20 }, () => h.controller.invoke('session.end', { sessionId: h.sessionId })));
  await entered.promise; await nextTurn();
  assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 1);
  deletion.resolve({}); assert.ok((await endings).every(result => result.status === 'fulfilled'));
  assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(h.controller.sessions.size, 0);
});

test('a failed disconnect retries a late renewal replacement instead of its superseded remote ID', { timeout: 3000 }, async () => {
  const renewing = deferred(), replacement = deferred(); let creations = 0, deletes = 0, h;
  h = await scenario(call => {
    if (call.route === '/api/sessions' && call.method === 'POST' && ++creations === 2) { renewing.resolve(); return replacement.promise; }
    if (call.pathname === '/api/sessions/remote-1/frame') { h.remoteSessions.delete('remote-1'); throw httpError(404); }
    if (call.method === 'DELETE' && ++deletes === 1) throw httpError(503);
  });
  h.controller.local = async () => { throw new Error('Cleanup must stay bound to the outgoing replacement.'); };
  const frame = h.frames('secondary').then(value => ({ value }), error => ({ error }));
  await renewing.promise;
  const ending = h.controller.invoke('session.end', { sessionId: h.sessionId }).then(value => ({ value }), error => ({ error }));
  h.remoteSessions.set('late-replacement', secondary);
  replacement.resolve({ json: { id: 'late-replacement', permissions: { view: true, control: true } } });
  assert.equal((await ending).error?.status, 503);
  assert.ok((await frame).error, 'late renewal cannot publish a frame after disconnect');
  assert.equal(h.controller.sessions.size, 0);
  await assert.rejects(h.frames('secondary'), error => error.status === 410);
  await h.controller.invoke('session.end', { sessionId: h.sessionId });
  assert.deepEqual(h.calls.filter(call => call.method === 'DELETE').map(call => call.route),
    ['/api/sessions/late-replacement', '/api/sessions/late-replacement']);
  assert.equal(h.remoteSessions.size, 0);
  assert.equal(h.creations().length, 2, 'disconnect retries never create authorization');
});

test('disconnect retry retains its original pin and client identity after pairing and local identity change', { timeout: 3000 }, async () => {
  const entered = deferred(), deletion = deferred(), calls = [];
  const originalIdentity = { certificate: 'synthetic-original-client' }, replacementIdentity = { certificate: 'synthetic-replacement-client' };
  let identity = originalIdentity;
  const device = { id: 'original-device', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) };
  const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (target, client, route, options) => {
    calls.push({ target: { ...target }, client, route, method: options.method });
    if (calls.length === 1) { entered.resolve(); return deletion.promise; }
    return {};
  } });
  controller.local = async () => { throw new Error('Captured cleanup must not contact the local host.'); };
  controller.getIdentity = async () => identity;
  controller.sessions.set('outgoing', { device, remoteId: 'original-remote', inputQueue: Promise.resolve() });
  const first = controller.invoke('session.end', { sessionId: 'outgoing' }).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  device.address = 'https://100.100.9.9:47832'; device.fingerprint = 'BB'.repeat(32); identity = replacementIdentity;
  deletion.reject(Object.assign(new Error('Synthetic response lost.'), { code: 'ECONNRESET' }));
  assert.equal((await first).error?.code, 'ECONNRESET');
  await controller.shutdown();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.target, { address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) });
    assert.equal(call.client, originalIdentity);
    assert.equal(call.route, '/api/sessions/original-remote'); assert.equal(call.method, 'DELETE');
  }
  assert.equal(controller.sessionCleanups.size, 0);
  assert.equal(controller.sessions.size, 0);
});

test('internal cleanup preserves a reconnect lease while explicit disconnect cancels it on retry', async () => {
  let attempts = 0;
  const h = await scenario(call => { if (call.method === 'DELETE' && ++attempts === 1) throw httpError(503); });
  const operation = { cancelled: false }; h.controller.reconnectPending.set(h.sessionId, operation);
  await assert.rejects(h.controller.closeSession(h.sessionId), error => error.status === 503);
  assert.equal(operation.cancelled, false, 'internal teardown must not cancel its owning reconnect operation');
  await h.controller.invoke('session.end', { sessionId: h.sessionId });
  assert.equal(operation.cancelled, true);
  assert.equal(h.remoteSessions.size, 0);
  assert.equal(h.controller.sessions.size, 0);
});

test('retained cleanup drops drained session buffers without unused failure metadata', async () => {
  const h = await scenario(call => { if (call.method === 'DELETE') throw httpError(503); });
  await h.frames('primary');
  const session = h.controller.sessions.get(h.sessionId);
  session.fileSizes = new Map([['synthetic-file', 100]]);
  session.monitors = Array.from({ length: 32 }, () => ({ ...primary }));
  session.frameSlots.get('primary').cache = { buffer: Buffer.alloc(65536) };
  await assert.rejects(h.controller.invoke('session.end', { sessionId: h.sessionId }), error => error.status === 503);
  const cleanup = h.controller.sessionCleanups.get(h.sessionId);
  assert.equal(cleanup.session, null, 'the retained record must not hold the drained session object');
  assert.equal(cleanup.device, null, 'the bound cleanup does not retain full saved-device metadata');
  assert.equal(Object.hasOwn(cleanup, 'lastFailure'), false);
  assert.equal(session.frame, null);
  assert.equal(session.frameSlots.get('primary').cache, null);
  assert.equal(h.controller.sessions.size, 0);
});

test('retained cleanup records cap at64 and evict the oldest without restoring authority', async () => {
  const controller = new OrbitController({ directory: os.tmpdir() });
  controller.remote = async () => { throw httpError(503); };
  controller.local = async () => { throw new Error('Bounded cleanup tests must never use the local host.'); };
  for (let index = 0; index < 65; index++) {
    const id = 'closed-' + index;
    controller.sessions.set(id, { device: {}, remoteId: 'remote-' + index, inputQueue: Promise.resolve() });
    await assert.rejects(controller.invoke('session.end', { sessionId: id }), error => error.status === 503);
    assert.ok(controller.sessionCleanups.size <= 64);
  }
  assert.equal(controller.sessionCleanups.size, 64);
  assert.equal(controller.sessionCleanups.has('closed-0'), false);
  assert.equal(controller.sessionCleanups.has('closed-1'), true);
  assert.equal(controller.sessionCleanups.has('closed-64'), true);
  assert.ok([...controller.sessionCleanups.values()].every(value => value.session === null));
  assert.equal(controller.sessions.size, 0);
  await assert.rejects(controller.invoke('session.frame', { sessionId: 'closed-0' }), error => error.status === 410);
  await assert.rejects(controller.invoke('session.input', { sessionId: 'closed-64', event: { type: 'key' } }), error => error.status === 410);
  assert.deepEqual(await controller.invoke('session.end', { sessionId: 'closed-0' }), { ok: true, alreadyEnded: true });
  assert.equal(controller.sessionCleanups.size, 64, 'retrying an evicted target never creates local cleanup authority');
});

test('shutdown retries retained cleanup once before clearing the local identity', async () => {
  let deletes = 0, h;
  h = await scenario(call => {
    if (call.method === 'DELETE') {
      if (++deletes === 1) throw httpError(503);
      assert.equal(h.controller.identity?.certificate, 'synthetic-client');
    }
  });
  h.controller.identity = { certificate: 'synthetic-client' };
  h.controller.local = async () => { throw new Error('Shutdown Retry cannot contact an incoming session route.'); };
  await assert.rejects(h.controller.invoke('session.end', { sessionId: h.sessionId }), error => error.status === 503);
  await h.controller.shutdown();
  assert.equal(deletes, 2);
  assert.equal(h.remoteSessions.size, 0);
  assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(h.controller.identity, null);
  assert.equal(h.creations().length, 1);
  assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true, alreadyEnded: true });
});

test('shutdown tolerates one failed retained cleanup pass without looping or restoring authority', async () => {
  let deletes = 0;
  const h = await scenario(call => { if (call.method === 'DELETE') { deletes++; throw httpError(503); } });
  await assert.rejects(h.controller.invoke('session.end', { sessionId: h.sessionId }));
  const cleanup = h.controller.sessionCleanups.get(h.sessionId);
  h.controller.local = async () => { throw new Error('A retired outgoing ID must not address an incoming session.'); };
  await h.controller.shutdown();
  assert.equal(deletes, 2, 'shutdown adds exactly one best-effort retry');
  assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(cleanup.session, null); assert.equal(cleanup.device, null); assert.equal(cleanup.deleteRemote, null);
  assert.equal(h.controller.sessions.size, 0);
  assert.equal(h.creations().length, 1);
  assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true, alreadyEnded: true });
  assert.equal(deletes, 2, 'Retry after final shutdown disposal cannot restart cleanup');
});

test('retired outgoing IDs are bounded at256 while unknown incoming IDs retain their local route', async () => {
  const controller = new OrbitController({ directory: os.tmpdir() });
  const local = [];
  controller.local = async (route, method) => { local.push({ route, method }); return {}; };
  for (let index = 0; index < 257; index++) {
    controller.sessions.set('retired-' + index, { device: {}, remoteId: 'remote-' + index,
      deleteRemote: async () => { throw httpError(404); } });
    await controller.invoke('session.end', { sessionId: 'retired-' + index });
  }
  assert.equal(controller.retiredOutgoingSessions.size, 256);
  assert.equal(controller.retiredOutgoingSessions.has('retired-0'), false);
  assert.deepEqual(await controller.invoke('session.end', { sessionId: 'retired-256' }), { ok: true, alreadyEnded: true });
  assert.deepEqual(local, []);
  assert.deepEqual(await controller.invoke('session.end', { sessionId: 'incoming-unknown' }), { ok: true });
  assert.deepEqual(local, [{ route: 'sessions/incoming-unknown', method: 'DELETE' }]);
});

for (const code of ['access_revoked', 'permission_changed', 'identity_rotated'])
  test(`disconnect consumes final security code ${code} without another DELETE or local fallback`, async () => {
    const h = await scenario(call => { if (call.method === 'DELETE') throw Object.assign(new Error('Synthetic security terminal.'), { code }); });
    h.controller.local = async () => { throw new Error('Security terminal cleanup cannot use local authority.'); };
    assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true });
    assert.equal(h.controller.sessionCleanups.size, 0);
    assert.deepEqual(await h.controller.invoke('session.end', { sessionId: h.sessionId }), { ok: true, alreadyEnded: true });
    await h.controller.shutdown();
    assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 1);
    assert.equal(h.controller.sessions.size, 0); assert.equal(h.creations().length, 1);
  });

test('an untyped pin-like message does not invent a final security code', async () => {
  const failure = new Error('The remote certificate fingerprint does not match.');
  const h = await scenario(call => { if (call.method === 'DELETE') throw failure; });
  await assert.rejects(h.controller.invoke('session.end', { sessionId: h.sessionId }), error => error === failure);
  assert.equal(h.controller.sessionCleanups.size, 1);
  assert.equal(h.controller.sessions.size, 0);
});

test('local identity reset makes one old-identity cleanup pass then drops key references without closing a live session', async () => {
  const original = { certificatePem: 'generated-old-cert', privateKeyPem: 'generated-old-key' };
  const calls = [], controller = new OrbitController({ directory: os.tmpdir() });
  const session = { device: {}, remoteId: 'closed-remote', deleteRemote: async remoteId => {
    calls.push({ remoteId, identity: original }); throw httpError(503);
  } };
  controller.sessions.set('closed', session);
  await assert.rejects(controller.invoke('session.end', { sessionId: 'closed' }));
  const cleanup = controller.sessionCleanups.get('closed');
  const live = { device: {}, remoteId: 'renewed-live', permissions: { view: true, control: true } };
  controller.sessions.set('live', live); controller.identity = original;
  const oldAgent = { destroyed: false, destroy() { this.destroyed = true; } };
  controller.localAgent = oldAgent;
  const generation = controller.localGeneration;
  const reset = controller.clearLocalControl();
  assert.equal(controller.localGeneration, generation + 1); assert.equal(controller.identity, null);
  assert.equal(oldAgent.destroyed, true); assert.equal(controller.localAgent, null);
  await reset;
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.identity === original && call.remoteId === 'closed-remote'));
  assert.equal(controller.sessionCleanups.size, 0);
  for (const key of ['deleteRemote', 'device', 'session', 'pending']) assert.equal(cleanup[key], null);
  assert.equal(controller.getSession({ sessionId: 'live' }), live, 'reset cleanup never removes unrelated live or renewed authorization');
  assert.deepEqual(await controller.invoke('session.end', { sessionId: 'closed' }), { ok: true, alreadyEnded: true });
  assert.equal(calls.length, 2);
});

test('identity reset waits an in-flight DELETE and repeated reset does not duplicate the final pass', { timeout: 3000 }, async () => {
  const entered = deferred(), firstDelete = deferred(), finalEntered = deferred(), finalDelete = deferred();
  const controller = new OrbitController({ directory: os.tmpdir() }); let deletes = 0;
  controller.sessions.set('closed', { device: {}, remoteId: 'original-remote', deleteRemote: async () => {
    if (++deletes === 1) { entered.resolve(); return firstDelete.promise; }
    finalEntered.resolve(); return finalDelete.promise;
  } });
  const ending = controller.invoke('session.end', { sessionId: 'closed' }).catch(error => error);
  await entered.promise;
  const cleanup = controller.sessionCleanups.get('closed');
  const reset = controller.setLocalControl(null, 'replacement-token');
  await nextTurn(); assert.equal(deletes, 1, 'old cleanup cannot overlap its existing DELETE');
  firstDelete.reject(httpError(503)); assert.equal((await ending).status, 503);
  await nextTurn(); assert.equal(deletes, 2, 'reset must issue its final pass after the original DELETE settles');
  await finalEntered.promise;
  const repeated = controller.clearLocalControl();
  await nextTurn(); assert.equal(deletes, 2, 'a second supervisor notification shares the outstanding final pass');
  finalDelete.reject(httpError(503)); await Promise.all([reset, repeated]);
  assert.equal(deletes, 2); assert.equal(controller.sessionCleanups.size, 0);
  for (const key of ['deleteRemote', 'device', 'session', 'pending']) assert.equal(cleanup[key], null);
  assert.deepEqual(await controller.invoke('session.end', { sessionId: 'closed' }), { ok: true, alreadyEnded: true });
});

for (const reset of ['shutdown', 'clearLocalControl'])
  test(`${reset} disposes failed cleanup bound to the original creation identity before rotation`, async () => {
    const original = { certificatePem: 'generated-creation-cert', privateKeyPem: 'generated-creation-key' }, deletions = [];
    const device = { id: 'paired', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) };
    const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (target, identity, route, options) => {
      if (route === '/api/info') return { json: { platform: { monitors: [primary] } } };
      if (route === '/api/sessions' && options.method === 'POST') return { json: { id: 'original-created' } };
      if (options.method === 'DELETE') {
        deletions.push({ target, identity, route }); throw httpError(503);
      }
      throw new Error('Unexpected synthetic request.');
    } });
    controller.connections.push(device); controller.identity = original;
    controller.local = async () => { throw new Error('This identity-reset fixture cannot use local HTTP.'); };
    const started = await controller.invoke('session.start', { deviceId: device.id });
    await assert.rejects(controller.invoke('session.end', started), error => error.status === 503);
    const cleanup = controller.sessionCleanups.get(started.sessionId);
    controller.getIdentity = async () => { throw new Error('Reset cleanup must not acquire a new client identity.'); };
    await controller[reset]();
    assert.equal(deletions.length, 2);
    for (const deletion of deletions) {
      assert.equal(deletion.identity, original); assert.equal(deletion.target.fingerprint, 'AA'.repeat(32));
      assert.equal(deletion.route, '/api/sessions/original-created');
    }
    assert.equal(controller.identity, null); assert.equal(controller.sessionCleanups.size, 0);
    for (const key of ['deleteRemote', 'device', 'session', 'pending']) assert.equal(cleanup[key], null);
    assert.deepEqual(await controller.invoke('session.end', started), { ok: true, alreadyEnded: true });
    assert.equal(deletions.length, 2);
  });

test('created session cleanup uses its POST identity even if the first later identity lookup fails', async () => {
  const original = { certificate: 'synthetic-created-client' }, replacement = { certificate: 'synthetic-rotated-client' };
  const deletes = []; let attempts = 0;
  const device = { id: 'paired-device', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) };
  const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (target, identity, route, options) => {
    if (route === '/api/info') return { json: { platform: { monitors: [primary] } } };
    if (route === '/api/sessions' && options.method === 'POST') return { json: { id: 'created-remote' } };
    if (options.method === 'DELETE') {
      deletes.push({ target: { ...target }, identity, route });
      if (++attempts === 1) throw httpError(503);
      return {};
    }
    throw new Error('Unexpected synthetic request.');
  } });
  controller.connections.push(device); controller.getIdentity = async () => original;
  controller.local = async () => { throw new Error('This fixture must never use the local host.'); };
  const session = await controller.invoke('session.start', { deviceId: device.id });
  controller.getIdentity = async () => { throw Object.assign(new Error('Synthetic identity unavailable.'), { code: 'ORBIT_LOCAL_HOST_RESTARTING' }); };
  await assert.rejects(controller.invoke('session.end', session), error => error.status === 503);
  device.address = 'https://100.100.9.9:47832'; device.fingerprint = 'BB'.repeat(32);
  controller.getIdentity = async () => replacement;
  await controller.invoke('session.end', session);
  assert.equal(deletes.length, 2);
  for (const deletion of deletes) {
    assert.equal(deletion.identity, original);
    assert.deepEqual(deletion.target, { address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) });
    assert.equal(deletion.route, '/api/sessions/created-remote');
  }
});

test('renewed session cleanup retains the identity used for its actual replacement POST', async () => {
  const original = { certificate: 'synthetic-original-client' }, renewed = { certificate: 'synthetic-renewed-client' };
  let identity = original, sequence = 0; const deletions = [];
  const device = { id: 'paired-device', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) };
  const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (target, client, route, options) => {
    if (route === '/api/info') return { json: { platform: { monitors: [primary] } } };
    if (route === '/api/sessions' && options.method === 'POST') return { json: { id: 'remote-' + ++sequence, resumeEpoch: 'synthetic-epoch' } };
    if (route === '/api/sessions/remote-1/frame') throw httpError(404);
    if (route === '/api/sessions/remote-2/frame') return imageResponse(primary);
    if (options.method === 'DELETE') { deletions.push({ client, route }); return {}; }
    throw new Error('Unexpected synthetic request.');
  } });
  controller.connections.push(device); controller.getIdentity = async () => identity;
  const session = await controller.invoke('session.start', { deviceId: device.id });
  identity = renewed;
  await controller.invoke('session.frame', session);
  controller.getIdentity = async () => { throw new Error('No fresh identity lookup may occur during cleanup.'); };
  await controller.invoke('session.end', session);
  assert.deepEqual(deletions, [{ client: renewed, route: '/api/sessions/remote-2' }]);
});

test('cancelled creation retains its failed DELETE for shutdown without entering session authority', { timeout: 3000 }, async () => {
  const entered = deferred(), created = deferred(); let reconnecting = false, deletes = 0;
  const h = await scenario(call => {
    if (reconnecting && call.route === '/api/sessions' && call.method === 'POST') { entered.resolve(); return created.promise; }
    if (call.method === 'DELETE' && ++deletes === 1) throw httpError(503);
  });
  h.controller.local = async () => { throw new Error('Cancelled cleanup must not use local session authority.'); };
  h.controller.connections[0].fingerprint = 'AA'.repeat(32); ordinaryEnded(h); reconnecting = true;
  const outcome = h.controller.invoke('session.reconnect', { sessionId: h.sessionId }).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await h.controller.invoke('session.end', { sessionId: h.sessionId });
  h.remoteSessions.set('cancelled-created', primary);
  created.resolve({ json: { id: 'cancelled-created', permissions: { view: true, control: true } } });
  assert.match((await outcome).error?.message || '', /cancelled/);
  assert.equal(h.controller.sessions.size, 0);
  assert.equal(h.controller.sessionCleanups.size, 1);
  const [cleanupId, cleanup] = [...h.controller.sessionCleanups][0];
  assert.equal(cleanup.session, null); assert.equal(Object.hasOwn(cleanup, 'lastFailure'), false);
  await assert.rejects(h.controller.invoke('session.frame', { sessionId: cleanupId }), error => error.status === 410);
  await h.controller.shutdown();
  assert.equal(deletes, 2); assert.equal(h.remoteSessions.size, 0);
  assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(h.creations().length, 2, 'shutdown cleanup cannot authorize another session');
});

test('swallowed internal reconnect cleanup failure retains its target and retries at shutdown', async () => {
  let deletes = 0;
  const h = await scenario(call => { if (call.method === 'DELETE' && ++deletes === 1) throw httpError(503); });
  h.controller.connections[0].fingerprint = 'AA'.repeat(32); ordinaryEnded(h);
  const invoke = h.controller.invoke.bind(h.controller);
  h.controller.invoke = async (action, payload, assertCurrent) => {
    const value = await invoke(action, payload, assertCurrent);
    if (action === 'session.start') h.controller.reconnectPending.get(h.sessionId).cancelled = true;
    return value;
  };
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /cancelled/);
  assert.equal(h.controller.sessions.size, 0);
  assert.equal(h.controller.sessionCleanups.size, 1);
  assert.equal([...h.controller.sessionCleanups.values()][0].session, null);
  await h.controller.shutdown();
  assert.equal(h.remoteSessions.size, 0);
  assert.equal(deletes, 2); assert.equal(h.creations().length, 2);
});

test('monitor selection reuses one remote session and returning to primary preserves its geometry', { timeout: 3000 }, async () => {
  const h = await scenario();
  assert.equal((await h.frames('unchanged')).width, primary.width);
  const second = await h.frames('secondary');
  assert.equal(second.width, secondary.width);
  assert.equal(second.left, secondary.left);
  const returned = await h.frames(undefined);
  assert.equal(returned.width, primary.width);
  assert.equal(returned.left, primary.left);
  assert.deepEqual(h.creations().map(c => c.body.monitorId), [null], 'monitor selection never creates another control session');
  assert.equal(h.remoteSessions.size, 1);
  assert.ok(h.calls.some(c => c.pathname.endsWith('/frame') && c.monitorId === 'secondary'), 'secondary frames select the monitor through the frame query');
  assert.equal(h.calls.filter(c => c.method === 'DELETE').length, 0, 'monitor selection never tears down the shared session');
  await h.input({ type: 'pointer.move', x: 1, y: 0 });
  assert.equal(h.inputs().at(-1).body.x, primary.width - 1, 'control uses the returned primary frame coordinates');
  assert.match(h.inputs().at(-1).route, /\/remote-1\/input$/);
});

test('slow transport coalesces unsent pointer movement to its latest position', { timeout: 3000 }, async () => {
  const entered = deferred(); const gate = deferred(); let first = true;
  const h = await scenario(call => {
    if (call.route.endsWith('/input') && first) { first = false; entered.resolve(); return gate.promise; }
  });
  await h.frames('unchanged');
  const inFlight = h.input({ type: 'pointer.move', x: 0, y: 0 });
  await entered.promise;
  const moves = Array.from({ length: 100 }, (_, i) => h.input({ type: 'pointer.move', x: (i + 1) / 100, y: 0 }));
  const completed = Promise.all([inFlight, ...moves]);
  await nextTurn();
  assert.equal(h.inputs().length, 1, 'one input request is in flight while the transport is blocked');
  gate.resolve({});
  await completed;
  assert.equal(h.inputs().length, 2, 'unsent pointer moves collapse into a single latest move');
  assert.equal(h.inputs().at(-1).body.x, primary.width - 1);
});

test('two monitor windows fetch independently and keep their own pointer geometry under one control session', { timeout: 3000 }, async () => {
  const entered = deferred(); const gate = deferred(); let first = true;
  const h = await scenario(call => {
    if (call.pathname.endsWith('/frame') && first) { first = false; entered.resolve(); return gate.promise; }
  });
  const original = h.frames('unchanged');
  await entered.promise;
  const second = await h.frames('secondary');
  assert.equal(second.width, secondary.width, 'secondary frame completes while primary is still in flight');
  gate.resolve(imageResponse(primary));
  assert.equal((await original).width, primary.width);
  await h.input({ type: 'pointer.move', x: 1, y: 1 }, 'secondary');
  assert.equal(h.inputs().at(-1).body.x, secondary.left + secondary.width - 1,
    'a secondary-window pointer uses secondary geometry even after primary completed later');
  assert.equal(h.inputs().at(-1).body.y, secondary.height - 1);
  // Fetch the explicit primary key used by a separate primary viewer window.
  // Each window must obtain its own selected-monitor frame before sending input.
  await h.frames('primary');
  await h.input({ type: 'pointer.move', x: 0, y: 0 }, 'primary');
  assert.equal(h.inputs().at(-1).body.x, primary.left);
  await h.input({ type: 'pointer.move', x: 1, y: 0 });
  assert.equal(h.inputs().at(-1).body.x, primary.width - 1, 'legacy default viewer retains primary frame geometry');
  assert.equal(h.remoteSessions.size, 1);
  assert.deepEqual(h.creations().map(c => c.body.monitorId), [null]);
});

test('release invalidates already queued keys and pointer buttons before sending their actions', { timeout: 3000 }, async () => {
  const entered = deferred(); const gate = deferred(); let first = true;
  const h = await scenario(call => {
    if (call.route.endsWith('/input') && first) { first = false; entered.resolve(); return gate.promise; }
  });
  await h.frames('unchanged');
  const firstInput = h.input({ type: 'key', code: 'KeyA', down: true });
  await entered.promise;
  const stale = [h.input({ type: 'key', code: 'KeyB', down: true }),
    h.input({ type: 'pointer.button', button: 0, down: true, x: 0, y: 0 }),
    h.input({ type: 'pointer.move', x: 1, y: 1 })];
  const released = h.controller.invoke('session.release-inputs', { sessionId: h.sessionId });
  const completed = Promise.allSettled([firstInput, ...stale, released]);
  gate.resolve({});
  const results = await completed;
  assert.equal(results.at(-1).status, 'fulfilled');
  assert.equal(h.inputs().length, 1, 'actions queued before release must never reach the host');
  assert.equal(h.releases().length, 1);
  const order = h.calls.filter(c => c.route.endsWith('/input') || c.route.endsWith('/release-inputs'));
  assert.ok(order.at(-1).route.endsWith('/release-inputs'), 'release follows the one already in-flight action');
  await h.input({ type: 'key', code: 'KeyA', down: false });
  assert.equal(h.inputs().length, 2, 'new actions remain usable after release finishes');
});

test('input sent while a release is in flight waits for it and is delivered after it', { timeout: 3000 }, async () => {
  const entered = deferred(); const gate = deferred();
  const h = await scenario(call => { if (call.route.endsWith('/release-inputs')) { entered.resolve(); return gate.promise; } });
  await h.frames('unchanged');
  const released = h.controller.invoke('session.release-inputs', { sessionId: h.sessionId });
  await entered.promise;
  const move = h.input({ type: 'pointer.move', x: 5, y: 5 });
  await nextTurn(); assert.equal(h.inputs().length, 0, 'no input reaches the host before the release completes');
  gate.resolve({});
  await Promise.all([released, move]);
  const order = h.calls.filter(c => c.route.endsWith('/input') || c.route.endsWith('/release-inputs')).map(c => c.route.split('/').at(-1));
  assert.deepEqual(order, ['release-inputs', 'input']);
});

test('input backpressure bounds queued actions and avoids an overflow release flood', { timeout: 3000 }, async () => {
  const entered = deferred(); const gate = deferred(); let first = true;
  const h = await scenario(call => {
    if (call.route.endsWith('/input') && first) { first = false; entered.resolve(); return gate.promise; }
  });
  await h.frames('unchanged');
  const inFlight = h.input({ type: 'key', code: 'KeyA', down: true });
  await entered.promise;
  const queued = Array.from({ length: 128 }, () => h.input({ type: 'key', code: 'KeyB', down: true }));
  const completed = Promise.allSettled([inFlight, ...queued]);
  await nextTurn();
  gate.resolve({});
  const results = await completed;
  assert.ok(results.some(result => result.status === 'rejected'), 'overflow is reported to callers');
  assert.ok(h.inputs().length <= 64, 'the pending action limit is enforced');
  assert.ok(h.releases().length <= 2, 'a burst cannot append an unbounded release request per overflow event');
});

test('a revoked certificate response never triggers automatic session renewal', { timeout: 3000 }, async () => {
  const h = await scenario(call => { if (call.pathname.endsWith('/frame')) throw httpError(401); });
  await assert.rejects(h.frames('unchanged'), error => error.status === 401);
  await assert.rejects(h.frames('unchanged'), /ended|Mock remote HTTP 401/);
  assert.equal(h.controller.sessions.size, 0, 'revocation removes local authorization immediately');
  assert.equal(h.creations().length, 1, 'revocation can never take the missing-session renewal path');
});

test('wheel events retain DOM direction for each native backend to translate exactly once', async () => {
  const h = await scenario();
  await h.frames('unchanged');
  await h.input({ type: 'pointer.wheel', x: 0.5, y: 0.5, deltaX: 120, deltaY: -240 });
  assert.equal(h.inputs().at(-1).body.deltaX, 120);
  assert.equal(h.inputs().at(-1).body.deltaY, -240);
});

test('an authorized missing session still reconnects through a fresh remote session', { timeout: 3000 }, async () => {
  let first = true;
  const h = await scenario(call => {
    if (call.pathname.endsWith('/frame') && first) { first = false; throw httpError(404); }
  });
  const frame = await h.frames('unchanged');
  assert.equal(frame.width, primary.width);
  assert.equal(frame.sessionGeneration, 1);
  assert.equal(h.controller.sessions.get(h.sessionId).sessionGeneration, 1);
  assert.equal(h.creations().length, 2, '404 renewal remains available to an authorized viewer');
});
test('ordinary host-stop metadata permits a new session only through an explicit reconnect action', async () => {
  const h = await scenario(call => { if (call.pathname === '/api/sessions/remote-1/frame') throw httpError(410); });
  h.controller.connections[0].fingerprint = 'AA'.repeat(32);
  h.controller.noteHostStopping(h.sessionId, 'host_stopping');
  await assert.rejects(h.frames('unchanged'), error => error.status === 410);
  assert.equal(h.controller.sessions.size, 0); assert.equal(h.controller.canReconnect(h.sessionId), true);
  await nextTurn(); assert.equal(h.creations().length, 1, 'presentation metadata alone never creates authorization');
  const next = await h.controller.invoke('session.reconnect', { sessionId: h.sessionId });
  assert.notEqual(next.session.sessionId, h.sessionId); assert.equal(h.creations().length, 2);
  assert.equal(next.session.device.id, 'paired-device'); assert.equal(next.session.viewOnly, false);
  assert.equal((await h.controller.invoke('session.frame', { sessionId: next.session.sessionId })).width, primary.width);
  assert.equal(h.controller.canReconnect(h.sessionId), false, 'one explicit action consumes the old presentation target');
});
test('security denials and identity changes cannot use ordinary reconnect metadata', async () => {
  for (const status of [401, 403]) {
    const h = await scenario(call => { if (call.pathname.endsWith('/frame')) throw httpError(status); });
    h.controller.connections[0].fingerprint = 'AA'.repeat(32); h.controller.noteHostStopping(h.sessionId, 'host_stopping');
    await assert.rejects(h.frames('unchanged')); assert.equal(h.controller.canReconnect(h.sessionId), false);
    await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /unavailable/);
    assert.equal(h.creations().length, 1);
  }
  const h = await scenario(); h.controller.connections[0].fingerprint = 'AA'.repeat(32);
  for (const code of ['session_ended_by_host', 'access_revoked', 'permission_changed', 'identity_rotated']) {
    h.controller.noteHostStopping(h.sessionId, code); assert.equal(h.controller.canReconnect(h.sessionId), false);
  }
  h.controller.noteHostStopping(h.sessionId, 'host_stopping'); h.controller.connections[0].fingerprint = 'BB'.repeat(32);
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /unavailable/);
  assert.equal(h.creations().length, 1);
});

test('simultaneous missing-session frames on two monitors share a single renewal', { timeout: 3000 }, async () => {
  const bothEntered = deferred(); const failure = deferred(); let oldFrames = 0;
  const h = await scenario(call => {
    if (call.pathname === '/api/sessions/remote-1/frame') {
      if (++oldFrames === 2) bothEntered.resolve();
      return failure.promise;
    }
  });
  const first = h.frames('unchanged');
  const second = h.frames('secondary');
  const completed = Promise.all([first, second]);
  await bothEntered.promise;
  h.remoteSessions.delete('remote-1');
  failure.reject(httpError(404));
  const [primaryFrame, secondaryFrame] = await completed;
  assert.equal(primaryFrame.width, primary.width);
  assert.equal(secondaryFrame.width, secondary.width);
  assert.equal(primaryFrame.sessionGeneration, 1); assert.equal(secondaryFrame.sessionGeneration, 1);
  assert.equal(h.creations().length, 2, 'both failures must share one replacement request');
  assert.equal(h.remoteSessions.size, 1, 'only the renewed remote session remains');
  assert.deepEqual([...h.remoteSessions.keys()], ['remote-2']);
  await h.input({ type: 'pointer.move', x: 0, y: 0 }, 'secondary');
  assert.equal(h.inputs().at(-1).body.x, secondary.left);
  assert.match(h.inputs().at(-1).route, /\/remote-2\/input$/);
});
test('input release leaves session generation unchanged; recovery advances it once and overflow cannot create a replacement', async () => {
  const h = await scenario();
  assert.equal((await h.frames('unchanged')).sessionGeneration, 0);
  await h.controller.invoke('session.release-inputs', { sessionId: h.sessionId });
  assert.equal((await h.frames('unchanged')).sessionGeneration, 0);
  h.remoteSessions.delete('remote-1');
  assert.equal((await h.frames('unchanged')).sessionGeneration, 1);
  assert.equal(h.controller.sessions.get(h.sessionId).sessionGeneration, 1);
  h.controller.sessions.get(h.sessionId).sessionGeneration = Number.MAX_SAFE_INTEGER;
  h.remoteSessions.delete('remote-2');
  await assert.rejects(h.frames('unchanged'), /cannot safely resume/);
  assert.equal(h.creations().length, 2, 'generation exhaustion fails before remote session creation');
  assert.equal(h.controller.sessions.has(h.sessionId), false, 'an exhausted generation becomes terminal');
});

test('a successful old-monitor frame arriving after renewal cannot restore stale geometry or enable input', { timeout: 3000 }, async () => {
  const entered = deferred(); const oldFrame = deferred();
  let h;
  h = await scenario(call => {
    if (call.pathname === '/api/sessions/remote-1/frame' && call.monitorId === 'primary') {
      entered.resolve(); return oldFrame.promise;
    }
    if (call.pathname === '/api/sessions/remote-1/frame' && call.monitorId === 'secondary') {
      h.remoteSessions.delete('remote-1');
      throw httpError(404);
    }
  });
  const staleOutcome = h.frames('primary').then(value => ({ value }), error => ({ error }));
  await entered.promise;
  assert.equal((await h.frames('secondary')).width, secondary.width);
  assert.equal(h.creations().length, 2, 'the other monitor renewed the missing session');
  oldFrame.resolve(imageResponse({ ...primary, left: 5000, width: 640 }));
  assert.match((await staleOutcome).error?.message || '', /fresh screen/,
    'a successful response belonging to the old remote session must be discarded');
  assert.equal(h.controller.sessions.get(h.sessionId).frameSlots.get('primary').frame, null,
    'pre-renewal geometry must remain cleared');
  await assert.rejects(h.input({ type: 'pointer.move', x: 1, y: 0 }, 'primary'), /first frame/);
  assert.equal(h.inputs().length, 0, 'stale geometry cannot authorize pointer input');
  await h.frames('primary');
  await h.input({ type: 'pointer.move', x: 1, y: 0 }, 'primary');
  assert.equal(h.inputs().at(-1).body.x, primary.width - 1, 'only a fresh frame supplies the new session geometry');
  assert.match(h.inputs().at(-1).route, /\/remote-2\/input$/);
});

test('ending while a shared session renewal is in flight deletes the late replacement without orphaning it', { timeout: 3000 }, async () => {
  const renewing = deferred(); const replacement = deferred(); let creations = 0;
  let h;
  h = await scenario(call => {
    if (call.route === '/api/sessions' && call.method === 'POST' && ++creations === 2) {
      renewing.resolve(); return replacement.promise;
    }
    if (call.pathname === '/api/sessions/remote-1/frame') {
      h.remoteSessions.delete('remote-1');
      throw httpError(404);
    }
  });
  const frameOutcome = h.frames('secondary').then(value => ({ value }), error => ({ error }));
  await renewing.promise;
  const ending = h.controller.invoke('session.end', { sessionId: h.sessionId });
  await nextTurn();
  h.remoteSessions.set('remote-late', primary);
  replacement.resolve({ json: { id: 'remote-late', permissions: { view: true, control: true } } });
  await ending;
  assert.ok((await frameOutcome).error, 'a closed viewer must not return a renewed frame');
  assert.equal(h.creations().length, 2, 'disconnect never starts another renewal');
  assert.equal(h.remoteSessions.size, 0, 'the replacement created during disconnect is deleted');
  assert.ok(h.calls.some(c => c.pathname === '/api/sessions/remote-late' && c.method === 'DELETE'));
});


test('an explicit disconnect clears an ordinary-stop reconnect offer', async () => {
  const h = await scenario(call => { if (call.pathname.endsWith('/frame')) throw httpError(410); });
  h.controller.connections[0].fingerprint = 'AA'.repeat(32);
  h.controller.noteHostStopping(h.sessionId, 'host_stopping');
  await assert.rejects(h.frames('unchanged'), error => error.status === 410);
  assert.equal(h.controller.canReconnect(h.sessionId), true);
  await h.controller.invoke('session.end', { sessionId: h.sessionId });
  assert.equal(h.controller.canReconnect(h.sessionId), false);
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /unavailable/);
  assert.equal(h.creations().length, 1, 'Disconnect never leaves a reusable reconnect offer');
});



function ordinaryEnded(h) {
  h.controller.noteHostStopping(h.sessionId, 'host_stopping');
  const session = h.controller.sessions.get(h.sessionId);
  if (session) { session.closed = true; h.remoteSessions.delete(session.remoteId); h.controller.sessions.delete(h.sessionId); }
  h.controller.endedSessions.set(h.sessionId, 'Session ended after an ordinary host restart.');
}

test('explicit reconnect preserves the selected secondary monitor instead of silently choosing primary', async () => {
  const h = await scenario(); h.controller.connections[0].fingerprint = 'AA'.repeat(32);
  ordinaryEnded(h);
  const next = await h.controller.invoke('session.reconnect', { sessionId: h.sessionId, monitorId: 'secondary' });
  assert.equal(next.monitorId, 'secondary'); assert.equal(h.creations().at(-1).body.monitorId, 'secondary');
  const frame = await h.controller.invoke('session.frame', { sessionId: next.session.sessionId, monitorId: 'secondary' });
  assert.equal(frame.left, secondary.left); assert.equal(frame.width, secondary.width);
});

test('reconnect refuses a disappeared selected monitor before creating a replacement', async () => {
  let reconnecting = false;
  const h = await scenario(call => {
    if (reconnecting && call.route === '/api/info') return { json: { platform: { monitors: [primary] } } };
  });
  h.controller.connections[0].fingerprint = 'AA'.repeat(32); ordinaryEnded(h);
  reconnecting = true;
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId, monitorId: 'secondary' }), /monitor is no longer available/);
  assert.equal(h.creations().length, 1); assert.equal(h.controller.sessions.size, 0);
});

for (const phase of ['info', 'create']) for (const reason of ['disconnect', 'forget', 'shutdown', 'local-generation', 'paired-identity'])
  test(`reconnect cancelled during ${phase} by ${reason} cannot return or retain a late session`, { timeout: 3000 }, async () => {
    const entered = deferred(), gate = deferred(); let reconnecting = false;
    const h = await scenario(call => {
      if (!reconnecting) return;
      if (phase === 'info' && call.route === '/api/info' || phase === 'create' && call.route === '/api/sessions' && call.method === 'POST') {
        entered.resolve(); return gate.promise;
      }
    });
    h.controller.save = async () => {};
    h.controller.local = async () => { throw new Error('Fixture must never call the local host.'); };
    h.controller.connections[0].fingerprint = 'AA'.repeat(32); ordinaryEnded(h);
    reconnecting = true;
    const outcome = h.controller.invoke('session.reconnect', { sessionId: h.sessionId }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    let cancellation;
    if (reason === 'disconnect') cancellation = h.controller.invoke('session.end', { sessionId: h.sessionId });
    if (reason === 'forget') cancellation = h.controller.invoke('device.forget', { deviceId: 'paired-device' });
    if (reason === 'shutdown') cancellation = h.controller.shutdown();
    if (reason === 'local-generation') h.controller.localGeneration++;
    if (reason === 'paired-identity') h.controller.connections[0].fingerprint = 'BB'.repeat(32);
    if (phase === 'info') gate.resolve({ json: { platform: { monitors: [primary, secondary] } } });
    else {
      h.remoteSessions.set('late-reconnect', primary);
      gate.resolve({ json: { id: 'late-reconnect', permissions: { view: true, control: true } } });
    }
    await cancellation;
    assert.match((await outcome).error?.message || '', /cancelled|identity changed/);
    assert.equal(h.controller.sessions.size, 0); assert.equal(h.controller.reconnectPending.size, 0);
    assert.equal(h.controller.canReconnect(h.sessionId), reason === 'local-generation');
    assert.equal(h.remoteSessions.size, 0, 'a cancelled late POST is deleted at the host');
    assert.equal(h.creations().length, phase === 'info' ? 1 : 2, 'a cancelled info response cannot create a session');
    if (phase === 'create') assert.ok(h.calls.some(call => call.route === '/api/sessions/late-reconnect' && call.method === 'DELETE'));
  });


test('known local host proof-agent absence has explicit transient restart provenance', async () => {
  const controller = new OrbitController({ directory: os.tmpdir(), requireLocalProof: true });
  await assert.rejects(controller.local('client-identity'), error => error.code === 'ORBIT_LOCAL_HOST_RESTARTING');
});


test('late reconnect cleanup retains the original pin and client identity after local control is cleared', { timeout: 3000 }, async () => {
  const entered = deferred(), gate = deferred(), calls = [];
  const identity = { certificatePem: 'generated-old-certificate', privateKeyPem: 'generated-old-key' };
  const device = { id: 'paired', name: 'Generated host', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32), permissions: { view: true } };
  const controller = new OrbitController({ directory: os.tmpdir(), requireLocalProof: true, remoteRequest: async (target, credentials, route, options) => {
    calls.push({ target: { ...target }, credentials, route, method: options?.method || 'GET' });
    if (route === '/api/info') return { json: { platform: { monitors: [primary] } } };
    if (options?.method === 'POST') { entered.resolve(); return gate.promise; }
    return {};
  } });
  controller.connections.push(device); controller.identity = identity;
  controller.sessions.set('old', { device, remoteId: 'old-remote', monitorId: null, monitors: [primary], viewOnly: true });
  controller.noteHostStopping('old', 'host_stopping');
  controller.sessions.delete('old'); controller.endedSessions.set('old', 'Session ended after host restart.');
  const outcome = controller.invoke('session.reconnect', { sessionId: 'old' }).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  controller.clearLocalControl(); device.fingerprint = 'BB'.repeat(32);
  gate.resolve({ json: { id: 'late-created', permissions: { view: true } } });
  assert.match((await outcome).error?.message || '', /cancelled/);
  const cleanup = calls.find(call => call.route === '/api/sessions/late-created' && call.method === 'DELETE');
  assert.ok(cleanup, 'cleanup never needs the now unavailable local host');
  assert.equal(cleanup.credentials, identity); assert.equal(cleanup.target.fingerprint, 'AA'.repeat(32));
  assert.equal(controller.sessions.size, 0);
});


test('live restart waiting never accepts explicit reconnect or deletes the protected session', async () => {
  const h = await scenario(); h.controller.connections[0].fingerprint = 'AA'.repeat(32);
  h.controller.noteHostStopping(h.sessionId, 'host_stopping');
  assert.equal(h.controller.canReconnect(h.sessionId), false);
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /unavailable/);
  assert.equal(h.controller.sessions.size, 1); assert.equal(h.creations().length, 1);
  assert.ok(h.controller.reconnectTargets.has(h.sessionId));
  assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 0);
});

test('failed explicit reconnect retains the ended target and a later user retry can succeed', async () => {
  let failing = false;
  const h = await scenario(call => { if (failing && call.route === '/api/info') throw Object.assign(new Error('Refused'), { code: 'ECONNREFUSED' }); });
  h.controller.connections[0].fingerprint = 'AA'.repeat(32); ordinaryEnded(h); failing = true;
  await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: h.sessionId }), /Refused/);
  assert.equal(h.controller.canReconnect(h.sessionId), true); assert.equal(h.controller.sessions.size, 0);
  failing = false;
  const next = await h.controller.invoke('session.reconnect', { sessionId: h.sessionId });
  assert.ok(next.session.sessionId); assert.equal(h.controller.canReconnect(h.sessionId), false);
  assert.deepEqual(Object.keys(next.session.device).sort(), ['direction', 'id', 'name', 'platform']);
});

for (const mode of ['fresh-frame', 'renewal']) test(`successful ${mode} clears stale ordinary restart hints`, async () => {
  const h = await scenario(); h.controller.connections[0].fingerprint = 'AA'.repeat(32);
  h.controller.noteHostStopping(h.sessionId, 'host_stopping');
  if (mode === 'renewal') h.remoteSessions.delete('remote-1');
  await h.frames('unchanged');
  assert.equal(h.controller.reconnectTargets.has(h.sessionId), false);
  const session = h.controller.sessions.get(h.sessionId); session.closed = true;
  h.controller.sessions.delete(h.sessionId); h.controller.endedSessions.set(h.sessionId, 'Later terminal410.');
  assert.equal(h.controller.canReconnect(h.sessionId), false);
});

test('second-window tombstone polling preserves ordinary restart target and410 metadata', async () => {
  const { frameRequestError } = require('./stream-session.cjs');
  const h = await scenario(); h.controller.connections[0].fingerprint = 'AA'.repeat(32); ordinaryEnded(h);
  for (let index = 0; index < 3; index++) {
    let failure; try { await h.frames('secondary'); } catch (error) { failure = error; }
    const result = frameRequestError(failure, h.controller.endedSessions.get(h.sessionId), h.controller.canReconnect(h.sessionId));
    assert.equal(result.error.status, 410); assert.equal(result.error.canReconnect, true);
    assert.equal(h.controller.canReconnect(h.sessionId), true);
  }
  assert.equal(h.creations().length, 1);
});
