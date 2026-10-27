'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { streamFallback, terminalStreamFailure, VideoRetryPolicy } = require('../renderer/src/stream/recovery.ts');
const { PresentationWindow } = require('../renderer/src/stream/presentation-stats.ts');
const { api, OrbitRequestError } = require('../renderer/src/api.ts');
const transient = code => streamFallback({ code, reason: 'Synthetic transient fault', retryable: true });

test('transient retries back off at1/2/5/15s, cap and reset only after60s healthy', () => {
  const policy = new VideoRetryPolicy();
  assert.deepEqual(Array.from({ length: 6 }, () => policy.failed(transient('stream_eof'))), [1000, 2000, 5000, 15000, 15000, 15000]);
  policy.presented(1000); policy.presented(60999);
  assert.equal(policy.failed(transient('decoder_fault')), 15000);
  policy.presented(70000); policy.presented(130000);
  assert.equal(policy.failed(transient('stream_restart')), 1000);
  policy.reset(); assert.equal(policy.failed(transient('host_stopping')), 1000);
});

for (const code of ['session_ended', 'session_ended_by_host', 'session_ended_other', 'access_revoked', 'permission_changed', 'identity_rotated']) {
  test(`terminal ${code} cannot retry even if incorrectly marked retryable`, () => {
    const info = streamFallback({ code, reason: 'Synthetic terminal', retryable: true });
    assert.equal(info.retryable, false); assert.equal(terminalStreamFailure(info), true);
    assert.equal(new VideoRetryPolicy().failed(info), null);
  });
}
for (const status of [401, 403, 410]) test(`HTTP${status} always suppresses video retry`, () => {
  const info = streamFallback({ code: 'stream_unavailable', status, retryable: true });
  assert.equal(info.retryable, false); assert.equal(terminalStreamFailure(info), true);
  assert.equal(new VideoRetryPolicy().failed(info), null);
});

test('unknown, protocol, TLS, capability and bare IPC faults do not create retry loops', () => {
  for (const code of ['stream_protocol_error', 'invalid_video_record', 'tls_pin_failure', 'decoder_unsupported', 'stream_open_denied', 'unknown'])
    assert.equal(new VideoRetryPolicy().failed(streamFallback({ code, retryable: true, status: 409 })), null);
  assert.equal(streamFallback(new Error('timeout')).retryable, false);
  assert.equal(streamFallback({ code: 'stream_unavailable', retryable: false, status: 503 }).retryable, false);
  assert.equal(streamFallback({ code: 'stream_unavailable', retryable: true, status: 503 }).retryable, true);
});

test('actual presentation window counts60Hz without overstating a short burst and decays on a stall', () => {
  const stats = new PresentationWindow(0);
  for (let frame = 1; frame <= 120; frame++) {
    const now = frame * 1000 / 60;
    stats.received(now, 1000); stats.presented(now, .6, .3);
  }
  const steady = stats.snapshot(2000);
  assert.equal(steady.fps, 60); assert.equal(steady.samples, 120);
  assert.ok(Math.abs(steady.decodeMs - .6) < .0001);
  assert.equal(steady.kbps, 480);
  // The last inter-frame gap can be1ms. The displayed rate still counts the full window.
  stats.presented(2001, .5, .2);
  assert.equal(stats.snapshot(2001).fps, 60.5);
  assert.equal(stats.snapshot(4002).fps, 0);
  assert.equal(stats.snapshot(4002).kbps, 0);
});

test('received access units and unchanged image polls never count as presentations', () => {
  const stats = new PresentationWindow(0);
  for (let now = 100; now <= 2000; now += 100) stats.received(now, 1000);
  stats.presented(1000, 1, 1);
  assert.equal(stats.snapshot(2000).fps, .5);
  assert.equal(stats.snapshot(2000).samples, 1);
  assert.equal(stats.snapshot(2000).kbps, 80);
  assert.equal(new PresentationWindow(0).snapshot(10).fps, undefined);
});

test('frame request allows JPEG only with an explicit capability decision and preserves full scale', async () => {
  const original = globalThis.window, calls = [];
  globalThis.window = { orbit: { invoke: async (action, payload) => { calls.push({ action, payload }); return {}; } } };
  try {
    await api.frame('session', 'screen', 1, true, true);
    assert.deepEqual(calls[0].payload, { sessionId: 'session', monitorId: 'screen', scale: 1, includeImage: true, format: 'jpeg', quality: 75 });
    await api.frame('legacy', 'screen', 1, true, false);
    assert.equal(Object.hasOwn(calls[1].payload, 'format'), false);
    assert.equal(calls[1].payload.scale, 1);
  } finally { globalThis.window = original; }
});

test('structured main stream-open error retains retry and terminal metadata through the renderer bridge', async () => {
  const original = globalThis.window;
  globalThis.window = { orbit: { invoke: async () => ({ error: { message: 'Synthetic permission loss', code: 'permission_changed', retryable: false, status: 403 } }) } };
  try {
    await assert.rejects(api.openStream('s', 'm', 1, 'request'), error => {
      assert.ok(error instanceof OrbitRequestError); assert.equal(error.status, 403);
      assert.equal(streamFallback(error).code, 'permission_changed');
      assert.equal(terminalStreamFailure(streamFallback(error)), true); return true;
    });
  } finally { globalThis.window = original; }
});

test('capacity retries wait at least15seconds without resetting the existing failure budget', () => {
  const info = streamFallback({ code: 'stream_capacity', status: 429, retryable: true, reason: 'Video busy' });
  assert.equal(info.retryable, true); const policy = new VideoRetryPolicy();
  assert.equal(policy.failed(info), 15000); assert.equal(policy.failed(transient('stream_eof')), 2000);
  assert.equal(policy.failed(info), 15000); assert.equal(policy.failed(info), 15000);
  policy.reset(); assert.equal(policy.failed(transient('stream_eof')), 1000);
  for (const status of [401, 403, 410]) assert.equal(policy.failed(streamFallback({ ...info, status })), null);
  assert.equal(policy.failed(streamFallback({ ...info, retryable: false })), null);
});

for (const code of ['pin_mismatch', 'identity_mismatch']) test(`typed local identity ${code} keeps its code and uses canonical UI instructions`, async () => {
  const { errorMessage } = require('../renderer/src/api.ts'); const oldWindow = globalThis.window;
  globalThis.window = { orbit: { invoke: async () => ({ error: { code, message: 'Untrusted raw detail' } }) } };
  try { await assert.rejects(api.start('device', true), error => error.code === code && errorMessage(error) === "This device's identity changed. Forget it, then pair again."); }
  finally { globalThis.window = oldWindow; }
  assert.equal(errorMessage(Object.assign(new Error('HTTP detail'), { code, status: 503 })), 'HTTP detail');
});
