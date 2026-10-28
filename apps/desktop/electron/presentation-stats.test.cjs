'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PresentationWindow, videoQuality, LATE_FRAME_MS } = require('../renderer/src/stream/presentation-stats.ts');

// 60 fps for one second; host capture times every 16.7 ms; optional extra arrival delay for one frame.
function run(delayFrame, delayMs) {
  const stats = new PresentationWindow(0); let lag = 0;
  for (let frame = 1; frame <= 60; frame++) {
    const host = frame * 16_667; if (frame === delayFrame) lag = delayMs;
    const at = host / 1000 + 5 + lag; stats.received(at, 1000, host); stats.presented(at + 1, .5, .2);
  }
  return stats.snapshot(1100);
}
test('frames delivered on the host cadence are not late; the longest gap is one frame', () => {
  const s = run(0, 0);
  assert.equal(s.lateFrames, 0); assert.ok(Math.abs(s.longestGapMs - 16.667) < .01);
  assert.deepEqual(videoQuality(s), { level: 'good', label: '55 fps' });
});
test('one frame delivered 80 ms late counts once and shows as the longest gap', () => {
  const s = run(30, 80);
  assert.equal(s.lateFrames, 1); assert.ok(s.longestGapMs > 90);
  assert.equal(videoQuality(s).level, 'fair');
});
test('a still screen (frames far apart in capture time too) is never late and reads as a still screen', () => {
  const stats = new PresentationWindow(0);
  for (const [at, host] of [[100, 95_000], [900, 895_000], [1700, 1_695_000]]) { stats.received(at, 500, host); stats.presented(at, .5, .2); }
  const s = stats.snapshot(1900);
  assert.equal(s.lateFrames, 0);
  assert.deepEqual(videoQuality(s), { level: 'good', label: 'Still screen' });
});
test('without host timestamps lateness stays unmeasured, and many late frames rate as stuttering', () => {
  const stats = new PresentationWindow(0);
  for (let i = 1; i <= 30; i++) stats.received(i * 33, 1000);
  assert.equal(stats.snapshot(1100).lateFrames, undefined);
  assert.equal(videoQuality({ fps: 30, lateFrames: 5 }).level, 'slow');
  assert.equal(LATE_FRAME_MS, 50);
});
test('superseded frames are counted apart from dropped frames and do not lower the smoothness rating', () => {
  const smooth = run(0, 0);
  const stats = new PresentationWindow(0);
  for (let frame = 1; frame <= 60; frame++) {
    const host = frame * 16_667, at = host / 1000 + 5; stats.received(at, 1000, host); stats.presented(at + 1, .5, .2);
    if (frame % 3 === 0) stats.superseded(at + .5); // a decoded frame replaced within the same display refresh
  }
  stats.dropped(500, 2); stats.dropped(-1, 1); stats.dropped(600, 0); stats.superseded(700, 1.5);
  const s = stats.snapshot(1100);
  assert.equal(s.superseded, 20); assert.equal(s.dropped, 2, 'invalid times and counts are ignored');
  assert.deepEqual(videoQuality(s), videoQuality(smooth), 'normal skipping keeps the same rating');
  assert.equal(s.fps, smooth.fps, 'frames drawn count presentations only');
  assert.equal(stats.snapshot(4000).superseded, 0, 'counts age out with the two-second window');
  assert.equal(new PresentationWindow(0).snapshot(100).superseded, undefined, 'unmeasured before half a second');
});
test('decode mode starts unknown and reports only a value the decoder engine set', () => {
  const stats = new PresentationWindow(0);
  assert.equal(stats.snapshot(10).decodeMode, 'unknown');
  stats.decoder('software'); assert.equal(stats.snapshot(10).decodeMode, 'software');
  stats.decoder('prefer-hardware'); assert.equal(stats.snapshot(10).decodeMode, 'software');
  stats.decoder('unknown'); assert.equal(stats.snapshot(10).decodeMode, 'unknown');
});

const { TimingRing, percentile, TIMING_FRAMES } = require('../renderer/src/stream/presentation-stats.ts');
test('nearest-rank percentiles of known inputs', () => {
  const sorted = Float64Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual([50, 95, 99, 100].map(p => percentile(sorted, 100, p)), [50, 95, 99, 100]);
  assert.deepEqual([50, 95, 99].map(p => percentile([4, 9], 2, p)), [4, 9, 9]);
  assert.equal(percentile([7], 1, 1), 7);
  const ring = new TimingRing(1, 16);
  for (const [at, value] of [[1, 30], [2, 10], [3, 20], [4, NaN], [5, -1], [6, 40]]) ring.set(ring.push(at), 0, value);
  assert.deepEqual(ring.percentiles(0, 0, 10), { p50: 20, p95: 40, p99: 40, min: 10, samples: 4 }, 'unsorted input; NaN and negative are unreported');
  assert.equal(ring.percentiles(0, 6, 10), undefined, 'nothing after the cutoff');
});
test('the timing ring keeps a fixed capacity and only the newest samples', () => {
  const ring = new TimingRing(2, TIMING_FRAMES);
  for (let i = 1; i <= 1000; i++) { const slot = ring.push(i); ring.set(slot, 0, i); if (i % 2) ring.set(slot, 1, i); }
  assert.equal(ring.size, TIMING_FRAMES); assert.equal(TIMING_FRAMES, 240);
  const all = ring.percentiles(0, -Infinity, Infinity);
  assert.equal(all.samples, 240); assert.equal(all.min, 761); assert.equal(all.p50, 880); assert.equal(all.p99, 998);
  assert.equal(ring.percentiles(1, -Infinity, Infinity).samples, 120, 'a column reports only frames that set it');
  assert.equal(ring.percentiles(0, 990, 995).samples, 5, 'window bounds are (cutoff, now]');
});
test('the snapshot reports viewer pipeline, decode, draw and round-trip percentiles over two seconds', () => {
  const stats = new PresentationWindow(0);
  assert.deepEqual(stats.snapshot(10).latency, { viewer: undefined, decode: undefined, draw: undefined, queue: undefined, mainQueue: undefined, roundTrip: undefined });
  stats.presented(5, 9, 9, { viewerMs: 500, queueMs: 500, mainQueueMs: 500 }); // leaves the window by the snapshot below
  for (let i = 1; i <= 100; i++) stats.presented(1000 + i, i / 10, i / 100, { viewerMs: i, queueMs: i / 2, mainQueueMs: i % 2 ? i : undefined });
  stats.presented(1200, 1, 1); // no client timing (for example the image path)
  for (const ms of [8, 3, 5, 4]) stats.roundTrip(1500, ms);
  stats.roundTrip(1500, -2); stats.roundTrip(-1, 1);
  const { latency } = stats.snapshot(2500);
  assert.deepEqual(latency.viewer, { p50: 50, p95: 95, p99: 99, min: 1, samples: 100 });
  assert.equal(latency.decode.samples, 101); assert.equal(latency.decode.p50, 5); assert.equal(latency.draw.p99, 1);
  assert.equal(latency.queue.p95, 47.5); assert.equal(latency.mainQueue.samples, 50);
  assert.deepEqual(latency.roundTrip, { p50: 4, p95: 8, p99: 8, min: 3, samples: 4 });
  assert.equal(stats.snapshot(5000).latency.viewer, undefined, 'samples age out with the two-second window');
});
