'use strict';
// Security review D-1 and D-4: data from a paired host is checked in main before it is
// stored or shown. Generated values only; no host, socket to a peer, or real file is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { OrbitController } = require('./controller.cjs');
const { request } = require('./transport.cjs');
const peerData = require('./peer-data.cjs');

const PIN = 'AA'.repeat(32);
const ADDRESS = 'https://100.100.1.1:47832';

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-peer-data-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
const saved = async directory => JSON.parse(await fs.readFile(path.join(directory, 'connections.json'), 'utf8'));
const invite = (extra = {}) => 'orbit://pair/' + Buffer.from(JSON.stringify({ v: 1, address: ADDRESS, fingerprint: PIN,
  secret: 'test-only-32-byte-invitation-secret-long', expiresAt: new Date(Date.now() + 60000).toISOString(), ...extra })).toString('base64url');
const onlyStrings = device => ['id', 'name', 'platform'].every(key => typeof device[key] === 'string');

test('the display rule matches Security.IsSafeDisplayText on the host', () => {
  for (const ok of ['Studio PC', 'Zo\u00EB\u2019s Mac', '\u0645\u0643\u062A\u0628', 'a\u200Db', 'a\u200Cb', 'a\u200Eb', 'a\u200Fb', '\uD83D\uDE00 laptop'])
    assert.equal(peerData.isSafeDisplayText(ok), true, JSON.stringify(ok));
  for (const bad of ['a\u202Eb', 'a\u2066b', 'a\u2069b', 'a\u202Ab', 'a\u200Bb', 'a\u2060b', 'a\uFEFFb', 'a\u061Cb', 'a\u00ADb',
    'a\u2028b', 'a\u2029b', 'a\u0007b', 'a\u0085b', 'a\u007Fb', 'a\nb', 'a\uD800b', 'a\uDC00b', {}, 1, null])
    assert.equal(peerData.isSafeDisplayText(bad), false, JSON.stringify(bad));
  assert.equal(peerData.displayText('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(peerData.displayText('x'.repeat(81)), null, 'the host limit is 80 characters');
  assert.equal(peerData.displayText('   '), null);
});

test('pairing with a host that sends an object as its name stores only strings', async t => {
  const directory = await tempDir(t);
  const controller = new OrbitController({ directory, controlToken: 'test' });
  controller.local = async () => ({ hostName: 'Viewer' });
  controller.remote = async () => ({ json: { hostId: 'host-1', hostName: { x: 1 }, permissions: { view: true, control: 'yes', extra: { x: 1 } } } });
  const device = await controller.invoke('pair', { invite: invite({ hostName: { y: 2 } }) });
  assert.equal(device.name, 'Remote device');
  assert.deepEqual(device.permissions, { view: true, control: false, clipboard: false, files: false, power: false });
  assert.ok(onlyStrings((await saved(directory))[0]));
  controller.remote = async () => ({ json: { hostId: { x: 1 }, hostName: 'Host' } });
  await assert.rejects(controller.invoke('pair', { invite: invite() }), /invalid identity/);
});

test('a refresh with an object, oversized or bidi name and platform keeps the saved values', async t => {
  const directory = await tempDir(t);
  const controller = new OrbitController({ directory, controlToken: 'test' });
  controller.connections.push({ id: 'host-1', name: 'Studio PC', platform: 'Windows', address: ADDRESS, fingerprint: PIN });
  controller.local = async () => [];
  for (const [hostName, operatingSystem] of [[{ x: 1 }, { x: 1 }], ['y'.repeat(5000), 'z'.repeat(5000)], ['Studio\u202Egnp.exe', 'Plan\u202E9']]) {
    controller.remote = async () => ({ json: { hostName, platform: { operatingSystem }, permissions: [] } });
    const { devices } = await controller.invoke('network.refresh');
    assert.equal(controller.connections[0].name, 'Studio PC');
    assert.equal(controller.connections[0].platform, 'unknown', 'only Windows, macOS, Linux or unknown is kept');
    assert.ok(devices.every(onlyStrings));
  }
  controller.remote = async () => ({ json: { hostName: 'Renamed PC', platform: { operatingSystem: 'macOS' } } });
  await controller.invoke('network.refresh');
  assert.deepEqual([controller.connections[0].name, controller.connections[0].platform], ['Renamed PC', 'macOS']);
  assert.ok((await saved(directory)).every(onlyStrings));
});

test('a saved connections.json with bad display data is repaired on load, not trusted', async t => {
  const directory = await tempDir(t);
  await fs.writeFile(path.join(directory, 'connections.json'), JSON.stringify([
    { id: 'host-1', name: { x: 1 }, platform: { operatingSystem: { x: 1 } }, address: ADDRESS, fingerprint: PIN, serverFingerprint: { x: 1 },
      permissions: { view: true, files: 'yes' }, pairedAt: { x: 1 }, revoked: true, statusReason: 'x'.repeat(5000), unknownField: { x: 1 } },
    { id: { x: 1 }, name: 'No usable ID', address: ADDRESS, fingerprint: PIN },
    { id: 'host-2', name: 'Bidi\u202Etxt.exe', platform: 'Windows', address: ADDRESS, fingerprint: PIN },
  ]));
  const controller = new OrbitController({ directory, controlToken: 'test' });
  await controller.initialize();
  assert.deepEqual(controller.connections, [
    { id: 'host-1', name: 'Remote device', platform: 'unknown', address: ADDRESS, fingerprint: PIN,
      permissions: { view: true, control: false, clipboard: false, files: false, power: false }, revoked: true, statusReason: 'Access revoked by the host.' },
    { id: 'host-2', name: 'Remote device', platform: 'Windows', address: ADDRESS, fingerprint: PIN },
  ]);
  assert.deepEqual(await saved(directory), controller.connections, 'the repaired list replaces the bad file');
});

test('session monitors from the host are type-checked before reaching windows', async () => {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.connections.push({ id: 'host-1', name: 'Studio PC', address: ADDRESS, fingerprint: PIN, permissions: { view: true } });
  let monitors = { x: 1 };
  controller.remote = async (_device, route) => route === '/api/info' ? { json: { platform: { monitors } } } : { json: { id: 'remote-1', permissions: 'all' } };
  assert.deepEqual((await controller.invoke('session.start', { deviceId: 'host-1' })).monitors, []);
  monitors = [{ id: 'one', name: { x: 1 }, left: 0, top: 0, width: 1920, height: { x: 1 }, primary: 'yes' }, { id: { x: 1 } }, { id: 'one' },
    { id: 'two', name: 'Second\u202E', left: -1280, top: 0, width: 1280, height: 720, primary: true, extra: { x: 1 } }];
  const started = await controller.invoke('session.start', { deviceId: 'host-1' });
  assert.deepEqual(started.monitors, [
    { id: 'one', name: 'Display 1', left: 0, top: 0, width: 1920, primary: false },
    { id: 'two', name: 'Display 2', left: -1280, top: 0, width: 1280, height: 720, primary: true },
  ]);
  assert.deepEqual(started.permissions, { view: true }, 'non-object grants fall back to the saved pairing');
});

test('remote error text is bounded and its unsafe characters are neutralised', async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Denied\u202E' + 'x'.repeat(100000) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const error = await request({ url: new URL('http://127.0.0.1:' + server.address().port + '/') }).catch(value => value);
  assert.equal(error.status, 400);
  assert.equal(Array.from(error.message).length, 500);
  assert.ok(error.message.startsWith('Denied x'));
  assert.equal(peerData.neutralText({ x: 1 }), undefined);
});

// D-4: a file name that would display as "invoiceexe.txt" or "invoiceexe.pdf".
const SPOOFED = ['invoice\u202Etxt.exe', 'invoice\u202Efdp.exe', 'report\u2067.pdf\u2069.exe', 'a\u200Bb.txt', 'CON.txt', 'trailing.', 'tab\tname'];

test('remote file listings refuse bidi, format and control characters in names', async () => {
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test' });
  controller.sessions.set('s', { remoteId: 'r', device: { id: 'd' }, permissions: { files: true }, closed: false });
  controller.remote = async () => ({ json: [{ name: 'notes.txt', size: 5, modifiedAt: '2026-10-27T10:00:00Z', owner: { x: 1 } },
    { name: 'photo\u200D.png', size: { x: 1 } }, { name: { x: 1 } }, ...SPOOFED.map(name => ({ name, size: 1 }))] });
  const { entries } = await controller.invoke('files.list', { sessionId: 's' });
  assert.deepEqual(entries, [
    { name: 'notes.txt', size: 5, modifiedAt: '2026-10-27T10:00:00Z', path: 'notes.txt', isDirectory: false },
    { name: 'photo\u200D.png', path: 'photo\u200D.png', isDirectory: false },
  ]);
});

test('a download with a spoofed name is refused before the save dialog opens', async () => {
  const offered = [];
  const controller = new OrbitController({ directory: os.tmpdir(), controlToken: 'test', native: { saveFile: async name => { offered.push(name); } } });
  controller.sessions.set('s', { remoteId: 'r', device: { id: 'd' }, permissions: { files: true }, closed: false });
  controller.remote = async () => { throw new Error('No request expected.'); };
  for (const name of SPOOFED) await assert.rejects(controller.invoke('files.download', { sessionId: 's', name }), /Invalid file name/, JSON.stringify(name));
  assert.deepEqual(offered, []);
  assert.deepEqual(await controller.invoke('files.download', { sessionId: 's', name: 'notes.txt' }), { cancelled: true });
  assert.deepEqual(offered, ['notes.txt']);
});

test('reserved Windows device names match the host rule (H-10), including stems with trailing spaces', () => {
  for (const name of ['CONIN$', 'conout$.txt', 'CLOCK$', 'Clock$.log', 'CON .txt', 'NUL. .log', 'Prn  .pdf', 'COM0.bin', 'lpt0',
    'LPT\u00B9.txt', 'com\u00B3', 'Con', 'aux.tar.gz'])
    assert.equal(peerData.isSafeFileName(name), false, JSON.stringify(name));
  for (const name of ['CONSOLE.txt', 'CONIN.txt', 'clock.txt', 'COM10.txt', 'nul-report.txt', 'my CON.txt', 'LPT\u00B9a.txt'])
    assert.equal(peerData.isSafeFileName(name), true, JSON.stringify(name));
});

test('stream error text from the host is bounded and neutralised on both stream paths', async t => {
  const https = require('node:https');
  const crypto = require('node:crypto');
  const { remoteStream } = require('./transport.cjs');
  const { streamOpenError } = require('./stream-session.cjs');
  // Deliberately public, test-only certificate (see transport.test.cjs).
  const certificatePem = await fs.readFile(path.join(__dirname, 'test-fixtures/test-cert.pem'), 'utf8');
  const privateKeyPem = await fs.readFile(path.join(__dirname, 'test-fixtures/test-private.pem'), 'utf8');
  const fingerprint = new crypto.X509Certificate(certificatePem).fingerprint256.replace(/:/g, '');
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_request, response) => {
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Denied\u202E' + 'x'.repeat(5000) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const error = await remoteStream({ address: 'https://127.0.0.1:' + server.address().port, fingerprint },
    { certificatePem, privateKeyPem }, '/api/sessions/s/stream', { onData: () => {} }, true).catch(value => value);
  assert.equal(error.status, 403);
  assert.equal(Array.from(error.message).length, 500);
  assert.ok(error.message.startsWith('Denied x'));
  const { error: detail } = streamOpenError(Object.assign(new Error('Busy\u2066' + 'y'.repeat(5000)), { status: 403 }));
  assert.equal(Array.from(detail.message).length, 500);
  assert.ok(detail.message.startsWith('Busy y'));
});

test('loading a valid connections.json does not rewrite it, whatever its key order', async t => {
  const directory = await tempDir(t);
  const file = path.join(directory, 'connections.json');
  await fs.writeFile(file, JSON.stringify([{ fingerprint: PIN, address: ADDRESS, platform: 'Windows', name: 'Studio PC', id: 'host-1' }]));
  const controller = new OrbitController({ directory, controlToken: 'test' });
  let saves = 0;
  controller.save = async () => { saves++; };
  await controller.initialize();
  assert.equal(saves, 0, 'key order alone is not a repair');
  await fs.writeFile(file, JSON.stringify([{ id: 'host-1', name: { x: 1 }, platform: 'Windows', address: ADDRESS, fingerprint: PIN }]));
  await controller.initialize();
  assert.equal(saves, 1, 'a real repair is saved');
});

test('every field the controller writes survives a save and load unchanged', async t => {
  const directory = await tempDir(t);
  const controller = new OrbitController({ directory, controlToken: 'test' });
  controller.local = async route => route === 'peers' ? [] : { hostName: 'Viewer' };
  const grants = { view: true, control: true, clipboard: true, files: false, power: false };
  controller.remote = async () => ({ json: { hostId: 'host-1', hostName: 'Studio PC', permissions: grants } });
  await controller.invoke('pair', { invite: invite() });
  controller.remote = async () => ({ json: { hostName: 'Studio PC', platform: { operatingSystem: 'Windows' }, permissions: grants } });
  await controller.invoke('network.refresh');
  const reload = async () => {
    const loaded = new OrbitController({ directory, controlToken: 'test' });
    let saves = 0;
    loaded.save = async () => { saves++; };
    await loaded.initialize();
    assert.equal(saves, 0, 'nothing the controller wrote needs repair');
    return loaded.connections;
  };
  const online = structuredClone(controller.connections);
  assert.deepEqual(Object.keys(online[0]).sort(), ['address', 'fingerprint', 'id', 'lastSeen', 'name', 'online', 'pairedAt', 'permissions', 'platform', 'serverFingerprint']);
  assert.deepEqual(await reload(), online);
  controller.remote = async () => { throw Object.assign(new Error('Generated revocation.'), { status: 401 }); };
  await controller.invoke('network.refresh');
  const revoked = structuredClone(controller.connections);
  assert.deepEqual([revoked[0].revoked, revoked[0].online, revoked[0].statusReason], [true, false, 'Access revoked by the host.']);
  assert.deepEqual(await reload(), revoked);
  for (const device of [...online, ...revoked]) assert.deepEqual(peerData.savedDevice(device), device);
});
