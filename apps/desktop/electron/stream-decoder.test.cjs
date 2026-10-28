'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamDecoderEngine, DECODER_STALL_MS, MAX_PENDING_FRAMES } = require('../renderer/src/stream/decoder-engine.ts');
const config = { codec: 'avc1.4D4028', width: 1920, height: 1080, codedWidth: 1920, codedHeight: 1088,
  physicalLeft: 0, physicalTop: 0, physicalWidth: 1920, physicalHeight: 1080, scale: 1, fps: 60, monitorId: 'display-1',
  colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
const unit = (sequence, keyframe = false) => ({ type: 'access-unit', sequence, timestamp: sequence * 16000,
  data: new Uint8Array([0, 0, 1, keyframe ? 0x65 : 0x41]).buffer, keyframe });
function fixture({ supports = async () => true, configureThrows = false, animationFrame = false, strictHardwarePreference, backlog } = {}) {
  const messages = [], decoders = [], drawn = [], cleared = [];
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage: frame => drawn.push(frame), clearRect: (...args) => cleared.push(args) }) };
  let time = 0, frameCallbacks = [];
  const engine = new StreamDecoderEngine(canvas, { post: message => messages.push(message), now: () => time,
    animationFrame: animationFrame ? callback => frameCallbacks.push(callback) : undefined, timer: () => undefined, strictHardwarePreference, backlog,
    supports, createChunk: value => value, createDecoder: callbacks => {
      const decoder = { callbacks, state: 'unconfigured', decodeQueueSize: 0, chunks: [], closed: 0,
        configure(value) { this.configuration = value; if (configureThrows === true || configureThrows === value.hardwareAcceleration) throw new Error('Synthetic configuration error'); this.state = 'configured'; },
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
    tick: () => { const pending = frameCallbacks; frameCallbacks = []; for (const callback of pending) callback(); },
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
  assert.equal(failed.decoders[0].closed, 1); assert.equal(failed.decoders[1].closed, 1);
  assert.deepEqual(failed.ofType('fault').map(message => message.reason), ['decoder-configuration-failed']);
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

test('an accepted prefer-hardware config is reported as unknown, never as hardware', async () => {
  const checked = [], h = fixture({ supports: async value => { checked.push(value); return true; } });
  await h.engine.handle({ type: 'config', config });
  assert.deepEqual(checked.map(value => value.hardwareAcceleration), ['prefer-hardware']);
  assert.equal(h.ofType('configured')[0].decodeMode, 'unknown');
});

test('unsupported prefer-hardware retries once with prefer-software for the same codec and bounds', async () => {
  const checked = [], h = fixture({ supports: async value => { checked.push(value); return value.hardwareAcceleration === 'prefer-software'; } });
  await h.engine.handle({ type: 'config', config });
  assert.deepEqual(checked.map(value => value.hardwareAcceleration), ['prefer-hardware', 'prefer-software']);
  assert.deepEqual({ ...checked[1], hardwareAcceleration: 'prefer-hardware' }, checked[0]);
  assert.equal(h.ofType('fault').length, 0);
  assert.equal(h.decoders.length, 1); assert.equal(h.decoders[0].configuration.hardwareAcceleration, 'prefer-software');
  assert.equal(h.ofType('configured')[0].decodeMode, 'software');
  // A recovered decoder keeps the software config in use.
  await h.engine.handle(unit(1, true)); h.decoders[0].callbacks.error(new Error('Synthetic decoder failure'));
  await h.engine.handle(unit(2, true));
  assert.equal(h.decoders[1].configuration.hardwareAcceleration, 'prefer-software');
});

test('a prefer-hardware configure or support failure falls back to prefer-software; two failures report unsupported', async () => {
  const thrown = fixture({ configureThrows: 'prefer-hardware' });
  await thrown.engine.handle({ type: 'config', config });
  assert.equal(thrown.decoders[0].closed, 1); assert.equal(thrown.decoders[1].configuration.hardwareAcceleration, 'prefer-software');
  assert.equal(thrown.ofType('configured')[0].decodeMode, 'software'); assert.equal(thrown.ofType('fault').length, 0);
  const rejected = fixture({ supports: async value => { if (value.hardwareAcceleration === 'prefer-hardware') throw new Error('Synthetic support failure'); return true; } });
  await rejected.engine.handle({ type: 'config', config });
  assert.equal(rejected.ofType('configured')[0].decodeMode, 'software');
  let checks = 0; const neither = fixture({ supports: async () => { checks++; return false; } });
  await neither.engine.handle({ type: 'config', config });
  assert.equal(checks, 2); assert.equal(neither.decoders.length, 0);
  assert.deepEqual(neither.ofType('fault').map(message => message.reason), ['unsupported-decoder-config']);
  assert.equal(neither.ofType('closed').length, 1);
});

test('the hardware attempt decides the fault reason when both attempts fail differently', async () => {
  const unsupportedThenThrows = fixture({ supports: async value => value.hardwareAcceleration === 'prefer-software', configureThrows: 'prefer-software' });
  await unsupportedThenThrows.engine.handle({ type: 'config', config });
  assert.deepEqual(unsupportedThenThrows.ofType('fault').map(message => message.reason), ['unsupported-decoder-config']);
  const throwsThenUnsupported = fixture({ supports: async value => value.hardwareAcceleration === 'prefer-hardware', configureThrows: 'prefer-hardware' });
  await throwsThenUnsupported.engine.handle({ type: 'config', config });
  assert.deepEqual(throwsThenUnsupported.ofType('fault').map(message => message.reason), ['decoder-configuration-failed']);
});

test('a hardware decoder that errors before its first frame is rebuilt in software and reported only once installed', async () => {
  const h = fixture();
  await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true));
  h.decoders[0].callbacks.error(new Error('Synthetic early hardware failure'));
  assert.equal(h.decoders[0].closed, 1, 'recovery is not delayed by the software support check');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown']);
  await h.engine.handle(unit(2, true));
  assert.equal(h.decoders[1].configuration.hardwareAcceleration, 'prefer-software');
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown', 'software']);
});

test('a hardware decoder that already presented frames stays on hardware after an error', async () => {
  const h = fixture();
  await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); h.decoders[0].output(16000);
  h.decoders[0].callbacks.error(new Error('Synthetic later failure'));
  await new Promise(resolve => setImmediate(resolve));
  h.at(600); await h.engine.handle(unit(2, true));
  assert.equal(h.decoders[1].configuration.hardwareAcceleration, 'prefer-hardware');
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown']);
});

test('viewer time adds the window part to the Worker part; decode stays decode() call to output', async () => {
  const h = fixture(); await h.engine.handle({ type: 'config', config });
  h.at(100); await h.engine.handle({ ...unit(1, true), windowQueueMs: 1.5 });
  h.at(104); h.decoders[0].output(16000);
  assert.deepEqual(h.ofType('presented')[0], { type: 'presented', sequence: 1, timestamp: 16000, decodeMs: 4, drawMs: 0, queueMs: 1.5, viewerMs: 5.5 });
  h.at(110); await h.engine.handle(unit(2)); h.at(111); h.decoders[0].output(32000);
  h.at(120); await h.engine.handle({ ...unit(3), windowQueueMs: -0.1 }); h.at(121); h.decoders[0].output(48000);
  h.at(130); await h.engine.handle({ ...unit(4), windowQueueMs: -5 }); h.decoders[0].output(64000);
  const [, plain, coarse, invalid] = h.ofType('presented');
  assert.equal(plain.decodeMs, 1); assert.equal('viewerMs' in plain, false, 'no window part, no viewer total');
  assert.deepEqual([coarse.queueMs, coarse.viewerMs], [0, 1], 'timer coarsening up to 0.2 ms reads as 0');
  assert.equal('viewerMs' in invalid, false, 'an invalid window part drops the whole total');
  assert.equal('queueMs' in invalid, false);
});
test('a large window/Worker clock offset cannot change the reported viewer time', async () => {
  const run = async base => {
    const h = fixture(); await h.engine.handle({ type: 'config', config });
    h.at(base + 10); await h.engine.handle({ ...unit(1, true), windowQueueMs: 0.75 });
    h.at(base + 13); h.decoders[0].output(16000);
    return h.ofType('presented')[0];
  };
  const near = await run(0), far = await run(-86_400_000), ahead = await run(5_000_000);
  assert.deepEqual([near.queueMs, near.viewerMs], [0.75, 3.75]);
  assert.deepEqual(far, near); assert.deepEqual(ahead, near);
});

// S2: display on requestAnimationFrame, newest frame wins; decoding still takes every unit.
test('every unit is decoded; after an immediate draw, later frames in the refresh wait and the newest wins', async () => {
  const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); const first = h.decoders[0].output(16000);
  assert.deepEqual(h.drawn, [first], 'a lone frame in an idle refresh is drawn at once');
  for (let sequence = 2; sequence <= 5; sequence++) await h.engine.handle(unit(sequence));
  assert.equal(h.decoders[0].chunks.length, 5, 'reference frames are never skipped at decode');
  const frames = [2, 3, 4, 5].map(sequence => h.decoders[0].output(sequence * 16000));
  assert.equal(h.drawn.length, 1, 'no second draw in the same refresh, even for a frame with nothing newer pending');
  h.tick();
  assert.deepEqual(h.drawn, [first, frames[3]], 'the newest frame wins the next animation frame');
  assert.deepEqual(h.ofType('presented').map(message => message.sequence), [1, 5]);
  assert.deepEqual(h.ofType('superseded'), [2, 3, 4].map(sequence => ({ type: 'superseded', sequence })));
  assert.ok(h.ofType('consumed').every(message => !message.dropped), 'superseded units are not dropped units');
});

test('a burst\'s last frame is drawn without waiting for rAF once nothing newer is pending; earlier frames wait', async () => {
  const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
  for (let sequence = 1; sequence <= 3; sequence++) await h.engine.handle(unit(sequence, sequence === 1));
  const [one, two] = [1, 2].map(sequence => h.decoders[0].output(sequence * 16000));
  assert.equal(h.drawn.length, 0, 'a frame with a newer one still in the decoder waits, even in an idle refresh');
  assert.deepEqual([one.closed, two.closed], [1, 0]);
  const three = h.decoders[0].output(48000);
  assert.deepEqual(h.drawn, [three], 'the decoder is empty, so the burst\'s last frame is drawn at once, before any rAF');
  assert.deepEqual(h.ofType('superseded').map(message => message.sequence), [1, 2]);
  h.tick(); assert.deepEqual(h.drawn, [three], 'the animation frame finds nothing more to draw');
});

test('a burst straddling a refresh: the rAF draw of an earlier frame does not hold the last one, and a refresh draws at most two', async () => {
  const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
  for (let sequence = 1; sequence <= 3; sequence++) await h.engine.handle(unit(sequence, sequence === 1));
  const one = h.decoders[0].output(16000);
  h.tick(); assert.deepEqual(h.drawn, [one], 'the refresh boundary arrived first: the waiting frame is drawn on rAF');
  h.decoders[0].output(32000); assert.equal(h.drawn.length, 1, 'frame 2 has a newer frame behind it, so it waits');
  const three = h.decoders[0].output(48000);
  assert.deepEqual(h.drawn, [one, three], 'the last frame is the newest there is: drawn at once in the same refresh');
  await h.engine.handle(unit(4)); const four = h.decoders[0].output(64000);
  assert.deepEqual(h.drawn, [one, three], 'one immediate draw per refresh: a further frame waits');
  h.tick(); assert.deepEqual(h.drawn, [one, three, four]);
  assert.deepEqual(h.ofType('superseded').map(message => message.sequence), [2]);
});

test('a frame waits while the decoder still holds input or a newer unit is admitted but not yet decoded', async () => {
  // Decoders that keep several frames queued (Windows on ARM) stay on the rAF path, at most one refresh of wait.
  const queued = fixture({ animationFrame: true }); await queued.engine.handle({ type: 'config', config });
  await queued.engine.handle(unit(1, true)); queued.decoders[0].decodeQueueSize = 2;
  queued.decoders[0].output(16000);
  assert.equal(queued.drawn.length, 0, 'decodeQueueSize > 0 means a newer frame is coming');
  queued.tick(); assert.equal(queued.drawn.length, 1, 'drawn at the next animation frame');
  // The codec took the input (decodeQueueSize 0) but has not output it yet: still a newer frame on its way.
  const held = fixture({ animationFrame: true }); await held.engine.handle({ type: 'config', config });
  await held.engine.handle(unit(1, true)); await held.engine.handle(unit(2)); held.decoders[0].decodeQueueSize = 1;
  held.decoders[0].output(16000);
  assert.equal(held.decoders[0].decodeQueueSize, 0); assert.equal(held.drawn.length, 0, 'an undelivered output is newer input');
  held.tick(); assert.equal(held.drawn.length, 1);
  let backlog = 1;
  const admitted = fixture({ animationFrame: true, backlog: () => backlog }); await admitted.engine.handle({ type: 'config', config });
  await admitted.engine.handle(unit(1, true)); admitted.decoders[0].output(16000);
  assert.equal(admitted.drawn.length, 0, 'an admitted, undecoded unit is newer input');
  backlog = 0; admitted.tick(); assert.equal(admitted.drawn.length, 1);
});

test('skipped frames are closed immediately, before the next animation frame', async () => {
  const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); const first = h.decoders[0].output(16000);
  for (let sequence = 2; sequence <= 4; sequence++) await h.engine.handle(unit(sequence));
  const frames = [first, ...[2, 3, 4].map(sequence => h.decoders[0].output(sequence * 16000))];
  assert.deepEqual(frames.map(frame => frame.closed), [1, 1, 1, 0], 'only the waiting newest frame is still open');
  h.tick();
  assert.deepEqual(frames.map(frame => frame.closed), [1, 1, 1, 1], 'every VideoFrame is closed exactly once');
});

test('a frame waiting for display is closed without drawing on reconfiguration, recovery or shutdown', async () => {
  for (const reset of [
    async h => h.engine.handle({ type: 'config', config }),
    async h => { h.decoders[0].callbacks.error(new Error('Synthetic decoder failure')); },
    async h => h.engine.handle({ type: 'terminal' }),
  ]) {
    const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
    await h.engine.handle(unit(1, true)); h.decoders[0].output(16000);
    await h.engine.handle(unit(2)); const waiting = h.decoders[0].output(32000); // second frame in the refresh: waits
    await reset(h);
    assert.equal(waiting.closed, 1, 'released at the reset, not at a later animation frame');
    h.tick(); assert.equal(waiting.closed, 1); assert.equal(h.drawn.length, 1);
    assert.deepEqual(h.ofType('presented').map(message => message.sequence), [1]); assert.equal(h.ofType('superseded').length, 0);
  }
});

test('a reset reports exactly the discarded units as dropped; a keyframe admitted after it is decoded and presented', async () => {
  const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); h.decoders[0].output(16000);
  await h.engine.handle(unit(2)); await h.engine.handle(unit(3));
  h.decoders[0].output(32000); // frame 2 waits for display (second frame in the refresh); unit 3 is still in the decoder
  h.decoders[0].callbacks.error(new Error('Synthetic decoder failure'));
  const dropped = () => h.ofType('consumed').filter(message => message.dropped).map(message => message.sequence);
  assert.deepEqual(dropped().sort(), [2, 3], 'the waiting frame and the undecoded unit, nothing else');
  assert.equal(h.ofType('keyframe-needed').length, 1);
  h.tick(); await h.engine.handle(unit(4, true)); h.decoders[1].output(64000);
  assert.deepEqual(h.ofType('presented').map(message => message.sequence), [1, 4], 'the keyframe in flight ends recovery');
  assert.deepEqual(dropped().sort(), [2, 3]);
});

test('a rebuilt hardware decoder is not labelled hardware before its own first frame', async () => {
  const h = fixture({ strictHardwarePreference: true }); await h.engine.handle({ type: 'config', config });
  await h.engine.handle(unit(1, true)); h.decoders[0].output(16000);
  h.decoders[0].callbacks.error(new Error('Synthetic later failure')); // after a frame: stays prefer-hardware
  await new Promise(resolve => setImmediate(resolve));
  h.at(600); await h.engine.handle(unit(2, true));
  assert.equal(h.decoders[1].configuration.hardwareAcceleration, 'prefer-hardware');
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown', 'hardware', 'unknown']);
  h.decoders[1].output(32000);
  assert.equal(h.ofType('configured').at(-1).decodeMode, 'hardware');
});

test('the wait for the animation frame counts in viewer time, not in decode time', async () => {
  const h = fixture({ animationFrame: true }); await h.engine.handle({ type: 'config', config });
  h.at(100); await h.engine.handle({ ...unit(1, true), windowQueueMs: 1 }); h.at(102); h.decoders[0].output(16000);
  h.at(103); await h.engine.handle({ ...unit(2), windowQueueMs: 1 }); h.at(105); h.decoders[0].output(32000);
  h.at(110); h.tick();
  const [, second] = h.ofType('presented');
  assert.deepEqual([second.sequence, second.decodeMs, second.viewerMs], [2, 2, 8]);
});

test('hardware is reported only after a hardware-only prefer-hardware decoder produced a frame', async () => {
  const h = fixture({ strictHardwarePreference: true }); await h.engine.handle({ type: 'config', config });
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown'], 'configured is not decoding');
  await h.engine.handle(unit(1, true));
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown']);
  h.decoders[0].output(16000);
  assert.deepEqual(h.ofType('configured').map(message => message.decodeMode), ['unknown', 'hardware']);
  await h.engine.handle({ type: 'config', config });
  assert.equal(h.ofType('configured').at(-1).decodeMode, 'unknown', 'a new configuration starts unconfirmed again');
});

test('the indicator never says hardware when the path is unknown', async () => {
  const modes = async (options, steps) => {
    const h = fixture(options); await h.engine.handle({ type: 'config', config });
    await h.engine.handle(unit(1, true)); await steps?.(h); h.decoders.at(-1)?.output(16000);
    return h.ofType('configured').map(message => message.decodeMode);
  };
  assert.deepEqual(await modes({}), ['unknown'], 'a runtime not known to be hardware-only');
  assert.deepEqual(await modes({ strictHardwarePreference: false }), ['unknown']);
  assert.deepEqual(await modes({ strictHardwarePreference: true, supports: async value => {
    if (value.hardwareAcceleration === 'prefer-hardware') throw new Error('Synthetic support failure'); return true; } }), ['software']);
  assert.deepEqual(await modes({ strictHardwarePreference: true, supports: async value => value.hardwareAcceleration === 'prefer-software' }), ['software']);
  assert.deepEqual(await modes({ strictHardwarePreference: true, supports: async () => 'yes' }), ['unknown'], 'only an exact true counts');
  // A hardware decoder that fails before its first frame moves to software and is never called hardware.
  assert.deepEqual(await modes({ strictHardwarePreference: true }, async h => {
    h.decoders[0].callbacks.error(new Error('Synthetic early hardware failure'));
    await new Promise(resolve => setImmediate(resolve)); await h.engine.handle(unit(2, true));
  }), ['unknown', 'software']);
});
