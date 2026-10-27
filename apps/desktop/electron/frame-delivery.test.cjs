'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { frameDelay, drawEncodedFrame } = require('../renderer/src/ui/frame-delivery.ts');

test('changed frames resume at 16ms, idle responses back off to 400ms and reset on change', () => {
  assert.deepEqual([1, 2, 3, 4, 20].map(count => frameDelay(true, count)), [50, 100, 200, 400, 400]);
  assert.equal(frameDelay(false, 20), 16);
  assert.equal(frameDelay(true, 1), 50);
});

const frame = { data: new Uint8Array([1, 2, 3]), contentType: 'image/png', width: 200, height: 100, encodedWidth: 100, encodedHeight: 50 };
function canvasFixture() {
  const drawn = [];
  const canvas = { width: 1, height: 1, getContext: () => ({ drawImage: image => drawn.push(image) }) };
  return { canvas, drawn };
}

test('a monitor/session transition discards and closes a late decoded bitmap', async () => {
  const original = globalThis.createImageBitmap;
  let resolve;
  globalThis.createImageBitmap = () => new Promise(done => { resolve = done; });
  const { canvas, drawn } = canvasFixture();
  let current = true, closed = 0;
  try {
    const pending = drawEncodedFrame(canvas, frame, () => current);
    current = false;
    resolve({ width: 100, height: 50, close: () => closed++ });
    assert.equal(await pending, false);
    assert.equal(drawn.length, 0);
    assert.equal(closed, 1);
    assert.equal(canvas.width, 1, 'stale decode cannot resize or clear the new canvas');
  } finally { globalThis.createImageBitmap = original; }
});

test('binary decode draws at encoded resolution and closes the bitmap on success or failure', async () => {
  const original = globalThis.createImageBitmap;
  const { canvas, drawn } = canvasFixture();
  let closed = 0, width = 100;
  globalThis.createImageBitmap = async blob => {
    assert.equal(blob.type, 'image/png');
    return { width, height: 50, close: () => closed++ };
  };
  try {
    assert.equal(await drawEncodedFrame(canvas, frame, () => true), true);
    assert.deepEqual([canvas.width, canvas.height, drawn.length, closed], [100, 50, 1, 1]);
    width = 101;
    await assert.rejects(drawEncodedFrame(canvas, frame, () => true), /dimensions changed/);
    assert.equal(closed, 2);
    assert.equal(drawn.length, 1);
    await assert.rejects(drawEncodedFrame(canvas, { ...frame, encodedWidth: 33_554_433 }, () => true), /dimensions are unsupported/);
    await assert.rejects(drawEncodedFrame(canvas, { ...frame, data: undefined }, () => true), /image is unavailable/);
  } finally { globalThis.createImageBitmap = original; }
});
