'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameInputCoalescer } = require('../renderer/src/ui/input-moves.ts');
function fixture() {
  const callbacks = new Map(), sent = []; let next = 0;
  const queue = new FrameInputCoalescer(event => sent.push(event), callback => { callbacks.set(++next, callback); return next; }, id => callbacks.delete(id));
  const tick = () => { const ready = [...callbacks.values()]; callbacks.clear(); ready.forEach(callback => callback()); };
  return { queue, sent, callbacks, tick };
}
const move = x => ({ type: 'pointer.move', x, y: .5 });
test('a burst keeps only the newest move and admits one animation callback', () => {
  const f = fixture();
  for (let index = 0; index < 10000; index++) f.queue.move(move(index / 10000));
  assert.equal(f.sent.length, 0); assert.equal(f.callbacks.size, 1);
  f.tick(); assert.deepEqual(f.sent, [move(.9999)]); assert.equal(f.callbacks.size, 0);
  f.queue.move(move(.7)); f.tick(); assert.deepEqual(f.sent.at(-1), move(.7));
});
test('buttons, keys and wheel are immediate and ordered after preceding latest moves', () => {
  const f = fixture();
  f.queue.move(move(.1)); f.queue.move(move(.2));
  const button = { type: 'pointer.button', down: true }, key = { type: 'key', down: true }, wheel = { type: 'pointer.wheel', deltaY: 1 };
  f.queue.immediate(button); f.queue.immediate(key); f.queue.move(move(.3)); f.queue.immediate(wheel);
  assert.deepEqual(f.sent, [move(.2), button, key, move(.3), wheel]);
  f.tick(); assert.equal(f.sent.length, 5, 'cancelled callbacks must not replay a move after a button/key');
});
test('release, blur and geometry-generation teardown drop pending moves without dispatch', () => {
  const f = fixture(); f.queue.move(move(.5)); f.queue.cancel(); f.tick();
  assert.deepEqual(f.sent, []); assert.equal(f.callbacks.size, 0);
  // A fresh generation can accept new movement; the old target receives none.
  const fresh = fixture(); fresh.queue.move(move(.8)); fresh.tick(); assert.deepEqual(fresh.sent, [move(.8)]);
  assert.deepEqual(f.sent, []);
});
