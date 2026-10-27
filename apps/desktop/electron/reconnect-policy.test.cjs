'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { HostReturnPolicy } = require('../renderer/src/stream/reconnect-policy.ts');
const failure = (code, extra = {}) => ({ code, reason: 'Generated event', retryable: true, ...extra });
test('ordinary typed host stop permits only one automatic attempt after an authorized fresh draw', () => {
  for (const code of ['host_stopping', 'stream_restart', 'stream_eof', 'stream_unavailable', 'session_reconnected']) {
    const policy = new HostReturnPolicy(); policy.failed(failure(code));
    assert.equal(policy.awaitingHost(), true);
    assert.equal(policy.hostBack(), true); assert.equal(policy.hostBack(), false);
    assert.equal(policy.ownsRetry(), false, 'after the first fresh draw, normal bounded video backoff owns retries');
    policy.failed(failure(code)); assert.equal(policy.hostBack(), false, 'repeated stop events cannot reset the first-draw gate');
    assert.equal(policy.hostBack(), false);
  }
});
test('terminal security codes and HTTP denials permanently disarm an earlier ordinary-stop hint', () => {
  for (const value of [failure('session_ended'), failure('session_ended_by_host'), failure('access_revoked'),
    failure('permission_changed'), failure('identity_rotated'), failure('stream_replaced'),
    ...[401, 403, 410].map(status => failure('host_stopping', { status })), failure('stream_open_denied', { retryable: false })]) {
    const policy = new HostReturnPolicy(); policy.failed(failure('host_stopping')); policy.failed(value);
    assert.equal(policy.hostBack(), false);
    policy.failed(failure('host_stopping')); assert.equal(policy.hostBack(), false);
  }
});
test('unknown errors or human stopping text cannot arm automatic reconnect', () => {
  for (const value of [failure('stream_error'), failure('stream_eof', { retryable: false }), failure('stream_unavailable', { retryable: false }),
    failure('unknown'), failure('host_stopping', { retryable: false }), { reason: 'The host is stopping.' }]) {
    const policy = new HostReturnPolicy(); policy.failed(value);
    assert.equal(policy.hostBack(), false);
  }
  const policy = new HostReturnPolicy(); policy.failed(failure('host_stopping')); policy.deny();
  assert.equal(policy.hostBack(), false); policy.reset(); policy.failed(failure('stream_restart'));
  assert.equal(policy.hostBack(), true, 'only an explicit new context/reset restores a budget');
});


test('untyped image polling errors cannot permanently disarm approved abrupt transport recovery', () => {
  const policy = new HostReturnPolicy(); policy.failed(failure('stream_unavailable'));
  policy.failed({ code: 'stream_open_failed', reason: 'Bare image IPC failure', retryable: false }, 'image');
  assert.equal(policy.awaitingHost(), true); assert.equal(policy.hostBack(), true);
  policy.failed(failure('permission_changed'), 'image'); assert.equal(policy.hostBack(), false);
});
