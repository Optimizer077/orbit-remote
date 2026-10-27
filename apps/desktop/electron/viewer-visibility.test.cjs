'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NativeWindowVisibility } = require('./viewer-visibility.cjs');
const { WindowStateTracker, observeWindowState, RememberedControl, WindowPlaybackState } = require('../renderer/src/stream/window-state.ts');
const turn = () => new Promise(resolve => setImmediate(resolve));

class Window extends EventEmitter {
  webContents = new EventEmitter(); visible = true; minimized = false; destroyed = false;
  isVisible() { return this.visible; } isMinimized() { return this.minimized; } isDestroyed() { return this.destroyed; }
}
test('only explicit native minimize/hide pauses, duplicate events and focus loss do not', t => {
  const window = new Window(), events = [];
  const state = new NativeWindowVisibility(window, { notify: value => events.push(['state', value]), onPause: () => events.push(['pause']) });
  t.after(() => state.close());
  assert.deepEqual(state.current(), { paused: false, reason: null, revision: 0 });
  window.emit('blur'); window.emit('focus'); assert.equal(events.length, 0, 'visible but unfocused keeps delivery');
  window.minimized = true; window.emit('minimize'); window.emit('minimize');
  assert.deepEqual(events, [['state', { paused: true, reason: 'minimized', revision: 1 }], ['pause']]);
  window.minimized = false; window.emit('restore');
  assert.deepEqual(state.current(), { paused: false, reason: null, revision: 2 });
  window.visible = false; window.emit('hide');
  assert.deepEqual(state.current(), { paused: true, reason: 'hidden', revision: 3 });
  window.visible = true; window.emit('show');
  assert.deepEqual(state.current(), { paused: false, reason: null, revision: 4 });
  assert.equal(events.filter(value => value[0] === 'pause').length, 2);
});
test('load repeats the authoritative snapshot, query refreshes native state, close releases listeners', () => {
  const window = new Window(), events = []; window.visible = false;
  const state = new NativeWindowVisibility(window, { notify: value => events.push(value) });
  window.webContents.emit('did-finish-load'); assert.deepEqual(events, [{ paused: true, reason: 'hidden', revision: 0 }]);
  window.visible = true; assert.deepEqual(state.current(), { paused: false, reason: null, revision: 1 });
  window.destroyed = true; window.emit('closed');
  for (const event of ['minimize', 'restore', 'hide', 'show', 'closed']) assert.equal(window.listenerCount(event), 0);
  assert.equal(window.webContents.listenerCount('did-finish-load'), 0);
  window.emit('show'); assert.equal(events.length, 2);
});
test('a renderer IPC failure cannot prevent main-side delivery pause', t => {
  const window = new Window(); let paused = 0;
  const state = new NativeWindowVisibility(window, { notify() { throw new Error('renderer gone'); }, onPause: () => paused++ });
  t.after(() => state.close()); window.minimized = true;
  assert.doesNotThrow(() => window.emit('minimize')); assert.equal(paused, 1);
});
test('renderer ignores stale revisions, malformed state, and caller mutations', () => {
  const tracker = new WindowStateTracker();
  assert.equal(tracker.accept({ paused: true, reason: 'minimized', revision: 3 }), true);
  for (const value of [null, [], { paused: false, reason: null, revision: 2 }, { paused: false, reason: null, revision: 3 },
    { paused: false, reason: 'minimized', revision: 4 }, { paused: true, reason: null, revision: 4 }, { paused: false, reason: null, revision: Infinity }]) assert.equal(tracker.accept(value), false);
  const copy = tracker.snapshot(); copy.paused = false; assert.equal(tracker.snapshot().paused, true);
  assert.equal(tracker.accept({ paused: false, reason: null, revision: 4 }), true);
});
test('an initial query arriving after minimize cannot resume; teardown ignores late IPC', async () => {
  let listener, finish, removed = 0; const events = [], errors = [];
  const bridge = { onWindowState(callback) { listener = callback; return () => removed++; }, invoke(action) { assert.equal(action, 'window.state'); return new Promise(resolve => finish = resolve); } };
  const close = observeWindowState(bridge, value => events.push(value), () => errors.push('error'));
  listener({ paused: true, reason: 'minimized', revision: 2 });
  finish({ paused: false, reason: null, revision: 1 }); await turn();
  assert.deepEqual(events, [{ paused: true, reason: 'minimized', revision: 2 }]);
  close(); listener({ paused: false, reason: null, revision: 3 });
  assert.equal(events.length, 1); assert.equal(removed, 1); assert.deepEqual(errors, []);
});
const control = { sessionId: 'session-a', sessionGeneration: 0, monitorId: 'monitor-a', frame: { width: 1920, height: 1080, left: -1920, top: 5 }, enabled: true, allowed: true, viewOnly: false, ended: false };
test('pre-minimize control can return only once after a fresh unchanged target frame', () => {
  const remembered = new RememberedControl(); remembered.pause(control);
  assert.equal(remembered.freshFrame({ ...control, enabled: false }), true);
  assert.equal(remembered.freshFrame(control), false, 'a second draw cannot enable control again');
  remembered.pause({ ...control, enabled: false }); assert.equal(remembered.freshFrame(control), false);
});
test('target, geometry, permission, view-only, terminal and recovery changes invalidate remembered control', () => {
  for (const change of [{ sessionId: 'session-b' }, { sessionGeneration: 1 }, { sessionGeneration: undefined }, { monitorId: 'monitor-b' }, { frame: null },
    { frame: { ...control.frame, left: 0 } }, { frame: { ...control.frame, width: 2560 } },
    { allowed: false }, { viewOnly: true }, { ended: true }]) {
    const remembered = new RememberedControl(); remembered.pause(control);
    assert.equal(remembered.freshFrame({ ...control, ...change }), false);
    assert.equal(remembered.freshFrame(control), false, 'a later matching frame must not revive invalidated state');
  }
  const remembered = new RememberedControl(); remembered.pause(control); remembered.invalidate();
  assert.equal(remembered.freshFrame(control), false);
});
for (const ordering of ['port-first', 'ipc-first']) test(`classified pause preserves control with ${ordering} delivery and discards pre-pause draws`, () => {
  const playback = new WindowPlaybackState(false); let enabled = true, releases = 0;
  const apply = state => { const change = playback.receive(state, { ...control, enabled }); if (change?.transition === 'paused') { enabled = false; releases++; } return change; };
  apply({ paused: false, reason: null, revision: 0 });
  const staleDraw = playback.delivery.begin();
  const portState = { paused: true, reason: 'minimized', revision: 1 };
  // Both actual routes invoke receive synchronously; the later route is a duplicate.
  const first = ordering === 'port-first' ? { ...portState } : portState;
  apply(first); apply({ ...portState });
  assert.equal(releases, 1); assert.equal(enabled, false);
  assert.equal(playback.freshFrame(control, staleDraw), false, 'already queued Worker output cannot undo pause or consume remembered control');
  apply({ paused: false, reason: null, revision: 0 });
  assert.equal(playback.freshFrame(control, staleDraw), false, 'late initial IPC cannot resume');
  assert.equal(apply({ paused: false, reason: null, revision: 2 }).transition, 'resumed');
  assert.equal(playback.freshFrame(control, staleDraw), false, 'an old draw stays invalid after restore');
  const freshDraw = playback.delivery.begin();
  assert.equal(playback.freshFrame(control, freshDraw), true);
  assert.equal(playback.freshFrame(control, freshDraw), false, 'restoration occurs at most once');
});
test('bare port failure, recovery and terminal cannot restore remembered control', () => {
  for (const stop of ['clearControl', 'end']) {
    const playback = new WindowPlaybackState(false);
    playback.receive({ paused: true, reason: 'minimized', revision: 1 }, control);
    playback[stop]();
    playback.receive({ paused: false, reason: null, revision: 2 }, control);
    assert.equal(playback.freshFrame(control, playback.delivery.begin()), false);
  }
});

test('main fresh-frame gate cannot be unlocked by old or another-owner image receipts', () => {
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'); const gate = new OwnerFrameGate();
  const context = { sessionId: 'session', monitorId: 'secondary', generation: 3, frame: { width: 160, height: 100, left: -160, top: 0 } };
  const old = gate.capture(1), oldToken = gate.issue(1, old, context);
  gate.invalidate(1); const current = gate.capture(1);
  assert.equal(gate.acknowledge(1, oldToken, context), false); assert.equal(gate.presented(1, old, context), false);
  assert.equal(gate.issue(1, old, context), undefined);
  const other = gate.issue(2, gate.capture(2), context);
  assert.equal(gate.acknowledge(2, other, context), true); assert.equal(gate.allows(1, context), false);
  const token = gate.issue(1, current, context);
  assert.equal(gate.acknowledge(2, token, context), false); assert.equal(gate.acknowledge(1, token, { ...context, monitorId: 'primary' }), false);
  assert.equal(gate.acknowledge(1, token, context), true); assert.equal(gate.acknowledge(1, token, context), false);
  assert.equal(gate.allows(1, context), true); assert.equal(gate.allows(1, { ...context, generation: 4 }), false);
  assert.equal(gate.allows(1, { ...context, frame: { ...context.frame, left: 0 } }), false);
  gate.invalidate(1); assert.equal(gate.allows(1, context), false);
  assert.equal(gate.presented(1, gate.capture(1), context), true); assert.equal(gate.allows(1, context), true);
  gate.forget(1); assert.equal(gate.allows(1, context), false);
});

test('main fresh-frame gate rejects changed generation receipts and bounds retained pending contexts', () => {
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'); const gate = new OwnerFrameGate(), capture = gate.capture(1);
  const context = { sessionId: 'session', monitorId: '', generation: 0, frame: { width: 100, height: 100 } };
  const token = gate.issue(1, capture, context);
  assert.equal(gate.acknowledge(1, token, { ...context, generation: 1 }), false); assert.equal(gate.allows(1, context), false);
  for (let index = 0; index < 1000; index++) gate.issue(1, capture, { ...context, sessionId: 'session-' + index });
  assert.equal(capture.pending.size, 32); assert.equal(capture.ready.size, 0);
  assert.equal(gate.presented(1, capture, { ...context, frame: null }), false);
});

test('another viewer changing shared geometry after image delivery cannot relabel old pixels as a fresh frame', () => {
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate(), capture = gate.capture(1);
  const delivered = { sessionGeneration: 2, width: 160, height: 100, left: -160, top: 0 };
  const current = { sessionId: 'session', monitorId: 'monitor', generation: 2, frame: { ...delivered, left: 0, width: 200 } };
  const token = gate.issueFrame(1, capture, 'session', 'monitor', delivered);
  assert.equal(gate.acknowledge(1, token, current), false);
  assert.equal(gate.allows(1, current), false, 'an old image cannot unlock the geometry another window published');
  const next = gate.issueFrame(1, capture, 'session', 'monitor', { ...current.frame, sessionGeneration: 2 });
  assert.equal(gate.acknowledge(1, next, current), true); assert.equal(gate.allows(1, current), true);
});
test('closed event runs every later listener although the destroyed window refuses webContents', () => {
  // Electron 45: inside 'closed', window.webContents throws "Object has been destroyed".
  class DestroyedWindow extends Window {
    contents = new EventEmitter();
    constructor() { super(); delete this.webContents; } // expose the prototype getter below
    get webContents() { if (this.destroyed) throw new TypeError('Object has been destroyed'); return this.contents; }
  }
  const window = new DestroyedWindow(), later = [];
  const state = new NativeWindowVisibility(window, { notify: () => {} });
  window.on('closed', () => later.push('cleanup'));
  window.destroyed = true;
  assert.doesNotThrow(() => window.emit('closed'));
  assert.deepEqual(later, ['cleanup']);
  assert.equal(window.contents.listenerCount('did-finish-load'), 0);
  assert.equal(window.listenerCount('minimize'), 0);
  assert.equal(state.closed, true);
});

test('F30b review sleep retires only its session receipts and preserves unrelated live stream capture and pending images', () => {
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate(), capture = gate.capture(1);
  const a = { sessionId: 'A', monitorId: 'primary', generation: 2, frame: { width: 320, height: 180, left: -320, top: 0 } };
  const b = { ...a, sessionId: 'B' }, bSecond = { ...b, monitorId: 'secondary' };
  const aToken = gate.issue(1, capture, a), bToken = gate.issue(1, capture, b), bSecondToken = gate.issue(1, capture, bSecond);
  for (const context of [a, b, bSecond]) assert.equal(gate.presented(1, capture, context), true);
  gate.invalidateSession(1, 'B');
  assert.equal(gate.capture(1), capture, 'sleep is not native window retirement');
  assert.equal(gate.allows(1, a), true); assert.equal(gate.acknowledge(1, aToken, a), true);
  assert.equal(gate.presented(1, capture, a), true, 'the ongoing A video retains its original capture');
  for (const [token, context] of [[bToken, b], [bSecondToken, bSecond]]) {
    assert.equal(gate.allows(1, context), false); assert.equal(gate.acknowledge(1, token, context), false);
  }
  const fresh = gate.issue(1, capture, b); assert.equal(gate.acknowledge(1, fresh, b), true);
  gate.invalidate(1); assert.equal(gate.presented(1, capture, a), false, 'native lifetime replacement still rejects old streams');
});

test('F30b review session-only retirement is a bounded no-op for absent owners and unrelated session keys', () => {
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate();
  gate.invalidateSession(99, 'B'); assert.equal(gate.owners.size, 0);
  const capture = gate.capture(1), context = { sessionId: 'B-prefix', monitorId: 'B', generation: 0, frame: { width: 1, height: 1 } };
  const token = gate.issue(1, capture, context); gate.presented(1, capture, context);
  for (let index = 0; index < 1000; index++) gate.invalidateSession(1, 'B');
  assert.equal(gate.owners.size, 1); assert.equal(capture.pending.size, 1); assert.equal(capture.ready.size, 1);
  assert.equal(gate.acknowledge(1, token, context), true);
});

test('F30bRepeat: pending-only invalidation rejects the late asleep-session nonce while preserving all ready frames', () => {
  const { OwnerFrameGate } = require('./viewer-visibility.cjs'), gate = new OwnerFrameGate(), capture = gate.capture(1);
  const a = { sessionId: 'A', monitorId: 'first', generation: 0, frame: { width: 160, height: 100 } };
  const b = { ...a, sessionId: 'B' }, second = { ...b, monitorId: 'second' };
  const aToken = gate.issue(1, capture, a), bToken = gate.issue(1, capture, b), secondToken = gate.issue(1, capture, second);
  for (const context of [a, b, second]) gate.presented(1, capture, context);
  gate.invalidatePendingSession(1, 'B');
  assert.equal(gate.capture(1), capture); for (const context of [a, b, second]) assert.equal(gate.allows(1, context), true);
  assert.equal(gate.acknowledge(1, bToken, b), false); assert.equal(gate.acknowledge(1, secondToken, second), false);
  assert.equal(gate.acknowledge(1, aToken, a), true); assert.equal(gate.presented(1, capture, a), true);
  gate.invalidatePendingSession(99, 'B'); assert.equal(gate.owners.size, 1);
});
