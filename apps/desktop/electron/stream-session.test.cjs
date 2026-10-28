'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SessionVideoStreams, ACK_INTERVAL_MS, MAX_UNCONSUMED_UNITS, MAX_QUEUED_RECORDS, VIDEO_CREDIT_WINDOW, frameRequestError } = require('./stream-session.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
const config = { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
  physicalLeft: -1920, physicalTop: 5, physicalWidth: 1920, physicalHeight: 1080, scale: 1, fps: 60, monitorId: 'display-1' };
const unit = Uint8Array.of(0, 0, 0, 1, 0x65, 1);
const delta = Uint8Array.of(0, 0, 0, 1, 0x41, 1); // non-IDR slice: the parser checks the keyframe flag against NAL types
function record(type, value, sequence, flags = 0) {
  const body = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(24); header[0] = type; header[1] = flags;
  header.writeUInt32LE(body.length, 4); header.writeUInt32LE(sequence, 8); header.writeBigUInt64LE(BigInt(sequence), 16);
  return Buffer.concat([header, body]);
}
class Port extends EventEmitter {
  messages = []; closed = false;
  postMessage(message) { if (this.closed) throw new Error('closed'); this.messages.push(message); }
  start() {}
  close() { if (this.closed) return; this.closed = true; this.emit('close'); }
  receive(data) { this.emit('message', { data }); }
}
function fixture(t, options = {}) {
  const session = { device: {}, remoteId: 'remote-1', closed: false, permissions: { view: true, control: true }, monitorId: null,
    monitors: [{ id: 'display-1', primary: true }, { id: 'display-2' }], frameSlots: new Map(), inputEpoch: 0 };
  const calls = [], connections = [], ended = [];
  const controller = { sessions: new Map([['local-1', session]]), endedSessions: new Map(), allowLoopback: true,
    getSession(payload) { const s = this.sessions.get(payload.sessionId); if (!s || s.closed) throw new Error('Session ended'); return s; },
    async getIdentity() { return {}; }, async remote(_device, route, request) { calls.push({ route, body: request.body, at: performance.now() }); return {}; } };
  const openRemote = async (_device, _identity, route, remoteOptions) => {
    let complete, reject;
    const done = new Promise((ok, fail) => { complete = ok; reject = fail; }); done.catch(() => {});
    const connection = { route, options: remoteOptions, done, aborts: 0, resumes: 0,
      abort() { this.aborts++; reject(new Error('aborted')); }, resume() { this.resumes++; },
      feed(bytes) { return remoteOptions.onData(bytes); }, complete, fail: reject };
    connections.push(connection); return connection;
  };
  const manager = new SessionVideoStreams(controller, { remoteStream: openRemote, onTerminal: (...args) => ended.push(args), ...options });
  t.after(() => manager.shutdown());
  const port = new Port(); const opened = manager.open({ sessionId: 'local-1', monitorId: '' }, port, 1);
  return { manager, controller, session, calls, connections, port, opened, ended };
}

test('only the owning window can close a stream and another window cannot replace its session/monitor', async t => {
  const f = fixture(t); await turn();
  f.manager.close(f.opened.streamId, 2); assert.equal(f.manager.entries.size, 1);
  assert.throws(() => f.manager.open({ sessionId: 'local-1', monitorId: 'display-1' }, new Port(), 2), /another window/);
  assert.equal(f.connections.length, 1);
  f.manager.closeOwner(1); assert.equal(f.manager.entries.size, 0); assert.equal(f.port.closed, true);
});
test('native pause is classified on its stream port before close and preserves session authority', async t => {
  const f = fixture(t); await turn();
  const state = { paused: true, reason: 'minimized', revision: 8 };
  const order = [], originalPost = f.port.postMessage.bind(f.port), originalClose = f.port.close.bind(f.port);
  f.port.postMessage = value => { order.push(['message', value]); originalPost(value); };
  f.port.close = () => { order.push(['close']); originalClose(); };
  f.manager.pauseOwner(2, state); assert.equal(f.port.closed, false, 'another window cannot pause delivery');
  f.manager.pauseOwner(1, state);
  assert.deepEqual(order[0], ['message', { type: 'status', state: 'paused', windowState: state }]);
  assert.deepEqual(order[1], ['close']); assert.equal(f.manager.entries.size, 0);
  assert.equal(f.controller.sessions.size, 1, 'a native-window pause cannot revoke paired/session authority');
});
test('frame failure IPC metadata separates explicit ordinary reconnect from security denial and automatic retry', () => {
  for (const status of [401, 403, 410]) {
    const value = frameRequestError(Object.assign(new Error('Generated denial'), { status }), undefined, true).error;
    assert.equal(value.status, status); assert.equal(value.retryable, false);
    assert.equal(value.canReconnect === true, status === 410, 'only a main-approved ordinary end offers an explicit click');
  }
  assert.equal(frameRequestError(Object.assign(new Error('Generated reset'), { code: 'ECONNRESET' })).error.retryable, true);
  assert.equal(frameRequestError(new Error('Unknown identity/TLS failure')).error.retryable, false);
});
test('a static visible desktop with heartbeat and no pending access unit remains healthy idle', async t => {
  let now = 0; const f = fixture(t, { now: () => now }); await turn();
  f.port.receive({ type: 'credit', count: 1 }); f.connections[0].feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 1 }); f.connections[0].feed(record(3, new Uint8Array(), 1));
  now = 60000; await sleep(310);
  assert.equal(f.manager.entries.size, 1); assert.equal(f.port.closed, false);
  assert.equal(f.port.messages.some(message => message.state === 'fallback'), false);
});
test('an unpresented access unit stalls after five seconds even if Worker credit was returned', async t => {
  let now = 0; const f = fixture(t, { now: () => now }); await turn();
  f.port.receive({ type: 'credit', count: 1 }); f.connections[0].feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 1 }); f.connections[0].feed(record(2, unit, 1, 1));
  f.port.receive({ type: 'consumed', sequence: 1, dropped: false }); f.port.receive({ type: 'credit', count: 1 });
  assert.equal(f.manager.entries.get(f.opened.streamId).credit, 1);
  now = 5001; await sleep(310);
  assert.equal(f.port.messages.at(-1).code, 'decoder_stalled'); assert.equal(f.port.messages.at(-1).retryable, true);
  assert.equal(f.manager.entries.size, 0); assert.equal(f.controller.sessions.size, 1, 'a decoder stall cannot remove session authority');
});

test('pin route and canonical monitor stay in main, unknown monitor or malformed settings cannot open', async t => {
  const f = fixture(t); await turn();
  assert.match(f.connections[0].route, /^\/api\/sessions\/remote-1\/stream\?/);
  assert.match(f.connections[0].route, /monitorId=display-1/);
  assert.throws(() => f.manager.open({ sessionId: 'local-1', monitorId: 'other' }, new Port(), 3), /monitor/);
  assert.throws(() => f.manager.open({ sessionId: 'local-1', maxFps: NaN }, new Port(), 1), /settings/);
  f.session.permissions.view = false;
  assert.throws(() => f.manager.open({ sessionId: 'local-1' }, new Port(), 1), /permission/);
});

test('fully received validated AUs are cumulatively acknowledged before decoder presentation, with no raw body in control', async t => {
  const f = fixture(t); await turn(); const connection = f.connections[0];
  connection.feed(Buffer.concat([record(1, config, 0), record(2, unit, 1, 1)]));
  assert.equal(f.port.messages.filter(x => x.type === 'record').length, 0, 'no decoder credit, so no body sent over IPC');
  await sleep(15);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].body, { ack: 1, decodeMs: 0 });
  assert.match(f.calls[0].route, /stream\/control\?monitorId=display-1$/);
  assert.equal(f.manager.entries.get(f.opened.streamId).queue.length, 2);
});

test('records cross the Electron port without a transfer list and carry an exclusively owned payload buffer', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  const counts = [], post = f.port.postMessage.bind(f.port);
  // Electron's MessagePortMain.postMessage throws for any transfer entry that is not a MessagePortMain.
  f.port.postMessage = (...args) => {
    counts.push(args.length);
    if (args[1] !== undefined && (!Array.isArray(args[1]) || args[1].some(item => !(item instanceof Port)))) throw new TypeError('Port at index 0 is not a valid port');
    post(args[0]);
  };
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 1 }); c.feed(Buffer.concat([record(2, unit, 1, 1), record(3, new Uint8Array(), 2)]));
  const sent = f.port.messages.find(message => message.record?.type === 'access-unit');
  assert.ok(sent, 'the access unit reached the port'); assert.equal(f.port.closed, false); assert.equal(f.manager.entries.size, 1);
  assert.ok(counts.every(count => count === 1));
  assert.ok(sent.record.data instanceof ArrayBuffer); assert.deepEqual(new Uint8Array(sent.record.data), unit);
  assert.equal(sent.record.data.byteLength, unit.byteLength, 'never a view onto a pooled Buffer slab');
});
test('credit admits one record at a time and physical input geometry becomes available only after presentation', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0)); c.feed(record(2, unit, 1, 1));
  assert.deepEqual(f.port.messages.filter(x => x.type === 'record').map(x => x.record.type), ['config']);
  f.port.receive({ type: 'credit', count: 1 });
  assert.deepEqual(f.port.messages.filter(x => x.type === 'record').map(x => x.record.type), ['config', 'access-unit']);
  assert.equal(f.session.frameSlots.get('').frame, null);
  f.port.receive({ type: 'consumed', sequence: 1, dropped: false }); assert.equal(f.session.frameSlots.get('').frame, null);
  f.port.receive({ type: 'presented', sequence: 1, decodeMs: .6, drawMs: .2 });
  assert.deepEqual(f.session.frameSlots.get('').frame, { width: 1920, height: 1080, left: -1920, top: 5 });
  assert.equal(f.session.frame.width, 1920);
});
// S2 credit window: records in flight to the renderer never exceed the window, whatever the burst.
const inFlightRecords = f => f.port.messages.filter(x => x.type === 'record').length;
test('the credit window keeps at most VIDEO_CREDIT_WINDOW records in flight and refills one per returned credit', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  assert.ok(VIDEO_CREDIT_WINDOW > 1 && VIDEO_CREDIT_WINDOW <= 4, 'a small bounded window');
  c.feed(record(1, config, 0));
  for (let seq = 1; seq <= 8; seq++) c.feed(record(2, seq === 1 ? unit : delta, seq, seq === 1 ? 1 : 0));
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW });
  assert.equal(inFlightRecords(f), VIDEO_CREDIT_WINDOW, 'one burst of records, no more than the window');
  let returned = 0;
  for (let step = 0; step < 6; step++) {
    f.port.receive({ type: 'credit', count: 1 }); returned++;
    assert.equal(inFlightRecords(f) - returned, VIDEO_CREDIT_WINDOW, 'each returned credit admits exactly one more record');
  }
  assert.equal(inFlightRecords(f), 9); assert.equal(f.manager.entries.get(f.opened.streamId).credit, VIDEO_CREDIT_WINDOW - 3);
});
test('a Worker that stops returning credit pauses the transport, then the window drains the backlog when credit returns', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0], entry = f.manager.entries.get(f.opened.streamId);
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW });
  c.feed(record(1, config, 0));
  for (let seq = 1; seq < VIDEO_CREDIT_WINDOW; seq++) c.feed(record(2, seq === 1 ? unit : delta, seq, seq === 1 ? 1 : 0));
  assert.equal(entry.credit, 0); assert.equal(entry.queue.length, 0);
  // The Worker is stalled: further units queue in main and each read asks the transport to pause.
  const reads = [];
  for (let seq = VIDEO_CREDIT_WINDOW; seq < VIDEO_CREDIT_WINDOW + 5; seq++) reads.push(c.feed(record(2, delta, seq)));
  assert.deepEqual(reads, [false, false, false, false, false]); assert.equal(entry.queue.length, 5);
  assert.equal(inFlightRecords(f), VIDEO_CREDIT_WINDOW);
  const resumes = c.resumes;
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW });
  assert.equal(inFlightRecords(f), 2 * VIDEO_CREDIT_WINDOW, 'returned credit admits the window, not the whole backlog');
  f.port.receive({ type: 'credit', count: 2 });
  assert.equal(entry.queue.length, 0); assert.ok(c.resumes > resumes, 'an empty queue resumes reading');
  assert.equal(f.port.closed, false);
});
test('the oldest uncredited record trips the decoder stall after five seconds even while window credit remains', async t => {
  let now = 0; const f = fixture(t, { now: () => now }); await turn();
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW }); f.connections[0].feed(record(1, config, 0));
  assert.equal(f.manager.entries.get(f.opened.streamId).credit, VIDEO_CREDIT_WINDOW - 1);
  now = 4900; await sleep(310); assert.equal(f.manager.entries.size, 1);
  now = 5001; await sleep(310);
  assert.equal(f.port.messages.at(-1).code, 'decoder_stalled'); assert.equal(f.manager.entries.size, 0);
});
test('keyframe-needed keeps units admitted after the reset: a keyframe in flight is presented, discarded units are reported', async t => {
  const f = fixture(t), presented = []; f.manager.onPresented = entry => presented.push(entry.monitorId);
  await turn(); const c = f.connections[0], entry = f.manager.entries.get(f.opened.streamId);
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW }); c.feed(record(1, config, 0));
  c.feed(record(2, unit, 1, 1)); c.feed(record(2, delta, 2));
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(2, unit, 3, 1)); // keyframe 3 is in flight
  // The decoder resets: it reports the units it discarded, then asks for a keyframe.
  f.port.receive({ type: 'consumed', sequence: 1, dropped: true }); f.port.receive({ type: 'consumed', sequence: 2, dropped: true });
  f.port.receive({ type: 'keyframe-needed', reason: 'decoder-error' });
  assert.equal(f.port.messages.at(-1).state, 'recovering');
  assert.deepEqual([...entry.pending.keys()], [3], 'only the discarded units leave; the in-flight keyframe stays pending');
  f.port.receive({ type: 'presented', sequence: 3, decodeMs: .5, drawMs: .2 });
  assert.equal(presented.length, 1, 'its presentation counts and ends recovery');
  assert.deepEqual(f.session.frameSlots.get('').frame, { width: 1920, height: 1080, left: -1920, top: 5 });
  assert.equal(entry.pending.size, 0);
});
test('a doubled or invented credit cannot widen the window after the first grant', async t => {
  let f = fixture(t); await turn(); let c = f.connections[0];
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 1 }); // the config record was handled
  assert.equal(f.manager.entries.size, 1);
  f.port.receive({ type: 'credit', count: 1 }); // nothing is in flight: a doubled credit
  assert.equal(f.port.messages.at(-1).code, 'invalid_worker_message'); assert.equal(f.manager.entries.size, 0);
  f = fixture(t); await turn(); c = f.connections[0];
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 2 }); // one record in flight, two credits back
  assert.equal(f.port.messages.at(-1).code, 'invalid_worker_message', 'more credit than records in flight fails closed');
});
test('a superseded unit leaves the pending set without counting as a presentation', async t => {
  const f = fixture(t), presented = []; f.manager.onPresented = entry => presented.push(entry.monitorId);
  await turn(); const c = f.connections[0], entry = f.manager.entries.get(f.opened.streamId);
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW }); c.feed(record(1, config, 0));
  c.feed(record(2, unit, 1, 1)); c.feed(record(2, delta, 2));
  f.port.receive({ type: 'superseded', sequence: 1 });
  assert.equal(entry.pending.has(1), false); assert.equal(presented.length, 0); assert.equal(f.session.frameSlots.get('').frame, null);
  f.port.receive({ type: 'presented', sequence: 2, decodeMs: .5, drawMs: .2 });
  assert.equal(presented.length, 1); assert.equal(entry.pending.size, 0);
  f.port.receive({ type: 'superseded', sequence: -1 });
  assert.equal(f.port.messages.at(-1).code, 'invalid_worker_message', 'a malformed supersession fails closed');
});

test('viewer timing: control round trip and main queue wait use main\'s clock and ride on the next record', async t => {
  let now = 0; const f = fixture(t, { now: () => now }); await turn(); const c = f.connections[0];
  const releases = []; f.controller.remote = () => new Promise(resolve => releases.push(resolve));
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0));
  now = 100; c.feed(record(2, unit, 1, 1));
  await sleep(5); assert.equal(releases.length, 1, 'the existing ack POST is the only request');
  now = 107.5; releases[0]({}); await turn();
  now = 112; f.port.receive({ type: 'credit', count: 1 });
  const records = () => f.port.messages.filter(message => message.type === 'record');
  assert.equal('mainQueueMs' in records()[0], false, 'config records carry no frame timing');
  assert.equal(records()[1].mainQueueMs, 12); assert.equal(records()[1].rttMs, 7.5);
  assert.equal(records()[1].rttAgeMs, 4.5, 'the sample carries its age, so the viewer files it at its measurement time');
  f.port.receive({ type: 'credit', count: 1 }); now = 113; c.feed(record(2, delta, 2, 0));
  assert.equal(records()[2].mainQueueMs, 0); assert.equal('rttMs' in records()[2], false, 'each round trip is reported once');
});
test('viewer timing: a failed control request records no round trip', async t => {
  let now = 0; const f = fixture(t, { now: () => now }); await turn(); const c = f.connections[0];
  const entry = f.manager.entries.get(f.opened.streamId);
  f.controller.remote = async () => { now += 3; throw Object.assign(new Error('Generated busy'), { status: 429 }); };
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0)); c.feed(record(2, unit, 1, 1));
  await sleep(5);
  assert.equal(entry.roundTripMs, undefined);
});

test('a frozen consumer has a bounded AU queue and excess units abort transport without killing main', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  c.feed(record(1, config, 0));
  // Without credit nothing reaches the renderer: the record queue bound (payload memory) is the one that trips.
  const held = Math.min(MAX_QUEUED_RECORDS - 1, MAX_UNCONSUMED_UNITS);
  for (let seq = 1; seq <= held; seq++) c.feed(record(2, seq === 1 ? unit : delta, seq, seq === 1 ? 1 : 0));
  assert.equal(f.port.closed, false); assert.equal(f.manager.entries.get(f.opened.streamId).queue.length, held + 1);
  assert.equal(c.feed(record(2, delta, held + 1)), false);
  assert.equal(f.port.closed, true); assert.equal(c.aborts, 1);
  assert.equal(f.port.messages.at(-1).code, 'stream_protocol_error');
  assert.equal(f.controller.sessions.size, 1, 'PNG fallback keeps existing authorization, never creates a session');
});

test('a decoder holding 12 consumed-but-unpresented units (its own recovery cap) keeps the stream open', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0));
  for (let seq = 1; seq <= 12; seq++) {
    f.port.receive({ type: 'credit', count: 1 }); c.feed(record(2, seq === 1 ? unit : delta, seq, seq === 1 ? 1 : 0));
    f.port.receive({ type: 'consumed', sequence: seq, dropped: false });
  }
  assert.equal(f.port.closed, false, 'a 12-frame decoder hiccup is not a protocol violation');
  assert.equal(f.port.messages.filter(x => x.type === 'record' && x.record.type === 'access-unit').length, 12);
  assert.ok(MAX_UNCONSUMED_UNITS > 12);
});
test('12 waiting units plus a full credit window and one frame awaiting display, then a parsed unit, stay within bounds', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW }); c.feed(record(1, config, 0));
  const held = 12 + 1 + VIDEO_CREDIT_WINDOW; // decoder queue, display slot, Worker admission
  for (let seq = 1; seq <= held; seq++) {
    c.feed(record(2, seq === 1 ? unit : delta, seq, seq === 1 ? 1 : 0));
    if (seq <= 13) { f.port.receive({ type: 'credit', count: 1 }); f.port.receive({ type: 'consumed', sequence: seq, dropped: false }); }
  }
  c.feed(record(2, delta, held + 1));
  assert.equal(f.port.closed, false, 'the deepest legitimate pipeline is not a protocol violation');
  assert.ok(MAX_UNCONSUMED_UNITS >= held + 1);
});

test('terminal host-end immediately deletes authority, clears geometry and ends every stream attached to that session', async t => {
  const f = fixture(t); const second = new Port();
  f.manager.open({ sessionId: 'local-1', monitorId: 'display-2' }, second, 2); await turn();
  f.connections[0].feed(record(1, config, 0));
  f.connections[0].feed(record(4, { code: 'session_ended_by_host', error: 'Session ended by host.' }, 1));
  assert.equal(f.controller.sessions.size, 0); assert.equal(f.session.closed, true);
  assert.equal(f.session.frame, null); assert.equal(f.manager.entries.size, 0);
  assert.equal(f.port.closed, true); assert.equal(second.closed, true); assert.equal(f.ended.length, 1);
  assert.match(f.controller.endedSessions.get('local-1'), /ended by host/);
  assert.equal(f.calls.length, 0, 'no automatic session creation or pending ACK after terminal');
});

test('partial EOF is transient, releases the payload and allows existing PNG authorization only', async t => {
  const f = fixture(t); await turn(); const c = f.connections[0];
  c.feed(record(1, config, 0).subarray(0, 27)); c.complete({ eof: true }); await turn();
  assert.equal(f.port.messages.at(-1).state, 'fallback'); assert.equal(f.port.messages.at(-1).code, 'stream_eof');
  assert.equal(f.manager.entries.size, 0); assert.equal(f.controller.sessions.size, 1);
});

test('HTTP401/403/410 never fall back to automatic access, while409 is a permanent image fallback', async t => {
  for (const [status, expected] of [[401, 'ended'], [403, 'ended'], [410, 'ended'], [409, 'fallback']]) {
    const f = fixture(t); await turn(); f.connections[0].fail(Object.assign(new Error('Device unavailable'), { status })); await turn();
    assert.equal(f.port.messages.at(-1).state, expected);
    assert.equal(f.controller.sessions.size, expected === 'ended' ? 0 : 1);
    assert.equal(f.port.messages.at(-1).retryable, false);
    assert.equal(f.port.messages.at(-1).status, status);
  }
});

test('only explicit transient transport failures permit a video retry without changing session authority', async t => {
  for (const [error, expected] of [
    [Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }), true],
    [Object.assign(new Error('stream timeout'), { code: 'ORBIT_STREAM_STALLED' }), true],
    [Object.assign(new Error('busy'), { status: 503 }), true],
    [new Error('Device identity changed. Connection blocked.'), false],
    [Object.assign(new Error('TLS policy failed'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), false],
    [Object.assign(new Error('No endpoint'), { status: 404 }), false],
    [new Error('unknown failure'), false],
  ]) {
    const f = fixture(t); await turn(); f.connections[0].fail(error); await turn();
    const message = f.port.messages.at(-1);
    assert.equal(message.state, 'fallback'); assert.equal(message.retryable, expected);
    assert.equal(f.manager.entries.size, 0); assert.equal(f.controller.sessions.size, 1);
    assert.equal(f.controller.endedSessions.size, 0);
  }
});

test('validated transient terminal records permit retry; terminal authority and malformed streams do not', async t => {
  for (const code of ['stream_restart', 'stream_error', 'host_stopping', 'session_ended', 'session_ended_by_host',
    'access_revoked', 'permission_changed', 'identity_rotated', 'stream_replaced']) {
    const f = fixture(t); await turn();
    f.connections[0].feed(record(1, config, 0));
    f.connections[0].feed(record(4, Buffer.from(JSON.stringify({ code, error: 'bounded test reason' })), 1));
    const ended = !['stream_restart', 'stream_error', 'host_stopping'].includes(code);
    assert.equal(f.port.messages.at(-1).state, ended ? 'ended' : 'fallback');
    assert.equal(f.port.messages.at(-1).retryable, !ended);
    assert.equal(f.controller.sessions.size, ended ? 0 : 1);
  }
  const f = fixture(t); await turn(); f.connections[0].feed(Buffer.alloc(24));
  assert.equal(f.port.messages.at(-1).code, 'stream_protocol_error');
  assert.equal(f.port.messages.at(-1).retryable, false);
});

test('denied-open metadata survives IPC serialization and cannot authorize a retry', () => {
  const { streamOpenError } = require('./stream-session.cjs');
  const denied = JSON.parse(JSON.stringify(streamOpenError(new Error('A different window owns the stream'))));
  assert.equal(denied.error.code, 'stream_open_denied'); assert.equal(denied.error.retryable, false);
  const ended = JSON.parse(JSON.stringify(streamOpenError(new Error('Missing session'), 'Ended by the host')));
  assert.equal(ended.error.code, 'session_ended'); assert.equal(ended.error.status, 410); assert.equal(ended.error.retryable, false);
  for (const status of [401, 403, 410]) {
    const value = JSON.parse(JSON.stringify(streamOpenError(Object.assign(new Error('Denied'), { status }))));
    assert.equal(value.error.status, status); assert.equal(value.error.retryable, false);
    assert.notEqual(value.error.code, 'stream_open_denied');
  }
  assert.equal(streamOpenError(new Error('x'.repeat(2000))).error.message.length, 500);
});

test('a pending connect is cancelled on close; late success cannot restore a stream or forward a record', async t => {
  let resolve, signal, aborts = 0;
  const f = fixture(t, { remoteStream: (_d, _i, _r, options) => { signal = options.signal; return new Promise(ok => { resolve = ok; }); } });
  await turn(); f.manager.close(f.opened.streamId, 1); assert.equal(signal.aborted, true);
  resolve({ done: Promise.resolve(), abort() { aborts++; }, resume() {} }); await turn();
  assert.equal(aborts, 1); assert.equal(f.manager.entries.size, 0);
  assert.equal(f.port.messages.filter(x => x.type === 'record').length, 0);
});

test('independent access timer closes a stream after its controller session is removed, even without more network data', async t => {
  const f = fixture(t); await turn(); f.controller.sessions.delete('local-1');
  await sleep(310); assert.equal(f.manager.entries.size, 0); assert.equal(f.port.closed, true);
  assert.equal(f.port.messages.at(-1).state, 'ended');
});

test('renewal by another authorized window closes only the old video generation and uses PNG fallback', async t => {
  const f = fixture(t); await turn(); f.session.remoteId = 'remote-2';
  await sleep(310);
  assert.equal(f.manager.entries.size, 0); assert.equal(f.port.messages.at(-1).state, 'fallback');
  assert.equal(f.port.messages.at(-1).code, 'session_reconnected'); assert.equal(f.controller.sessions.size, 1);
  assert.equal(f.session.closed, false); assert.equal(f.controller.endedSessions.size, 0);
});

test('repeated decoder recovery requests cannot issue keyframes faster than twice per second', async t => {
  const f = fixture(t); await turn();
  for (let i = 0; i < 20; i++) f.port.receive({ type: 'keyframe-needed', reason: 'synthetic decoder error' });
  await sleep(550);
  const keyframes = f.calls.filter(call => call.body.keyframe);
  assert.equal(keyframes.length, 1, 'one coalesced request, no unnecessary second request after it succeeded');
  f.port.receive({ type: 'keyframe-needed' }); await sleep(15);
  assert.equal(f.calls.filter(call => call.body.keyframe).length, 2);
  assert.ok(f.calls.at(-1).at - keyframes[0].at >= 500);
});

test('credit beyond the window fails closed and receipt acknowledgements coalesce instead of one HTTP request per AU', async t => {
  let f = fixture(t); await turn();
  f.port.receive({ type: 'credit', count: VIDEO_CREDIT_WINDOW });
  assert.equal(f.manager.entries.get(f.opened.streamId).credit, VIDEO_CREDIT_WINDOW, 'the whole window is accepted at once');
  f.port.receive({ type: 'credit', count: 1 });
  assert.equal(f.port.messages.at(-1).code, 'invalid_worker_message'); assert.equal(f.manager.entries.size, 0);
  for (const count of [0, -1, 1.5, '1', VIDEO_CREDIT_WINDOW + 1]) {
    f = fixture(t); await turn(); f.port.receive({ type: 'credit', count });
    assert.equal(f.port.messages.at(-1).code, 'invalid_worker_message', `credit ${count} fails closed`);
  }
  assert.ok(ACK_INTERVAL_MS >= 1000 / 30);
  f = fixture(t, { ackInterval: 40 }); await turn(); const c = f.connections[0];
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0)); f.port.receive({ type: 'credit', count: 1 });
  c.feed(record(2, unit, 1, 1)); f.port.receive({ type: 'consumed', sequence: 1, dropped: true }); f.port.receive({ type: 'credit', count: 1 });
  await sleep(10);
  for (let seq = 2; seq <= 6; seq++) { c.feed(record(2, delta, seq)); f.port.receive({ type: 'consumed', sequence: seq, dropped: true }); f.port.receive({ type: 'credit', count: 1 }); }
  await sleep(60);
  assert.ok(f.calls.length <= 2); assert.equal(f.calls.at(-1).body.ack, 6);
  if (f.calls.length === 2) assert.ok(f.calls[1].at - f.calls[0].at >= 35);
});


test('only explicit local restart provenance is transient; matching human text stays permanent', () => {
  const { streamErrorPolicy, frameRequestError } = require('./stream-session.cjs');
  for (const code of ['ORBIT_LOCAL_HOST_RESTARTING', 'ORBIT_LOCAL_HOST_RESTARTED']) {
    assert.equal(streamErrorPolicy(Object.assign(new Error('Generated local restart'), { code })).retryable, true);
    assert.equal(frameRequestError(Object.assign(new Error('Generated local restart'), { code })).error.retryable, true);
    for (const status of [401, 403, 410]) assert.equal(streamErrorPolicy({ code, status }).retryable, false);
  }
  assert.equal(streamErrorPolicy(new Error('The authenticated background host is not ready.')).retryable, false);
  assert.equal(streamErrorPolicy({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }).retryable, false);
});


test('main presentation hook runs only for an actual pending AU, never config/credit/dropped/stale output', async t => {
  const f = fixture(t), presented = []; f.manager.onPresented = entry => presented.push({ owner: entry.owner, monitor: entry.monitorId });
  await turn(); const c = f.connections[0];
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(2, unit, 1, 1));
  f.port.receive({ type: 'consumed', sequence: 1, dropped: true });
  f.port.receive({ type: 'presented', sequence: 1, decodeMs: 1, drawMs: 1 }); assert.equal(presented.length, 0);
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(2, delta, 2));
  f.port.receive({ type: 'presented', sequence: 2, decodeMs: 1, drawMs: 1 }); assert.equal(presented.length, 1);
  f.port.receive({ type: 'presented', sequence: 2, decodeMs: 1, drawMs: 1 }); assert.equal(presented.length, 1);
  f.port.receive({ type: 'credit', count: 1 }); c.feed(record(2, delta, 3));
  c.feed(record(1, config, 0));
  f.port.receive({ type: 'presented', sequence: 3, decodeMs: 1, drawMs: 1 }); assert.equal(presented.length, 1);
});


test('video410 preserves an ordinary stopping target, but security terminals delete it', async t => {
  for (const code of ['session_ended_by_host', 'access_revoked', 'permission_changed', 'identity_rotated']) {
    const f = fixture(t); await turn();
    f.controller.reconnectTargets = new Map([['local-1', { deviceId: 'paired' }]]);
    f.controller.canReconnect = id => !f.controller.sessions.has(id) && f.controller.reconnectTargets.has(id);
    f.connections[0].feed(record(1, config, 0));
    f.connections[0].feed(record(4, { code, error: 'Generated terminal' }, 1));
    assert.equal(f.controller.sessions.size, 0);
    assert.equal(f.controller.reconnectTargets.has('local-1'), code === 'session_ended_by_host');
    assert.equal(f.port.messages.at(-1).canReconnect, code === 'session_ended_by_host');
  }
});


async function until(predicate, cycles = 100) { for (let i = 0; i < cycles; i++) { if (predicate()) return; await sleep(5); } assert.ok(predicate(), 'bounded fixture wait timed out'); }

test('quality settings coalesce while one control POST is pending without losing ACK or keyframe', async t => {
  const f = fixture(t); await turn(); let release, active = 0, peak = 0;
  const gate = new Promise(resolve => { release = resolve; });
  f.controller.remote = async (_device, route, request) => { active++; peak = Math.max(peak, active); f.calls.push({ route, body: request.body }); if (f.calls.length === 1) await gate; active--; return {}; };
  f.port.receive({ type: 'settings', scale: .5 }); await until(() => f.calls.length === 1);
  const entry = f.manager.entries.get(f.opened.streamId);
  f.port.receive({ type: 'settings', scale: .75 }); f.port.receive({ type: 'settings', scale: 1 });
  f.port.receive({ type: 'credit', count: 1 }); f.connections[0].feed(record(1, config, 0));
  f.port.receive({ type: 'credit', count: 1 }); f.connections[0].feed(record(2, unit, 1, 1));
  f.port.receive({ type: 'keyframe-needed', reason: 'fixture' });
  release(); await until(() => f.calls.length === 2); await turn();
  assert.equal(peak, 1); assert.equal(f.calls[0].body.scale, .5); assert.equal(f.calls[1].body.scale, 1);
  assert.equal(f.calls[1].body.ack, 1); assert.equal(f.calls[1].body.keyframe, true);
  assert.equal(f.manager.entries.get(f.opened.streamId), entry); assert.equal(f.connections.length, 1); assert.equal(f.controller.sessions.size, 1);
});

test('quality selected before GET construction starts at the latest scale without a redundant control POST', async t => {
  let connect, route; const gate = new Promise(resolve => { connect = resolve; });
  const f = fixture(t, { remoteStream: (_device, _identity, value) => { route = value; return gate; } });
  f.port.receive({ type: 'settings', scale: .5 }); f.port.receive({ type: 'settings', scale: .75 });
  await turn(); assert.equal(new URL('https://generated' + route).searchParams.get('scale'), '0.75');
  assert.equal(f.calls.length, 0);
  connect({ done: new Promise(() => {}), resume() {}, abort() {} });
  await turn(); await sleep(45);
  assert.equal(f.calls.length, 0, 'the GET already requests the latest quality');
  assert.equal(f.manager.entries.get(f.opened.streamId).settings.scale, .75);
});

test('quality selected after GET construction waits for GET200 and sends only its latest value', async t => {
  let connect, route; const gate = new Promise(resolve => { connect = resolve; });
  const f = fixture(t, { remoteStream: (_device, _identity, value) => { route = value; return gate; } });
  await turn(); assert.equal(new URL('https://generated' + route).searchParams.get('scale'), '1');
  f.port.receive({ type: 'settings', scale: .5 }); f.port.receive({ type: 'settings', scale: .75 });
  await turn(); assert.equal(f.calls.length, 0, 'settings cannot address a run before GET200');
  connect({ done: new Promise(() => {}), resume() {}, abort() {} });
  await until(() => f.calls.length === 1); assert.equal(f.calls[0].body.scale, .75);
  assert.equal(f.manager.entries.size, 1);
});

test('malformed or extra authority fields in quality messages never reach the remote API', async t => {
  for (const message of [{ type: 'settings', scale: NaN }, { type: 'settings', scale: '0.5' }, { type: 'settings', scale: 2 },
    { type: 'settings', scale: .5, streamId: 'another' }, { type: 'settings', scale: .5, monitorId: 'display-2' }, { type: 'settings', scale: .5, sessionId: 'other' }]) {
    const f = fixture(t); await turn(); f.port.receive(message); await turn();
    assert.equal(f.calls.length, 0); assert.equal(f.port.closed, true); assert.equal(f.controller.sessions.size, 1);
  }
});

test('native pause drops queued quality work and a late old POST failure cannot touch a replacement stream', async t => {
  const f = fixture(t); await turn(); let fail;
  const gate = new Promise((_resolve, reject) => { fail = reject; });
  f.controller.remote = async (_device, route, request) => { f.calls.push({ route, body: request.body }); if (f.calls.length === 1) return gate; return {}; };
  f.port.receive({ type: 'settings', scale: .5 }); await until(() => f.calls.length === 1);
  f.port.receive({ type: 'settings', scale: 1 }); f.manager.pauseOwner(1, { paused: true, reason: 'minimized', revision: 1 });
  const nextPort = new Port(), next = f.manager.open({ sessionId: 'local-1', monitorId: '' }, nextPort, 1); await turn();
  fail(Object.assign(new Error('Old transport failed'), { code: 'ECONNRESET' })); await sleep(60);
  assert.equal(f.calls.length, 1); assert.equal(f.manager.entries.has(next.streamId), true); assert.equal(nextPort.closed, false);
});


test('quality preempts a throttled keyframe timer while keeping the keyframe request bounded', async t => {
  const f = fixture(t); await turn();
  f.port.receive({ type: 'keyframe-needed', reason: 'first' }); await until(() => f.calls.length === 1);
  f.port.receive({ type: 'keyframe-needed', reason: 'second' });
  const requestedAt = performance.now(); f.port.receive({ type: 'settings', scale: .5 });
  await until(() => f.calls.length >= 2, 30);
  assert.equal(f.calls[1].body.scale, .5); assert.equal(f.calls[1].body.keyframe, undefined);
  assert.ok(f.calls[1].at - requestedAt < 150, 'quality uses normal control cadence instead of the500ms keyframe wait');
  assert.equal(f.manager.entries.get(f.opened.streamId).keyframe, true, 'the throttled refresh remains pending');
});


test('replacement GET waits for a delayed successful old quality POST so it cannot configure the new run', async t => {
  const f = fixture(t); await turn(); let release, replacementOpened = false, oldAppliedAfterReplacement = false;
  const gate = new Promise(resolve => { release = resolve; });
  const originalOpen = f.manager.openRemote;
  f.manager.openRemote = async (...args) => { replacementOpened = true; return originalOpen(...args); };
  f.controller.remote = async (_device, route, request) => {
    f.calls.push({ route, body: request.body });
    if (f.calls.length === 1) { await gate; oldAppliedAfterReplacement = replacementOpened; }
    return {};
  };
  f.port.receive({ type: 'settings', scale: .5 }); await until(() => f.calls.length === 1);
  f.manager.close(f.opened.streamId, 1);
  const nextPort = new Port(), next = f.manager.open({ sessionId: 'local-1', monitorId: '' }, nextPort, 1);
  await turn(); assert.equal(replacementOpened, false); assert.equal(f.connections.length, 1);
  release(); await until(() => replacementOpened);
  assert.equal(oldAppliedAfterReplacement, false); assert.equal(f.manager.entries.has(next.streamId), true);
  nextPort.receive({ type: 'settings', scale: 1 }); await until(() => f.calls.length === 2);
  assert.equal(f.calls[1].body.scale, 1); assert.equal(f.manager.controlFlights.size, 0);
});

const capacityText = 'Video is busy. Up to 4 screens per device and 8 per host can use video. Close a screen or try again later.';
test('typed HTTP429 stream capacity stays nonterminal and preserves its truthful bounded message', async t => {
  const f = fixture(t); await turn();
  f.connections[0].fail(Object.assign(new Error('untrusted detailed server text'), { status: 429, code: 'stream_capacity' }));
  await turn();
  const result = f.port.messages.find(message => message.type === 'status' && message.state === 'fallback');
  assert.equal(result.code, 'stream_capacity'); assert.equal(result.retryable, true); assert.equal(result.status, 429);
  assert.equal(result.error, capacityText); assert.equal(f.controller.sessions.get('local-1'), f.session); assert.equal(f.ended.length, 0);
});
test('synchronous capacity open preserves metadata while terminal authority takes precedence', () => {
  const { streamOpenError } = require('./stream-session.cjs');
  const result = streamOpenError({ code: 'stream_capacity', status: 429, message: 'raw remote text' });
  assert.deepEqual(result.error, { code: 'stream_capacity', status: 429, retryable: true, message: capacityText });
  for (const status of [401, 403, 410]) {
    const ended = streamOpenError({ code: 'stream_capacity', status, message: 'Denied' });
    assert.notEqual(ended.error.code, 'stream_capacity'); assert.equal(ended.error.retryable, false);
  }
  assert.equal(streamOpenError({ code: 'stream_capacity', status: 503, message: 'Other failure' }).error.code, 'stream_open_denied');
  assert.equal(streamOpenError({ code: 'stream_capacity', status: 429 }, 'Ended by owner').error.retryable, false);
});
