'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FramePresenter, PRESENT_FALLBACK_MS } = require('../renderer/src/stream/frame-presenter.ts');
const { AdmissionQueue, VIDEO_CREDIT_WINDOW, MAX_CLIENT_PENDING } = require('../renderer/src/stream/decoder-admission.ts');
const { VIDEO_CREDIT_WINDOW: MAIN_CREDIT_WINDOW, MAX_UNCONSUMED_UNITS } = require('./stream-session.cjs');

const frame = id => ({ id, closed: 0, close() { this.closed++; } });
function presenter({ animationFrame = true, drawWhenIdle } = {}) {
  const drawn = [], superseded = [], frames = [], timers = [];
  let callbacks = [], time = 0;
  const p = new FramePresenter({
    animationFrame: animationFrame ? callback => { callbacks.push(callback); } : undefined,
    timer: (callback, ms) => timers.push({ callback, ms }), now: () => time,
    draw: (value, meta) => { assert.equal(value.closed, 0, 'a drawn frame is still open'); drawn.push(meta); },
    superseded: meta => superseded.push(meta), drawWhenIdle });
  const offer = id => { const value = frame(id); frames.push(value); p.offer(value, id); return value; };
  const tick = () => { const pending = callbacks; callbacks = []; for (const callback of pending) callback(); };
  return { p, drawn, superseded, frames, timers, offer, tick, at: value => { time = value; }, pendingFrames: () => callbacks.length };
}

test('newest frame wins: frames decoded within one display refresh coalesce to the newest', () => {
  const h = presenter();
  h.offer(1); assert.deepEqual(h.drawn, [1], 'the first frame of an idle refresh draws at once');
  h.offer(2); h.offer(3); h.offer(4);
  assert.deepEqual(h.drawn, [1], 'later frames in the same refresh wait for the animation frame');
  h.tick();
  assert.deepEqual(h.drawn, [1, 4], 'only the newest is drawn');
  assert.deepEqual(h.superseded, [2, 3]);
  h.tick(); h.offer(5); assert.deepEqual(h.drawn, [1, 4, 5], 'after an idle refresh the next frame draws at once again');
});

test('every skipped VideoFrame is closed at once and every drawn frame exactly once', () => {
  const h = presenter();
  for (let id = 1; id <= 10; id++) h.offer(id);
  assert.deepEqual(h.superseded, [2, 3, 4, 5, 6, 7, 8, 9]);
  for (const value of h.frames.slice(1, 9)) assert.equal(value.closed, 1, `superseded frame ${value.id} closed before the next refresh`);
  assert.equal(h.frames[9].closed, 0, 'the waiting frame stays open until drawn');
  h.tick();
  assert.ok(h.frames.every(value => value.closed === 1), 'no frame is leaked or closed twice');
});

test('strict animation-frame pacing draws nothing outside requestAnimationFrame', () => {
  const h = presenter({ drawWhenIdle: false });
  h.offer(1); h.offer(2); assert.deepEqual(h.drawn, []);
  h.tick(); assert.deepEqual(h.drawn, [2]); assert.deepEqual(h.superseded, [1]);
});

test('without requestAnimationFrame every frame is drawn when decoded', () => {
  const h = presenter({ animationFrame: false });
  h.offer(1); h.offer(2); h.offer(3);
  assert.deepEqual(h.drawn, [1, 2, 3]); assert.deepEqual(h.superseded, []);
  assert.ok(h.frames.every(value => value.closed === 1));
});

test('a stopped animation frame (throttled Worker) still presents the newest frame after the fallback delay', () => {
  const h = presenter();
  h.offer(1); h.offer(2); h.offer(3);
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].ms, PRESENT_FALLBACK_MS);
  h.at(PRESENT_FALLBACK_MS); h.timers[0].callback();
  assert.deepEqual(h.drawn, [1, 3]); assert.deepEqual(h.superseded, [2]);
  h.offer(4); assert.equal(h.timers.length, 2, 'the next waiting frame re-arms the fallback');
  h.tick(); assert.deepEqual(h.drawn, [1, 3, 4]);
  h.timers[1].callback(); assert.deepEqual(h.drawn, [1, 3, 4], 'a fallback after the animation frame draws nothing twice');
});

test('a fallback timer armed for an earlier, already drawn frame cannot draw a later frame early', () => {
  const h = presenter();
  h.offer(1); h.offer(2); assert.equal(h.timers.length, 1, 'frame 2 waits and arms the fallback at 0 ms');
  h.at(10); h.tick(); assert.deepEqual(h.drawn, [1, 2], 'frame 2 drawn on rAF; its timer is still pending');
  h.at(12); h.offer(3); assert.deepEqual(h.drawn, [1, 2, 3], 'the one immediate draw of this refresh');
  h.at(45); h.offer(4); assert.equal(h.timers.length, 1, 'frame 4 waits; the old timer is still armed');
  h.at(PRESENT_FALLBACK_MS); h.timers[0].callback();
  assert.deepEqual(h.drawn, [1, 2, 3], 'frame 4 has waited only 5 ms: no third draw in this refresh');
  assert.equal(h.timers[1].ms, PRESENT_FALLBACK_MS - 5, 'the timer re-arms for the remainder');
  h.at(95); h.timers[1].callback(); assert.deepEqual(h.drawn, [1, 2, 3, 4]);
});

test('while rAF is stopped, frames that keep replacing each other are still drawn once the slot has waited', () => {
  const h = presenter();
  h.offer(1); h.offer(2);
  h.at(20); h.offer(3); h.at(40); h.offer(4);
  h.at(PRESENT_FALLBACK_MS); h.timers[0].callback();
  assert.deepEqual(h.drawn, [1, 4], 'the waiting slot, not each frame, is timed: a 60 fps stream cannot starve display');
  assert.deepEqual(h.superseded, [2, 3]);
});

test('reporting a supersession that throws still closes the new frame', () => {
  const frames = [frame(1), frame(2), frame(3)];
  const p = new FramePresenter({ animationFrame: () => undefined, timer: () => undefined, draw: () => undefined,
    superseded: () => { throw new Error('Synthetic closed port'); } });
  p.offer(frames[0], 1); p.offer(frames[1], 2);
  assert.throws(() => p.offer(frames[2], 3), /Synthetic closed port/);
  assert.deepEqual(frames.map(value => value.closed), [1, 1, 1], 'nothing leaks when the report fails');
});

test('clear returns what was waiting so the decoder can report it dropped', () => {
  const h = presenter();
  h.offer(1); h.offer(2);
  assert.equal(h.p.clear(), 2); assert.equal(h.p.clear(), undefined);
});

test('clear and close release a waiting frame without drawing or reporting it', () => {
  const h = presenter();
  h.offer(1); const waiting = h.offer(2);
  h.p.clear(); assert.equal(waiting.closed, 1); h.tick();
  assert.deepEqual(h.drawn, [1]); assert.deepEqual(h.superseded, []);
  h.offer(3); const late = h.offer(4); h.p.close(); assert.equal(late.closed, 1);
  const after = h.offer(5); assert.equal(after.closed, 1, 'a closed presenter closes new frames'); h.tick();
  assert.deepEqual(h.drawn, [1, 3]);
});

test('a draw failure still closes the frame', () => {
  const value = frame(1);
  const p = new FramePresenter({ draw: () => { throw new Error('Synthetic draw failure'); }, superseded: () => undefined });
  assert.throws(() => p.offer(value, 1), /Synthetic draw failure/);
  assert.equal(value.closed, 1);
});

test('the Worker and main agree on the credit window and the unpresented-unit bound', () => {
  assert.equal(VIDEO_CREDIT_WINDOW, MAIN_CREDIT_WINDOW);
  assert.equal(MAX_CLIENT_PENDING, MAX_UNCONSUMED_UNITS, 'the window and main bound the same pipeline');
});

test('admission handles messages one at a time, in order, and returns one credit per handled message', async () => {
  const credits = [], handled = [], releases = []; let active = 0, maxActive = 0, violations = 0;
  const queue = new AdmissionQueue({ window: 3, credit: count => credits.push(count), violation: () => violations++,
    handle: message => new Promise(resolve => { active++; maxActive = Math.max(maxActive, active); handled.push(message); releases.push(() => { active--; resolve(); }); }) });
  queue.open(); assert.deepEqual(credits, [3]);
  queue.push('a'); queue.push('b'); queue.push('c');
  assert.deepEqual(handled, ['a']); assert.equal(queue.size, 3);
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(credits, [3, 1]); assert.deepEqual(handled, ['a', 'b']);
  queue.push('d'); assert.equal(violations, 0, 'a returned credit admits one more');
  while (releases.length) { releases.shift()(); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(handled, ['a', 'b', 'c', 'd']); assert.deepEqual(credits, [3, 1, 1, 1, 1]); assert.equal(maxActive, 1);
});

test('admission past the window is a credit violation and stops all further work', async () => {
  const credits = [], handled = []; let violations = 0;
  const queue = new AdmissionQueue({ window: 2, credit: count => credits.push(count), violation: () => violations++,
    handle: async message => { handled.push(message); await new Promise(() => undefined); } });
  queue.open(); queue.push(1); queue.push(2); queue.push(3);
  assert.equal(violations, 1); assert.equal(queue.size, 0);
  queue.push(4); assert.equal(violations, 1); assert.deepEqual(handled, [1]); assert.deepEqual(credits, [2]);
});
