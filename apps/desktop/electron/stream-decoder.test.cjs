'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamDecoderEngine, DECODER_STALL_MS, MAX_PENDING_FRAMES } = require('../renderer/src/stream/decoder-engine.ts');
const config = { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
  physicalLeft: 0, physicalTop: 0, physicalWidth: 1920, physicalHeight: 1080, scale: 1, fps: 60, monitorId: 'display-1',
  colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
const unit = (sequence, keyframe = false) => ({ type: 'access-unit', sequence, timestamp: sequence * 16000,
  data: new Uint8Array([0, 0, 1, keyframe ? 0x65 : 0x41]).buffer, keyframe });
function fixture({ supports = async () => true, configureThrows = false } = {}) {
  const messages = [], decoders = [], drawn = [], cleared = [];
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage: frame => drawn.push(frame), clearRect: (...args) => cleared.push(args) }) };
  let time = 0;
  const engine = new StreamDecoderEngine(canvas, { post: message => messages.push(message), now: () => time,
    supports, createChunk: value => value, createDecoder: callbacks => {
      const decoder = { callbacks, state: 'unconfigured', decodeQueueSize: 0, chunks: [], closed: 0,
        configure(value) { this.configuration = value; if (configureThrows) throw new Error('Synthetic configuration error'); this.state = 'configured'; },
        decode(value) { this.chunks.push(value); this.decodeQueueSize++; },
        close() { this.closed++; this.state = 'closed'; },
        output(timestamp, width = 1920, height = 1080) {
          this.decodeQueueSize = Math.max(0, this.decodeQueueSize - 1);
          const frame = { timestamp, displayWidth: width, displayHeight: height, closed: 0, close() { this.closed++; } };
          callbacks.output(frame); return frame;
        },
      };
      decoders.push(decoder); return decoder;
    } });
  return { engine, messages, decoders, canvas, drawn, cleared, at: value => { time = value; },
    ofType: type => messages.filter(message => message.type === type) };
}

test('decoder config prefers hardware with explicit BT.709 limited and a delta cannot start playback', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  assert.equal(h.decoders[0].configuration.hardwareAcceleration, 'prefer-hardware');
  assert.equal(h.decoders[0].configuration.optimizeForLatency, true);
  assert.deepEqual(h.decoders[0].configuration.colorSpace, config.colorSpace);
  await h.engine.handle(unit(1));
  assert.equal(h.decoders[0].chunks.length, 0);
  assert.deepEqual(h.ofType('consumed').at(-1), { type: 'consumed', sequence: 1, dropped: true });
  await h.engine.handle(unit(2, true)); h.at(5);
  const frame = h.decoders[0].output(32000);
  assert.equal(h.drawn.length, 1); assert.equal(frame.closed, 1);
  assert.deepEqual([h.canvas.width, h.canvas.height], [1920, 1080]);
  assert.equal(h.ofType('presented')[0].sequence, 2);
  assert.equal(h.ofType('presented')[0].decodeMs, 5);
});

test('overflow closes the decoder, keeps the last image and consumes discarded deltas without growing the queue', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); h.decoders[0].output(16000);
  h.decoders[0].decodeQueueSize = MAX_PENDING_FRAMES;
  await h.engine.handle(unit(2));
  assert.equal(h.decoders[0].closed, 1);
  assert.equal(h.cleared.length, 0, 'a recoverable decoder error retains the last displayed image');
  assert.equal(h.ofType('keyframe-needed').length, 1);
  for (let sequence = 3; sequence <= 20; sequence++) await h.engine.handle(unit(sequence));
  assert.equal(h.decoders.length, 1, 'deltas cannot spin up new decoders');
  assert.ok(h.ofType('consumed').slice(1).every(message => message.dropped));
  assert.equal(h.ofType('keyframe-needed').length, 1, 'keyframe requests are throttled');
  await h.engine.handle(unit(21, true));
  assert.equal(h.decoders.length, 2);
  assert.equal(h.decoders[1].chunks.length, 1);
});

test('a short decoder hiccup (frames waiting under the stall limit) catches up without a recovery', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); h.at(5); h.decoders[0].output(16000);
  for (let sequence = 2; sequence <= 9; sequence++) { h.at(5 + sequence * 16); await h.engine.handle(unit(sequence)); } // 8 waiting, ~130 ms
  h.at(260);
  for (let sequence = 2; sequence <= 9; sequence++) h.decoders[0].output(sequence * 16000);
  assert.equal(h.ofType('keyframe-needed').length, 0);
  assert.equal(h.decoders[0].closed, 0);
  assert.equal(h.ofType('presented').length, 9, 'every frame of the hiccup is still drawn');
});

test('a decoder whose oldest frame waits past the stall limit is replaced with a keyframe request', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); h.decoders[0].output(16000);
  h.at(100); await h.engine.handle(unit(2));
  h.at(100 + DECODER_STALL_MS + 1); await h.engine.handle(unit(3));
  assert.equal(h.decoders[0].closed, 1);
  assert.equal(h.ofType('keyframe-needed').length, 1);
});

test('stale decoder output is closed after reconfiguration and cannot draw into the current canvas', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true));
  await h.engine.handle({ type: 'config', config: { ...config, width: 960, height: 540, codedWidth: 960, codedHeight: 544, scale: .5 } });
  const old = h.decoders[0].output(16000);
  assert.equal(old.closed, 1); assert.equal(h.drawn.length, 0);
  await h.engine.handle(unit(2, true));
  const current = h.decoders[1].output(32000, 960, 540);
  assert.equal(current.closed, 1); assert.equal(h.drawn.length, 1);
  assert.deepEqual([h.canvas.width, h.canvas.height], [960, 540]);
});

test('repeated decoder errors cannot autonomously create decoders or request keyframes faster than twice per second', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  h.decoders[0].callbacks.error(new Error('Synthetic decoder failure'));
  assert.equal(h.decoders.length, 1);
  await h.engine.handle(unit(1, true));
  assert.equal(h.decoders.length, 2);
  h.decoders[1].callbacks.error(new Error('Another failure'));
  h.at(100); await h.engine.handle(unit(2, true));
  assert.equal(h.decoders.length, 2);
  assert.equal(h.ofType('keyframe-needed').length, 1);
  h.at(500); await h.engine.handle(unit(3, true));
  assert.equal(h.decoders.length, 3);
  h.decoders[2].callbacks.error(new Error('Failure at cooldown boundary'));
  assert.equal(h.ofType('keyframe-needed').length, 2);
});

test('an async support result cannot restore a decoder after close or a newer config', async () => {
  const resolvers = [];
  const h = fixture({ supports: () => new Promise(resolve => resolvers.push(resolve)) });
  const first = h.engine.handle({ type: 'config', config });
  const second = h.engine.handle({ type: 'config', config });
  resolvers[0](true); await first; assert.equal(h.decoders.length, 0);
  h.engine.close(); resolvers[1](true); await second;
  assert.equal(h.decoders.length, 0);
  assert.equal(h.ofType('configured').length, 0);
  assert.equal(h.cleared.length, 1);
});

test('unsupported config, synchronous configure failure and terminal shutdown close resources and clear pixels', async () => {
  const unsupported = fixture({ supports: async () => false });
  await unsupported.engine.handle({ type: 'config', config });
  assert.equal(unsupported.decoders.length, 0);
  assert.equal(unsupported.ofType('fault')[0].reason, 'unsupported-decoder-config');
  const failed = fixture({ configureThrows: true });
  await failed.engine.handle({ type: 'config', config });
  assert.equal(failed.decoders[0].closed, 1);
  const h = fixture(); await h.engine.handle({ type: 'config', config }); await h.engine.handle(unit(1, true));
  await h.engine.handle({ type: 'terminal' });
  const late = h.decoders[0].output(16000);
  assert.equal(late.closed, 1); assert.equal(h.drawn.length, 0); assert.equal(h.cleared.length, 1);
  await h.engine.handle(unit(2, true)); assert.equal(h.decoders[0].chunks.length, 1);
});

test('output shape mismatch closes the VideoFrame, resets and never resizes the canvas from decoder output', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config }); await h.engine.handle(unit(1, true));
  const bad = h.decoders[0].output(16000, 8193, 8193);
  assert.equal(bad.closed, 1); assert.equal(h.drawn.length, 0); assert.equal(h.canvas.width, 1);
  assert.equal(h.ofType('keyframe-needed')[0].reason, 'decoded-frame-mismatch');
});
