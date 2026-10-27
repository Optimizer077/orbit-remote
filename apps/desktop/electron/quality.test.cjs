'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQualityController, BACKOFF_MS, formatMs } = require('./quality.cjs');

const ALL = { canScale: true, canJpeg: true, canConditional: true };
const req = q => { const n = q.next(); return { scale: n.scale, format: n.format, quality: n.quality }; };
const changed = (q, ms, bytes = 100_000) => q.observe({ ok: true, ms, bytes, unchanged: false, status: 200 });
const idle = q => q.observe({ ok: true, ms: 20, bytes: 0, unchanged: true, status: 304 });

test('presets map to the agreed scale/format/q with full capabilities', () => {
  assert.deepEqual(req(createQualityController({ capabilities: ALL, preset: 'sharp' })), { scale: 1, format: 'png', quality: undefined });
  assert.deepEqual(req(createQualityController({ capabilities: ALL, preset: 'balanced' })), { scale: 0.75, format: 'jpeg', quality: 75 });
  assert.deepEqual(req(createQualityController({ capabilities: ALL, preset: 'saver' })), { scale: 0.5, format: 'jpeg', quality: 55 });
  const auto = createQualityController({ capabilities: ALL });
  assert.deepEqual(req(auto), { scale: 1, format: 'png', quality: undefined }, 'Auto starts at Sharp (good LAN loses nothing)');
  assert.deepEqual(auto.state.levels, ['sharp', 'balanced', 'saver']);
  assert.throws(() => createQualityController({ preset: 'ultra' }), /Unknown quality preset/);
});

test('missing capabilities are never exceeded', () => {
  const noJpeg = createQualityController({ capabilities: { canScale: true }, preset: 'balanced' });
  assert.deepEqual(req(noJpeg), { scale: 0.75, format: 'png', quality: undefined });
  assert.match(noJpeg.next().reason, /Balanced \(pinned; host has no JPEG → PNG\)/);
  const noScale = createQualityController({ capabilities: { canJpeg: true }, preset: 'saver' });
  assert.deepEqual(req(noScale), { scale: 1, format: 'jpeg', quality: 55 });
  const none = createQualityController({ capabilities: {}, preset: 'saver' });
  assert.deepEqual(req(none), { scale: 1, format: 'png', quality: undefined });
  // Auto with nothing to adapt collapses to one level and never moves.
  const auto = createQualityController({ capabilities: {} });
  assert.deepEqual(auto.state.levels, ['sharp']);
  for (let i = 0; i < 20; i++) changed(auto, 5000);
  assert.deepEqual(req(auto), { scale: 1, format: 'png', quality: undefined });
  assert.match(auto.next().reason, /Sharp only/);
  // Every request across a long slow run stays inside the capabilities.
  const scaleOnly = createQualityController({ capabilities: { canScale: true } });
  for (let i = 0; i < 30; i++) { changed(scaleOnly, 2000); assert.equal(scaleOnly.next().format, 'png'); }
  assert.equal(scaleOnly.next().scale, 0.5);
});

test('steps down fast: two consecutive over-budget frames, one isolated slow frame is ignored', () => {
  const q = createQualityController({ capabilities: ALL });
  changed(q, 500); changed(q, 100); changed(q, 500);
  assert.equal(q.next().level, 'sharp', 'non-consecutive slow frames do not step down');
  changed(q, 500);
  const n = q.next();
  assert.equal(n.level, 'balanced');
  assert.equal(n.reason, 'slow link: 500 ms per update → Balanced');
  assert.equal(q.state.mode, 'slow');
});

test('a very slow link collapses straight to Data saver with a readable reason', () => {
  const q = createQualityController({ capabilities: ALL });
  changed(q, 1200); changed(q, 1200);
  const n = q.next();
  assert.equal(n.level, 'saver');
  assert.equal(n.reason, 'slow link: 1.2 s per update → Data saver');
  assert.deepEqual(req(q), { scale: 0.5, format: 'jpeg', quality: 55 });
});

test('steps up slowly: needs 10 consecutive good frames; band frames reset the count', () => {
  const q = createQualityController({ capabilities: ALL });
  changed(q, 500); changed(q, 500);
  assert.equal(q.next().level, 'balanced');
  for (let i = 0; i < 9; i++) changed(q, 100);
  changed(q, 330); // Hysteresis band (predicted > 0.9 x budget, actual <= budget): hold, reset the streak.
  for (let i = 0; i < 9; i++) changed(q, 100);
  assert.equal(q.next().level, 'balanced');
  changed(q, 100);
  assert.equal(q.next().level, 'sharp');
  assert.match(q.next().reason, /^link improved: \d+ ms per update → Sharp$/);
});

test('CPU-bound LAN: a lower level that is not faster still recovers to Sharp', () => {
  // docs/PERFORMANCE.md loopback: full PNG ~996 KiB in 148 ms, 0.75 PNG ~706 KiB in 204 ms.
  const q = createQualityController({ capabilities: { canScale: true, canConditional: true } });
  changed(q, 148, 1_000_000); changed(q, 400, 1_000_000); changed(q, 400, 1_000_000); // A transient stall.
  assert.equal(q.next().level, 'balanced');
  for (let i = 0; i < 10; i++) changed(q, 204, 706_000);
  assert.equal(q.next().level, 'sharp');
});

test('narrow link: no useless probes when the better level is predicted to miss the budget', () => {
  // 2 Mbit/s-like: Data saver 55 KB in 300 ms; Balanced known to be 165 KB.
  const q = createQualityController({ capabilities: ALL });
  changed(q, 4000, 900_000); changed(q, 4000, 900_000);
  assert.equal(q.next().level, 'saver');
  for (let i = 0; i < 200; i++) changed(q, 300, 55_000);
  assert.equal(q.next().level, 'saver', 'Balanced would take ~740 ms at ~1.5 Mbit/s: stay');
  assert.equal(q.state.goodStreak, 0);
});

test('hysteresis: a link that fits Balanced but not Sharp does not flap', () => {
  const q = createQualityController({ capabilities: ALL });
  const link = { sharp: 900, balanced: 120, saver: 60 }; // ms per update at each level
  const levels = [];
  for (let i = 0; i < 400; i++) { changed(q, link[q.next().level]); levels.push(q.next().level); }
  const ups = levels.map((l, i) => (i > 0 && l === 'sharp' && levels[i - 1] !== 'sharp' ? i : -1)).filter(i => i >= 0);
  const gaps = ups.map((u, i) => u - (i ? ups[i - 1] : 0));
  // Each failed probe doubles the wait (10, 20, 40, 80 good frames, capped): probes get rarer, never faster.
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), `probe gaps ${gaps}`);
  assert.ok(gaps.at(-1) >= 80, `probe gaps ${gaps}`);
  assert.ok(ups.length <= 6, `probed ${ups.length} times in 400 frames`);
  assert.ok(levels.filter(l => l === 'balanced').length > 0.9 * levels.length);
  assert.equal(q.state.goodNeeded, 80);
  // Frames hovering around the budget never move the level.
  const steady = createQualityController({ capabilities: ALL });
  for (let i = 0; i < 200; i++) changed(steady, i % 2 ? 340 : 200);
  assert.equal(steady.next().level, 'sharp');
});

test('a successful upgrade clears the probe penalty', () => {
  const q = createQualityController({ capabilities: ALL });
  changed(q, 500); changed(q, 500);
  for (let i = 0; i < 10; i++) changed(q, 100);
  changed(q, 500); changed(q, 500); // Failed probe.
  assert.equal(q.state.goodNeeded, 20);
  for (let i = 0; i < 20; i++) changed(q, 100);
  assert.equal(q.next().level, 'sharp');
  for (let i = 0; i < 10; i++) changed(q, 100); // Upgrade held for N frames.
  assert.equal(q.state.goodNeeded, 10);
});

test('idle screen keeps the level, refines once to Sharp, returns when motion resumes', () => {
  const q = createQualityController({ capabilities: ALL });
  changed(q, 500); changed(q, 500);
  assert.equal(q.next().level, 'balanced');
  idle(q); idle(q);
  assert.equal(q.next().level, 'balanced', 'two idle frames: no refine yet');
  idle(q);
  let n = q.next();
  assert.deepEqual({ scale: n.scale, format: n.format, quality: n.quality }, { scale: 1, format: 'png', quality: undefined });
  assert.equal(n.reason, 'screen idle → Sharp refresh for text');
  assert.equal(q.state.refining, true);
  changed(q, 2000); // The refine frame itself is big and slow: must not count against adaptation.
  idle(q); idle(q); idle(q); idle(q); // Still idle: stay Sharp (cheap 304s), no second refine.
  assert.equal(q.next().level, 'sharp');
  changed(q, 2000); // Motion resumes (the first motion frame is Sharp-sized; ignored too).
  n = q.next();
  assert.equal(n.level, 'balanced');
  assert.equal(n.reason, 'motion resumed → Balanced');
  assert.equal(q.state.slowStreak, 0);
  // Re-armed: the next idle period refines again.
  changed(q, 100); idle(q); idle(q); idle(q);
  assert.equal(q.next().level, 'sharp');
});

test('no refine without conditional frames, at Sharp already, or when pinned', () => {
  const noCond = createQualityController({ capabilities: { canScale: true, canJpeg: true }, preset: 'auto' });
  changed(noCond, 500); changed(noCond, 500);
  for (let i = 0; i < 5; i++) idle(noCond);
  assert.equal(noCond.next().level, 'balanced');
  const pinned = createQualityController({ capabilities: ALL, preset: 'saver' });
  for (let i = 0; i < 5; i++) idle(pinned);
  assert.equal(pinned.next().level, 'saver');
  const sharp = createQualityController({ capabilities: ALL });
  for (let i = 0; i < 5; i++) idle(sharp);
  assert.equal(sharp.state.refining, false);
});

test('network failures back off 0.5,1,2,4,8 s (cap) and reset on success', () => {
  const q = createQualityController({ capabilities: ALL, random: () => 0 });
  const delays = [];
  for (let i = 0; i < 7; i++) { q.observe({ ok: false }); delays.push(q.next().delayMs); }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  assert.deepEqual([...BACKOFF_MS], [500, 1000, 2000, 4000, 8000]);
  assert.equal(q.next().attempt, 7);
  assert.equal(q.state.mode, 'reconnecting');
  assert.equal(q.next().reason, 'connection lost: retry 7 in 8.0 s');
  changed(q, 100);
  assert.equal(q.next().attempt, 0);
  assert.equal(q.next().delayMs, 260);
  assert.equal(q.state.mode, 'live');
  q.observe({ ok: false, status: 503 });
  assert.equal(q.next().delayMs, 500, 'sequence restarts after a success');
  assert.match(q.next().reason, /device error \(503\): retry 1/);
});

test('jitter is injectable, deterministic, and never exceeds the schedule', () => {
  const seq = [0.5, 1, 0.25, 0.75, 0.1];
  let i = 0;
  const q = createQualityController({ random: () => seq[i++] });
  const delays = [];
  for (let k = 0; k < 5; k++) { q.observe({ ok: false }); delays.push(q.next().delayMs); }
  assert.deepEqual(delays, [450, 800, 1900, 3400, 7840]);
  const r = createQualityController({ random: () => 0.999 });
  for (let k = 0; k < 10; k++) { r.observe({ ok: false }); const d = r.next().delayMs; assert.ok(d >= 400 && d <= 8000, String(d)); }
});

test('401, 403 and 410 are terminal and never retried', () => {
  for (const [status, text] of [[410, 'session ended by the host (410)'], [401, 'access revoked (401)'], [403, 'access denied (403)']]) {
    const q = createQualityController({ capabilities: ALL });
    q.observe({ ok: false });
    q.observe({ ok: false, status });
    const n = q.next();
    assert.equal(n.terminal, true);
    assert.equal(n.delayMs, null);
    assert.equal(n.reason, text);
    assert.equal(q.state.mode, 'disconnected');
    changed(q, 100); // Later successes cannot revive it.
    assert.equal(q.next().terminal, true);
  }
});

test('a host that rejects JPEG with 400 falls back to PNG instead of backing off', () => {
  const q = createQualityController({ capabilities: ALL, preset: 'balanced' });
  q.observe({ ok: false, status: 400 });
  const n = q.next();
  assert.deepEqual({ scale: n.scale, format: n.format, attempt: n.attempt, delayMs: n.delayMs },
    { scale: 0.75, format: 'png', attempt: 0, delayMs: 260 });
  assert.equal(n.reason, 'host refused JPEG → Balanced as PNG');
});

test('identical inputs give identical outputs; formatMs is readable', () => {
  const run = () => {
    const q = createQualityController({ capabilities: ALL, random: () => 0.3 });
    const out = [];
    for (const ms of [500, 500, 80, 80, 1200, 1200, 90]) { changed(q, ms); out.push(q.next()); }
    q.observe({ ok: false }); out.push(q.next());
    return out;
  };
  assert.deepEqual(run(), run());
  assert.equal(formatMs(1234), '1.2 s');
  assert.equal(formatMs(99.6), '100 ms');
});
