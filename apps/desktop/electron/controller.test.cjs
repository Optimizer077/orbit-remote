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
  controller.remote = async (_device, route, options = {}) => {
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
  await assert.rejects(h.frames('unchanged'), error => error.status === 401);
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
  assert.equal(h.creations().length, 2, '404 renewal remains available to an authorized viewer');
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
  assert.equal(h.creations().length, 2, 'both failures must share one replacement request');
  assert.equal(h.remoteSessions.size, 1, 'only the renewed remote session remains');
  assert.deepEqual([...h.remoteSessions.keys()], ['remote-2']);
  await h.input({ type: 'pointer.move', x: 0, y: 0 }, 'secondary');
  assert.equal(h.inputs().at(-1).body.x, secondary.left);
  assert.match(h.inputs().at(-1).route, /\/remote-2\/input$/);
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
