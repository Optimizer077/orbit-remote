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
