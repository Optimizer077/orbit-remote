'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createViewerLayout, normalizedClientPoint, physicalPointToClient, cursorPlacementForLayout } = require('../renderer/src/stream/viewer-layout.ts');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const pointNear = (actual, expected) => { assert.ok(actual); near(actual.x, expected.x); near(actual.y, expected.y); };
const rectNear = (actual, expected) => { assert.ok(actual); for (const key of ['left', 'top', 'width', 'height']) near(actual[key], expected[key]); };
const desktop = { width: 1920, height: 1080 }, viewport = { left: 10, top: 20, width: 1000, height: 800 };
const fit = () => createViewerLayout({ physical: desktop, viewport, mode: 'fit' });
const scrolled = () => createViewerLayout({ physical: { ...desktop, left: -1920, top: -100 },
  viewport: { left: 100.5, top: 30.25, width: 640, height: 480 }, mode: 'one-to-one', scroll: { left: 300.25, top: 200.5 } });

test('F23 Fit uses the largest complete image and rejects letterbox points', () => {
  const layout = fit(); assert.ok(layout); near(layout.scale, 1000 / 1920);
  rectNear(layout.painted, { left: 10, top: 138.75, width: 1000, height: 562.5 });
  rectNear(layout.visible, layout.painted);
  assert.equal(normalizedClientPoint(layout, 500, 20), null);
  assert.equal(normalizedClientPoint(layout, 500, 800), null);
  pointNear(normalizedClientPoint(layout, 10, 138.75), { x: 0, y: 0 });
  pointNear(normalizedClientPoint(layout, 1010, 701.25), { x: 1, y: 1 });
  pointNear(normalizedClientPoint(layout, 510, 420), { x: .5, y: .5 });
});

test('F23 portrait Fit centers horizontal letterboxing without cropping', () => {
  const layout = createViewerLayout({ physical: { width: 1080, height: 1920 },
    viewport: { left: 20, top: -30, width: 1200, height: 600 }, mode: 'fit' });
  rectNear(layout.painted, { left: 451.25, top: -30, width: 337.5, height: 600 });
  pointNear(normalizedClientPoint(layout, 620, 270), { x: .5, y: .5 });
  assert.equal(normalizedClientPoint(layout, 20, 270), null);
});

test('F23 1:1 scroll uses CSS offsets and rejects points outside the viewport even inside the image', () => {
  const layout = scrolled(); assert.equal(layout.scale, 1);
  rectNear(layout.painted, { left: -199.75, top: -170.25, width: 1920, height: 1080 });
  rectNear(layout.visible, layout.viewport);
  pointNear(normalizedClientPoint(layout, 100.5, 30.25), { x: 300.25 / 1920, y: 200.5 / 1080 });
  assert.equal(normalizedClientPoint(layout, 100.49, 300), null);
  assert.equal(normalizedClientPoint(layout, 740.51, 300), null);
  assert.equal(normalizedClientPoint(layout, 400, 510.26), null);
  assert.ok(normalizedClientPoint(layout, 740.5, 510.25));
});

test('F23 a small 1:1 desktop stays at the scroll origin and empty viewport space is not remote input', () => {
  const layout = createViewerLayout({ physical: { width: 100, height: 50 }, viewport, mode: 'one-to-one' });
  rectNear(layout.painted, { left: 10, top: 20, width: 100, height: 50 });
  pointNear(normalizedClientPoint(layout, 110, 70), { x: 1, y: 1 });
  assert.equal(normalizedClientPoint(layout, 111, 70), null);
});

test('F23 a fully scrolled-out image or zero-area intersection safely rejects/hides', () => {
  for (const left of [1920, 5000]) {
    const layout = createViewerLayout({ physical: desktop, viewport, mode: 'one-to-one', scroll: { left, top: 0 } });
    assert.ok(layout); assert.equal(layout.visible, null);
    assert.equal(normalizedClientPoint(layout, 10, 20), null);
    assert.equal(cursorPlacementForLayout(layout, { x: 0, y: 0 }, { width: 20, height: 20, hotX: 0, hotY: 0 }), null);
  }
});

test('F23 Fit ignores only finite nonnegative supplied scroll and Fill is not supported', () => {
  const normal = fit();
  assert.deepEqual(createViewerLayout({ physical: desktop, viewport, mode: 'fit', scroll: { left: 500, top: 300 } }), normal);
  for (const value of [NaN, Infinity, -Infinity, -1, '10']) {
    assert.equal(createViewerLayout({ physical: desktop, viewport, mode: 'fit', scroll: { left: value, top: 0 } }), null);
    assert.equal(createViewerLayout({ physical: desktop, viewport, mode: 'one-to-one', scroll: { left: 0, top: value } }), null);
  }
  assert.equal(createViewerLayout({ physical: desktop, viewport, mode: 'fill' }), null);
});

test('F23 invalid physical dimensions and CSS rectangles fail closed', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity, '100', null, undefined]) for (const key of ['width', 'height']) {
    assert.equal(createViewerLayout({ physical: { ...desktop, [key]: value }, viewport, mode: 'fit' }), null);
    assert.equal(createViewerLayout({ physical: desktop, viewport: { ...viewport, [key]: value }, mode: 'fit' }), null);
  }
  for (const value of [NaN, Infinity, -Infinity, '10', null]) for (const key of ['left', 'top']) {
    assert.equal(createViewerLayout({ physical: { ...desktop, [key]: value }, viewport, mode: 'fit' }), null);
    assert.equal(createViewerLayout({ physical: desktop, viewport: { ...viewport, [key]: value }, mode: 'fit' }), null);
  }
  assert.equal(createViewerLayout(null), null);
  assert.equal(createViewerLayout({ physical: desktop, viewport: null, mode: 'fit' }), null);
  assert.equal(createViewerLayout({ physical: desktop, viewport, mode: 'fit', scroll: null }), null);
});

test('F23 coordinate overflow and scale underflow cannot manufacture a usable transform', () => {
  assert.equal(createViewerLayout({ physical: { width: Number.MAX_VALUE, height: 1, left: Number.MAX_VALUE }, viewport, mode: 'fit' }), null);
  assert.equal(createViewerLayout({ physical: desktop, viewport: { left: Number.MAX_VALUE, top: 0, width: Number.MAX_VALUE, height: 1 }, mode: 'fit' }), null);
  assert.equal(createViewerLayout({ physical: { width: Number.MAX_VALUE, height: Number.MAX_VALUE },
    viewport: { left: 0, top: 0, width: Number.MIN_VALUE, height: Number.MIN_VALUE }, mode: 'fit' }), null);
  assert.equal(createViewerLayout({ physical: { width: Number.MIN_VALUE, height: Number.MIN_VALUE },
    viewport: { left: 0, top: 0, width: Number.MAX_VALUE, height: Number.MAX_VALUE }, mode: 'fit' }), null);
});

test('F23 fractional exact edges normalize to0/1 while just-outside/nonfinite points are rejected', () => {
  const layout = createViewerLayout({ physical: { width: 2, height: 2 }, viewport: { left: .1, top: -.3, width: .2, height: .2 }, mode: 'fit' });
  const right = layout.painted.left + layout.painted.width, bottom = layout.painted.top + layout.painted.height;
  assert.deepEqual(normalizedClientPoint(layout, right, bottom), { x: 1, y: 1 });
  assert.deepEqual(normalizedClientPoint(layout, layout.painted.left, layout.painted.top), { x: 0, y: 0 });
  assert.equal(normalizedClientPoint(layout, right + Number.EPSILON, bottom), null);
  assert.equal(normalizedClientPoint(layout, layout.painted.left - Number.EPSILON, bottom), null);
  for (const value of [NaN, Infinity, -Infinity, '10']) assert.equal(normalizedClientPoint(layout, value, 0), null);
  assert.equal(normalizedClientPoint(null, 0, 0), null);
});

test('F23 negative physical monitor origins round-trip through the same scrolled inverse', () => {
  const layout = scrolled(), client = physicalPointToClient(layout, -1220, 250);
  pointNear(client, { x: 500.25, y: 179.75 });
  pointNear(normalizedClientPoint(layout, client.x, client.y), { x: 700 / 1920, y: 350 / 1080 });
  assert.equal(physicalPointToClient(layout, NaN, 0), null);
  assert.equal(physicalPointToClient(null, 0, 0), null);
});

test('F23 cursor hotspot subtracts monitor origin and scales physical shape dimensions', () => {
  const layout = createViewerLayout({ physical: { width: 1000, height: 500, left: -1000, top: 200 },
    viewport: { left: 10, top: 20, width: 500, height: 500 }, mode: 'fit' });
  const cursor = cursorPlacementForLayout(layout, { x: -500, y: 450 }, { width: 20, height: 30, hotX: 10, hotY: 15 });
  rectNear(cursor.rect, { left: 255, top: 262.5, width: 10, height: 15 });
  rectNear(cursor.visible, cursor.rect); rectNear(cursor.source, { left: 0, top: 0, width: 20, height: 30 });
});

test('F23 cursor layers share image/viewport clipping and bounded bitmap source crop', () => {
  const layout = createViewerLayout({ physical: { width: 1000, height: 500, left: -1000, top: 200 },
    viewport: { left: 10, top: 20, width: 500, height: 500 }, mode: 'fit' });
  const cursor = cursorPlacementForLayout(layout, { x: -1000, y: 200 }, { width: 20, height: 20, hotX: 10, hotY: 10 });
  rectNear(cursor.rect, { left: 5, top: 140, width: 10, height: 10 });
  rectNear(cursor.visible, { left: 10, top: 145, width: 5, height: 5 });
  rectNear(cursor.source, { left: 10, top: 10, width: 10, height: 10 });
  const scroll = scrolled(), clipped = cursorPlacementForLayout(scroll, { x: -1619.75, y: 100.5 }, { width: 32, height: 32, hotX: 16, hotY: 16 });
  rectNear(clipped.visible, { left: 100.5, top: 30.25, width: 16, height: 16 });
  rectNear(clipped.source, { left: 16, top: 16, width: 16, height: 16 });
});

test('F23 invisible, invalid and overflowing cursor shapes do not paint', () => {
  const layout = fit(), point = { x: 100, y: 100 }, shape = { width: 20, height: 20, hotX: 0, hotY: 0 };
  assert.equal(cursorPlacementForLayout(layout, { x: -1000, y: -1000 }, shape), null);
  for (const patch of [{ width: 0 }, { height: Infinity }, { hotX: -1 }, { hotX: 20 }, { hotY: NaN }])
    assert.equal(cursorPlacementForLayout(layout, point, { ...shape, ...patch }), null);
  assert.equal(cursorPlacementForLayout(layout, { x: Infinity, y: 0 }, shape), null);
  assert.equal(cursorPlacementForLayout(null, point, shape), null);
});

test('F23 fractional cursor clipping always stays within the physical bitmap', () => {
  const layout = fit(), shape = { width: 31, height: 27, hotX: 15, hotY: 13 };
  for (const x of [0, .25, 960, 1919.75, 1920]) for (const y of [0, .75, 540, 1079.25, 1080]) {
    const cursor = cursorPlacementForLayout(layout, { x, y }, shape);
    assert.ok(cursor);
    assert.ok(cursor.source.left >= 0 && cursor.source.top >= 0 && cursor.source.width > 0 && cursor.source.height > 0);
    assert.ok(cursor.source.left + cursor.source.width <= shape.width);
    assert.ok(cursor.source.top + cursor.source.height <= shape.height);
    rectNear(cursor.visible, { left: cursor.rect.left + cursor.source.left * layout.scale,
      top: cursor.rect.top + cursor.source.top * layout.scale,
      width: cursor.source.width * layout.scale, height: cursor.source.height * layout.scale });
  }
});

test('F23 delivery quality and encoded dimensions never affect physical pointer/cursor mapping', () => {
  const expected = fit(), expectedPoint = normalizedClientPoint(expected, 510, 420);
  const shape = { width: 20, height: 20, hotX: 10, hotY: 10 };
  const expectedCursor = cursorPlacementForLayout(expected, { x: 960, y: 540 }, shape);
  for (const quality of [.5, .75, 1]) {
    const layout = createViewerLayout({ physical: { ...desktop, encodedWidth: 1920 * quality, encodedHeight: 1080 * quality },
      viewport, mode: 'fit', deliveryScale: quality });
    assert.deepEqual(layout, expected);
    assert.deepEqual(normalizedClientPoint(layout, 510, 420), expectedPoint);
    assert.deepEqual(cursorPlacementForLayout(layout, { x: 960, y: 540 }, shape), expectedCursor);
  }
});

test('F23 browser zoom/DPR use CSS bounds once and preserve normalized/physical correspondence', () => {
  for (const zoom of [.75, 1, 1.25, 2]) for (const dpr of [1, 1.5, 2, 3]) {
    const layout = createViewerLayout({ physical: { ...desktop, left: -1920, top: -100 },
      viewport: { left: 13.5 / zoom, top: 27.25 / zoom, width: 1000 / zoom, height: 700 / zoom }, mode: 'fit', devicePixelRatio: dpr });
    const client = physicalPointToClient(layout, -480, 170);
    pointNear(normalizedClientPoint(layout, client.x, client.y), { x: .75, y: .25 });
    near(layout.painted.width, 1000 / zoom);
  }
});

test('F23 transform snapshots do not change when caller geometry objects are mutated', () => {
  const physical = { ...desktop }, surface = { ...viewport }, scroll = { left: 20, top: 10 };
  const layout = createViewerLayout({ physical, viewport: surface, mode: 'one-to-one', scroll });
  physical.width = 100; surface.left = 999; scroll.left = 800;
  assert.equal(layout.physical.width, 1920); assert.equal(layout.viewport.left, 10); assert.equal(layout.scroll.left, 20);
  assert.equal(layout.painted.left, -10);
});

test('F23 DOMRect-style inherited fields are read explicitly instead of lost by object spread', () => {
  const bounds = Object.create(viewport);
  assert.deepEqual(Object.keys(bounds), []);
  assert.deepEqual(createViewerLayout({ physical: desktop, viewport: bounds, mode: 'fit' }), fit());
});
