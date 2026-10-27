'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');
const { frameRequestError, streamOpenError, wakeDisplayError, sessionAvailability } = require('./stream-session.cjs');
const { NativeWindowVisibility, OwnerFrameGate } = require('./viewer-visibility.cjs');
const { EventEmitter } = require('node:events');
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const plain = value => JSON.parse(JSON.stringify(value));
const callbackBody = (source, name, parameter = 'entry') => {
  const match = source.match(new RegExp(name + ':\\s*' + parameter + '\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\},'));
  assert.ok(match, 'actual main callback ' + name); return match[1];
};

// Run the actual privileged registration body, without starting Electron, a
// host, network, clipboard or OS input. The bridge remains the code under test.
function fixture(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('orbit:invoke',"), end = source.indexOf('\n  });', start);
  assert.ok(start > 0 && end > start);
  const viewers = source.match(/const viewerActions = new Set\([\s\S]*?\);/)[0];
  const frame = { url: 'file:///generated/main.html' }, popFrame = { url: 'file:///generated/main.html?viewer=1' };
  const owner = { id: 1, mainFrame: frame, isDestroyed: () => false }, popout = { id: 2, mainFrame: popFrame, isDestroyed: () => false };
  const sessionId = 'local-session', session = { remoteId: 'private-remote-session', resumeEpoch: 'private-host-epoch', device: { id: 'paired', name: 'Generated computer' },
    sessionGeneration: 3, canWakeDisplay: true, permissions: { view: true, control: true }, viewOnly: false, frameSlots: new Map(), closed: false };
  const calls = [], wire = [], presentations = [], mainWindow = { webContents: owner, isDestroyed: () => false };
  const controller = { sessions: new Map([[sessionId, session]]), endedSessions: new Map(), canReconnect: () => false,
    getSession(payload) { const current = this.sessions.get(payload.sessionId); assert.ok(current, 'known generated session'); return current; }, availability: id => sessionAvailability(id, session),
    noteDisplayPresented(id, generation) { presentations.push({ id, generation }); },
    async invoke(action, payload, assertCurrent) {
      calls.push({ action, payload });
      if (options.beforeWire) await options.beforeWire;
      assertCurrent?.();
      if (options.error) throw options.error;
      wire.push({ action, payload }); return options.result || { state: 'requested' };
    } };
  const viewer = { sessionId, monitorId: 'first', presentation: { device: { id: 'paired' } }, window: { isDestroyed: () => false, close() {} } };
  const viewerWindows = new Map([[2, viewer]]), states = new Map([[1, { paused: false }], [2, { paused: false }]]);
  const windowStates = new Map([...states].map(([id]) => [id, { current: () => states.get(id) }]));
  const frameGate = new OwnerFrameGate();
  const context = { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE, frameRequestError, streamOpenError, wakeDisplayError,
    controller, mainWindow, viewerWindows, windowStates, frameGate, windowInputs: new Map(), windowReconnects: new Map(),
    frameContext: (id, monitorId) => { const current = controller.getSession({ sessionId: id });
      return { sessionId: id, monitorId, generation: current.sessionGeneration, frame: current.frameSlots.get(monitorId)?.frame }; },
    pageUrl: viewer => viewer ? popFrame.url : frame.url, ipcMain: { handle: (_name, handler) => { context.handler = handler; } } };
  vm.runInNewContext(viewers + '\n' + source.slice(start, end + '\n  });'.length), context);
  const invoke = (action = 'session.wake-display', args = {}) => context.handler({ sender: args.sender || (args.popup ? popout : owner),
    senderFrame: args.senderFrame || (args.popup ? popFrame : frame) }, action, args.payload || { sessionId });
  return { invoke, owner, popout, frame, popFrame, session, sessionId, viewer, viewerWindows, calls, wire, presentations, states, frameGate, source, context };
}

test('F30b actual IPC permits only owner or exact bound viewer fixed wake without ordinary image readiness', async () => {
  const f = fixture();
  assert.deepEqual(plain(await f.invoke()), { state: 'requested' });
  assert.deepEqual(plain(await f.invoke(undefined, { popup: true })), { state: 'requested' });
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.action === 'session.wake-display' && Object.keys(call.payload).join() === 'sessionId'));
  await assert.rejects(f.invoke('session.input', { payload: { sessionId: f.sessionId, monitorId: 'first', event: { type: 'key', code: 'KeyA', down: true } } }), /fresh screen/);
  assert.equal(f.calls.length, 2, 'Wake does not make ordinary input ready');
});

test('F30b actual IPC rejects unrelated viewers, subframes, destroyed callers and unknown windows before wake', async () => {
  const f = fixture();
  await assert.rejects(f.invoke(undefined, { popup: true, payload: { sessionId: 'other-session' } }), /another session/);
  await assert.rejects(f.invoke(undefined, { senderFrame: { url: f.frame.url } }), /Untrusted/);
  await assert.rejects(f.invoke(undefined, { sender: { id: 99, mainFrame: f.frame, isDestroyed: () => false } }), /Untrusted/);
  f.owner.isDestroyed = () => true; await assert.rejects(f.invoke(), /Untrusted/);
  assert.equal(f.calls.length, 0); assert.equal(f.wire.length, 0);
});

for (const extras of [{ event: { type: 'key' } }, { coordinates: [0, 0] }, { body: {} }, { availability: { canWakeDisplay: true } }, { monitorId: 'first' }])
  test('F30b actual IPC rejects renderer wake extras ' + Object.keys(extras).join(), async () => {
    const f = fixture(); const result = await f.invoke(undefined, { payload: { sessionId: f.sessionId, ...extras } });
    assert.equal(result.error.code, 'wake_failed'); assert.equal(f.calls.length, 0); assert.equal(f.wire.length, 0);
  });

for (const reason of ['hidden', 'minimized']) test('F30b native ' + reason + ' window cannot wake or claim renderer visibility', async () => {
  const f = fixture(); f.states.set(1, { paused: true, reason });
  assert.equal((await f.invoke()).error.code, 'wake_cancelled'); assert.equal(f.calls.length, 0);
});

for (const change of ['pause', 'navigation', 'destroyed', 'owner-capture', 'viewer-binding'])
  test('F30b actual IPC deferred ' + change + ' cancels wake before the privileged operation', { timeout: 1000 }, async () => {
    const beforeWire = deferred(), f = fixture({ beforeWire: beforeWire.promise }), popup = change === 'viewer-binding';
    const result = f.invoke(undefined, { popup });
    assert.equal(f.calls.length, 1);
    if (change === 'pause') f.states.set(1, { paused: true, reason: 'minimized' });
    if (change === 'navigation') f.owner.mainFrame = { url: f.frame.url };
    if (change === 'destroyed') f.owner.isDestroyed = () => true;
    if (change === 'owner-capture') f.frameGate.invalidate(1);
    if (change === 'viewer-binding') f.viewer.sessionId = 'successor-session';
    beforeWire.resolve(); const value = await result;
    assert.equal(value.error.code, 'wake_cancelled'); assert.equal(f.wire.length, 0);
  });

test('F30b live viewer.context carries current exact availability without remote authority secrets', async () => {
  const f = fixture(); const first = await f.invoke('viewer.context', { popup: true });
  assert.deepEqual(plain(first.session.availability), { sessionId: f.sessionId, sessionGeneration: 3, canWakeDisplay: true, controlGranted: true, viewOnly: false });
  f.session.sessionGeneration = 4; f.session.canWakeDisplay = false; f.session.permissions.control = false;
  const fresh = await f.invoke('viewer.context', { popup: true });
  assert.deepEqual(plain(fresh.session.availability), { sessionId: f.sessionId, sessionGeneration: 4, canWakeDisplay: false, controlGranted: false, viewOnly: false });
  assert.equal(JSON.stringify(fresh).includes('private-'), false);
});

test('F30b asleep observer invalidates every attached owner receipt before identical geometry can return', async () => {
  const f = fixture(), gate = f.frameGate;
  f.viewerWindows.set(3, { sessionId: 'other-session' }); f.context.windowStates.set(3, { current: () => ({ paused: false }) });
  const context = { sessionId: f.sessionId, monitorId: 'first', generation: 3, frame: { width: 1920, height: 1080, left: -1920, top: 0 } };
  const unrelated = { ...context, sessionId: 'other-session' };
  f.context.controller.sessions.set(unrelated.sessionId, { ...f.session, frameSlots: new Map([['first', { frame: unrelated.frame }]]) });
  const captures = new Map([1, 2, 3].map(owner => [owner, gate.capture(owner)]));
  const token = gate.issue(1, captures.get(1), context), otherToken = gate.issue(1, captures.get(1), unrelated);
  for (const owner of [1, 2]) assert.equal(gate.presented(owner, captures.get(owner), context), true);
  for (const owner of [1, 3]) assert.equal(gate.presented(owner, captures.get(owner), unrelated), true);
  const observer = vm.runInNewContext('(sessionId) => {' + callbackBody(f.source, 'onDisplayAsleep', 'sessionId') + '\n}', f.context); observer(f.sessionId);
  assert.equal(gate.allows(1, context), false); assert.equal(gate.allows(2, context), false);
  assert.equal(gate.allows(3, unrelated), true); assert.equal(gate.acknowledge(1, token, context), false);
  assert.equal(gate.capture(1), captures.get(1)); assert.equal(gate.allows(1, unrelated), true);
  assert.equal(gate.acknowledge(1, otherToken, unrelated), true);
  vm.runInNewContext('(entry) => {' + callbackBody(f.source, 'onFramePresented', 'entry') + '\n}', f.context)({ owner: 1, ownerCapture: captures.get(1), sessionId: unrelated.sessionId, slotKey: 'first' });
  assert.equal(gate.allows(1, unrelated), true, 'ongoing unrelated A video retains its capture');
  await f.invoke('session.input', { payload: { sessionId: unrelated.sessionId, monitorId: 'first', event: { type: 'key', code: 'KeyA', down: true } } });
  assert.equal(f.wire.filter(call => call.action === 'session.input').length, 1, 'actual main IPC still allows authorized A input');
  await assert.rejects(f.invoke('session.input', { popup: true, payload: { sessionId: f.sessionId, monitorId: 'first', event: { type: 'key', code: 'KeyA', down: true } } }), /fresh screen/);
  const fresh = gate.issue(1, gate.capture(1), context); assert.equal(gate.allows(1, context), false);
  assert.equal(gate.acknowledge(1, fresh, context), true);
});

for (const code of IDENTITY_TERMINAL) test('F30b wake preserves only local statusless ' + code + ' as canonical identity failure', async () => {
  const error = Object.assign(new Error('Private exception details'), { code, address: 'private-address' });
  const result = await fixture({ error }).invoke();
  assert.deepEqual(plain(result), { error: { code, message: IDENTITY_CHANGED_MESSAGE, retryable: false } });
  for (const status of [403, 503]) assert.notEqual(wakeDisplayError(Object.assign(error, { status })).error.code, code);
});

test('F30b wake errors retain typed security precedence and bounded rate feedback without automatic retry', async () => {
  for (const status of [401, 403, 410]) {
    const error = Object.assign(new Error('asleep is not a terminal override'), { status, code: 'display_asleep', displayState: 'off' });
    const result = await fixture({ error }).invoke();
    assert.equal(result.error.status, status); assert.equal(result.error.retryable, false); assert.notEqual(result.error.code, 'display_asleep');
  }
  const rate = await fixture({ error: Object.assign(new Error('Private rate details'), { status: 429, code: 'wake_rate_limited', retryAfterSeconds: 5 }) }).invoke();
  assert.equal(rate.error.code, 'wake_rate_limited'); assert.equal(rate.error.retryAfterSeconds, 5); assert.equal(rate.error.retryable, false);
  assert.equal(wakeDisplayError(Object.assign(new Error('Private details'), { status: 409, code: 'wake_unsupported' })).error.code, 'wake_unsupported');
  assert.equal(JSON.stringify(rate).includes('Private'), false);
});

test('F30b preload exposes only the fixed wake action through the existing bridge', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), calls = []; let bridge;
  vm.runInNewContext(source, { window: { postMessage() {} }, require(name) {
    assert.equal(name, 'electron'); return { contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
      ipcRenderer: { on() {}, invoke(...args) { calls.push(args); return Promise.resolve({ state: 'requested' }); } } };
  } });
  await bridge.invoke('session.wake-display', { sessionId: 'local-session' });
  assert.deepEqual(plain(calls), [['orbit:invoke', 'session.wake-display', { sessionId: 'local-session' }]]);
  await assert.rejects(bridge.invoke('session.send-input-command', {}), /Unknown/); assert.equal(calls.length, 1);
});

function asleepObserver(f) {
  return vm.runInNewContext('(sessionId) => {' + callbackBody(f.source, 'onDisplayAsleep', 'sessionId') + '\n}', f.context);
}

function hardenFixtureWindow(f) {
  // Keep the authenticated WebContents object used by invoke(), while adding
  // only the native event surface needed by the actual hardenWindow function.
  Object.setPrototypeOf(f.owner, EventEmitter.prototype); EventEmitter.call(f.owner);
  f.owner.send = () => {}; f.owner.setWindowOpenHandler = () => {};
  const window = new EventEmitter(); window.webContents = f.owner; window.visible = true; window.destroyed = false;
  window.isVisible = () => window.visible; window.isMinimized = () => false; window.isDestroyed = () => window.destroyed;
  f.context.NativeWindowVisibility = NativeWindowVisibility;
  f.context.NativeWindowFullscreen = class { close() {} };
  f.context.fullscreenStates = new Map();
  f.context.controller.videoStreams = { entries: new Map(), closeOwner() {}, pauseOwner() {} };
  const start = f.source.indexOf('function hardenWindow(window) {'), end = f.source.indexOf('\nfunction openViewer(', start);
  assert.ok(start > 0 && end > start);
  vm.runInNewContext(f.source.slice(start, end) + '\nhardenWindow(mainWindow);', {
    ...f.context, mainWindow: window });
  return { window, close() { f.context.windowStates.get(1)?.close(); } };
}

test('F30b review same-session asleep readiness invalidation cannot cancel an in-flight accepted wake', { timeout: 1000 }, async () => {
  const beforeWire = deferred(), f = fixture({ beforeWire: beforeWire.promise });
  const capture = f.frameGate.capture(1), context = { sessionId: f.sessionId, monitorId: 'first', generation: 3, frame: { width: 10, height: 10 } };
  f.frameGate.presented(1, capture, context); const pending = f.invoke();
  asleepObserver(f)(f.sessionId); assert.equal(f.frameGate.allows(1, context), false);
  beforeWire.resolve(); assert.deepEqual(plain(await pending), { state: 'requested' });
  assert.equal(f.frameGate.capture(1), capture); assert.equal(f.wire.length, 1);
});

for (const lifetime of ['hide-show', 'same-frame-navigation'])
  test('F30b review actual native ' + lifetime + ' retires a deferred wake lifetime even after visibility returns', { timeout: 1000 }, async t => {
    const beforeWire = deferred(), f = fixture({ beforeWire: beforeWire.promise }), native = hardenFixtureWindow(f); t.after(() => native.close());
    const pending = f.invoke(); assert.equal(f.calls.length, 1);
    if (lifetime === 'hide-show') {
      native.window.visible = false; native.window.emit('hide'); native.window.visible = true; native.window.emit('show');
    } else f.owner.emit('did-start-navigation', {}, f.frame.url, false, true);
    beforeWire.resolve(); assert.equal((await pending).error.code, 'wake_cancelled'); assert.equal(f.wire.length, 0);
  });

test('F30b review actual accepted image receipt alone clears the matching generation asleep latch', async () => {
  const f = fixture(), geometry = { width: 20, height: 10, left: -20, top: 0 };
  f.session.frameSlots.set('first', { frame: geometry }); const capture = f.frameGate.capture(1);
  const context = { sessionId: f.sessionId, monitorId: 'first', generation: 3, frame: geometry };
  const token = f.frameGate.issue(1, capture, context);
  await assert.rejects(f.invoke('session.frame.presented', { payload: { sessionId: f.sessionId, monitorId: 'first', deliveryId: 'not-a-token' } }), /fresh screen/);
  assert.deepEqual(f.presentations, []);
  assert.deepEqual(plain(await f.invoke('session.frame.presented', { payload: { sessionId: f.sessionId, monitorId: 'first', deliveryId: token } })), { ok: true });
  assert.deepEqual(f.presentations, [{ id: f.sessionId, generation: 3 }]);
  await assert.rejects(f.invoke('session.frame.presented', { payload: { sessionId: f.sessionId, monitorId: 'first', deliveryId: token } }), /fresh screen/);
  const old = f.frameGate.issue(1, capture, context); f.session.sessionGeneration++;
  await assert.rejects(f.invoke('session.frame.presented', { payload: { sessionId: f.sessionId, monitorId: 'first', deliveryId: old } }), /fresh screen/);
  assert.equal(f.presentations.length, 1);
});

test('F30b review actual video presentation clears sleep only for a live unpaused native capture', () => {
  const f = fixture(), geometry = { width: 20, height: 10, left: -20, top: 0 };
  f.session.frameSlots.set('first', { frame: geometry }); const entry = { owner: 1, ownerCapture: f.frameGate.capture(1), sessionId: f.sessionId, slotKey: 'first' };
  const presented = vm.runInNewContext('(entry) => {' + callbackBody(f.source, 'onFramePresented', 'entry') + '\n}', f.context);
  f.states.set(1, { paused: true }); presented(entry); assert.deepEqual(f.presentations, []);
  f.states.set(1, { paused: false }); f.frameGate.invalidate(1); presented(entry); assert.deepEqual(f.presentations, []);
  entry.ownerCapture = f.frameGate.capture(1); presented(entry);
  assert.deepEqual(f.presentations, [{ id: f.sessionId, generation: 3 }]);
  f.context.windowStates.delete(1); presented(entry); assert.equal(f.presentations.length, 1);
});

test('F30b review local wake_not_permitted mapping stays nonterminal but remote403 always wins', () => {
  const local = wakeDisplayError(Object.assign(new Error('Private local wording'), { code: 'wake_not_permitted' })).error;
  assert.deepEqual(local, { message: 'Control permission is required to request display wake.', code: 'wake_not_permitted', retryable: false });
  const remote = wakeDisplayError(Object.assign(new Error('Host denial'), { status: 403, code: 'wake_not_permitted' })).error;
  assert.equal(remote.status, 403); assert.equal(remote.retryable, false); assert.notEqual(remote.code, 'wake_not_permitted');
});

test('F30bRepeat: actual repeat callback discards only its session pending receipts on registered owners', () => {
  const f = fixture(), gate = f.frameGate, b = { sessionId: f.sessionId, monitorId: 'first', generation: 3, frame: { width: 20, height: 10 } };
  const a = { ...b, sessionId: 'unrelated-session' }, owners = [1, 2];
  const captures = owners.map(owner => gate.capture(owner)), old = owners.map((owner, index) => gate.issue(owner, captures[index], b));
  const unrelated = gate.issue(1, captures[0], a);
  for (const [index, owner] of owners.entries()) for (const context of [a, b]) gate.presented(owner, captures[index], context);
  vm.runInNewContext('(sessionId) => {' + callbackBody(f.source, 'onDisplayPendingInvalidated', 'sessionId') + '\n}', f.context)(f.sessionId);
  for (const [index, owner] of owners.entries()) {
    assert.equal(gate.capture(owner), captures[index]); assert.equal(gate.acknowledge(owner, old[index], b), false);
    for (const context of [a, b]) assert.equal(gate.allows(owner, context), true);
  }
  assert.equal(gate.acknowledge(1, unrelated, a), true); assert.equal(f.presentations.length, 0);
});

for (const visibility of ['paused', 'absent']) test('F30bRepeat: ' + visibility + ' video owner never evaluates retired frame context', () => {
  const f = fixture(); let lookups = 0;
  if (visibility === 'paused') f.states.set(1, { paused: true }); else f.context.windowStates.delete(1);
  f.context.frameContext = () => { lookups++; throw new Error('Retired session must not be inspected.'); };
  const presented = vm.runInNewContext('(entry) => {' + callbackBody(f.source, 'onFramePresented', 'entry') + '\n}', f.context);
  assert.doesNotThrow(() => presented({ owner: 1, sessionId: 'retired-session', slotKey: 'first' }));
  assert.equal(lookups, 0); assert.deepEqual(f.presentations, []);
});

test('F30bRepeatReview3: main refuses an image receipt after the captured session object was replaced', async () => {
  const f = fixture(), geometry = { width: 20, height: 10, left: -20, top: 0 };
  f.session.frameSlots.set('first', { frame: geometry });
  f.context.controller.invoke = async (action, payload) => {
    assert.equal(action, 'session.frame'); f.calls.push({ action, payload });
    f.context.controller.sessions.set(f.sessionId, { ...f.session, frameSlots: new Map(f.session.frameSlots) });
    return { ...geometry, data: Buffer.from('generated-image'), sessionGeneration: 3 };
  };
  const result = await f.invoke('session.frame', { payload: { sessionId: f.sessionId, monitorId: 'first' } });
  assert.equal(result.deliveryId, undefined, 'a retired session object must not receive a new image receipt');
  assert.equal(f.frameGate.allows(1, f.context.frameContext(f.sessionId, 'first')), false);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.presentations, []);
});
