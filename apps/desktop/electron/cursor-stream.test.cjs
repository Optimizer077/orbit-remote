'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { deflateSync, crc32 } = require('node:zlib');
const { OrbitStreamParser, StreamProtocolError } = require('./stream-parser.cjs');
const { SessionVideoStreams } = require('./stream-session.cjs');
const turn = () => new Promise(resolve => setImmediate(resolve));
const config = { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
  physicalLeft: -1920, physicalTop: 5, physicalWidth: 1920, physicalHeight: 1080, scale: 1, fps: 60, monitorId: 'screen' };
function png(width = 1, height = 1) {
  const chunk = (kind, data) => { const body = Buffer.concat([Buffer.from(kind), data]), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), data.length + 8); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const shape = { width: 1, height: 1, hotX: 0, hotY: 0, kind: 'color', pngBase64: png() };
const pointer = (x = -1000, shapeId = 'shape-1', withShape = false) => ({ x, y: 100, visible: true, shapeId, ...(withShape ? { shape } : {}) });
function wire(type, value, sequence, flags = 0) {
  const body = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(24); header[0] = type; header[1] = flags; header.writeUInt32LE(body.length, 4); header.writeUInt32LE(sequence, 8); header.writeBigUInt64LE(BigInt(sequence), 16);
  return Buffer.concat([header, body]);
}
function parser() { const records = [], value = new OrbitStreamParser({ monitorId: 'screen', allowCursor: true, onRecord: record => records.push(record) }); value.push(wire(1, config, 0)); return { value, records }; }

test('negotiated pointer uses physical negative-origin hotspot and bounded RGBA/invert shapes', () => {
  const f = parser();
  f.value.push(wire(5, { ...pointer(-1000, 'mono', true), shape: { ...shape, kind: 'mono', invertPngBase64: png() } }, 1));
  f.value.push(wire(5, pointer(-999, 'mono'), 2));
  f.value.push(wire(5, { ...pointer(-999, 'hidden-1', true), visible: false }, 3));
  assert.equal(f.records.length, 4); assert.equal(f.records[1].cursor.x, -1000);
  assert.equal(f.records[1].cursor.shape.kind, 'mono'); assert.equal(f.records[2].cursor.shape, undefined);
});
test('non-negotiated type5, nonzero flags and oversized cursor lengths fail before payload allocation', () => {
  const old = new OrbitStreamParser({ monitorId: 'screen', onRecord: () => {} }); old.push(wire(1, config, 0));
  assert.throws(() => old.push(wire(5, pointer(-1000, 'a', true), 1)), StreamProtocolError);
  for (const mutate of [header => header[1] = 1, header => header.writeUInt32LE(65537, 4)]) {
    const f = parser(), bytes = wire(5, pointer(-1000, 'a', true), 1); mutate(bytes);
    assert.throws(() => f.value.push(bytes), StreamProtocolError); assert.equal(f.value.payload, null);
  }
});
for (const [name, value] of [
  ['outside monitor', { ...pointer(-1, 'a', true), x: 0 }], ['empty hidden id', { ...pointer(-1000, '', true), visible: false }],
  ['unknown id', pointer()], ['too wide', { ...pointer(-1000, 'a', true), shape: { ...shape, width: 257 } }],
  ['invalid hotspot', { ...pointer(-1000, 'a', true), shape: { ...shape, hotX: 1 } }],
  ['PNG geometry mismatch', { ...pointer(-1000, 'a', true), shape: { ...shape, pngBase64: png(2, 1) } }],
  ['color inversion', { ...pointer(-1000, 'a', true), shape: { ...shape, invertPngBase64: png() } }],
  ['unknown shape field', { ...pointer(-1000, 'a', true), shape: { ...shape, uri: 'https://invalid.test' } }],
]) test(`cursor rejects ${name}`, () => { const f = parser(); assert.throws(() => f.value.push(wire(5, value, 1)), StreamProtocolError); });
test('configuration clears the shape cache and identity cannot silently change its bitmap', () => {
  const f = parser(); f.value.push(wire(5, pointer(-1000, 'a', true), 1));
  f.value.push(wire(1, config, 2)); assert.throws(() => f.value.push(wire(5, pointer(-1000, 'a'), 3)), /Unknown/);
  const g = parser(); g.value.push(wire(5, pointer(-1000, 'a', true), 1));
  assert.throws(() => g.value.push(wire(5, { ...pointer(-1000, 'a', true), shape: { ...shape, kind: 'masked' } }, 2)), /identity/);
});
test('returning to an earlier shape in the same config re-attaches its definition (arrow -> I-beam -> arrow)', () => {
  const f = parser(), beam = { ...shape, width: 2, height: 2, pngBase64: png(2, 2) };
  f.value.push(wire(5, pointer(-1000, 'arrow', true), 1));
  f.value.push(wire(5, { ...pointer(-990, 'beam'), shape: beam }, 2));
  f.value.push(wire(5, pointer(-980, 'arrow'), 3));
  f.value.push(wire(5, pointer(-970, 'arrow'), 4));
  const cursors = f.records.filter(r => r.type === 'cursor').map(r => r.cursor);
  assert.deepEqual(cursors.map(c => [c.shapeId, c.shape?.width]), [['arrow', 1], ['beam', 2], ['arrow', 1], ['arrow', undefined]]);
});
test('the shape cache is bounded to 64 per config: the oldest definition is evicted', () => {
  const f = parser();
  for (let i = 0; i <= 64; i++) f.value.push(wire(5, pointer(-1000, 's' + i, true), i + 1));
  f.value.push(wire(5, pointer(-1000, 's1'), 66));
  assert.throws(() => f.value.push(wire(5, pointer(-1000, 's0'), 67)), /Unknown/);
  // Re-defining an id refreshes it: after s0..s63, s0 again, then s64, the oldest is s1 (the host's bound relies on this).
  const g = parser(); let sequence = 1;
  for (let i = 0; i < 64; i++) g.value.push(wire(5, pointer(-1000, 's' + i, true), sequence++));
  g.value.push(wire(5, pointer(-1000, 's0', true), sequence++)); g.value.push(wire(5, pointer(-1000, 's64', true), sequence++));
  g.value.push(wire(5, pointer(-1000, 's0'), sequence++));
  assert.throws(() => g.value.push(wire(5, pointer(-1000, 's1'), sequence++)), /Unknown/);
});
class Port extends EventEmitter { messages = []; start() {} postMessage(value) { this.messages.push(value); } close() { this.emit('close'); } receive(data) { this.emit('message', { data }); } }
function sessionFixture(t) {
  let now = 0; const calls = []; let connection;
  const session = { device: {}, remoteId: 'remote', closed: false, permissions: { view: true }, canLocalCursor: true,
    monitors: [{ id: 'screen', primary: true }], frameSlots: new Map() };
  const controller = { sessions: new Map([['local', session]]), endedSessions: new Map(), allowLoopback: true,
    getSession: () => session, getIdentity: async () => ({}), remote: async (_d, route, options) => { calls.push({ route, body: options.body }); return {}; } };
  const manager = new SessionVideoStreams(controller, { now: () => now, remoteStream: async (_d, _i, route, options) => {
    connection = { route, feed: options.onData, done: new Promise(() => {}), resume() {}, abort() {} }; return connection;
  } });
  const port = new Port(); manager.open({ sessionId: 'local', monitorId: 'screen', cursor: 'local' }, port, 1);
  t.after(() => manager.shutdown());
  return { manager, port, session, calls, entry: () => [...manager.entries.values()][0], connection: () => connection, at: value => now = value };
}
test('cursor bursts retain one outstanding plus one latest slot, carry skipped shape and never consume AU credits/acks', async t => {
  const f = sessionFixture(t); await turn(); const c = f.connection(); assert.match(c.route, /cursor=local/);
  c.feed(wire(1, config, 0)); c.feed(wire(5, pointer(-1000, 'a', true), 1));
  c.feed(wire(5, pointer(-999, 'a'), 2)); assert.equal(f.port.messages.filter(m => m.type === 'cursor').length, 0);
  f.port.receive({ type: 'credit', count: 1 });
  const first = f.port.messages.find(m => m.type === 'cursor'); assert.equal(first.sequence, 2); assert.ok(first.cursor.shape);
  for (let sequence = 3; sequence <= 1000; sequence++) c.feed(wire(5, pointer(-1000 + sequence % 500, 'a'), sequence));
  assert.equal(f.port.messages.filter(m => m.type === 'cursor').length, 1);
  assert.equal(f.entry().pointer.record.sequence, 1000); assert.equal(f.entry().pending.size, 0); assert.equal(f.entry().queue.length, 0);
  assert.equal(f.entry().lastAckSent, -1); assert.equal(f.entry().credit, 0); assert.equal(f.calls.length, 0);
  f.at(100); f.port.receive({ type: 'cursor-consumed', sequence: 2 });
  const latest = f.port.messages.filter(m => m.type === 'cursor').at(-1); assert.equal(latest.sequence, 1000); assert.equal(latest.cursor.shape, undefined);
  assert.equal(f.entry().lastAckSent, -1); assert.equal(f.entry().credit, 0);
});
test('manager delivers a revisited shape with its own definition, never the previous shape (A -> B -> A)', async t => {
  const f = sessionFixture(t); await turn(); const c = f.connection(), beam = { ...shape, width: 2, height: 2, pngBase64: png(2, 2) };
  const cursors = () => f.port.messages.filter(m => m.type === 'cursor');
  c.feed(wire(1, config, 0)); c.feed(wire(5, pointer(-1000, 'a', true), 1)); f.port.receive({ type: 'credit', count: 1 });
  f.at(100); c.feed(wire(5, { ...pointer(-990, 'b'), shape: beam }, 2)); f.port.receive({ type: 'cursor-consumed', sequence: 1 });
  f.at(200); c.feed(wire(5, pointer(-980, 'a'), 3)); f.port.receive({ type: 'cursor-consumed', sequence: 2 });
  assert.deepEqual(cursors().map(m => [m.sequence, m.cursor.shapeId, m.cursor.shape?.width]), [[1, 'a', 1], [2, 'b', 2], [3, 'a', 1]]);
  // Coalesced while one record is outstanding: B is skipped, so A needs no definition again and must not carry B's.
  f.at(300); c.feed(wire(5, pointer(-970, 'b'), 4)); c.feed(wire(5, pointer(-960, 'a'), 5)); f.port.receive({ type: 'cursor-consumed', sequence: 3 });
  assert.deepEqual(cursors().slice(3).map(m => [m.sequence, m.cursor.shapeId, m.cursor.shape?.width]), [[5, 'a', undefined]]);
  // A config reset forgets every shape: a bare id is then a protocol violation.
  f.at(400); f.port.receive({ type: 'cursor-consumed', sequence: 5 }); c.feed(wire(1, config, 6));
  assert.equal(c.feed(wire(5, pointer(-950, 'a'), 7)), false); assert.equal(f.port.messages.at(-1).code, 'stream_protocol_error');
});
test('cursor consumption for a wrong sequence fails closed', async t => {
  const f = sessionFixture(t); await turn(); f.connection().feed(wire(1, config, 0));
  f.connection().feed(wire(5, pointer(-1000, 'a', true), 1)); f.port.receive({ type: 'credit', count: 1 });
  f.port.receive({ type: 'cursor-consumed', sequence: 99 });
  assert.equal(f.manager.entries.size, 0); assert.equal(f.port.messages.at(-1).code, 'invalid_worker_message');
});
test('hidden cursor transition is delivered before a following composited access unit', async t => {
  const f = sessionFixture(t); await turn(); const c = f.connection();
  c.feed(wire(1, config, 0)); c.feed(wire(5, pointer(-1000, 'a', true), 1)); f.port.receive({ type: 'credit', count: 1 });
  c.feed(wire(5, { ...pointer(-1000, 'hidden-1', true), visible: false }, 2));
  c.feed(wire(2, Uint8Array.of(0, 0, 1, 0x65, 1), 3, 1)); f.port.receive({ type: 'credit', count: 1 });
  assert.equal(f.port.messages.filter(message => message.record?.type === 'access-unit').length, 0);
  f.at(100); f.port.receive({ type: 'cursor-consumed', sequence: 1 });
  const messages = f.port.messages;
  const hidden = messages.findIndex(message => message.type === 'cursor' && message.cursor.visible === false);
  const unit = messages.findIndex(message => message.record?.type === 'access-unit');
  assert.ok(hidden >= 0 && unit > hidden); assert.equal(f.entry().pending.size, 1);
});
test('host terminal clears outstanding pointer data, timers and session authority', async t => {
  const f = sessionFixture(t); await turn(); f.connection().feed(wire(1, config, 0));
  f.connection().feed(wire(5, pointer(-1000, 'a', true), 1)); f.port.receive({ type: 'credit', count: 1 });
  const entry = f.entry();
  f.connection().feed(wire(4, { code: 'session_ended_by_host', error: 'Stopped' }, 2));
  assert.equal(f.manager.entries.size, 0); assert.equal(entry.pointer, null); assert.equal(entry.pointerShape, null);
  assert.equal(f.port.messages.at(-1).state, 'ended'); assert.equal(entry.session.closed, true);
  f.port.receive({ type: 'cursor-consumed', sequence: 1 }); assert.equal(f.manager.entries.size, 0);
});
test('local cursor requires stored host capability and old hosts receive no cursor query', async t => {
  const f = sessionFixture(t); await turn(); f.manager.shutdown(); f.session.canLocalCursor = false;
  assert.throws(() => f.manager.open({ sessionId: 'local', cursor: 'local' }, new Port(), 1), /not advertised/);
  f.manager.open({ sessionId: 'local' }, new Port(), 1); await turn();
  assert.equal(new URL('https://example.invalid' + f.connection().route).searchParams.has('cursor'), false);
});
