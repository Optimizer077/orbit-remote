'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMacPermissionSetup } = require('./mac-permissions.cjs');

function fixture(response, screenStatus = 'denied', trusted = false) {
  const calls = [];
  const show = createMacPermissionSetup({
    dialog: { showMessageBox: async options => { calls.push(['dialog', options]); return { response }; } },
    getHostStatus: async () => ({ platform: { canCapture: false, canInput: true } }),
    desktopCapturer: { getSources: async options => { calls.push(['capture', options]); return []; } },
    systemPreferences: {
      getMediaAccessStatus: () => screenStatus,
      isTrustedAccessibilityClient: prompt => { calls.push(['accessibility', prompt]); return trusted; },
    },
    shell: { openExternal: async url => calls.push(['settings', url]) },
  });
  return { calls, show };
}

test('Mac permission setup reads host permissions and does nothing when dismissed', async () => {
  const { calls, show } = fixture(4);
  await show();
  assert.equal(calls.length, 1);
  assert.match(calls[0][1].detail, /Screen Recording: Approval needed\nAccessibility: Allowed/);
  assert.equal(calls[0][1].cancelId, 4);
});

test('screen permission request avoids thumbnails and opens only the fixed screen settings page', async () => {
  const { calls, show } = fixture(0);
  await show();
  assert.deepEqual(calls[1], ['capture', { types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }]);
  assert.deepEqual(calls[2], ['settings', 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
});

test('granted screen permission does not open settings unnecessarily', async () => {
  const { calls, show } = fixture(0, 'granted');
  await show();
  assert.equal(calls.length, 2);
});

test('accessibility request requires the selected native dialog action', async () => {
  const { calls, show } = fixture(1);
  await show();
  assert.deepEqual(calls[1], ['accessibility', true]);
  assert.deepEqual(calls[2], ['settings', 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
});

test('a second request while the sheet is open joins it instead of stacking another sheet', async () => {
  const calls = []; let answer;
  const show = createMacPermissionSetup({
    dialog: { showMessageBox: async options => { calls.push(options); return new Promise(resolve => { answer = resolve; }); } },
    getHostStatus: async () => ({ platform: { canCapture: false, canInput: false } }),
    desktopCapturer: { getSources: async () => [] }, systemPreferences: {}, shell: { openExternal: async () => undefined },
  });
  const first = show('menu'), second = show('banner');
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  answer({ response: 4 }); await first;
  const third = show('banner'); await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(third, first); assert.equal(calls.length, 2, 'a new sheet can open after the first one closes');
  answer({ response: 4 }); await third;
});

test('a failed sheet releases the guard so the next request can open', async () => {
  let fail = true; const calls = [];
  const show = createMacPermissionSetup({
    dialog: { showMessageBox: async () => { calls.push(1); if (fail) throw new Error('generated failure'); return { response: 4 }; } },
    getHostStatus: async () => ({ platform: {} }), desktopCapturer: {}, systemPreferences: {}, shell: {},
  });
  await assert.rejects(show(), /generated failure/);
  fail = false; await show(); assert.equal(calls.length, 2);
});
