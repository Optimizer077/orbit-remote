'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OrbitStreamParser, StreamProtocolError, parseConfig, MAX_ACCESS_UNIT } = require('./stream-parser.cjs');

const config = { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
  physicalLeft: -1920, physicalTop: 0, physicalWidth: 1920, physicalHeight: 1080,
  scale: 1, fps: 60, monitorId: 'display-1' };
const unit = Buffer.from([0, 0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2, 0, 0, 1, 0x65, 3]);
function record(type, value, sequence = 0, timestamp = 100n, flags = 0) {
  const body = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value === undefined ? '' : JSON.stringify(value));
  const header = Buffer.alloc(24);
  header[0] = type; header[1] = flags; header.writeUInt32LE(body.length, 4); header.writeUInt32LE(sequence, 8); header.writeBigUInt64LE(timestamp, 16);
  return Buffer.concat([header, body]);
}
const key = (sequence = 1, timestamp = 100n) => record(2, unit, sequence, timestamp, 1);
function parserFixture() {
  const records = [];
  const parser = new OrbitStreamParser({ monitorId: 'display-1', onRecord: value => records.push(value) });
  return { parser, records };
}
function rejectsHeader(change, first = false) {
  const { parser } = parserFixture();
  if (!first) parser.push(record(1, config));
  const bytes = first ? record(1, config) : key(); change(bytes);
  assert.throws(() => parser.push(bytes), StreamProtocolError);
  assert.equal(parser.payload, null, 'a failed record releases its bounded payload');
  assert.throws(() => parser.push(new Uint8Array()), /closed/);
}

test('records survive every split and byte-at-a-time TCP fragmentation without pooled-buffer exposure', () => {
  const stream = Buffer.concat([record(1, config), key(), record(3, undefined, 2, 200n),
    record(4, { code: 'session_ended_by_host', error: 'Session ended by host.' }, 3, 200n)]);
  for (let split = 0; split <= stream.length; split++) {
    const { parser, records } = parserFixture();
    parser.push(stream.subarray(0, split)); parser.push(stream.subarray(split));
    assert.deepEqual(records.map(r => r.type), ['config', 'access-unit', 'heartbeat', 'terminal']);
    assert.equal(records[1].data.byteLength, unit.length);
    assert.deepEqual(new Uint8Array(records[1].data), new Uint8Array(unit));
    assert.deepEqual(parser.finish(), { terminal: true, transient: false, partial: false });
  }
  const { parser, records } = parserFixture();
  for (const byte of stream) parser.push(Uint8Array.of(byte));
  assert.equal(records.length, 4);
  assert.equal(records[0].config.physicalLeft, -1920);
});

test('header validation rejects unknown types, reserved bits, flags and lengths before allocation', () => {
  rejectsHeader(bytes => { bytes[0] = 9; });
  rejectsHeader(bytes => { bytes[1] = 2; });
  rejectsHeader(bytes => { bytes[2] = 1; });
  rejectsHeader(bytes => { bytes[12] = 1; });
  rejectsHeader(bytes => { bytes.writeUInt32LE(MAX_ACCESS_UNIT + 1, 4); });
  rejectsHeader(bytes => { bytes.writeUInt32LE(0, 4); });
  rejectsHeader(bytes => { bytes.writeUInt32LE(4097, 4); }, true);
  rejectsHeader(bytes => { bytes[1] = 1; }, true);
});

test('sequence starts at zero and cannot repeat, skip, wrap or outrun safe timestamps', () => {
  rejectsHeader(bytes => { bytes.writeUInt32LE(1, 8); }, true);
  rejectsHeader(bytes => { bytes.writeUInt32LE(0, 8); });
  rejectsHeader(bytes => { bytes.writeUInt32LE(2, 8); });
  rejectsHeader(bytes => { bytes.writeBigUInt64LE(99n, 16); });
  rejectsHeader(bytes => { bytes.writeBigUInt64LE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 16); });
  const { parser } = parserFixture(); parser.push(record(1, config));
  parser.nextSequence = 0xffffffff; // Reach the multi-year rollover boundary without emitting billions of frames.
  assert.throws(() => parser.push(key(0xffffffff)), /sequence/);
});

test('configuration is bounded, tied to the chosen monitor and distinguishes encoded and physical geometry', () => {
  const scaled = parseConfig({ ...config, width: 960, height: 540, codedWidth: 960, codedHeight: 544, scale: .5 }, 'display-1');
  assert.equal(scaled.physicalWidth, 1920);
  assert.deepEqual(scaled.colorSpace, { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
  for (const invalid of [{ width: 9000 }, { height: 0 }, { width: 8192, height: 8192 }, { codedWidth: 1937 },
    { codedHeight: 1000 }, { physicalWidth: 0 }, { physicalTop: 2 ** 31 }, { physicalLeft: '0' }, { scale: .2 },
    { scale: .5 }, { fps: 0 }, { fps: 241 }, { codec: 'avc1.4d4028' }, { codec: 'vp09.00.10.08' },
    { monitorId: 'other' }, { monitorId: 'display\n1' }, { monitorId: 'x'.repeat(129) }, { unexpected: true }, { capturedUtc: 'bad date' },
    { colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true } }])
    assert.throws(() => parseConfig({ ...config, ...invalid }, 'display-1'), StreamProtocolError);
  const { parser } = parserFixture();
  assert.throws(() => parser.push(record(1, new Uint8Array([0xc3, 0x28]))), /JSON or UTF-8/);
});

test('video needs config and a keyframe after every config, while heartbeat has exactly zero body and flags', () => {
  let fixture = parserFixture();
  assert.throws(() => fixture.parser.push(key(0)), /configuration must come first/);
  fixture = parserFixture(); fixture.parser.push(record(1, config));
  assert.throws(() => fixture.parser.push(record(2, unit, 1)), /keyframe/);
  fixture = parserFixture(); fixture.parser.push(record(1, config)); fixture.parser.push(key());
  fixture.parser.push(record(1, config, 2));
  assert.throws(() => fixture.parser.push(record(2, unit, 3)), /keyframe/);
  fixture = parserFixture(); fixture.parser.push(record(1, config));
  assert.throws(() => fixture.parser.push(record(3, Buffer.from([1]), 1)), /length/);
  fixture = parserFixture(); fixture.parser.push(record(1, config));
  assert.throws(() => fixture.parser.push(record(3, undefined, 1, 100n, 1)), /flags/);
  fixture = parserFixture(); fixture.parser.push(record(1, config));
  assert.throws(() => fixture.parser.push(record(2, Buffer.from([1, 2, 3, 4]), 1, 100n, 1)), /Annex-B/);
});

test('EOF without a terminal discards partial headers/payloads as transient without emitting partial records', () => {
  const bytes = record(1, config);
  for (const length of [1, 23, 24, bytes.length - 1]) {
    const { parser, records } = parserFixture(); parser.push(bytes.subarray(0, length));
    assert.deepEqual(parser.finish(), { terminal: false, transient: true, partial: true });
    assert.equal(records.length, 0);
    assert.equal(parser.payload, null);
    assert.throws(() => parser.push(bytes), /closed/);
  }
  const { parser } = parserFixture(); parser.push(bytes);
  assert.deepEqual(parser.finish(), { terminal: false, transient: true, partial: false });
});

test('terminal is final across chunks, its JSON is bounded and no bytes after it are accepted', () => {
  let { parser, records } = parserFixture(); parser.push(record(1, config));
  parser.push(record(4, { code: 'access_revoked', error: 'Access ended.' }, 1));
  assert.equal(records.at(-1).type, 'terminal');
  assert.equal(records.at(-1).code, 'access_revoked');
  assert.throws(() => parser.push(Uint8Array.of(0)), /after terminal/);
  ({ parser } = parserFixture()); parser.push(record(1, config));
  assert.throws(() => parser.push(record(4, { code: 'revoked', error: 'x'.repeat(1100) }, 1)), /length/);
  ({ parser } = parserFixture()); parser.push(record(1, config));
  assert.throws(() => parser.push(record(4, { code: '../bad', error: '' }, 1)), /terminal/);
  ({ parser } = parserFixture()); parser.push(record(1, config));
  parser.nextSequence = 0xffffffff;
  parser.push(record(4, { code: 'stream_restart', error: '' }, 0xffffffff));
  assert.equal(parser.finish().terminal, true);
});

test('terminal enum is preserved, unknown bounded codes become stream_error, and human text stops at500chars', () => {
  for (const code of ['session_ended', 'session_ended_by_host', 'access_revoked', 'permission_changed',
    'identity_rotated', 'host_stopping', 'stream_replaced', 'stream_restart', 'stream_error', 'future_failure']) {
    const { parser, records } = parserFixture(); parser.push(record(1, config));
    parser.push(record(4, { code, error: 'x'.repeat(500) }, 1));
    assert.equal(records.at(-1).code, code === 'future_failure' ? 'stream_error' : code);
    assert.equal(records.at(-1).error.length, 500);
  }
  const { parser } = parserFixture(); parser.push(record(1, config));
  assert.throws(() => parser.push(record(4, { code: 'stream_error', error: 'x'.repeat(501) }, 1)), /terminal/);
});
