'use strict';

const HEADER_BYTES = 24;
const MAX_ACCESS_UNIT = 8 * 1024 * 1024;
const MAX_PIXELS = 33_554_432;
const MAX_CURSOR_BYTES = 64 * 1024;
const COLOR_SPACE = Object.freeze({ primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false });
const TERMINAL_CODES = new Set(['session_ended', 'session_ended_by_host', 'access_revoked', 'permission_changed',
  'identity_rotated', 'host_stopping', 'stream_replaced', 'stream_restart', 'stream_error', 'display_asleep']);
const CONFIG_FIELDS = new Set(['codec', 'width', 'height', 'codedWidth', 'codedHeight', 'physicalLeft', 'physicalTop',
  'physicalWidth', 'physicalHeight', 'scale', 'fps', 'monitorId', 'colorSpace', 'capturedUtc']);

class StreamProtocolError extends Error {
  constructor(reason) { super(reason); this.name = 'StreamProtocolError'; this.code = 'stream_protocol_error'; }
}
const invalid = reason => { throw new StreamProtocolError(reason); };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function jsonPayload(bytes) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid('Invalid stream JSON or UTF-8.'); }
}

function parseConfig(value, monitorId) {
  if (!plainObject(value) || Object.keys(value).some(key => !CONFIG_FIELDS.has(key))) invalid('Invalid stream configuration fields.');
  if (typeof value.codec !== 'string' || !/^avc1\.[0-9A-F]{6}$/.test(value.codec)) invalid('Unsupported stream codec.');
  if (!integer(value.width, 1, 8192) || !integer(value.height, 1, 8192) || value.width * value.height > MAX_PIXELS
    || !integer(value.codedWidth, value.width, value.width + 16) || !integer(value.codedHeight, value.height, value.height + 16))
    invalid('Invalid encoded stream dimensions.');
  if (!integer(value.physicalLeft, -2147483648, 2147483647) || !integer(value.physicalTop, -2147483648, 2147483647)
    || !integer(value.physicalWidth, 1, MAX_PIXELS) || !integer(value.physicalHeight, 1, MAX_PIXELS)
    || value.physicalWidth * value.physicalHeight > MAX_PIXELS) invalid('Invalid physical stream geometry.');
  if (typeof value.scale !== 'number' || !Number.isFinite(value.scale) || value.scale < .33 || value.scale > 1
    || Math.abs(value.width - Math.round(value.physicalWidth * value.scale)) > 1
    || Math.abs(value.height - Math.round(value.physicalHeight * value.scale)) > 1) invalid('Invalid stream scale or geometry mapping.');
  if (typeof value.fps !== 'number' || !Number.isFinite(value.fps) || value.fps < 1 || value.fps > 240) invalid('Invalid stream frame rate.');
  if (typeof value.monitorId !== 'string' || !value.monitorId || value.monitorId.length > 128 || /[\x00-\x1f\x7f]/.test(value.monitorId)
    || value.monitorId !== monitorId) invalid('Stream belongs to another remote monitor.');
  if (value.capturedUtc !== undefined && (typeof value.capturedUtc !== 'string' || value.capturedUtc.length > 64
    || !Number.isFinite(Date.parse(value.capturedUtc)))) invalid('Invalid stream capture metadata.');
  if (value.colorSpace !== undefined && (!plainObject(value.colorSpace) || Object.keys(value.colorSpace).length !== 4
    || Object.entries(COLOR_SPACE).some(([key, expected]) => value.colorSpace[key] !== expected))) invalid('Unsupported stream color space.');
  return Object.freeze({ ...value, colorSpace: COLOR_SPACE });
}

function cursorPng(value, width, height) {
  if (typeof value !== 'string' || value.length > MAX_CURSOR_BYTES || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid('Invalid cursor PNG encoding.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height
    || bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) invalid('Invalid cursor PNG dimensions or format.');
  const crc = (start, end) => { let c = 0xffffffff; for (let i = start; i < end; i++) { c ^= bytes[i]; for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  if (crc(12, 29) !== bytes.readUInt32BE(29)) invalid('Invalid cursor PNG checksum.');
  let offset = 33, sawData = false, finished = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12 || !['IDAT', 'IEND'].includes(kind) || finished) invalid('Invalid cursor PNG chunks.');
    if (crc(offset + 4, offset + 8 + length) !== bytes.readUInt32BE(offset + 8 + length)) invalid('Invalid cursor PNG checksum.');
    if (kind === 'IDAT') sawData = true;
    else { if (length !== 0 || !sawData) invalid('Invalid cursor PNG end.'); finished = true; }
    offset += 12 + length;
  }
  if (!finished || offset !== bytes.length) invalid('Invalid cursor PNG termination.');
}

// NAL units examined per access unit. The host sends one picture per record (a few parameter sets plus its slices).
const MAX_NAL_UNITS = 512;
const START_CODE = Buffer.from([0, 0, 1]);

// The keyframe flag must match the bitstream: a keyframe holds an IDR slice (5) and no non-IDR slice (1); a delta holds
// no IDR slice. Other NAL types (SPS 7, PPS 8, SEI 6, AUD 9, ...) may appear in either. Only NAL header bytes are read,
// from a view over the received payload (no copy); emulation prevention keeps 00 00 01 out of NAL payloads.
function checkAccessUnitSlices(payload, keyframe) {
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  let idr = false, count = 0;
  for (let at = bytes.indexOf(START_CODE); at !== -1 && at + 3 < bytes.length; at = bytes.indexOf(START_CODE, at + 3)) {
    if (++count > MAX_NAL_UNITS) invalid('Stream access unit has too many NAL units.');
    const header = bytes[at + 3], nalType = header & 0x1f;
    if (header & 0x80) invalid('Stream access unit has a forbidden NAL header bit.');
    if (nalType === 5) { if (!keyframe) invalid('Stream delta access unit carries an IDR slice.'); idr = true; }
    else if (nalType === 1 && keyframe) invalid('Stream keyframe access unit carries a non-IDR slice.');
  }
  if (keyframe && !idr) invalid('Stream keyframe access unit has no IDR slice.');
}

// Shapes the viewer keeps per config. The host never relies on more than this many (docs/PROTOCOL.md, type 5).
const MAX_CURSOR_SHAPES = 64;

function parseCursor(value, config, shapes) {
  if (!plainObject(value) || Object.keys(value).some(key => !['x', 'y', 'visible', 'shapeId', 'shape'].includes(key)) || !config
    || !integer(value.x, -2147483648, 2147483647) || !integer(value.y, -2147483648, 2147483647)
    || value.x < config.physicalLeft || value.x >= config.physicalLeft + config.physicalWidth || value.y < config.physicalTop || value.y >= config.physicalTop + config.physicalHeight
    || typeof value.visible !== 'boolean' || typeof value.shapeId !== 'string' || !value.shapeId || value.shapeId.length > 128 || /[\x00-\x1f\x7f]/.test(value.shapeId)) invalid('Invalid cursor position or shape identity.');
  if (value.shape !== undefined) {
    const s = value.shape;
    if (!plainObject(s) || Object.keys(s).some(key => !['width', 'height', 'hotX', 'hotY', 'kind', 'pngBase64', 'invertPngBase64'].includes(key))
      || !integer(s.width, 1, 256) || !integer(s.height, 1, 256) || !integer(s.hotX, 0, s.width - 1) || !integer(s.hotY, 0, s.height - 1)
      || !['color', 'masked', 'mono'].includes(s.kind) || (s.invertPngBase64 !== undefined && s.kind === 'color')) invalid('Invalid cursor shape.');
    cursorPng(s.pngBase64, s.width, s.height);
    if (s.invertPngBase64 !== undefined) cursorPng(s.invertPngBase64, s.width, s.height);
    const known = shapes.get(value.shapeId);
    if (known && ['width', 'height', 'hotX', 'hotY', 'kind', 'pngBase64', 'invertPngBase64'].some(key => known[key] !== s[key])) invalid('Cursor shape changed without a new identity.');
  } else if (!shapes.has(value.shapeId)) invalid('Unknown cursor shape without a definition.');
  return value;
}

// A single bounded payload is allocated only after its header passes validation.
// Records are delivered synchronously, without an accumulating output array.
// The future transport consumer supplies credits/backpressure across IPC.
class OrbitStreamParser {
  constructor({ monitorId, onRecord, allowCursor = false }) {
    if (typeof monitorId !== 'string' || !monitorId || monitorId.length > 128 || typeof onRecord !== 'function')
      throw new TypeError('A selected monitor and record consumer are required.');
    this.monitorId = monitorId; this.onRecord = onRecord;
    this.allowCursor = allowCursor === true; this.config = null; this.cursorShapes = new Map(); this.cursorShapeId = null;
    this.header = Buffer.alloc(HEADER_BYTES); this.headerUsed = 0;
    this.payload = null; this.payloadUsed = 0; this.record = null;
    this.nextSequence = 0; this.lastTimestamp = 0n; this.configured = false; this.needsKeyframe = true;
    this.terminal = false; this.closed = false; this.failed = false;
  }

  push(chunk) {
    if (this.closed || this.failed) invalid('Stream parser is closed.');
    if (!(chunk instanceof Uint8Array)) throw new TypeError('Stream chunks must be binary.');
    try {
      for (let offset = 0; offset < chunk.byteLength;) {
        if (this.terminal) invalid('Bytes received after terminal stream record.');
        if (this.headerUsed < HEADER_BYTES) {
          const count = Math.min(HEADER_BYTES - this.headerUsed, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + count), this.headerUsed);
          this.headerUsed += count; offset += count;
          if (this.headerUsed !== HEADER_BYTES) continue;
          this.beginRecord();
          if (this.record.length === 0) { this.completeRecord(); continue; }
        }
        const count = Math.min(this.record.length - this.payloadUsed, chunk.byteLength - offset);
        this.payload.set(chunk.subarray(offset, offset + count), this.payloadUsed);
        this.payloadUsed += count; offset += count;
        if (this.payloadUsed === this.record.length) this.completeRecord();
      }
    } catch (error) {
      this.failed = true; this.payload = null; this.record = null;
      throw error;
    }
  }

  beginRecord() {
    const type = this.header[0], flags = this.header[1];
    const length = this.header.readUInt32LE(4), sequence = this.header.readUInt32LE(8), timestamp = this.header.readBigUInt64LE(16);
    if (![1, 2, 3, 4, 5].includes(type) || (type === 5 && !this.allowCursor) || this.header.readUInt16LE(2) !== 0 || this.header.readUInt32LE(12) !== 0
      || (type === 2 ? flags & ~1 : flags !== 0)) invalid('Invalid stream record type, flags or reserved bits.');
    if (sequence !== this.nextSequence || (sequence === 0xffffffff && type !== 4)) invalid('Stream record sequence gap, repeat or wrap.');
    if (timestamp < this.lastTimestamp || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) invalid('Invalid stream timestamp.');
    const limit = ({ 1: 4096, 2: MAX_ACCESS_UNIT, 3: 0, 4: 1024, 5: MAX_CURSOR_BYTES })[type];
    if (length > limit || (type !== 3 && length === 0)) invalid('Stream record length is outside its limit.');
    if (!this.configured && type !== 1) invalid('Stream configuration must come first.');
    if (type === 2 && this.needsKeyframe && !(flags & 1)) invalid('Stream configuration must be followed by a keyframe.');
    this.record = { type, flags, length, sequence, timestamp: Number(timestamp) };
    // A dedicated ArrayBuffer avoids exposing a pooled Node Buffer slab when a
    // compressed access unit is later transferred to the decoder Worker.
    this.payload = new Uint8Array(length); this.payloadUsed = 0;
  }

  completeRecord() {
    const { type, flags, sequence, timestamp } = this.record;
    const payload = this.payload;
    let delivered;
    if (type === 1) {
      delivered = { type: 'config', config: parseConfig(jsonPayload(payload), this.monitorId), sequence, timestamp };
      this.config = delivered.config; this.cursorShapes.clear(); this.cursorShapeId = null;
      this.configured = true; this.needsKeyframe = true;
    } else if (type === 2) {
      const annexB = payload.length >= 4 && payload[0] === 0 && payload[1] === 0
        && (payload[2] === 1 || (payload.length >= 5 && payload[2] === 0 && payload[3] === 1));
      if (!annexB) invalid('Stream access unit is not Annex-B H.264.');
      checkAccessUnitSlices(payload, !!(flags & 1));
      delivered = { type: 'access-unit', data: payload.buffer, keyframe: !!(flags & 1), sequence, timestamp };
      this.needsKeyframe = false;
    } else if (type === 3) delivered = { type: 'heartbeat', sequence, timestamp };
    else if (type === 5) {
      const cursor = parseCursor(jsonPayload(payload), this.config, this.cursorShapes);
      if (cursor.shape) {
        this.cursorShapes.delete(cursor.shapeId); this.cursorShapes.set(cursor.shapeId, cursor.shape);
        if (this.cursorShapes.size > MAX_CURSOR_SHAPES) this.cursorShapes.delete(this.cursorShapes.keys().next().value);
      } else if (cursor.shapeId !== this.cursorShapeId) {
        // Back to a shape defined earlier in this config: consumers keep only the current shape, so attach it again.
        cursor.shape = this.cursorShapes.get(cursor.shapeId);
      }
      this.cursorShapeId = cursor.shapeId;
      delivered = { type: 'cursor', cursor, sequence, timestamp };
    } else {
      const value = jsonPayload(payload);
      if (!plainObject(value) || Object.keys(value).some(key => !['code', 'error'].includes(key))
        || typeof value.code !== 'string' || !/^[a-z0-9_]{1,80}$/.test(value.code)
        || typeof value.error !== 'string' || value.error.length > 500) invalid('Invalid terminal stream record.');
      delivered = { type: 'terminal', code: TERMINAL_CODES.has(value.code) ? value.code : 'stream_error', error: value.error, sequence, timestamp };
      this.terminal = true;
    }
    this.nextSequence = sequence + 1; this.lastTimestamp = BigInt(timestamp);
    this.headerUsed = 0; this.payloadUsed = 0; this.payload = null; this.record = null;
    this.onRecord(delivered);
  }

  finish() {
    if (this.failed) invalid('Stream parser failed before EOF.');
    const result = { terminal: this.terminal, transient: !this.terminal, partial: this.headerUsed !== 0 || this.payload !== null };
    this.closed = true; this.payload = null; this.record = null; this.headerUsed = 0; this.payloadUsed = 0;
    return result;
  }
}

module.exports = { OrbitStreamParser, StreamProtocolError, parseConfig, parseCursor, HEADER_BYTES, MAX_ACCESS_UNIT, MAX_CURSOR_BYTES, MAX_NAL_UNITS, COLOR_SPACE };
