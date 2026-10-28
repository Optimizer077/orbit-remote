'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// The production `ipcMain.handle('orbit:invoke', ...)` call, found by name and closed by brace
// matching, so a change of indentation or an inner `});` cannot cut it short. Braces inside the
// body's strings and regexes are balanced in main.cjs; the parse check fails loudly if that changes.
function invokeRegistration(source) {
  const start = source.search(/ipcMain\.handle\(\s*'orbit:invoke'\s*,/);
  assert.ok(start >= 0, 'main.cjs must register orbit:invoke');
  const open = source.indexOf('{', source.indexOf('=>', start));
  let depth = 0, close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { close = i; break; }
  }
  const end = source.indexOf(');', close);
  assert.ok(close > open && /^\s*$/.test(source.slice(close + 1, end)), 'the orbit:invoke handler must close with });');
  const registration = source.slice(start, end + 2);
  assert.doesNotThrow(() => new vm.Script(registration), 'the extracted registration must parse');
  return registration;
}

// Runs the actual production IPC registration body with in-memory doubles.
// No Electron dialog, System Settings page or macOS permission prompt is touched.
function ownerFixture({ mac = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const calls = [], setups = [], frame = { url: 'file:///generated/main.html' }, popupFrame = { url: 'file:///generated/main.html?viewer=1' };
  const owner = { id: 1, mainFrame: frame, isDestroyed: () => false }, popup = { id: 2, mainFrame: popupFrame, isDestroyed: () => false };
  const mainWindow = { webContents: owner };
  const controller = { sessions: new Map(), endedSessions: new Map(), invoke: async (action, payload) => { calls.push({ action, payload }); return { ok: true }; } };
  const context = { controller, mainWindow, viewerWindows: new Map([[2, { window: { isDestroyed: () => false }, sessionId: 'generated', presentation: { device: {} } }]]),
    showMacPermissionSetup: mac ? async parent => { setups.push(parent); } : undefined,
    pageUrl: viewer => viewer ? popupFrame.url : frame.url, windowStates: new Map(), windowInputs: new Map(), windowReconnects: new Map(), frameGate: { capture: () => 1 },
    ipcMain: { handle(_name, handler) { context.handler = handler; } } };
  vm.runInNewContext(source.match(/const viewerActions = new Set\([\s\S]*?\);/)[0] + '\n' + invokeRegistration(source), context);
  return { invoke: context.handler, calls, setups, frame, popupFrame, owner, popup, mainWindow };
}

test('app.mac-permissions is owner-only at the actual production IPC boundary', async () => {
  const f = ownerFixture();
  await assert.rejects(f.invoke({ sender: f.popup, senderFrame: f.popupFrame }, 'app.mac-permissions', { sessionId: 'generated' }), /cannot perform/);
  await assert.rejects(f.invoke({ sender: f.owner, senderFrame: { url: f.frame.url } }, 'app.mac-permissions', {}), /Untrusted/);
  await assert.rejects(f.invoke({ sender: f.owner, senderFrame: { url: 'https://untrusted.example/' } }, 'app.mac-permissions', {}), /Untrusted/);
  f.owner.isDestroyed = () => true;
  await assert.rejects(f.invoke({ sender: f.owner, senderFrame: f.frame }, 'app.mac-permissions', {}), /Untrusted/);
  assert.equal(f.setups.length, 0); assert.equal(f.calls.length, 0);
});

test('the owner opens the existing Mac permission setup once, attached to the owner window, without reaching the host', async () => {
  const f = ownerFixture();
  const result = await f.invoke({ sender: f.owner, senderFrame: f.frame }, 'app.mac-permissions', { request: 'screen', grant: true });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
  assert.equal(f.setups.length, 1); assert.equal(f.setups[0], f.mainWindow, 'the payload cannot choose a prompt or a window');
  assert.equal(f.calls.length, 0, 'no host or controller request');
});

test('off macOS the action is refused instead of opening anything', async () => {
  const f = ownerFixture({ mac: false });
  await assert.rejects(f.invoke({ sender: f.owner, senderFrame: f.frame }, 'app.mac-permissions', {}), /only available on a Mac/);
  assert.equal(f.calls.length, 0);
});

test('preload exposes the fixed Mac permission action through the existing bridge only', async () => {
  let bridge; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer: {
      on() {}, removeListener() {}, invoke: async (...args) => { calls.push(args); return { ok: true }; },
    } }),
  });
  await bridge.invoke('app.mac-permissions');
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['orbit:invoke', 'app.mac-permissions']]);
  for (const action of ['app.mac-permissions.grant', 'mac.permissions.request', 'shell.openExternal'])
    await assert.rejects(bridge.invoke(action, {}), /Unknown application action/);
  assert.equal(calls.length, 1);
});
