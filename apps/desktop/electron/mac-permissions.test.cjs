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
