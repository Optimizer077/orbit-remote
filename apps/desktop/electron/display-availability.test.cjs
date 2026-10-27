'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), os = require('node:os');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { OrbitController } = require('./controller.cjs');
const { OrbitStreamParser } = require('./stream-parser.cjs');
const { frameRequestError, streamOpenError, wakeDisplayError } = require('./stream-session.cjs');
const { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');
const DISPLAY_ASLEEP_MESSAGE = 'The remote display is asleep.';
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; };
const asleep = changes => Object.assign(new Error('Remote wording is not a classifier.'), { status: 409, code: 'display_asleep', displayState: 'off', ...changes });
const callbackBody = (source, name, parameter = 'entry') => {
  const match = source.match(new RegExp(name + ':\\s*' + parameter + '\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\},'));
  assert.ok(match, 'actual main callback ' + name); return match[1];
};
const monitors = [{ id: 'first', primary: true, width: 1920, height: 1080, left: -1920, top: 0 }, { id: 'second', width: 1920, height: 1080, left: 0, top: 0 }];
const grants = { view: true, control: true, clipboard: false, files: false, power: false };
const image = () => ({ status: 200, headers: { 'content-type': 'image/png', 'x-orbit-width': '1920', 'x-orbit-height': '1080',
  'x-orbit-left': '-1920', 'x-orbit-top': '0', etag: '"generated"' }, buffer: Buffer.from('generated-only-image') });
const config = { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
  physicalLeft: -1920, physicalTop: 0, physicalWidth: 1920, physicalHeight: 1080, scale: 1, fps: 60, monitorId: 'first' };
function record(type, value, sequence, flags = 0) {
  const body = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value)), header = Buffer.alloc(24);
  header[0] = type; header[1] = flags; header.writeUInt32LE(body.length, 4); header.writeUInt32LE(sequence, 8); header.writeBigUInt64LE(BigInt(sequence), 16);
  return Buffer.concat([header, body]);
}
class Port extends EventEmitter {
  messages = []; closed = false;
  start() {}
  postMessage(message) { if (this.closed) throw new Error('closed'); this.messages.push(message); }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
async function fixture(t, options = {}) {
  const calls = [], notifications = [], pendingNotifications = [], identity = { certificatePem: 'generated-certificate', privateKeyPem: 'generated-key' };
  const device = { id: 'paired', name: 'Generated computer', address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32), permissions: { ...grants } };
  let created = 0, frame = () => image(), wake = () => ({ status: 202, json: { state: 'requested' } });
  let renewal = { permissions: { ...grants }, canWakeDisplay: true };
  const controller = new OrbitController({ directory: os.tmpdir(), onDisplayAsleep: id => notifications.push(id),
    onDisplayPendingInvalidated: id => pendingNotifications.push(id),
    remoteRequest: async (target, client, route, request = {}) => {
      const url = new URL(route, 'https://fixture.invalid'), call = { target, client, route, pathname: url.pathname, query: url.searchParams,
        method: request.method || 'GET', request }; calls.push(call);
      if (route === '/api/info') return { json: { platform: { monitors, canConditionalFrames: true } } };
      if (route === '/api/sessions') return { json: { id: 'remote-' + ++created, resumeEpoch: 'generated-epoch',
        ...(created === 1 ? { permissions: { ...grants }, canWakeDisplay: options.capability ?? true } : renewal) } };
      if (url.pathname.endsWith('/frame')) return frame(call);
      if (url.pathname.endsWith('/wake-display')) return wake(call);
      if (call.method === 'DELETE' || url.pathname.endsWith('/input') || url.pathname.endsWith('/release-inputs')
        || url.pathname.endsWith('/stream/control')) return {};
      throw new Error('Unexpected generated transport path: ' + url.pathname);
    } });
  controller.connections.push(device); controller.getIdentity = async () => identity;
  controller.local = async () => assert.fail('Outgoing availability cannot use incoming/local authority.');
  t.after(() => controller.shutdown());
  const session = await controller.invoke('session.start', { deviceId: device.id, monitorId: 'first', viewOnly: options.viewOnly === true });
  const live = controller.sessions.get(session.sessionId); calls.length = 0;
  return { controller, session, live, device, identity, calls, notifications, pendingNotifications,
    frame(monitorId = 'first') { return controller.invoke('session.frame', { sessionId: session.sessionId, monitorId }); },
    wake() { return controller.invoke('session.wake-display', { sessionId: session.sessionId }); },
    setFrame(value) { frame = value; }, setWake(value) { wake = value; }, setRenewal(value) { renewal = value; },
    wakeCalls() { return calls.filter(call => call.pathname.endsWith('/wake-display')); },
    sessionPosts() { return calls.filter(call => call.route === '/api/sessions' && call.method === 'POST'); } };
}

function actualMainBridge(h) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const begin = source.indexOf("  ipcMain.handle('orbit:invoke',"), end = source.indexOf('\n  });', begin);
  assert.ok(begin > 0 && end > begin);
  const frame = { url: 'file:///generated/main.html' }, owner = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate();
  const context = { controller: h.controller, frameGate: gate, IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE,
    frameRequestError, streamOpenError, wakeDisplayError, mainWindow: { webContents: owner, isDestroyed: () => false },
    windowStates: new Map([[1, { current: () => ({ paused: false }) }]]), viewerWindows: new Map(),
    windowInputs: new Map(), windowReconnects: new Map(), pageUrl: () => frame.url,
    frameContext: (sessionId, monitorId) => { const session = h.controller.getSession({ sessionId });
      return { sessionId, monitorId, generation: session.sessionGeneration ?? 0, frame: session.frameSlots.get(monitorId)?.frame }; },
    ipcMain: { handle: (_name, handler) => { context.handler = handler; } } };
  vm.runInNewContext(source.match(/const viewerActions = new Set\([\s\S]*?\);/)[0] + '\n' + source.slice(begin, end + '\n  });'.length), context);
  const sleep = vm.runInNewContext('(sessionId) => {' + callbackBody(source, 'onDisplayAsleep', 'sessionId') + '\n}', context);
  const pending = vm.runInNewContext('(sessionId) => {' + callbackBody(source, 'onDisplayPendingInvalidated', 'sessionId') + '\n}', context);
  h.controller.onDisplayAsleep = id => { h.notifications.push(id); sleep(id); };
  h.controller.onDisplayPendingInvalidated = id => { h.pendingNotifications.push(id); pending(id); };
  return { gate, frameContext: context.frameContext,
    invoke: (action, payload) => context.handler({ sender: owner, senderFrame: frame }, action, payload) };
}

test('F30b create/frame304 snapshots expose only current local availability and legacy capability fails closed', async t => {
  const h = await fixture(t);
  const expected = { sessionId: h.session.sessionId, sessionGeneration: 0, canWakeDisplay: true, controlGranted: true, viewOnly: false };
  assert.deepEqual(h.session.availability, expected);
  assert.deepEqual((await h.frame()).availability, expected);
  h.live.permissions = { ...grants, control: false }; h.live.canWakeDisplay = false;
  h.setFrame(() => ({ status: 304, headers: { etag: '"generated"' } }));
  const unchanged = await h.frame(); assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.availability, { ...expected, controlGranted: false, canWakeDisplay: false });
  assert.equal(JSON.stringify(unchanged.availability).includes('remote-'), false);
  delete h.live.canWakeDisplay; assert.equal(h.controller.availability(h.session.sessionId).canWakeDisplay, false);
});

for (const renewal of [{ permissions: { ...grants }, canWakeDisplay: false }, { permissions: { ...grants, control: false } }])
  test('F30b protected renewal replaces capability/grants instead of inheriting earlier wake eligibility ' + JSON.stringify(renewal), { timeout: 1000 }, async t => {
    const h = await fixture(t); h.setRenewal(renewal);
    h.setFrame(call => { if (call.pathname.includes('/remote-1/')) throw Object.assign(new Error('Missing session'), { status: 404 }); return image(); });
    const frame = await h.frame();
    assert.deepEqual(frame.availability, { sessionId: h.session.sessionId, sessionGeneration: 1,
      canWakeDisplay: false, controlGranted: renewal.permissions.control, viewOnly: false });
    assert.equal(h.sessionPosts().length, 1); assert.equal(h.sessionPosts()[0].request.body.resumeEpoch, 'generated-epoch');
    await assert.rejects(h.wake()); assert.equal(h.wakeCalls().length, 0);
  });

test('F30b known asleep preserves session but retires all old geometry, caches, input epochs and delivery tokens', async t => {
  const h = await fixture(t); await h.frame(); await h.frame('second');
  const epoch = h.live.inputEpoch, old = h.live.frameSlots.get('first').deliveryToken;
  h.setFrame(() => { throw asleep(); });
  await assert.rejects(h.frame(), error => {
    assert.equal(error.message, DISPLAY_ASLEEP_MESSAGE); assert.equal(error.code, 'display_asleep');
    assert.equal(error.availability.sessionGeneration, 0); assert.equal(error.availability.controlGranted, true); return true;
  });
  assert.equal(h.controller.sessions.get(h.session.sessionId), h.live); assert.equal(h.live.closed, false);
  assert.equal(h.live.frame, null); assert.ok(h.live.inputEpoch > epoch);
  assert.ok([...h.live.frameSlots.values()].every(slot => slot.frame === null && slot.cache === null));
  assert.notEqual(h.live.frameSlots.get('first').deliveryToken, old); assert.deepEqual(h.notifications, [h.session.sessionId]);
  await assert.rejects(h.controller.invoke('session.input', { sessionId: h.session.sessionId, monitorId: 'first', event: { type: 'key', code: 'KeyA', down: true } }), /first frame/);
  assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

test('F30b old frame409 after another monitor renews is rejected without borrowing new generation metadata', { timeout: 1000 }, async t => {
  const h = await fixture(t), held = deferred(), entered = deferred();
  t.after(() => held.resolve(image()));
  h.setRenewal({ permissions: { ...grants, control: false }, canWakeDisplay: false });
  h.setFrame(call => {
    if (call.pathname.includes('/remote-1/') && call.query.get('monitorId') === 'first') { entered.resolve(); return held.promise; }
    if (call.pathname.includes('/remote-1/')) throw Object.assign(new Error('Missing session'), { status: 404 });
    return image();
  });
  const old = h.frame(); old.catch(() => {}); await entered.promise;
  const fresh = await h.frame('second'); assert.equal(fresh.sessionGeneration, 1);
  held.reject(asleep());
  await assert.rejects(old, error => error.code !== 'display_asleep' && error.availability === undefined);
  assert.deepEqual(h.notifications, []); assert.equal(h.live.frameSlots.get('second').frame.width, 1920);
  assert.equal(h.controller.availability(h.session.sessionId).controlGranted, false);
});

test('F30b exact asleep contract alone gets a retry exception; contradictory security status remains terminal', () => {
  assert.equal(frameRequestError(asleep()).error.code, 'display_asleep');
  assert.equal(frameRequestError(asleep()).error.retryable, true);
  for (const changes of [{ displayState: 'unknown' }, { displayState: undefined }, { code: 'capture_unavailable' }, { status: 503 }])
    assert.notEqual(frameRequestError(asleep(changes)).error.code, 'display_asleep');
  for (const status of [401, 403, 410]) {
    const error = frameRequestError(asleep({ status })).error;
    assert.notEqual(error.code, 'display_asleep'); assert.equal(error.retryable, false); assert.equal(error.status, status);
  }
  assert.equal(frameRequestError(asleep(), 'Session ended.').error.code, 'session_ended');
  assert.equal(streamOpenError(asleep({ code: 'wake_unsupported' })).error.retryable, false);
});

test('F30b Type4 asleep stays in its existing bounded schema and normalizes only inside main', () => {
  const delivered = [], parser = new OrbitStreamParser({ monitorId: 'first', onRecord: value => delivered.push(value) });
  parser.push(record(1, config, 0)); parser.push(record(4, { code: 'display_asleep', error: DISPLAY_ASLEEP_MESSAGE }, 1));
  assert.equal(delivered[1].code, 'display_asleep'); assert.equal(delivered[1].status, undefined);
  for (const extra of [{ status: 409 }, { displayState: 'off' }]) {
    const p = new OrbitStreamParser({ monitorId: 'first', onRecord() {} }); p.push(record(1, config, 0));
    assert.throws(() => p.push(record(4, { code: 'display_asleep', error: DISPLAY_ASLEEP_MESSAGE, ...extra }, 1)), /terminal/);
  }
});

for (const kind of ['record', 'http']) test('F30b current stream ' + kind + ' asleep carries current availability and never creates a session or wake', async t => {
  const h = await fixture(t), port = new Port(); let feed;
  h.controller.videoStreams.openRemote = async (_device, _identity, _route, options) => {
    if (kind === 'http') throw asleep();
    feed = options.onData; return { done: new Promise(() => {}), abort() {}, resume() {} };
  };
  h.controller.videoStreams.open({ sessionId: h.session.sessionId, monitorId: 'first' }, port, 1); await turn();
  if (kind === 'record') { feed(record(1, config, 0)); feed(record(4, { code: 'display_asleep', error: 'Generated host wording.' }, 1)); }
  const status = port.messages.find(value => value.code === 'display_asleep');
  assert.ok(status); assert.equal(status.state, 'fallback'); assert.equal(status.status, 409); assert.equal(status.displayState, 'off');
  assert.equal(status.error, DISPLAY_ASLEEP_MESSAGE); assert.equal(status.retryable, true);
  assert.deepEqual(status.availability, h.controller.availability(h.session.sessionId));
  assert.equal(h.live.closed, false); assert.equal(h.controller.videoStreams.entries.size, 0);
  assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

test('F30b stale stream failure cannot snapshot a successor generation', async t => {
  const h = await fixture(t), port = new Port(), connected = deferred();
  h.controller.videoStreams.openRemote = async () => ({ done: connected.promise, abort() {}, resume() {} });
  const { streamId } = h.controller.videoStreams.open({ sessionId: h.session.sessionId, monitorId: 'first' }, port, 1); await turn();
  const entry = h.controller.videoStreams.entries.get(streamId); h.live.sessionGeneration++; h.live.remoteId = 'remote-successor';
  h.controller.videoStreams.failure(entry, asleep());
  assert.equal(port.messages.at(-1).code, 'session_reconnected'); assert.equal(port.messages.at(-1).availability, undefined);
  assert.deepEqual(h.notifications, []); connected.resolve();
});

test('F30b fixed wake omits the body, does not need geometry and cannot grant ordinary input', async t => {
  const h = await fixture(t);
  assert.equal(h.live.frame, null); assert.deepEqual(await h.wake(), { state: 'requested' });
  const call = h.wakeCalls()[0]; assert.equal(call.method, 'POST'); assert.equal(call.pathname, '/api/sessions/remote-1/wake-display');
  assert.equal(Object.hasOwn(call.request, 'body'), false); assert.deepEqual(call.request.headers, { 'content-length': '0' });
  assert.equal(call.client, h.identity); assert.equal(call.target.fingerprint, h.device.fingerprint); assert.equal(h.sessionPosts().length, 0);
  await assert.rejects(h.controller.invoke('session.input', { sessionId: h.session.sessionId, event: { type: 'key', code: 'KeyA', down: true } }), /first frame/);
});

for (const denied of ['viewOnly', 'control', 'capability', 'closed', 'extras'])
  test('F30b wake denies ' + denied + ' before transport and never renews', async t => {
    const h = await fixture(t);
    if (denied === 'viewOnly') h.live.viewOnly = true;
    if (denied === 'control') h.live.permissions.control = false;
    if (denied === 'capability') delete h.live.canWakeDisplay;
    if (denied === 'closed') await h.controller.invoke('session.end', { sessionId: h.session.sessionId });
    await assert.rejects(h.controller.invoke('session.wake-display', { sessionId: h.session.sessionId, ...(denied === 'extras' ? { event: { type: 'key' } } : {}) }));
    assert.equal(h.wakeCalls().length, 0); assert.equal(h.sessionPosts().length, 0);
  });

for (const change of ['grant', 'capability', 'generation', 'pin', 'closed', 'owner'])
  test('F30b wake rechecks ' + change + ' after deferred identity before any POST', { timeout: 1000 }, async t => {
    const h = await fixture(t), identity = deferred(), entered = deferred(); let current = true;
    t.after(() => identity.resolve(h.identity));
    h.controller.getIdentity = () => { entered.resolve(); return identity.promise; };
    const pending = h.controller.invoke('session.wake-display', { sessionId: h.session.sessionId }, () => { if (!current) throw Object.assign(new Error('Owner changed'), { code: 'wake_cancelled' }); });
    pending.catch(() => {}); await entered.promise;
    if (change === 'grant') h.live.permissions.control = false;
    if (change === 'capability') h.live.canWakeDisplay = false;
    if (change === 'generation') { h.live.sessionGeneration++; h.live.remoteId = 'remote-successor'; }
    if (change === 'pin') h.device.fingerprint = 'BB'.repeat(32);
    if (change === 'closed') await h.controller.invoke('session.end', { sessionId: h.session.sessionId });
    if (change === 'owner') current = false;
    identity.resolve(h.identity); await assert.rejects(pending);
    assert.equal(h.wakeCalls().length, 0); assert.equal(h.sessionPosts().length, 0);
  });

test('F30b wake late success is rejected after explicit end and never restores a session', { timeout: 1000 }, async t => {
  const h = await fixture(t), response = deferred(), entered = deferred(); t.after(() => response.resolve({ status: 202, json: { state: 'requested' } }));
  h.setWake(() => { entered.resolve(); return response.promise; });
  const pending = h.wake(); pending.catch(() => {}); await entered.promise;
  await h.controller.invoke('session.end', { sessionId: h.session.sessionId });
  response.resolve({ status: 202, json: { state: 'requested' } }); await assert.rejects(pending, error => error.status === 410);
  assert.equal(h.controller.sessions.size, 0); assert.equal(h.wakeCalls().length, 1); assert.equal(h.sessionPosts().length, 0);
});

for (const status of [401, 403, 410]) test('F30b wake terminal HTTP' + status + ' retires authority and never renews or retries', async t => {
  const h = await fixture(t); await h.frame();
  h.setWake(() => { throw asleep({ status }); });
  await assert.rejects(h.wake(), error => error.status === status);
  assert.equal(h.live.closed, true); assert.equal(h.live.frame, null); assert.equal(h.controller.sessions.size, 0);
  await assert.rejects(h.wake(), error => error.status === 410);
  await assert.rejects(h.frame(), error => error.status === 410);
  assert.equal(h.wakeCalls().length, 1); assert.equal(h.sessionPosts().length, 0);
});

// Exercise actual transport parsing/framing with an in-memory HTTP implementation.
// No server, TLS socket, native host, display wake or OS input is created.
function fakeTransport(status, json, headers = {}) {
  const observed = [], source = fs.readFileSync(path.join(__dirname, 'transport.cjs'), 'utf8');
  const fake = { Agent: class { destroy() {} }, request(url, options, callback) {
    const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = error => { if (error) req.emit('error', error); req.emit('close'); };
    req.end = body => { observed.push({ url: String(url), options, body }); queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.headers = { 'content-type': 'application/json', ...headers }; res.socket = {};
      res.destroy = error => { if (error) res.emit('error', error); res.emit('close'); };
      callback(res); res.emit('data', Buffer.from(JSON.stringify(json))); res.emit('end'); res.emit('close'); req.emit('close');
    }); }; return req;
  } };
  const context = { module: { exports: {} }, Buffer, URL, setTimeout, clearTimeout, queueMicrotask,
    require(name) { return ['node:https', 'node:http'].includes(name) ? fake : require(name); } };
  vm.runInNewContext(source, context);
  return { transport: context.module.exports, observed };
}
test('F30b transport preserves only exact asleep409/off and filters remote identity claims', async () => {
  for (const [status, json, expected] of [[409, { code: 'display_asleep', error: DISPLAY_ASLEEP_MESSAGE, displayState: 'off' }, true],
    [409, { code: 'display_asleep', error: DISPLAY_ASLEEP_MESSAGE }, false], [503, { code: 'display_asleep', displayState: 'off' }, false],
    [403, { code: 'display_asleep', displayState: 'off' }, false], [409, { code: 'pin_mismatch', displayState: 'off' }, false]]) {
    const f = fakeTransport(status, json);
    await assert.rejects(f.transport.request({ url: new URL('https://fixture.invalid/api/frame') }), error => {
      assert.equal(error.status, status); assert.equal(error.code === 'display_asleep', expected);
      assert.equal(error.displayState === 'off', expected); assert.notEqual(error.code, 'pin_mismatch'); return true;
    });
  }
});
test('F30b empty wake transport sends zero bytes and preserves the bounded five-second limit', async () => {
  const ok = fakeTransport(202, { state: 'requested' });
  await ok.transport.request({ url: new URL('https://fixture.invalid/api/wake-display'), method: 'POST', headers: { 'content-length': '0' } });
  assert.equal(ok.observed[0].body, undefined); assert.equal(ok.observed[0].options.headers['content-length'], '0');
  assert.equal(ok.observed[0].options.headers['content-type'], undefined); assert.equal(ok.observed[0].options.headers['transfer-encoding'], undefined);
  const rate = fakeTransport(429, { code: 'wake_rate_limited' }, { 'retry-after': '5' });
  await assert.rejects(rate.transport.request({ url: new URL('https://fixture.invalid/api/wake-display') }), error => error.code === 'wake_rate_limited' && error.retryAfterSeconds === 5);
});
test('F30b streaming HTTP409 retains only the same strict asleep metadata as image HTTP', async () => {
  for (const json of [{ code: 'display_asleep', displayState: 'off', error: DISPLAY_ASLEEP_MESSAGE },
    { code: 'display_asleep', error: DISPLAY_ASLEEP_MESSAGE }, { code: 'identity_mismatch', displayState: 'off' }]) {
    const f = fakeTransport(409, json);
    await assert.rejects(f.transport.remoteStream({ address: 'https://100.100.1.1:47832', fingerprint: 'AA'.repeat(32) },
      { certificatePem: 'generated', privateKeyPem: 'generated' }, '/api/sessions/generated/stream', { onData() {} }), error => {
      const asleep = json.code === 'display_asleep' && json.displayState === 'off';
      assert.equal(error.code === 'display_asleep', asleep); assert.equal(error.displayState === 'off', asleep);
      assert.notEqual(error.code, 'identity_mismatch'); return true;
    });
  }
});

for (const [status, code] of [[401, 'access_revoked'], [403, 'permission_changed'], [410, 'session_ended'],
  [429, 'wake_rate_limited'], [409, 'wake_unsupported']])
  test(`F30b late G0 wake ${status}/${code} cannot retire or apply feedback to protected G1 on the same session object`, { timeout: 1000 }, async t => {
    const h = await fixture(t), response = deferred(), entered = deferred(), terminals = [];
    t.after(() => response.resolve({ status: 202, json: { state: 'requested' } }));
    h.controller.videoStreams.onTerminal = (...args) => terminals.push(args);
    h.setWake(() => { entered.resolve(); return response.promise; });
    const pending = h.wake(); pending.catch(() => {}); await entered.promise;
    h.setFrame(call => {
      if (call.pathname.includes('/remote-1/')) throw Object.assign(new Error('Authorized missing session'), { status: 404 });
      return image();
    });
    const fresh = await h.frame();
    assert.equal(h.controller.sessions.get(h.session.sessionId), h.live, 'renewal deliberately retains the same object');
    assert.equal(fresh.sessionGeneration, 1); assert.equal(h.live.remoteId, 'remote-2');
    const epoch = h.live.inputEpoch, geometry = h.live.frameSlots.get('first').frame, permissions = h.live.permissions, calls = h.calls.length;
    response.reject(Object.assign(new Error('Old remote-session reply'), { status, code, ...(status === 429 ? { retryAfterSeconds: 5 } : {}) }));
    await assert.rejects(pending, error => error.code === 'wake_cancelled' && error.status === undefined);
    assert.equal(h.controller.sessions.get(h.session.sessionId), h.live); assert.equal(h.live.closed, false);
    assert.equal(h.live.sessionGeneration, 1); assert.equal(h.live.remoteId, 'remote-2'); assert.equal(h.live.inputEpoch, epoch);
    assert.equal(h.live.frameSlots.get('first').frame, geometry); assert.equal(h.live.permissions, permissions);
    assert.equal(h.live.canWakeDisplay, true); assert.equal(h.controller.endedSessions.has(h.session.sessionId), false);
    assert.deepEqual(terminals, []); assert.equal(h.calls.length, calls, 'a late error triggers no cleanup, renewal or automatic request');
    assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 0);
    assert.equal(h.sessionPosts().length, 1); assert.equal(h.sessionPosts()[0].request.body.resumeEpoch, 'generated-epoch');
    assert.equal(h.wakeCalls().length, 1); assert.equal((await h.frame()).sessionGeneration, 1);
  });

for (const code of ['pin_mismatch', 'identity_mismatch'])
  test(`F30b late local identity ${code} keeps quarantine precedence after a protected same-object renewal`, { timeout: 1000 }, async t => {
    const h = await fixture(t), response = deferred(), entered = deferred();
    t.after(() => response.resolve({ status: 202, json: { state: 'requested' } }));
    h.setWake(() => { entered.resolve(); return response.promise; });
    const pending = h.wake(); pending.catch(() => {}); await entered.promise;
    h.setFrame(call => {
      if (call.pathname.includes('/remote-1/')) throw Object.assign(new Error('Authorized missing session'), { status: 404 });
      return image();
    });
    assert.equal((await h.frame()).sessionGeneration, 1); assert.equal(h.controller.sessions.get(h.session.sessionId), h.live);
    // This is the typed local transport failure, not a remote JSON-supplied code.
    response.reject(Object.assign(new Error('Generated TLS comparison failure'), { code }));
    await assert.rejects(pending, error => error.code === code && error.status === undefined
      && error.message === "This device's identity changed. Forget it, then pair again.");
    assert.equal(h.controller.sessions.size, 0); assert.equal(h.live.closed, true); assert.equal(h.live.frame, null);
    assert.equal(h.controller.identityFailures.get(h.device).error.code, code);
    const calls = h.calls.length; await assert.rejects(h.wake(), error => error.status === 410);
    assert.equal(h.calls.length, calls); assert.equal(h.calls.filter(call => call.method === 'DELETE').length, 0);
    assert.equal(h.sessionPosts().length, 1); assert.equal(h.wakeCalls().length, 1);
  });

test('F30b review repeated asleep polls retire input once until a current accepted presentation', async t => {
  const h = await fixture(t); await h.frame(); const before = h.live.inputEpoch;
  h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  const token = h.live.frameSlots.get('first').deliveryToken;
  assert.equal(h.live.inputEpoch, before + 1);
  for (let index = 0; index < 4; index++) await assert.rejects(h.frame(index % 2 ? 'second' : 'first'));
  assert.equal(h.live.inputEpoch, before + 1); assert.notEqual(h.live.frameSlots.get('first').deliveryToken, token);
  assert.deepEqual(h.notifications, [h.session.sessionId]);
  h.setFrame(() => image()); await h.frame();
  h.setFrame(() => ({ status: 304, headers: { etag: '"generated"' } })); await h.frame();
  await h.wake();
  h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  assert.equal(h.live.inputEpoch, before + 1, 'GET200,304 and Wake202 are not accepted draw receipts');
  assert.equal(h.controller.noteDisplayPresented(h.session.sessionId, 1), false, 'old or future generation cannot reset');
  assert.equal(h.controller.noteDisplayPresented('other-session', 0), false);
  assert.equal(h.controller.noteDisplayPresented(h.session.sessionId, 0), true);
  assert.equal(h.controller.noteDisplayPresented(h.session.sessionId, 0), false, 'one accepted transition');
  await assert.rejects(h.frame()); assert.equal(h.live.inputEpoch, before + 2);
  assert.deepEqual(h.notifications, [h.session.sessionId, h.session.sessionId]);
});

test('F30b review generation renewal needs its own sleep retirement and rejects old-generation presentation reset', async t => {
  const h = await fixture(t); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  h.setFrame(call => { if (call.pathname.includes('/remote-1/')) throw Object.assign(new Error('Authorized missing session'), { status: 404 }); return image(); });
  assert.equal((await h.frame()).sessionGeneration, 1); const before = h.live.inputEpoch;
  h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  assert.equal(h.live.inputEpoch, before + 1); assert.equal(h.controller.noteDisplayPresented(h.session.sessionId, 0), false);
  await assert.rejects(h.frame()); assert.equal(h.live.inputEpoch, before + 1);
  assert.equal(h.controller.noteDisplayPresented(h.session.sessionId, 1), true);
  await assert.rejects(h.frame()); assert.equal(h.live.inputEpoch, before + 2);
  assert.equal(h.sessionPosts().length, 1); assert.equal(h.wakeCalls().length, 0);
});

for (const permission of ['viewOnly', 'view', 'control'])
  test('F30b review local wake permission ' + permission + ' is nonterminal without forged HTTP403', async t => {
    const h = await fixture(t); const before = h.live.inputEpoch;
    if (permission === 'viewOnly') h.live.viewOnly = true; else h.live.permissions[permission] = false;
    await assert.rejects(h.wake(), error => error.code === 'wake_not_permitted' && error.status === undefined);
    assert.equal(h.controller.sessions.get(h.session.sessionId), h.live); assert.equal(h.live.closed, false);
    assert.equal(h.live.inputEpoch, before); assert.equal(h.controller.endedSessions.has(h.session.sessionId), false);
    assert.equal(h.wakeCalls().length, 0); assert.equal(h.sessionPosts().length, 0);
  });

test('F30b review deferred local grant loss stays nonterminal and sends no wake request', { timeout: 1000 }, async t => {
  const h = await fixture(t), identity = deferred(), entered = deferred();
  t.after(() => identity.resolve(h.identity));
  h.controller.getIdentity = () => { entered.resolve(); return identity.promise; };
  const pending = h.wake(); pending.catch(() => {}); await entered.promise;
  h.live.permissions.control = false; identity.resolve(h.identity);
  await assert.rejects(pending, error => error.code === 'wake_not_permitted' && error.status === undefined);
  assert.equal(h.live.closed, false); assert.equal(h.controller.sessions.get(h.session.sessionId), h.live);
  assert.equal(h.wakeCalls().length, 0); assert.equal(h.sessionPosts().length, 0);
});

test('F30b review authoritative remote403 stays terminal even when its wire code is wake_not_permitted', async t => {
  const h = await fixture(t); h.setWake(() => { throw Object.assign(new Error('Host denial'), { status: 403, code: 'wake_not_permitted' }); });
  await assert.rejects(h.wake(), error => error.status === 403);
  assert.equal(h.live.closed, true); assert.equal(h.controller.sessions.size, 0);
  assert.equal(h.wakeCalls().length, 1); assert.equal(h.sessionPosts().length, 0);
});

test('F30b review only a delivered pending video AU accepted by main clears the asleep transition', async t => {
  const h = await fixture(t), { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate();
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const frameContext = (sessionId, monitorId) => ({ sessionId, monitorId, generation: h.live.sessionGeneration,
    frame: h.live.frameSlots.get(monitorId)?.frame });
  const presented = vm.runInNewContext('(entry) => {' + callbackBody(source, 'onFramePresented') + '\n}', {
    windowStates: new Map([[1, { current: () => ({ paused: false }) }]]), frameGate: gate, frameContext, controller: h.controller });
  h.controller.videoStreams.onPresented = presented;
  h.controller.noteDisplayAsleep(h.session.sessionId, h.live); const before = h.live.inputEpoch;
  let feed; h.controller.videoStreams.openRemote = async (_device, _identity, _route, options) => {
    feed = options.onData; return { done: new Promise(() => {}), abort() {}, resume() {} };
  };
  const port = new Port(), opened = h.controller.videoStreams.open({ sessionId: h.session.sessionId, monitorId: 'first' }, port, 1);
  const entry = h.controller.videoStreams.entries.get(opened.streamId); entry.ownerCapture = gate.capture(1); await turn();
  const message = data => port.emit('message', { data });
  feed(record(1, config, 0)); message({ type: 'credit', count: 1 });
  message({ type: 'presented', sequence: 99, decodeMs: 1, drawMs: 1 });
  assert.equal(h.live.displayAsleepGeneration, 0, 'config and unrecognized receipt do not count');
  message({ type: 'credit', count: 1 }); feed(record(2, Uint8Array.of(0, 0, 0, 1, 0x65, 1), 1, 1));
  assert.equal(h.live.displayAsleepGeneration, 0, 'AU delivery alone does not count');
  message({ type: 'presented', sequence: 1, decodeMs: 1, drawMs: 1 });
  assert.equal(h.live.displayAsleepGeneration, undefined); assert.equal(gate.allows(1, frameContext(h.session.sessionId, 'first')), true);
  assert.equal(h.controller.noteDisplayAsleep(h.session.sessionId, h.live), true); assert.equal(h.live.inputEpoch, before + 1);
  assert.equal(h.controller.noteDisplayAsleep(h.session.sessionId, h.live), false); assert.equal(h.live.inputEpoch, before + 1);
});

test('F30bRepeat: latched reports rotate pending delivery without repeating the sleep transition', async t => {
  const h = await fixture(t); await h.frame(); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  const before = h.live.inputEpoch;
  h.setFrame(() => image()); await h.frame();
  const slot = h.live.frameSlots.get('first'), geometry = slot.frame, cache = slot.cache;
  let token = slot.deliveryToken;
  for (let index = 0; index < 3; index++) {
    assert.equal(h.controller.noteDisplayAsleep(h.session.sessionId, h.live), false);
    assert.notEqual(slot.deliveryToken, token); token = slot.deliveryToken;
    assert.equal(slot.frame, geometry); assert.equal(slot.cache, cache);
  }
  assert.equal(h.live.inputEpoch, before); assert.deepEqual(h.notifications, [h.session.sessionId]);
  assert.deepEqual(h.pendingNotifications, Array(3).fill(h.session.sessionId));
  assert.equal(h.live.displayAsleepGeneration, 0); assert.equal(h.live.closed, false);
  assert.equal(h.wakeCalls().length, 0); assert.equal(h.sessionPosts().length, 0);
});

test('F30bRepeat: a held image from before repeated sleep cannot publish geometry or restore its token', { timeout: 1000 }, async t => {
  const h = await fixture(t); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  const before = h.live.inputEpoch, held = deferred(), entered = deferred(); t.after(() => held.resolve(image()));
  h.setFrame(call => { if (call.query.get('monitorId') === 'first') { entered.resolve(); return held.promise; } throw asleep(); });
  const pending = h.frame(); pending.catch(() => {}); await entered.promise;
  const oldToken = h.live.frameSlots.get('first').deliveryToken;
  await assert.rejects(h.frame('second'), error => error.code === 'display_asleep');
  held.resolve(image()); await assert.rejects(pending, /fresh screen|changed|reconnected/i);
  assert.notEqual(h.live.frameSlots.get('first').deliveryToken, oldToken); assert.equal(h.live.frameSlots.get('first').frame, null);
  assert.equal(h.live.inputEpoch, before); assert.deepEqual(h.notifications, [h.session.sessionId]);
  assert.deepEqual(h.pendingNotifications, [h.session.sessionId]);
  assert.equal(h.controller.sessions.get(h.session.sessionId), h.live); assert.equal(h.live.closed, false);
  assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

test('F30bRepeatReview: concurrent asleep polls on different slots both retain typed current availability', { timeout: 1000 }, async t => {
  const h = await fixture(t); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  const before = h.live.inputEpoch, first = deferred(), second = deferred(), entered = [deferred(), deferred()];
  t.after(() => { first.resolve(image()); second.resolve(image()); });
  h.setFrame(call => { const index = call.query.get('monitorId') === 'first' ? 0 : 1; entered[index].resolve(); return [first, second][index].promise; });
  const a = h.frame(), b = h.frame('second'), results = Promise.allSettled([a, b]); await Promise.all(entered.map(value => value.promise));
  first.reject(asleep()); await a.catch(() => {}); second.reject(asleep());
  for (const result of await results) {
    assert.equal(result.status, 'rejected'); const error = frameRequestError(result.reason).error;
    assert.equal(error.code, 'display_asleep'); assert.equal(error.status, 409); assert.equal(error.displayState, 'off');
    assert.deepEqual(error.availability, h.controller.availability(h.session.sessionId));
  }
  assert.equal(h.live.inputEpoch, before); assert.deepEqual(h.notifications, [h.session.sessionId]);
  assert.deepEqual(h.pendingNotifications, [h.session.sessionId, h.session.sessionId]);
  assert.equal(h.live.closed, false); assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

test('F30bRepeatReview: a queued different-encoding caller retains the authorized asleep result without a new poll', { timeout: 1000 }, async t => {
  const h = await fixture(t); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  h.live.canJpegFrames = true; const held = deferred(), entered = deferred(); t.after(() => held.resolve(image()));
  h.setFrame(() => { entered.resolve(); return held.promise; });
  const first = h.frame(); await entered.promise;
  const queued = h.controller.invoke('session.frame', { sessionId: h.session.sessionId, monitorId: 'first', format: 'jpeg', quality: 80 });
  const results = Promise.allSettled([first, queued]), beforeCalls = h.calls.length;
  held.reject(asleep());
  for (const result of await results) {
    assert.equal(result.status, 'rejected'); const error = frameRequestError(result.reason).error;
    assert.equal(error.code, 'display_asleep'); assert.deepEqual(error.availability, h.controller.availability(h.session.sessionId));
  }
  assert.equal(h.calls.length, beforeCalls, 'queued encoding does not poll or create a replacement session');
  assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

for (const denial of ['identity', 'ended']) test('F30bRepeatReview: ' + denial + ' denial wins over a rotated asleep token for active and queued callers', { timeout: 1000 }, async t => {
  const h = await fixture(t); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  h.live.canJpegFrames = true; const held = deferred(), entered = deferred(); t.after(() => held.resolve(image()));
  h.setFrame(() => { entered.resolve(); return held.promise; });
  const first = h.frame(); await entered.promise;
  const queued = h.controller.invoke('session.frame', { sessionId: h.session.sessionId, monitorId: 'first', format: 'jpeg', quality: 80 });
  const results = Promise.allSettled([first, queued]); h.controller.noteDisplayAsleep(h.session.sessionId, h.live);
  const error = Object.assign(new Error('Generated local identity comparison failed.'), { code: 'pin_mismatch' });
  let ending;
  if (denial === 'identity') h.controller.retireIdentity(h.device, error);
  else ending = h.controller.invoke('session.end', { sessionId: h.session.sessionId });
  held.reject(asleep());
  for (const result of await results) {
    assert.equal(result.status, 'rejected'); assert.equal(result.reason.availability, undefined);
    if (denial === 'identity') assert.equal(result.reason.code, 'pin_mismatch');
    else { assert.equal(result.reason.code, 'session_ended'); assert.equal(result.reason.status, 410); }
  }
  await ending; assert.equal(h.live.closed, true); assert.equal(h.wakeCalls().length, 0);
});

test('F30bRepeatReview: repeated sleep retires its decoded pending video but preserves unrelated and fresh presentations', { timeout: 1000 }, async t => {
  const h = await fixture(t), { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate();
  const other = await h.controller.invoke('session.start', { deviceId: h.device.id, monitorId: 'first' });
  const otherSession = h.controller.sessions.get(other.sessionId), feeds = new Map(), manager = h.controller.videoStreams;
  const frameContext = (sessionId, monitorId) => { const session = h.controller.sessions.get(sessionId);
    return { sessionId, monitorId, generation: session.sessionGeneration ?? 0, frame: session.frameSlots.get(monitorId)?.frame }; };
  const accepted = vm.runInNewContext('(entry) => {' + callbackBody(fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8'), 'onFramePresented') + '\n}', {
    windowStates: new Map([1, 2].map(owner => [owner, { current: () => ({ paused: false }) }])), frameGate: gate, frameContext, controller: h.controller });
  let presentations = 0; manager.onPresented = entry => { presentations++; accepted(entry); };
  manager.openRemote = async (_device, _identity, route, options) => {
    feeds.set(new URL(route, 'https://fixture.invalid').pathname, options.onData);
    return { done: new Promise(() => {}), abort() {}, resume() {} };
  };
  h.controller.noteDisplayAsleep(h.session.sessionId, h.live); const before = h.live.inputEpoch;
  const open = async (sessionId, session, owner) => {
    const port = new Port(), opened = manager.open({ sessionId, monitorId: 'first' }, port, owner), entry = manager.entries.get(opened.streamId);
    entry.ownerCapture = gate.capture(owner); await turn();
    const feed = feeds.get('/api/sessions/' + session.remoteId + '/stream'), message = data => port.emit('message', { data });
    assert.equal(typeof feed, 'function'); feed(record(1, config, 0)); message({ type: 'credit', count: 1 });
    message({ type: 'credit', count: 1 }); // The config consumed the first credit.
    feed(record(2, Uint8Array.of(0, 0, 0, 1, 0x65, 1), 1, 1));
    assert.equal(entry.pending.size, 1); return { entry, port, message };
  };
  const target = await open(h.session.sessionId, h.live, 1), unrelated = await open(other.sessionId, otherSession, 2);
  const otherCapture = gate.capture(2); assert.equal(h.controller.noteDisplayAsleep(h.session.sessionId, h.live), false);
  assert.equal(target.entry.closed, true, 'repeat must finish its pending video entry'); assert.equal(target.entry.pending.size, 0);
  assert.equal(target.entry.queue.length, 0); assert.equal(target.port.closed, true);
  assert.equal(manager.entries.get(unrelated.entry.id), unrelated.entry); assert.equal(unrelated.port.closed, false);
  assert.equal(unrelated.entry.pending.size, 1); assert.equal(gate.capture(2), otherCapture);
  target.message({ type: 'presented', sequence: 1, decodeMs: 1, drawMs: 1 });
  assert.equal(presentations, 0); assert.equal(h.live.displayAsleepGeneration, 0);
  assert.equal(gate.allows(1, frameContext(h.session.sessionId, 'first')), false); assert.equal(h.live.inputEpoch, before);
  unrelated.message({ type: 'presented', sequence: 1, decodeMs: 1, drawMs: 1 });
  assert.equal(presentations, 1); assert.equal(gate.allows(2, frameContext(other.sessionId, 'first')), true);
  assert.equal(h.live.displayAsleepGeneration, 0);
  const fresh = await open(h.session.sessionId, h.live, 1);
  fresh.message({ type: 'presented', sequence: 1, decodeMs: 1, drawMs: 1 });
  assert.equal(presentations, 2); assert.equal(h.live.displayAsleepGeneration, undefined);
  assert.equal(gate.allows(1, frameContext(h.session.sessionId, 'first')), true); assert.equal(h.live.inputEpoch, before);
  assert.equal(h.wakeCalls().length, 0); assert.equal(h.sessionPosts().length, 1, 'only the explicitly created unrelated fixture session');
});

test('F30bRepeatReview3: late asleep reply after an actual fresh image receipt cannot relatch an awake session', { timeout: 1000 }, async t => {
  const h = await fixture(t), bridge = actualMainBridge(h); await h.frame(); await h.frame('second');
  const held = deferred(), entered = deferred(); t.after(() => held.resolve(image()));
  h.setFrame(call => { if (call.query.get('monitorId') === 'first') { entered.resolve(); return held.promise; } throw asleep(); });
  const late = h.frame(); late.catch(() => {}); await entered.promise;
  await assert.rejects(h.frame('second'), error => error.code === 'display_asleep');
  h.setFrame(() => image());
  const fresh = await bridge.invoke('session.frame', { sessionId: h.session.sessionId, monitorId: 'second' });
  assert.equal(typeof fresh.deliveryId, 'string');
  await bridge.invoke('session.frame.presented', { sessionId: h.session.sessionId, monitorId: 'second', deliveryId: fresh.deliveryId });
  assert.equal(h.live.displayAsleepGeneration, undefined);
  const epoch = h.live.inputEpoch, notes = h.notifications.length, pendingNotes = h.pendingNotifications.length;
  const slot = h.live.frameSlots.get('second'), geometry = slot.frame, cache = slot.cache;
  held.reject(asleep()); await assert.rejects(late, error => error.code !== 'display_asleep' && error.availability === undefined);
  assert.equal(h.live.displayAsleepGeneration, undefined); assert.equal(h.live.inputEpoch, epoch);
  assert.equal(h.notifications.length, notes); assert.equal(h.pendingNotifications.length, pendingNotes);
  assert.equal(slot.frame, geometry); assert.equal(slot.cache, cache);
  assert.equal(bridge.gate.allows(1, bridge.frameContext(h.session.sessionId, 'second')), true);
  assert.equal(h.live.closed, false); assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

for (const kind of ['http', 'record']) test('F30bRepeatReview3: video ' + kind + ' sleep preserves a concurrent image poll typed asleep despite video token replacement', { timeout: 1000 }, async t => {
  const h = await fixture(t); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  const held = deferred(), entered = deferred(); t.after(() => held.resolve(image()));
  h.setFrame(() => { entered.resolve(); return held.promise; });
  const poll = h.frame(); poll.catch(() => {}); await entered.promise;
  const manager = h.controller.videoStreams, epoch = h.live.inputEpoch; let feed;
  manager.openRemote = async (_device, _identity, _route, options) => {
    if (kind === 'http') throw asleep(); feed = options.onData;
    return { done: new Promise(() => {}), abort() {}, resume() {} };
  };
  const port = new Port(); manager.open({ sessionId: h.session.sessionId, monitorId: 'first' }, port, 1); await turn();
  if (kind === 'record') { feed(record(1, config, 0)); feed(record(4, { code: 'display_asleep', error: DISPLAY_ASLEEP_MESSAGE }, 1)); }
  assert.equal(port.closed, true); assert.equal(manager.entries.size, 0); assert.equal(h.live.displayAsleepGeneration, 0);
  held.reject(asleep()); await assert.rejects(poll, error => {
    const mapped = frameRequestError(error).error;
    assert.equal(mapped.code, 'display_asleep'); assert.equal(mapped.status, 409); assert.equal(mapped.displayState, 'off');
    assert.deepEqual(mapped.availability, h.controller.availability(h.session.sessionId)); return true;
  });
  assert.equal(h.live.inputEpoch, epoch); assert.deepEqual(h.notifications, [h.session.sessionId]);
  assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});

for (const order of ['image-then-sleep', 'sleep-then-image']) test('F30bRepeatReview3: actual main same-tick ' + order + ' never issues a post-report stale image receipt', { timeout: 1000 }, async t => {
  const h = await fixture(t), bridge = actualMainBridge(h); h.setFrame(() => { throw asleep(); }); await assert.rejects(h.frame());
  const a = deferred(), b = deferred(), entered = [deferred(), deferred()]; t.after(() => { a.resolve(image()); b.resolve(image()); });
  h.setFrame(call => { const index = call.query.get('monitorId') === 'first' ? 0 : 1; entered[index].resolve(); return [a, b][index].promise; });
  let issued = 0; const issue = bridge.gate.issueFrame.bind(bridge.gate);
  bridge.gate.issueFrame = (...args) => { issued++; return issue(...args); };
  const imageReply = bridge.invoke('session.frame', { sessionId: h.session.sessionId, monitorId: 'first' });
  const sleeping = h.frame('second'); sleeping.catch(() => {}); await Promise.all(entered.map(value => value.promise));
  if (order === 'image-then-sleep') { a.resolve(image()); b.reject(asleep()); } else { b.reject(asleep()); a.resolve(image()); }
  const result = await imageReply; await assert.rejects(sleeping, error => error.code === 'display_asleep');
  let accepted = false;
  if (result.deliveryId) {
    try { await bridge.invoke('session.frame.presented', { sessionId: h.session.sessionId, monitorId: 'first', deliveryId: result.deliveryId }); accepted = true; }
    catch { /* A prior report may already have purged this nonce. */ }
  }
  assert.equal(issued, 0, 'a sleep report cannot be followed by a new pre-report image receipt');
  assert.equal(accepted, false); assert.equal(result.deliveryId, undefined); assert.equal(h.live.displayAsleepGeneration, 0);
  assert.equal(bridge.gate.allows(1, bridge.frameContext(h.session.sessionId, 'first')), false);
  assert.equal(h.live.closed, false); assert.equal(h.sessionPosts().length, 0); assert.equal(h.wakeCalls().length, 0);
});
