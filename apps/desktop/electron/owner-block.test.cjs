'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { OrbitController } = require('./controller.cjs');
const peer = { id: 'paired-device', name: 'Generated peer', permissions: { view: true, control: false }, blockedByOwner: true };
const make = () => new OrbitController({ directory: os.tmpdir(), controlToken: 'generated-token' });

test('owner device block uses only the fixed local route and does not require a live session', async () => {
  const controller = make(), calls = [];
  controller.local = async (...args) => { calls.push(args); };
  controller.remote = async () => assert.fail('Block cannot contact a renderer-selected remote host');
  assert.deepEqual(await controller.invoke('device.block', { deviceId: peer.id, address: 'https://untrusted.invalid', sessionId: 'already-gone' }), { ok: true });
  assert.deepEqual(calls, [['peers/paired-device/block', 'POST']]); assert.equal(controller.sessions.size, 0);
});

test('owner Allow returns the host DTO and leaves all permission grants unchanged', async () => {
  const controller = make(), calls = [], permissions = { view: true, control: false, clipboard: false, files: false, power: false };
  controller.local = async (...args) => { calls.push(args); return { ...peer, blockedByOwner: false, permissions }; };
  const result = await controller.invoke('device.allow', { deviceId: peer.id, permissions: { control: true } });
  assert.equal(result.direction, 'incoming'); assert.equal(result.blockedByOwner, false); assert.deepEqual(result.permissions, permissions);
  assert.deepEqual(calls, [['peers/paired-device/allow', 'POST']]); assert.equal(controller.sessions.size, 0);
});

for (const action of ['device.block', 'device.allow']) test(`${action} refuses invalid paths and preserves final unknown/revoked errors`, async () => {
  const controller = make(); let calls = 0;
  controller.local = async () => { calls++; throw Object.assign(new Error('Peer no longer exists.'), { status: 404 }); };
  for (const deviceId of [undefined, null, '', '../peer', 'a/b', 'a?b', 'x'.repeat(129), []]) await assert.rejects(controller.invoke(action, { deviceId }), /Invalid paired device/);
  assert.equal(calls, 0);
  await assert.rejects(controller.invoke(action, { deviceId: peer.id }), error => error.status === 404); assert.equal(calls, 1);
});

test('incoming device listing retains the owner block separately from unchanged grants', async () => {
  const controller = make(); controller.local = async route => { assert.equal(route, 'peers'); return [peer, { ...peer, id: 'revoked', revokedAt: 'generated' }]; };
  const result = await controller.devices(); assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].blockedByOwner, true); assert.deepEqual(result.devices[0].permissions, peer.permissions); assert.equal(result.devices[0].online, null);
});

// Execute the production IPC registration body, rather than copying its policy.
function ipcFixture({ statusFails = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('orbit:invoke',"); const end = source.indexOf('\n  });', start);
  assert.ok(start > 0 && end > start);
  const viewers = source.match(/const viewerActions = new Set\([\s\S]*?\);/)[0];
  const controller = make(), calls = [];
  controller.local = async (...args) => { calls.push(args); if (args[0] === 'status' && statusFails) throw new Error('Generated later health failure.'); return args[0] === 'status' ? { sessions: [] } : { ...peer, blockedByOwner: false }; };
  const frame = { url: 'file:///generated/main.html' }, owner = { id: 1, mainFrame: frame, isDestroyed: () => false };
  const popFrame = { url: 'file:///generated/main.html?viewer=1' }, popout = { id: 2, mainFrame: popFrame, isDestroyed: () => false };
  const viewerWindows = new Map([[2, { window: { isDestroyed: () => false }, sessionId: 'not-authorized', presentation: { device: {} }, endedReason: 'Generated ended screen' }]]);
  const context = { controller, mainWindow: { webContents: owner }, viewerWindows, windowStates: new Map(), windowInputs: new Map(), windowReconnects: new Map(),
    frameGate: { capture: () => 1 }, pageUrl: viewer => viewer ? popFrame.url : frame.url, observeIncoming: () => {},
    ipcMain: { handle: (_name, handler) => { context.handler = handler; } } };
  vm.runInNewContext(viewers + '\n' + source.slice(start, end + '\n  });'.length), context);
  return { invoke: context.handler, calls, owner, popout, frame, popFrame };
}

for (const action of ['device.block', 'device.allow']) test(`${action} IPC is owner-only and rejects popout, subframe and destroyed callers`, async () => {
  const fixture = ipcFixture(), { invoke, owner, popout, frame, popFrame, calls } = fixture;
  await assert.rejects(invoke({ sender: popout, senderFrame: popFrame }, action, { deviceId: peer.id }), /cannot perform/);
  await assert.rejects(invoke({ sender: owner, senderFrame: { url: frame.url } }, action, { deviceId: peer.id }), /Untrusted/);
  owner.isDestroyed = () => true; await assert.rejects(invoke({ sender: owner, senderFrame: frame }, action, { deviceId: peer.id }), /Untrusted/);
  assert.equal(calls.length, 0);
  owner.isDestroyed = () => false; await invoke({ sender: owner, senderFrame: frame }, action, { deviceId: peer.id });
  assert.equal(calls[0][0], 'peers/' + peer.id + (action === 'device.allow' ? '/allow' : '/block'));
});

test('successful owner Allow is not reported as failed when the later banner health probe fails', async () => {
  const { invoke, owner, frame } = ipcFixture({ statusFails: true });
  const result = await invoke({ sender: owner, senderFrame: frame }, 'device.allow', { deviceId: peer.id });
  assert.equal(result.blockedByOwner, false); assert.deepEqual(result.permissions, peer.permissions);
});

test('preload exposes block/allow through the fixed IPC bridge without arbitrary actions', async () => {
  let bridge; const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { on() {}, invoke: async (...args) => { calls.push(args); return { ok: true }; } } }),
  });
  await bridge.invoke('device.block', { deviceId: peer.id }); await bridge.invoke('device.allow', { deviceId: peer.id });
  assert.deepEqual(calls.map(x => x.slice(0, 2)), [['orbit:invoke', 'device.block'], ['orbit:invoke', 'device.allow']]);
  await assert.rejects(bridge.invoke('arbitrary.http', {}), /Unknown application action/);
});

for (const code of ['ended_by_owner', undefined]) test(`HTTP403 ${code || 'old untyped path'} cannot resume after an earlier ordinary-stop hint`, async () => {
  const controller = make(), device = { id: 'host', fingerprint: 'AA'.repeat(32) }; controller.connections.push(device);
  controller.sessions.set('viewer', { device, remoteId: 'remote-session', monitors: [], monitorId: null, resumeEpoch: 'generated-epoch', permissions: { view: true }, frameSlots: new Map(), sessionGeneration: 0 });
  controller.noteHostStopping('viewer', 'host_stopping'); assert.equal(controller.reconnectTargets.has('viewer'), true);
  let requests = 0, posts = 0; controller.remote = async (_device, _route, options) => { requests++; if (options?.method === 'POST') posts++; throw Object.assign(new Error('The owner ended this session. Ask them to allow you again.'), { status: 403, ...(code ? { code } : {}) }); };
  await assert.rejects(controller.invoke('session.frame', { sessionId: 'viewer' }), error => error.status === 403);
  assert.equal(controller.sessions.size, 0); assert.equal(controller.canReconnect('viewer'), false); assert.equal(controller.reconnectTargets.has('viewer'), false);
  for (let n = 0; n < 3; n++) await assert.rejects(controller.invoke('session.frame', { sessionId: 'viewer' }), error => error.status === 410);
  await assert.rejects(controller.invoke('session.reconnect', { sessionId: 'viewer' }), /unavailable/);
  assert.equal(requests, 1); assert.equal(posts, 0);
});
