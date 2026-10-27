'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');
const actions = ['session.start', 'clipboard.read', 'clipboard.write', 'files.list', 'files.upload', 'files.download'];
const failure = code => Object.assign(new Error('Untrusted details must not enter the identity response.'),
  { code, address: 'private-address', stack: 'private-stack', secret: 'private-secret' });

// Run the actual registration body. No Electron/native host, clipboard, network,
// file transfer or OS input is invoked by these fixed in-memory doubles.
function fixture(error, result = { ok: true }) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('orbit:invoke',"), end = source.indexOf('\n  });', start);
  assert.ok(start > 0 && end > start);
  const viewers = source.match(/const viewerActions = new Set\([\s\S]*?\);/)[0];
  const frame = { url: 'file:///generated/main.html' }, popFrame = { url: 'file:///generated/main.html?viewer=1' };
  const owner = { id: 1, mainFrame: frame, isDestroyed: () => false }, popout = { id: 2, mainFrame: popFrame, isDestroyed: () => false };
  const calls = [], sessionId = 'bound-session';
  const controller = { endedSessions: new Map(), sessions: new Map([[sessionId, {}]]),
    async invoke(action, payload) { calls.push({ action, payload }); if (error) throw error; return result; } };
  const viewerWindows = new Map([[2, { sessionId, presentation: { device: {} }, window: { isDestroyed: () => false, close() {} } }]]);
  const context = { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE, controller, mainWindow: { webContents: owner }, viewerWindows,
    windowStates: new Map(), windowInputs: new Map(), windowReconnects: new Map(), frameGate: { capture: () => 1 },
    pageUrl: viewer => viewer ? popFrame.url : frame.url, ipcMain: { handle: (_name, handler) => { context.handler = handler; } } };
  vm.runInNewContext(viewers + '\n' + source.slice(start, end + '\n  });'.length), context);
  const invoke = (action, { popup = false, payload = { sessionId }, senderFrame, sender } = {}) => context.handler(
    { sender: sender || (popup ? popout : owner), senderFrame: senderFrame || (popup ? popFrame : frame) }, action, payload);
  return { invoke, owner, popout, frame, popFrame, calls };
}

for (const code of IDENTITY_TERMINAL) for (const action of actions)
  test(`IPC local identity ${code} survives ${action} as fixed bounded metadata`, async () => {
    const f = fixture(failure(code));
    for (const popup of action === 'session.start' ? [false] : [false, true]) {
      const value = await f.invoke(action, { popup });
      assert.deepEqual(JSON.parse(JSON.stringify(value)), { error: { code, message: IDENTITY_CHANGED_MESSAGE } });
    }
  });

for (const action of actions) test(`IPC ${action} never promotes HTTP or message text to local identity metadata`, async () => {
  for (const code of IDENTITY_TERMINAL) for (const status of [403, 503]) {
    const error = Object.assign(failure(code), { status });
    await assert.rejects(fixture(error).invoke(action), value => value === error);
  }
  for (const error of [new Error('pin_mismatch: ' + IDENTITY_CHANGED_MESSAGE), new Error('Generated ordinary failure.')])
    await assert.rejects(fixture(error).invoke(action), value => value === error);
});

test('IPC identity serialization leaves owner, subframe, destroyed caller and popout session checks intact', async () => {
  const f = fixture(failure('pin_mismatch'));
  await assert.rejects(f.invoke('session.start', { popup: true }), /cannot perform/);
  for (const action of actions.slice(1)) await assert.rejects(f.invoke(action, { popup: true, payload: { sessionId: 'other' } }), /another session/);
  await assert.rejects(f.invoke('session.start', { senderFrame: { url: f.frame.url } }), /Untrusted/);
  f.owner.isDestroyed = () => true;
  await assert.rejects(f.invoke('session.start'), /Untrusted/);
  assert.equal(f.calls.length, 0);
});

test('IPC identity serialization preserves successful and cancelled action results', async () => {
  for (const result of [{ ok: true }, { cancelled: true }, { sessionId: 'new-session' }, { text: 'generated' }])
    for (const action of actions) assert.equal(await fixture(null, result).invoke(action), result);
});

test('IPC local identity metadata is restricted to the six approved action paths', async () => {
  const error = failure('pin_mismatch');
  for (const action of ['session.lock', 'session.restart', 'devices', 'audit']) {
    const f = fixture(error);
    await assert.rejects(f.invoke(action), value => value === error);
  }
});
