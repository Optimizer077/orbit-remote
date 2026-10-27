'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cursorPlacement, predictedPointer } = require('../renderer/src/stream/cursor-layout.ts');
const { CursorLayer, createCursorLayer } = require('../renderer/src/stream/cursor-layer.ts');
const config = { physicalLeft: -1920, physicalTop: 5, physicalWidth: 1920, physicalHeight: 1080 };
const shape = { width: 32, height: 32, hotX: 4, hotY: 5, kind: 'mono', pngBase64: 'AQID', invertPngBase64: 'BAUG' };
const pointer = { x: -960, y: 545, visible: true, shapeId: 'synthetic-shape', shape };
const turn = () => new Promise(resolve => setImmediate(resolve));
test('negative monitor origins, hotspot, fit letterboxing and actual-size mapping remain physical', () => {
  const fit = cursorPlacement(config, pointer, shape, { left: 0, top: 0, width: 1000, height: 600 }, true);
  assert.ok(Math.abs(fit.left - (500 - 4 * 1000 / 1920)) < .001);
  assert.ok(Math.abs(fit.top - (300 - 5 * 1000 / 1920)) < .001);
  const actual = cursorPlacement(config, pointer, shape, { left: -100, top: -200, width: 1920, height: 1080 }, false);
  assert.equal(actual.left, 856); assert.equal(actual.top, 335); assert.equal(actual.width, 32);
  assert.equal(predictedPointer(config, pointer, 1, 1).x, -1);
  assert.equal(predictedPointer(config, pointer, 1, 1).y, 1084);
  assert.equal(cursorPlacement(config, { ...pointer, visible: false }, shape, { left: 0, top: 0, width: 100, height: 100 }, true), null);
});
function fixture(t, customDecode) {
  const saved = { window: globalThis.window, ResizeObserver: globalThis.ResizeObserver, createImageBitmap: globalThis.createImageBitmap, CSS: globalThis.CSS };
  const callbacks = new Map(), bitmaps = [], errors = []; let id = 0;
  globalThis.window = { requestAnimationFrame: callback => { callbacks.set(++id, callback); return id; }, cancelAnimationFrame: value => callbacks.delete(value), addEventListener() {}, removeEventListener() {} };
  globalThis.ResizeObserver = undefined; globalThis.CSS = { supports: () => true };
  // Decode is synthetic and contains no desktop pixels; parser PNG validation is checked separately.
  globalThis.createImageBitmap = customDecode || (async () => { const value = { width: 32, height: 32, closed: 0, close() { this.closed++; } }; bitmaps.push(value); return value; });
  const classes = new Set(['fit']), canvas = () => {
    const calls = [], context = { clearRect(...args) { calls.push(['clear', ...args]); }, drawImage(...args) { calls.push(['draw', ...args]); } };
    return { width: 1, height: 1, style: {}, calls, getContext: () => context };
  };
  const viewer = { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    addEventListener() {}, removeEventListener() {}, clientLeft: 0, clientTop: 0, clientWidth: 1000, clientHeight: 600, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 600 }) };
  const video = { getContext() { throw Error('Video pixels must never be read by the pointer layer.'); }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 600 }) };
  const invert = canvas(), replace = canvas(), layer = new CursorLayer(viewer, video, invert, replace, () => errors.push('decode'));
  t.after(() => { layer.close(); Object.assign(globalThis, saved); });
  const tick = () => { const ready = [...callbacks.values()]; callbacks.clear(); ready.forEach(callback => callback()); };
  return { layer, viewer, video, invert, replace, classes, callbacks, bitmaps, errors, tick };
}
test('pointer-only layers draw after a real frame; host position wins over prediction and hidden stops it', async t => {
  const f = fixture(t); f.layer.configure(config); f.layer.receive(pointer); await turn(); f.tick();
  assert.equal(f.replace.style.display, 'none');
  f.layer.setReady(true); f.tick(); assert.equal(f.replace.style.display, 'block'); assert.equal(f.invert.style.display, 'block');
  const hostLeft = f.replace.style.left; f.layer.predict(.75, .5); f.tick(); assert.notEqual(f.replace.style.left, hostLeft);
  f.layer.receive({ ...pointer, shape: undefined }); f.tick(); assert.equal(f.replace.style.left, hostLeft);
  f.layer.receive({ ...pointer, visible: false, shape: undefined }); f.layer.predict(.9, .5); f.tick(); assert.equal(f.replace.style.display, 'none');
  f.layer.close(); assert.equal(f.classes.has('local-cursor'), false); assert.equal(f.callbacks.size, 0); assert.ok(f.bitmaps.every(value => value.closed === 1));
});
test('a late pointer decode after configuration or close is disposed and never paints', async t => {
  const pending = [];
  const f = fixture(t, () => new Promise(resolve => pending.push(resolve)));
  f.layer.configure(config); f.layer.receive(pointer); f.layer.setReady(true); f.layer.configure({ ...config, physicalLeft: 0 });
  const bitmap = () => ({ width: 32, height: 32, closed: 0, close() { this.closed++; } });
  const first = bitmap(), second = bitmap(); pending[0](first); pending[1](second); await turn(); f.tick();
  assert.equal(first.closed, 1); assert.equal(second.closed, 1);
  assert.equal(f.replace.calls.some(call => call[0] === 'draw'), false); assert.equal(f.replace.style.display, 'none');
});
test('unknown shape and decoded dimension mismatch cannot silently produce cursorless video', async t => {
  const f = fixture(t, async () => ({ width: 999, height: 999, close() {} }));
  f.layer.configure(config); assert.throws(() => f.layer.receive({ ...pointer, shape: undefined }), /Unknown/);
  f.layer.receive(pointer); await turn(); assert.deepEqual(f.errors, ['decode']); assert.equal(f.replace.style.display, 'none');
  globalThis.CSS.supports = () => false;
  assert.equal(createCursorLayer(f.viewer, f.video, f.invert, f.replace, () => {}), null);
});
test('a delayed bitmap decoder admits one active pair plus only the latest pending shape', async t => {
  const pending = [], payloads = []; let active = 0, peak = 0, calls = 0;
  const f = fixture(t, blob => { payloads.push(blob); active++; peak = Math.max(peak, active); calls++; return new Promise(resolve => pending.push(value => { active--; resolve(value); })); });
  f.layer.configure(config); f.layer.setReady(true); f.layer.receive(pointer);
  for (let index = 1; index <= 1000; index++) f.layer.receive({ ...pointer, x: -1000 + index / 10, shapeId: `shape-${index}`,
    shape: { ...shape, pngBase64: btoa(`replacement-${index}`), invertPngBase64: btoa(`inversion-${index}`) } });
  assert.equal(calls, 2); assert.equal(peak, 2, 'only replace/invert for one shape may be decoding');
  const bitmap = () => ({ width: 32, height: 32, closed: 0, close() { this.closed++; } });
  const stale = [bitmap(), bitmap()]; pending.shift()(stale[0]); pending.shift()(stale[1]); await turn();
  assert.ok(stale.every(value => value.closed === 1)); assert.equal(calls, 4, 'intermediate 999 shapes must never start decoding');
  assert.equal(await payloads[2].text(), 'replacement-1000'); assert.equal(await payloads[3].text(), 'inversion-1000');
  const latest = [bitmap(), bitmap()]; pending.shift()(latest[0]); pending.shift()(latest[1]); await turn(); f.tick();
  assert.equal(f.replace.style.display, 'block'); assert.equal(peak, 2); assert.equal(active, 0);
  f.layer.close(); assert.ok(latest.every(value => value.closed === 1));
});
test('configuration and close discard a pending decode before it starts while disposing the active pair', async t => {
  const pending = []; let calls = 0;
  const f = fixture(t, () => { calls++; return new Promise(resolve => pending.push(resolve)); });
  f.layer.configure(config); f.layer.receive(pointer); f.layer.receive({ ...pointer, shapeId: 'queued' });
  f.layer.configure(config); f.layer.close();
  const a = { width: 32, height: 32, closed: 0, close() { this.closed++; } }, b = { ...a };
  pending[0](a); pending[1](b); await turn();
  assert.equal(calls, 2); assert.equal(a.closed, 1); assert.equal(b.closed, 1);
});
test('both cursor layers share the visible 1:1 scrolled viewport and crop the physical bitmap', async t => {
  const f=fixture(t);f.classes.delete('fit');f.viewer.clientWidth=400;f.viewer.clientHeight=300;
  f.viewer.scrollLeft=900;f.viewer.scrollTop=400;
  f.layer.configure(config);f.layer.receive({...pointer,x:config.physicalLeft+902});f.layer.setReady(true);await turn();f.tick();
  assert.equal(f.replace.style.left,'900px');assert.equal(f.replace.style.width,'30px');
  assert.equal(f.invert.style.left,f.replace.style.left);assert.equal(f.invert.style.width,f.replace.style.width);
  const crop=f.replace.calls.filter(call=>call[0]==='draw').at(-1);
  assert.equal(crop[2],2);assert.equal(crop[4],30,'scroll clipping crops exactly two physical bitmap pixels');
  f.layer.receive({...pointer,x:config.physicalLeft+100,shape:undefined});f.tick();
  assert.equal(f.replace.style.display,'none');assert.equal(f.invert.style.display,'none');
});
