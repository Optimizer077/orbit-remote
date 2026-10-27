'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function ownerFixture() {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('orbit:invoke',"), end = source.indexOf('\n  });', start);
  assert.ok(start > 0 && end > start);
  const calls = [], frame = { url: 'file:///generated/main.html' }, popupFrame = { url: 'file:///generated/main.html?viewer=1' };
  const owner = { id: 1, mainFrame: frame, isDestroyed: () => false }, popup = { id: 2, mainFrame: popupFrame, isDestroyed: () => false };
  const controller = { sessions: new Map(), endedSessions: new Map(), invoke: async (action, payload) => { calls.push({ action, payload }); return { revision: 4, entries: [] }; } };
  const context = { controller, mainWindow: { webContents: owner }, viewerWindows: new Map([[2, { window: { isDestroyed: () => false }, sessionId: 'ended', endedReason: 'Ended', presentation: { device: {} } }]]),
    pageUrl: popup => popup ? popupFrame.url : frame.url, windowStates: new Map(), windowInputs: new Map(), windowReconnects: new Map(), frameGate: { capture: () => 1 },
    ipcMain: { handle(_name, handler) { context.handler = handler; } } };
  vm.runInNewContext(source.match(/const viewerActions = new Set\([\s\S]*?\);/)[0] + '\n' + source.slice(start, end + '\n  });'.length), context);
  return { invoke: context.handler, calls, frame, popupFrame, owner, popup };
}
for (const action of ['session.cleanup.list', 'session.cleanup.retry']) test(`${action} is owner-only at the actual production IPC boundary`, async () => {
  const f = ownerFixture();
  await assert.rejects(f.invoke({ sender: f.popup, senderFrame: f.popupFrame }, action, { cleanupId: 'retired' }), /cannot perform/);
  await assert.rejects(f.invoke({ sender: f.owner, senderFrame: { url: f.frame.url } }, action, {}), /Untrusted/);
  f.owner.isDestroyed = () => true; await assert.rejects(f.invoke({ sender: f.owner, senderFrame: f.frame }, action, {}), /Untrusted/);
  assert.equal(f.calls.length, 0); f.owner.isDestroyed = () => false;
  const result = await f.invoke({ sender: f.owner, senderFrame: f.frame }, action, { cleanupId: 'retired' });
  assert.equal(result.revision, 4); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, action);
});
test('preload exposes only fixed cleanup actions and a revision-only removable event listener', async () => {
  let bridge; const listeners = new Map(), removed = [], calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer: {
      on(name, callback) { listeners.set(name, callback); }, removeListener(name, callback) { removed.push({ name, callback }); },
      invoke: async (...args) => { calls.push(args); return {}; },
    } }),
  });
  await bridge.invoke('session.cleanup.list'); await bridge.invoke('session.cleanup.retry', { cleanupId: 'retired' });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [['orbit:invoke', 'session.cleanup.list'], ['orbit:invoke', 'session.cleanup.retry']]);
  await assert.rejects(bridge.invoke('cleanup.remote-delete', {}), /Unknown application action/);
  assert.throws(() => bridge.onCleanupChanged(null), /Expected/);
  const changes = [], unsubscribe = bridge.onCleanupChanged(change => changes.push(change)), listener = listeners.get('orbit:cleanup-changed');
  for (const revision of [-1, NaN, Infinity, '4', Number.MAX_SAFE_INTEGER + 1]) listener({ secret: 'event' }, { revision });
  listener({ secret: 'event' }, { revision: 4, fingerprint: 'not-exposed', address: 'not-exposed' });
  assert.deepEqual(JSON.parse(JSON.stringify(changes)), [{ revision: 4 }]); unsubscribe();
  assert.equal(removed[0].name, 'orbit:cleanup-changed'); assert.equal(removed[0].callback, listener);
});
test('the production cleanup observer sends only to its live owner and never changes cleanup outcome', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const implementation = source.match(/^function notifyCleanupChanged\(change\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(implementation, 'The owner cleanup observer must be wired in main');
  assert.match(source, /onCleanupChanged:\s*notifyCleanupChanged/);
  const sent = [], context = { mainWindow: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } } };
  vm.runInNewContext(implementation, context);
  context.notifyCleanupChanged({ revision: 3, address: 'not-exposed', token: 'not-exposed' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['orbit:cleanup-changed', { revision: 3 }]]);
  context.notifyCleanupChanged({ revision: -1 }); context.notifyCleanupChanged({ revision: '3' }); assert.equal(sent.length, 1);
  context.mainWindow.isDestroyed = () => true; context.notifyCleanupChanged({ revision: 4 }); assert.equal(sent.length, 1);
  context.mainWindow.isDestroyed = () => false; context.mainWindow.webContents.isDestroyed = () => true; context.notifyCleanupChanged({ revision: 4 }); assert.equal(sent.length, 1);
  context.mainWindow.webContents.isDestroyed = () => false; context.mainWindow.webContents.send = () => { throw new Error('closed'); };
  assert.doesNotThrow(() => context.notifyCleanupChanged({ revision: 4 }));
  context.mainWindow = null; assert.doesNotThrow(() => context.notifyCleanupChanged({ revision: 4 }));
});
