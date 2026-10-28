'use strict';
// Security review D-3: the file-transfer folder comes only from the native folder dialog in main.
// Generated paths only; the local host is an in-memory stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { OrbitController } = require('./controller.cjs');

function scenario(hostSettings, chosen) {
  const dialogs = [], puts = [];
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test',
    native: { chooseFolder: async () => { dialogs.push(true); return chosen; }, getSettings: () => ({}) } });
  controller.local = async (route, method, body) => {
    if (route === 'settings' && method === 'PUT') { puts.push(body); return body; }
    if (route === 'settings') return { ...hostSettings };
    if (route === 'status') return { hostId: 'h', hostName: 'This PC', settings: puts.at(-1) || hostSettings };
    throw new Error('Unexpected local route ' + route);
  };
  return { controller, dialogs, puts };
}

const STARTUP = 'C:\\Users\\generated\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup';

test('a renderer-supplied folder is ignored; enabling transfer asks the native dialog', async () => {
  const { controller, dialogs, puts } = scenario({ fileTransferEnabled: false, fileTransferRoot: null }, 'D:\\Orbit transfers');
  await controller.invoke('settings.update', { allowFiles: true, fileTransferRoot: STARTUP });
  assert.equal(dialogs.length, 1);
  assert.equal(puts[0].fileTransferRoot, 'D:\\Orbit transfers');
});

test('a renderer-supplied folder cannot replace or clear the folder already chosen', async () => {
  for (const fileTransferRoot of [STARTUP, '', null]) {
    const { controller, dialogs, puts } = scenario({ fileTransferEnabled: true, fileTransferRoot: 'D:\\Orbit transfers' }, STARTUP);
    await controller.invoke('settings.update', { allowFiles: true, fileTransferRoot });
    assert.equal(dialogs.length, 0);
    assert.equal(puts[0].fileTransferRoot, 'D:\\Orbit transfers', JSON.stringify(fileTransferRoot));
  }
});

test('the owner UI flow still works: echoing status settings back keeps the folder', async () => {
  const { controller, puts } = scenario({ fileTransferEnabled: true, fileTransferRoot: 'D:\\Orbit transfers', allowRemotePower: false }, undefined);
  const { settings } = await controller.status();
  await controller.invoke('settings.update', { ...settings, allowPower: true });
  assert.deepEqual([puts[0].fileTransferRoot, puts[0].allowRemotePower], ['D:\\Orbit transfers', true]);
  const cancelled = scenario({ fileTransferEnabled: false, fileTransferRoot: null }, undefined);
  await assert.rejects(cancelled.controller.invoke('settings.update', { allowFiles: true }), /Select a dedicated folder/);
  assert.equal(cancelled.puts.length, 0);
});
