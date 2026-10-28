'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { friendlyError, rawErrorText, recheckOutcome } = require('../renderer/src/ui/friendly-errors.ts');

// Errors thrown in main reach the renderer as text inside this Electron wrapper.
const ipc = message => new Error(`Error invoking remote method 'orbit:invoke': Error: ${message}`);
const coded = (message, extra) => Object.assign(new Error(message), extra);

test('timeouts and unreachable computers ask to check Orbit, the lock screen and Tailscale on the other computer', () => {
  for (const error of [ipc('Device request timed out.'), ipc('Device TLS handshake timed out.'), ipc('connect ETIMEDOUT 100.64.0.2:47832'),
    ipc('connect ECONNREFUSED 100.64.0.2:47832'), ipc('Device request deadline exceeded.'), coded('Opaque', { code: 'ORBIT_REQUEST_TIMEOUT' })]) {
    const result = friendlyError(error);
    assert.equal(result.title, 'The other computer didn’t answer.');
    assert.match(result.action, /Orbit is open, the screen is unlocked, and Tailscale is on/);
  }
});

test('expired or used invites ask for a new invite on the host', () => {
  for (const error of [ipc('This pairing invitation has expired.'), ipc('The invite expired, was already used, or is invalid.')]) {
    const result = friendlyError(error);
    assert.equal(result.title, 'This invite can’t be used anymore.');
    assert.match(result.action, /create a new invite/);
  }
});

test('an unexpectedly long invite validity is explained as a clock difference', () => {
  for (const message of ['Pairing invitation validity is unexpectedly long.', 'The device certificate is expired or not yet valid.']) {
    const result = friendlyError(ipc(message));
    assert.equal(result.title, 'The two computers’ clocks may not match.');
    assert.match(result.action, /date, time and time zone on both computers/);
  }
});

test('401 and revoked access ask to pair again', () => {
  for (const error of [ipc('Device request failed (401).'), coded('Opaque', { status: 401 }), 'Access revoked by the host.']) {
    const result = friendlyError(error);
    assert.equal(result.title, 'This computer no longer has access.');
    assert.match(result.action, /pair again/);
  }
});

test('unavailable remote listening names the cause the renderer already knows', () => {
  const error = ipc('Remote listening is unavailable. Check Tailscale and identity status before pairing.');
  const off = friendlyError(error, { tailscaleConnected: false, identityExpired: true });
  assert.equal(off.title, 'Tailscale is off on this computer.', 'Tailscale off wins: the re-check button is on screen then');
  assert.match(off.action, /Tailscale is on now — check again/);
  const expired = friendlyError(error, { tailscaleConnected: true, identityExpired: true });
  assert.equal(expired.title, 'This computer’s identity has expired.');
  assert.equal(expired.action, 'Replace it under Settings → Identity, then pair again.');
  const rotating = friendlyError(error, { tailscaleConnected: true, identityExpired: false });
  assert.equal(rotating.title, 'This computer is replacing its identity.');
  assert.equal(rotating.action, 'Wait a moment, then try again.');
  assert.doesNotMatch(`${expired.action} ${rotating.action}`, /check again/, 'never points at a re-check button that is not shown');
});

test('the clock rule says the clocks may not match, and a locally expired invite also suggests checking the time', () => {
  const certificate = friendlyError(ipc('The device certificate is expired or not yet valid.'));
  assert.equal(certificate.title, 'The two computers’ clocks may not match.');
  assert.match(certificate.action, /may need to replace its identity/);
  assert.match(friendlyError(ipc('This pairing invitation has expired.')).action, /If a new invite also fails, check both computers’ date and time\./);
  assert.doesNotMatch(friendlyError(ipc('The invite expired, was already used, or is invalid.')).action, /date and time/, 'host-side expiry or reuse is not a clock hint');
});

test('identity-change codes map only like errorMessage(): local checks without an HTTP status', () => {
  assert.match(friendlyError(coded('Opaque', { code: 'pin_mismatch' })).action, /Forget it under Devices/);
  assert.equal(friendlyError(coded('Opaque', { code: 'pin_mismatch', status: 409 })).title, 'Something went wrong.');
});

test('Tailscale re-check outcome is decided from the refreshed status, not the supervisor state', () => {
  assert.equal(recheckOutcome({ tailscaleConnected: true, hostOnline: true, identityExpired: false }).tone, 'success');
  assert.match(recheckOutcome({ tailscaleConnected: false }).message, /still can’t find Tailscale/);
  assert.match(recheckOutcome({ tailscaleConnected: true, identityExpired: true, hostOnline: false }).message, /identity has expired\. Replace it under Settings → Identity/);
  assert.match(recheckOutcome({ tailscaleConnected: true, identityExpired: false, hostOnline: false }).message, /replacing its identity\. Wait a moment/);
  assert.match(recheckOutcome({ refused: 'identity_expired', tailscaleConnected: false }).message, /identity has expired/, 'main refused because of the identity, so do not blame Tailscale');
  assert.match(recheckOutcome({ refused: 'identity_rotating', tailscaleConnected: true }).message, /replacing its identity/);
  assert.match(recheckOutcome({ refused: 'too_soon' }).message, /Wait a few seconds/);
  assert.match(recheckOutcome({ refused: 'sessions_active' }).message, /after it disconnects/);
  assert.match(recheckOutcome({ stopped: true, tailscaleConnected: false }).message, /Choose Retry above/);
  assert.match(recheckOutcome({ pending: true, tailscaleConnected: false }).message, /Still checking/);
});

test('identity changes and incomplete invites have their own next action', () => {
  assert.match(friendlyError(coded('x', { code: 'pin_mismatch' })).action, /Forget it under Devices/);
  assert.match(friendlyError("This device's identity changed. Forget it, then pair again.").action, /Forget it under Devices/);
  assert.equal(friendlyError(ipc('Paste a complete Orbit pairing invitation.')).title, 'That doesn’t look like a complete invite.');
});

test('unknown errors fall back to a generic message and keep the original text as details', () => {
  const result = friendlyError(ipc('Something unexpected: code 7.'));
  assert.deepEqual(result, { title: 'Something went wrong.', action: 'Try again. If it keeps happening, restart Orbit on both computers.', details: 'Something unexpected: code 7.' });
  assert.equal(friendlyError(undefined).title, 'Something went wrong.');
  assert.equal(friendlyError(undefined).details, 'No further details.');
});

test('details keep the original text without the Electron IPC wrapper', () => {
  assert.equal(rawErrorText(ipc('Device request timed out.')), 'Device request timed out.');
  assert.equal(friendlyError(ipc('Device TLS handshake timed out.')).details, 'Device TLS handshake timed out.');
  assert.equal(rawErrorText('Plain text'), 'Plain text');
});
