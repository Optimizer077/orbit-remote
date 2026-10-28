'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countdownLabel, inviteRemaining, newlyJoined } = require('../renderer/src/ui/invite-progress.ts');
const { pairedDevicesSignature } = require('./host-supervisor.cjs');

test('invite countdown shows minutes and seconds and reaches 0:00 only at expiry', () => {
  const at = Date.parse('2026-10-27T12:05:00Z');
  assert.equal(countdownLabel(inviteRemaining('2026-10-27T12:05:00Z', at - 272000)), '4:32');
  assert.equal(countdownLabel(inviteRemaining('2026-10-27T12:05:00Z', at - 300)), '0:01');
  assert.equal(inviteRemaining('2026-10-27T12:05:00Z', at), 0);
  assert.equal(inviteRemaining('2026-10-27T12:05:00Z', at + 5000), 0, 'never negative');
  assert.equal(countdownLabel(0), '0:00');
  assert.equal(inviteRemaining(undefined, at), null);
  assert.equal(inviteRemaining('not a date', at), null);
});

test('a host clock ahead of this one never shows more than the five-minute invite lifetime', () => {
  const at = Date.parse('2026-10-27T12:05:00Z');
  assert.equal(countdownLabel(inviteRemaining('2026-10-27T12:05:00Z', at - 9 * 60_000)), '5:00');
});

const invite = { expiresAt: '2026-10-27T12:05:00Z' }; // created 12:00:00 on the host clock

test('a re-pair that keeps its id but has a new pairing time counts as joined', () => {
  const before = [{ id: 'laptop', name: 'Laptop', direction: 'incoming', pairedAt: '2026-10-20T09:00:00Z' }];
  assert.equal(newlyJoined(invite, before), undefined);
  const after = [{ id: 'laptop', name: 'Laptop', direction: 'incoming', pairedAt: '2026-10-27T12:01:30Z' }];
  assert.equal(newlyJoined(invite, after)?.name, 'Laptop');
});

test('devices paired before the invite are never "joined", even if the device list was empty when it was created', () => {
  const old = [{ id: 'a', name: 'Old A', direction: 'incoming', pairedAt: '2026-10-27T11:59:59Z' }, { id: 'b', name: 'Old B', direction: 'incoming', pairedAt: '2026-01-01T00:00:00Z' }];
  assert.equal(newlyJoined(invite, old), undefined);
  assert.equal(newlyJoined(invite, [{ id: 'c', name: 'No time', direction: 'incoming' }]), undefined, 'unknown pairing time is not a join');
});

test('only active incoming pairings count, and an invite without expiry never reports a join', () => {
  const fresh = '2026-10-27T12:02:00Z';
  assert.equal(newlyJoined(invite, [{ id: 'o', name: 'Saved host', direction: 'outgoing', pairedAt: fresh }]), undefined);
  assert.equal(newlyJoined(invite, [{ id: 'r', name: 'Gone', direction: 'incoming', revoked: true, pairedAt: fresh }]), undefined);
  assert.equal(newlyJoined({}, [{ id: 'n', name: 'New', direction: 'incoming', pairedAt: fresh }]), undefined);
  assert.equal(newlyJoined(invite, [{ id: 'p', name: 'Paused', direction: 'incoming', blockedByOwner: true, pairedAt: fresh }])?.name, 'Paused',
    'a paused re-pair is still reported; the dialog words it differently');
});

test('paired-device signature changes on a new, re-paired or revoked pairing and ignores statuses without pairings', () => {
  const one = pairedDevicesSignature({ pairedDevices: [{ id: 'b', createdAt: '1' }, { id: 'a', createdAt: '1' }] });
  assert.equal(one, pairedDevicesSignature({ pairedDevices: [{ id: 'a', createdAt: '1' }, { id: 'b', createdAt: '1' }] }), 'order does not matter');
  assert.notEqual(one, pairedDevicesSignature({ pairedDevices: [{ id: 'a', createdAt: '1' }, { id: 'b', createdAt: '1' }, { id: 'c', createdAt: '1' }] }));
  assert.notEqual(one, pairedDevicesSignature({ pairedDevices: [{ id: 'a', createdAt: '1' }, { id: 'b', createdAt: '2' }] }), 're-pair keeps the id but changes createdAt');
  assert.notEqual(one, pairedDevicesSignature({ pairedDevices: [{ id: 'a', createdAt: '1' }, { id: 'b', createdAt: '1', revokedAt: '2026-10-27T12:00:00Z' }] }));
  assert.equal(pairedDevicesSignature({ host: {}, sessions: [] }), undefined, 'the UI status carries no pairings and must not look like a change');
  assert.equal(pairedDevicesSignature(null), undefined);
});
