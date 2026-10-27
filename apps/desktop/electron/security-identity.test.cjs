'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { OrbitController } = require('./controller.cjs');
const { SECURITY_TERMINAL } = require('./security-terminal.cjs');
const { SessionVideoStreams, streamErrorPolicy, streamOpenError, frameRequestError } = require('./stream-session.cjs');
const { OrbitStreamParser } = require('./stream-parser.cjs');
const { streamFallback, terminalStreamFailure, VideoRetryPolicy } = require('../renderer/src/stream/recovery.ts');
const { HostReturnPolicy } = require('../renderer/src/stream/reconnect-policy.ts');
const message = "This device's identity changed. Forget it, then pair again.";
const turn = () => new Promise(resolve => setImmediate(resolve));
const failure = code => Object.assign(new Error('Synthetic detail that must not replace the pairing instruction.'), { code });

for (const code of ['pin_mismatch', 'identity_mismatch']) {
  test(`remote HTTP identity code ${code} has no local comparison authority`, () => {
    for (const status of [403, 410, 503]) {
      const error = Object.assign(failure(code), { status });
      const policy = streamErrorPolicy(error);
      assert.equal(policy.terminal, status === 403 ? 'permission_changed' : status === 410 ? 'session_ended_by_host' : null);
      assert.equal(policy.retryable, status === 503);
      const wrapped = frameRequestError(error).error;
      assert.notEqual(wrapped.code, code); assert.notEqual(wrapped.message, message);
      assert.equal(terminalStreamFailure({ code, status }), status !== 503);
      assert.notEqual(streamFallback({ code, status }).reason, message);
    }
  });

  test(`identity ${code} survives IPC error wrappers without retry or ordinary reconnect authority`, () => {
    assert.equal(SECURITY_TERMINAL.has(code), true);
    for (const status of [undefined]) {
      const error = failure(code); if (status !== undefined) error.status = status;
      const policy = streamErrorPolicy(error);
      assert.equal(policy.terminal, code); assert.equal(policy.retryable, false);
      for (const endedReason of [undefined, 'Old ordinary host stop explanation.']) {
        for (const wrapped of [streamOpenError(error, endedReason), frameRequestError(error, endedReason, true)]) {
          assert.equal(wrapped.error.code, code); assert.equal(wrapped.error.retryable, false);
          assert.equal(wrapped.error.canReconnect === true, false); assert.equal(wrapped.error.message, message);
          assert.equal(wrapped.error.status, status, 'identity errors cannot invent an HTTP response');
        }
      }
    }
  });

  test(`identity ${code} blocks video backoff and authorized-image host return`, () => {
    const info = streamFallback({ code, retryable: true, reason: 'Misleading retry suggestion.' });
    assert.equal(info.reason, message); assert.equal(info.retryable, false);
    assert.equal(terminalStreamFailure(info), true); assert.equal(new VideoRetryPolicy().failed(info), null);
    for (const source of ['stream', 'image']) {
      const host = new HostReturnPolicy();
      host.failed(streamFallback({ code: 'host_stopping', retryable: true }));
      assert.equal(host.awaitingHost(), true);
      host.failed(info, source); assert.equal(host.hostBack(), false); assert.equal(host.awaitingHost(), false);
    }
  });

  test(`identity ${code} cleanup is final after one DELETE with no restored authority or local fallback`, async () => {
    const controller = new OrbitController({ directory: os.tmpdir() }); let deletes = 0;
    controller.local = async () => { throw new Error('A retired outgoing session must not use local HTTP.'); };
    controller.remote = async () => { throw new Error('A cleanup cannot create authorization.'); };
    controller.sessions.set('closed', { device: {}, remoteId: 'remote', permissions: { view: true, control: true },
      deleteRemote: async () => { deletes++; throw failure(code); } });
    assert.deepEqual(await controller.invoke('session.end', { sessionId: 'closed' }), { ok: true });
    assert.equal(controller.sessions.size, 0); assert.equal(controller.sessionCleanups.size, 0);
    assert.deepEqual(await controller.invoke('session.end', { sessionId: 'closed' }), { ok: true, alreadyEnded: true });
    await assert.rejects(controller.invoke('session.frame', { sessionId: 'closed' }), error => error.status === 410);
    await assert.rejects(controller.invoke('session.input', { sessionId: 'closed', event: { type: 'key', code: 'KeyA', down: true } }), error => error.status === 410);
    await controller.shutdown(); assert.equal(deletes, 1);
  });

  test(`identity ${code} clears an ordinary reconnect target without a new session POST or another attempt`, async () => {
    const controller = new OrbitController({ directory: os.tmpdir() }); let infoCalls = 0;
    const device = { id: 'paired', fingerprint: 'AA'.repeat(32), permissions: { view: true } };
    controller.connections.push(device); controller.endedSessions.set('old', 'Ordinary host stop.');
    controller.reconnectTargets.set('old', { deviceId: device.id, fingerprint: device.fingerprint, monitorId: null, viewOnly: true });
    controller.local = async () => { throw new Error('Reconnect fixture cannot use local HTTP.'); };
    controller.remote = async (_device, route) => {
      assert.equal(route, '/api/info', 'pin verification precedes any new authorization POST'); infoCalls++; throw failure(code);
    };
    await assert.rejects(controller.invoke('session.reconnect', { sessionId: 'old' }), error => error.code === code);
    assert.equal(controller.canReconnect('old'), false); assert.equal(controller.reconnectTargets.size, 0);
    assert.equal(controller.reconnectPending.size, 0); assert.equal(controller.sessions.size, 0);
    await assert.rejects(controller.invoke('session.reconnect', { sessionId: 'old' }), /unavailable/);
    assert.equal(infoCalls, 1);
  });
}

test('identity-like message text alone never becomes an authoritative terminal code', () => {
  const error = new Error('pin_mismatch: This device identity changed. Pair again.');
  assert.equal(streamErrorPolicy(error).terminal, null);
  assert.equal(terminalStreamFailure(streamFallback(error)), false);
  assert.equal(frameRequestError(error).error.code, 'stream_unavailable');
  for (const status of [401, 403, 410]) {
    const policy = streamErrorPolicy(Object.assign(new Error('Generated old-server denial.'), { status }));
    assert.equal(policy.retryable, false); assert.ok(policy.terminal, 'old untyped denial statuses stay terminal');
  }
  assert.equal(new VideoRetryPolicy().failed(streamFallback({ code: 'stream_unavailable', status: 503, retryable: true })), 1000);
});

class Port extends EventEmitter {
  messages = []; closed = false;
  postMessage(value) { if (this.closed) throw new Error('Closed fixture port.'); this.messages.push(value); }
  start() {}
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  receive(data) { this.emit('message', { data }); }
}

// In-memory stream/controller doubles only. This fixture never injects OS input.
function streams(t, code, phase) {
  const session = { device: {}, remoteId: 'remote', permissions: { view: true, control: true }, monitorId: 'one',
    monitors: [{ id: 'one', primary: true }, { id: 'two' }], frameSlots: new Map(), inputEpoch: 3 };
  const other = { remoteId: 'unrelated', permissions: { view: true } }, calls = [], connections = [], ended = [];
  const controller = { sessions: new Map([['local', session], ['other', other]]), endedSessions: new Map(),
    reconnectTargets: new Map([['local', {}]]), cancellations: [],
    getSession({ sessionId }) { return this.sessions.get(sessionId); }, async getIdentity() { return {}; },
    cancelReconnect(id) { this.cancellations.push(id); }, canReconnect() { return true; },
    async remote(_device, route) { calls.push(route); if (phase === 'control') throw failure(code); return {}; } };
  const manager = new SessionVideoStreams(controller, { onTerminal: (...args) => ended.push(args), remoteStream: async (_device, _identity, _route, options) => {
    if (phase === 'open') throw failure(code);
    let reject;
    const done = new Promise((_resolve, fail) => { reject = fail; }); done.catch(() => {});
    const connection = { done, options, fail: reject, abort() { reject(new Error('Fixture abort.')); }, resume() {} };
    connections.push(connection); return connection;
  } });
  t.after(() => manager.shutdown());
  const ports = [new Port(), new Port()];
  const opened = [manager.open({ sessionId: 'local', monitorId: 'one' }, ports[0], 1),
    manager.open({ sessionId: 'local', monitorId: 'two' }, ports[1], 2)];
  session.frame = { width: 1920, height: 1080, left: -1920, top: 0 };
  for (const id of ['one', 'two']) Object.assign(session.frameSlots.get(id), { frame: session.frame, cache: { bytes: Buffer.alloc(10) } });
  return { session, other, controller, manager, ports, opened, calls, connections, ended };
}

for (const code of ['pin_mismatch', 'identity_mismatch']) for (const phase of ['open', 'control', 'done'])
  test(`identity ${code} during stream ${phase} retires sibling delivery and rejects late callbacks`, async t => {
    const f = streams(t, code, phase); await turn();
    const entry = f.manager.entries.get(f.opened[0].streamId);
    if (phase === 'control') { entry.keyframe = true; await f.manager.control(entry); }
    if (phase === 'done') f.connections[0].fail(failure(code));
    await turn();
    assert.equal(f.controller.sessions.has('local'), false); assert.equal(f.session.closed, true);
    assert.equal(f.controller.sessions.get('other'), f.other); assert.equal(f.session.inputEpoch, 4);
    assert.equal(f.session.frame, null);
    assert.ok([...f.session.frameSlots.values()].every(slot => slot.frame === null && slot.cache === null));
    assert.equal(f.controller.reconnectTargets.size, 0); assert.deepEqual(f.controller.cancellations, ['local']);
    assert.deepEqual(f.ended, [['local', message]]); assert.equal(f.manager.entries.size, 0);
    for (const port of f.ports) {
      assert.equal(port.closed, true);
      const status = port.messages.at(-1);
      assert.equal(status.state, 'ended'); assert.equal(status.code, code); assert.equal(status.error, message);
      assert.equal(status.retryable, false); assert.equal(status.canReconnect, false);
      const count = port.messages.length; port.receive({ type: 'keyframe' });
      assert.equal(port.messages.length, count);
    }
    for (const connection of f.connections) assert.equal(connection.options.onData(Buffer.alloc(0)), false);
    if (entry) await f.manager.control(entry);
    assert.equal(f.calls.length, phase === 'control' ? 1 : 0, 'no control request follows the terminal');
  });

for (const code of ['pin_mismatch', 'identity_mismatch']) {
  test(`remote terminal sink cannot forge local identity code ${code}`, async t => {
    const f = streams(t, code, 'record'); await turn();
    const entry = f.manager.entries.get(f.opened[0].streamId);
    f.manager.record(entry, { type: 'terminal', code, error: 'Generated remote terminal.' });
    assert.equal(f.controller.sessions.get('local'), f.session); assert.notEqual(f.session.closed, true);
    assert.equal(f.controller.reconnectTargets.has('local'), true); assert.equal(f.ended.length, 0);
    assert.equal(f.manager.entries.size, 1, 'only the reporting stream ends');
    const status = f.ports[0].messages.at(-1);
    assert.equal(status.state, 'fallback'); assert.equal(status.code, 'stream_error'); assert.equal(status.retryable, true);
    assert.equal(f.ports[1].closed, false);
  });

  // The parser allowlist predates S8 review2. Keep this baseline guard distinct
  // from the new direct-sink and HTTP JSON regressions.
  test(`existing wire parser guard rejects reserved identity code ${code}`, () => {
    const records = [], parser = new OrbitStreamParser({ monitorId: 'screen', onRecord: value => records.push(value) });
    const encode = (type, value, sequence) => {
      const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(24);
      header[0] = type; header.writeUInt32LE(body.length, 4); header.writeUInt32LE(sequence, 8);
      return Buffer.concat([header, body]);
    };
    parser.push(encode(1, { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
      physicalLeft: 0, physicalTop: 0, physicalWidth: 1920, physicalHeight: 1080, scale: 1, fps: 60, monitorId: 'screen' }, 0));
    parser.push(encode(4, { code, error: 'Generated remote terminal.' }, 1));
    assert.equal(records.at(-1).type, 'terminal'); assert.equal(records.at(-1).code, 'stream_error');
  });
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const screen = { id: 'screen', primary: true, width: 1920, height: 1080, left: -1920, top: 0 };
const image = () => ({ headers: { 'x-orbit-width': '1920', 'x-orbit-height': '1080', 'x-orbit-left': '-1920', 'x-orbit-top': '0' }, buffer: Buffer.from('generated-image') });
async function authority(t, intercept = () => undefined) {
  const calls = [], client = { certificatePem: 'generated-client', privateKeyPem: 'generated-key' };
  const permissions = { view: true, control: true, files: true, clipboard: true, power: true };
  const devices = [{ id: 'a', fingerprint: 'AA'.repeat(32) }, { id: 'b', fingerprint: 'BB'.repeat(32) }]
    .map(device => ({ ...device, address: 'https://100.100.1.1:47832', permissions }));
  let sequence = 0;
  const controller = new OrbitController({ directory: os.tmpdir(), remoteRequest: async (target, identity, route, options = {}) => {
    const call = { target, identity, route, method: options.method || 'GET', body: options.body }; calls.push(call);
    const value = await intercept(call); if (value !== undefined) return value;
    if (route === '/api/info') return { json: { platform: { monitors: [screen] } } };
    if (route === '/api/sessions' && call.method === 'POST') return { json: { id: 'remote-' + ++sequence, permissions, resumeEpoch: 'generated-resume' } };
    if (route.includes('/frame')) return image();
    if (call.method === 'DELETE' || route.endsWith('/input') || route.endsWith('/release-inputs')) return {};
    throw new Error('Unexpected generated route: ' + route);
  } });
  controller.connections.push(...devices); controller.getIdentity = async () => client; controller.save = async () => {};
  controller.local = async () => { throw new Error('The authority fixture cannot use local HTTP.'); };
  t.after(() => controller.shutdown());
  const a = await controller.invoke('session.start', { deviceId: 'a' });
  const b = await controller.invoke('session.start', { deviceId: 'b' });
  return { controller, devices, client, calls, a, b };
}

for (const code of ['pin_mismatch', 'identity_mismatch'])
  test(`controller identity ${code} retires frame and queued input authority while other devices remain live`, async t => {
    const entered = deferred(), heldInput = deferred(); let armed = false;
    const h = await authority(t, call => {
      if (call.target.fingerprint !== 'AA'.repeat(32)) return;
      if (armed && call.route.endsWith('/input')) { entered.resolve(); return heldInput.promise; }
      if (armed && call.route.includes('/frame')) throw failure(code);
    });
    await h.controller.invoke('session.frame', h.a); await h.controller.invoke('session.frame', h.b);
    const retired = h.controller.sessions.get(h.a.sessionId), other = h.controller.sessions.get(h.b.sessionId);
    const reconnect = { cancelled: false, deviceId: 'a' }; h.controller.reconnectPending.set(h.a.sessionId, reconnect);
    h.controller.reconnectTargets.set(h.a.sessionId, { deviceId: 'a', fingerprint: h.devices[0].fingerprint });
    h.controller.reconnectTargets.set('other-hint', { deviceId: 'b', fingerprint: h.devices[1].fingerprint });
    armed = true;
    const first = h.controller.invoke('session.input', { ...h.a, event: { type: 'key', code: 'KeyA', down: true } }).catch(error => error);
    await entered.promise;
    const queued = h.controller.invoke('session.input', { ...h.a, event: { type: 'key', code: 'KeyB', down: true } });
    const frame = h.controller.invoke('session.frame', h.a).catch(error => error);
    await turn(); heldInput.resolve({});
    const [frameError, inputError] = await Promise.all([frame, first]); await queued;
    assert.equal(frameError.code, code); assert.equal(frameError.message, message); assert.equal(inputError.code, code);
    assert.equal(h.controller.sessions.has(h.a.sessionId), false); assert.equal(retired.closed, true);
    assert.equal(retired.frame, null); assert.ok([...retired.frameSlots.values()].every(slot => slot.frame === null && slot.cache === null));
    assert.equal(reconnect.cancelled, true); assert.equal(h.controller.reconnectTargets.has('other-hint'), true);
    assert.equal(h.controller.sessions.get(h.b.sessionId), other);
    assert.equal(h.calls.filter(call => call.route.endsWith('/input')).length, 1);
    const count = h.calls.length;
    await assert.rejects(h.controller.remote(h.devices[0], '/api/info'), error => error.code === code);
    await assert.rejects(h.controller.invoke('session.start', { deviceId: 'a' }), error => error.code === code);
    assert.equal(h.calls.length, count, 'a terminal saved pin cannot retry TLS or authorize a new session');
    assert.equal((await h.controller.invoke('session.frame', h.b)).width, 1920);
  });

for (const phase of ['info', 'create']) test(`controller identity retirement discards a direct session start deferred at ${phase}`, async t => {
  const entered = deferred(), gate = deferred(); let armed = false;
  const h = await authority(t, call => {
    if (call.target.fingerprint !== 'AA'.repeat(32)) return;
    if (call.route === '/api/info?retire') throw failure('pin_mismatch');
    if (armed && ((phase === 'info' && call.route === '/api/info') || (phase === 'create' && call.route === '/api/sessions'))) {
      entered.resolve(); return gate.promise;
    }
    if (call.method === 'DELETE' && call.route.endsWith('/late-direct')) throw Object.assign(new Error('Generated final disposal failure.'), { status: 503 });
  });
  armed = true;
  const pending = h.controller.invoke('session.start', { deviceId: 'a' }).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await assert.rejects(h.controller.remote(h.devices[0], '/api/info?retire'), error => error.code === 'pin_mismatch');
  gate.resolve(phase === 'info' ? { json: { platform: { monitors: [screen] } } } : { json: { id: 'late-direct' } });
  const result = await pending;
  assert.equal(result.error?.code, 'pin_mismatch');
  assert.ok([...h.controller.sessions.values()].every(s => s.device !== h.devices[0]));
  assert.equal(h.controller.sessions.has(h.b.sessionId), true);
  const lateDeletes = () => h.calls.filter(call => call.method === 'DELETE' && call.route.endsWith('/late-direct'));
  assert.equal(lateDeletes().length, 0, 'a failed saved pin cannot send even a cancelled-creation DELETE');
  for (const call of lateDeletes()) { assert.equal(call.identity, h.client); assert.equal(call.target.fingerprint, h.devices[0].fingerprint); }
  assert.equal(h.controller.sessionCleanups?.size || 0, 0);
  await h.controller.shutdown(); assert.equal(lateDeletes().length, 0, 'pin-terminal disposal never gains a shutdown retry');
});

test('controller identity retirement discards a late protected renewal before changing the retired remote ID', async t => {
  const entered = deferred(), gate = deferred(); let armed = false;
  const h = await authority(t, call => {
    if (call.target.fingerprint !== 'AA'.repeat(32)) return;
    if (call.route === '/api/info?retire') throw failure('pin_mismatch');
    if (armed && call.route.includes('/frame')) throw Object.assign(new Error('Generated expired session.'), { status: 404 });
    if (armed && call.route === '/api/sessions') { entered.resolve(); return gate.promise; }
    if (call.method === 'DELETE' && call.route.endsWith('/late-renewal')) throw Object.assign(new Error('Generated final disposal failure.'), { status: 503 });
  });
  const retired = h.controller.sessions.get(h.a.sessionId), remoteId = retired.remoteId;
  armed = true;
  const pending = h.controller.invoke('session.frame', h.a).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await assert.rejects(h.controller.remote(h.devices[0], '/api/info?retire'), error => error.code === 'pin_mismatch');
  gate.resolve({ json: { id: 'late-renewal', permissions: { view: true }, resumeEpoch: 'late-epoch' } });
  assert.equal((await pending).error?.code, 'pin_mismatch');
  assert.equal(retired.remoteId, remoteId); assert.equal(retired.sessionGeneration, 0);
  assert.equal(h.controller.sessions.has(h.a.sessionId), false); assert.equal(h.controller.sessions.has(h.b.sessionId), true);
  const deletes = () => h.calls.filter(call => call.method === 'DELETE' && call.route.endsWith('/late-renewal')).length;
  assert.equal(deletes(), 0); assert.equal(h.controller.sessionCleanups.size, 0);
  await h.controller.shutdown(); assert.equal(deletes(), 0);
});

test('controller identity retirement rejects late file metadata before it can update the retired session', async t => {
  const entered = deferred(), gate = deferred();
  const h = await authority(t, call => {
    if (call.route === '/api/info?retire') throw failure('pin_mismatch');
    if (call.route.endsWith('/files')) { entered.resolve(); return gate.promise; }
  });
  const session = h.controller.sessions.get(h.a.sessionId);
  const pending = h.controller.invoke('files.list', h.a).then(value => ({ value }), error => ({ error }));
  await entered.promise;
  await assert.rejects(h.controller.remote(h.devices[0], '/api/info?retire'), error => error.code === 'pin_mismatch');
  gate.resolve({ json: { entries: [{ name: 'generated-file', size: 100 }] } });
  assert.equal((await pending).error?.code, 'pin_mismatch'); assert.equal(session.fileSizes, undefined);
  assert.equal(h.controller.sessions.has(h.b.sessionId), true);
});

for (const code of ['pin_mismatch', 'identity_mismatch']) test(`controller identity ${code} from a stream open shares the final request boundary`, async t => {
  const h = await authority(t);
  h.controller.videoStreams.openRemote = async () => { throw failure(code); };
  const port = new Port(), opened = h.controller.videoStreams.open({ ...h.a, monitorId: 'screen' }, port, 1);
  await turn();
  assert.equal(h.controller.videoStreams.entries.has(opened.streamId), false);
  assert.equal(port.messages.at(-1).code, code); assert.equal(port.messages.at(-1).error, message);
  const count = h.calls.length;
  await assert.rejects(h.controller.invoke('session.start', { deviceId: 'a' }), error => error.code === code);
  assert.equal(h.calls.length, count); assert.equal(h.controller.sessions.has(h.b.sessionId), true);
});

test('controller identity failure is bound to the saved object and pin, so a later re-pair is not poisoned by an old callback', async t => {
  const h = await authority(t);
  const old = h.devices[0];
  h.controller.retireIdentity(old, failure('pin_mismatch'));
  const fresh = { ...old }; h.controller.connections[0] = fresh;
  const started = await h.controller.invoke('session.start', { deviceId: fresh.id });
  const current = h.controller.sessions.get(started.sessionId);
  h.controller.retireIdentity(old, failure('pin_mismatch'));
  assert.equal(h.controller.sessions.get(started.sessionId), current);
  assert.equal((await h.controller.invoke('session.frame', started)).width, 1920);
  assert.equal(h.controller.sessions.has(h.b.sessionId), true);
  const count = h.calls.length;
  await assert.rejects(h.controller.remote(old, '/api/info'), error => error.code === 'pin_mismatch');
  assert.equal(h.calls.length, count);
});

for (const code of ['pin_mismatch', 'identity_mismatch']) for (const status of [403, 503])
  test(`remote HTTP ${status} code ${code} cannot quarantine a saved device`, async t => {
    const h = await authority(t);
    const active = h.controller.sessions.get(h.a.sessionId);
    h.controller.videoStreams.openRemote = async () => { throw Object.assign(failure(code), { status }); };
    const port = new Port(), opened = h.controller.videoStreams.open({ ...h.a, monitorId: 'screen' }, port, 1);
    await turn();
    assert.equal(h.controller.videoStreams.entries.has(opened.streamId), false);
    assert.equal(h.controller.identityFailures.has(h.devices[0]), false);
    assert.equal(port.messages.at(-1).code, status === 403 ? 'permission_changed' : 'stream_unavailable');
    if (status === 503) assert.equal(h.controller.sessions.get(h.a.sessionId), active);
    const before = h.calls.length;
    const explicit = await h.controller.invoke('session.start', { deviceId: 'a' });
    assert.ok(h.controller.sessions.has(explicit.sessionId)); assert.equal(h.calls.length, before + 2);
  });

for (const code of ['pin_mismatch', 'identity_mismatch'])
  test(`cleanup drained before ${code} drops its original binding with zero further remote requests`, async t => {
    let armed = false;
    const h = await authority(t, call => {
      if (!armed || call.target.fingerprint !== 'AA'.repeat(32)) return;
      if (call.method === 'DELETE') throw Object.assign(new Error('Generated unavailable cleanup.'), { status: 503 });
      if (call.route === '/api/info?retire') throw failure(code);
    });
    armed = true;
    await assert.rejects(h.controller.invoke('session.end', h.a), error => error.status === 503);
    const cleanup = h.controller.sessionCleanups.get(h.a.sessionId);
    assert.equal(cleanup.session, null); assert.equal(cleanup.device, null); assert.equal(typeof cleanup.deleteRemote, 'function');
    assert.equal(cleanup.deviceRef, h.devices[0]); assert.equal(cleanup.pin, h.devices[0].fingerprint);
    await assert.rejects(h.controller.remote(h.devices[0], '/api/info?retire'), error => error.code === code);
    assert.equal(h.controller.sessionCleanups.size, 0);
    for (const key of ['deviceRef', 'pin', 'deleteRemote', 'session', 'device']) assert.equal(cleanup[key], null, key);
    const count = () => h.calls.filter(call => call.target.fingerprint === h.devices[0].fingerprint).length;
    const before = count();
    assert.deepEqual(await h.controller.invoke('session.end', h.a), { ok: true, alreadyEnded: true });
    await h.controller.shutdown();
    assert.equal(count(), before, 'retry and shutdown cannot open TLS under the failed saved pin');
  });

test('cleanup waiting on an in-flight input cannot bind a DELETE after saved-pin retirement', async t => {
  const h = await authority(t), drain = deferred();
  const session = h.controller.sessions.get(h.a.sessionId); session.inputQueue = drain.promise;
  const pending = h.controller.invoke('session.end', h.a), cleanup = h.controller.sessionCleanups.get(h.a.sessionId);
  assert.equal(cleanup.session, session);
  h.controller.retireIdentity(h.devices[0], failure('pin_mismatch'));
  const before = h.calls.length; drain.resolve(); await pending;
  assert.equal(h.calls.length, before); assert.equal(h.controller.sessionCleanups.size, 0);
  assert.equal(cleanup.session, null); assert.equal(cleanup.deleteRemote, null); assert.equal(cleanup.deviceRef, null);
});

test('a cancelled-created cleanup is dropped before using a failed saved-pin binding', async t => {
  const h = await authority(t); let deletes = 0;
  h.controller.retireIdentity(h.devices[0], failure('pin_mismatch'));
  await h.controller.cleanupCreated(h.devices[0], 'cancelled-created', async () => { deletes++; });
  assert.equal(deletes, 0); assert.equal(h.controller.sessionCleanups.size, 0);
  await h.controller.shutdown(); assert.equal(deletes, 0);
});

test('a pin failure detected by the original cleanup binding also retires the saved pin', async t => {
  let armed = false;
  const h = await authority(t, call => {
    if (armed && call.method === 'DELETE' && call.target.fingerprint === 'AA'.repeat(32)) throw failure('pin_mismatch');
  });
  armed = true;
  await h.controller.invoke('session.end', h.a);
  assert.equal(h.controller.identityFailures.get(h.devices[0]).error.code, 'pin_mismatch');
  const count = () => h.calls.filter(call => call.target.fingerprint === h.devices[0].fingerprint).length;
  const before = count();
  await assert.rejects(h.controller.invoke('session.start', { deviceId: 'a' }), error => error.code === 'pin_mismatch');
  await h.controller.shutdown(); assert.equal(count(), before);
});

test('a remote HTTP identity code on cleanup stays retryable until a successful DELETE', async t => {
  let tries = 0;
  const h = await authority(t, call => {
    if (call.method === 'DELETE' && call.target.fingerprint === 'AA'.repeat(32) && ++tries === 1)
      throw Object.assign(failure('pin_mismatch'), { status: 503 });
  });
  await assert.rejects(h.controller.invoke('session.end', h.a), error => error.status === 503);
  assert.equal(h.controller.sessionCleanups.size, 1); assert.equal(h.controller.identityFailures.has(h.devices[0]), false);
  await h.controller.invoke('session.end', h.a);
  assert.equal(tries, 2); assert.equal(h.controller.sessionCleanups.size, 0);
});

test('cleanup preserves the original POST pin when its saved object later changes pin', async t => {
  let armed = false;
  const h = await authority(t, call => {
    if (armed && call.method === 'DELETE') throw Object.assign(new Error('Generated unavailable cleanup.'), { status: 503 });
  });
  const oldPin = h.devices[0].fingerprint; h.devices[0].fingerprint = 'CC'.repeat(32); armed = true;
  await assert.rejects(h.controller.invoke('session.end', h.a), error => error.status === 503);
  const cleanup = h.controller.sessionCleanups.get(h.a.sessionId);
  assert.equal(cleanup.pin, oldPin); assert.equal(cleanup.deviceRef, h.devices[0]);
  h.controller.retireIdentity(h.devices[0], failure('pin_mismatch'), oldPin);
  assert.equal(h.controller.sessionCleanups.size, 0); assert.equal(cleanup.deleteRemote, null);
  assert.equal(h.controller.identityFailures.has(h.devices[0]), false, 'old-pin failure cannot poison the new pin');
});

test('cleanup disposed while identity is loading cannot start a fallback DELETE', async t => {
  const h = await authority(t), entered = deferred(), gate = deferred();
  h.controller.sessions.get(h.a.sessionId).deleteRemote = null;
  h.controller.getIdentity = async () => { entered.resolve(); return gate.promise; };
  const pending = h.controller.invoke('session.end', h.a); await entered.promise;
  h.controller.retireIdentity(h.devices[0], failure('pin_mismatch'));
  const before = h.calls.length; gate.resolve(h.client); await pending;
  assert.equal(h.calls.length, before); assert.equal(h.controller.sessionCleanups.size, 0);
});

for (const code of ['pin_mismatch', 'identity_mismatch'])
  test(`remote HTTP identity code ${code} preserves transient reconnect hints while 403 stays final`, async t => {
    let status;
    const h = await authority(t, call => {
      if (status && call.route === '/api/info') throw Object.assign(failure(code), { status });
    });
    for (const denial of [503, 403]) {
      const id = 'ended-' + denial;
      h.controller.endedSessions.set(id, 'Generated ordinary host stop.');
      h.controller.reconnectTargets.set(id, { deviceId: 'a', fingerprint: h.devices[0].fingerprint, monitorId: null });
      status = denial;
      await assert.rejects(h.controller.invoke('session.reconnect', { sessionId: id }), error => error.status === denial);
      assert.equal(h.controller.canReconnect(id), denial === 503);
      assert.equal(h.controller.identityFailures.has(h.devices[0]), false);
    }
  });
