'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { ChildProofAgent, findTailscaleCli } = require('./local-control.cjs');
const { OrbitController } = require('./controller.cjs');
const key = () => crypto.randomBytes(32).toString('base64url');
const pid = 12345;

async function fixture(t, behavior) {
  const received = []; const sockets = new Set(); let proofKey = key();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = ''; let proved = false;
    socket.on('data', data => {
      buffer += data.toString('utf8'); received.push(data.toString('utf8'));
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      const headers = buffer.slice(0, end); buffer = buffer.slice(end + 4);
      if (!proved) {
        proved = true;
        const challenge = /X-Orbit-Challenge: ([^\r]+)/i.exec(headers)?.[1];
        const clientPort = socket.remotePort;
        const proof = crypto.createHmac('sha256', Buffer.from(proofKey, 'base64url')).update(`orbit-child-proof-v1\n${challenge}\n${pid}\n${server.address().port}\n${clientPort}`).digest('base64url');
        let value = { version: 1, pid, challenge, clientPort, proof };
        const custom = behavior?.({ value, socket, headers });
        if (custom === false) return;
        if (custom) value = custom;
        const body = JSON.stringify(value);
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      } else {
        const body = JSON.stringify({ ok: true });
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const makeAgent = secret => new ChildProofAgent({ proofKey: secret || proofKey, pid, port, timeout: 200 });
  const send = agent => new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path: '/api/client-identity', method: 'POST', agent,
      headers: { Authorization: 'Bearer TEST-BEARER', 'Content-Length': 20 } }, response => { response.resume(); response.on('end', resolve); });
    request.on('error', reject); request.end('PRIVATE-REQUEST-DATA');
  });
  return { makeAgent, send, received, rotate: () => { proofKey = key(); } };
}

test('local proof hands the SAME authenticated socket to HTTP before bearer and private body', async t => {
  const f = await fixture(t); const agent = f.makeAgent(); t.after(() => agent.destroy());
  await f.send(agent);
  assert.match(f.received[0], /^GET \/api\/parent-proof /);
  assert.doesNotMatch(f.received[0], /Authorization|TEST-BEARER|client-identity|PRIVATE-REQUEST/);
  assert.match(f.received.slice(1).join(''), /Authorization: Bearer TEST-BEARER/i);
  assert.match(f.received.slice(1).join(''), /PRIVATE-REQUEST-DATA/);
});

test('fake listener never receives bearer, identity route or private body', async t => {
  const f = await fixture(t, ({ value }) => ({ ...value, proof: key() })); const agent = f.makeAgent(); t.after(() => agent.destroy());
  await assert.rejects(f.send(agent), /proof failed/);
  assert.doesNotMatch(f.received.join(''), /Authorization|TEST-BEARER|client-identity|PRIVATE-REQUEST/);
});

test('a proof relayed with a different client TCP port is rejected before operation bytes', async t => {
  const f = await fixture(t, ({ value }) => ({ ...value, clientPort: value.clientPort + 1 })); const agent = f.makeAgent(); t.after(() => agent.destroy());
  await assert.rejects(f.send(agent), /proof failed/);
  assert.doesNotMatch(f.received.join(''), /Authorization|client-identity|PRIVATE-REQUEST/);
});

test('new sockets require fresh proof and cannot reuse an earlier signed response', async t => {
  let saved;
  const f = await fixture(t, ({ value }) => { if (saved) return saved; saved = value; });
  const agent = f.makeAgent(); t.after(() => agent.destroy()); await f.send(agent);
  f.received.length = 0;
  await assert.rejects(f.send(agent), /proof failed/);
  assert.doesNotMatch(f.received.join(''), /Authorization|client-identity|PRIVATE-REQUEST/);
});

test('restart rotates proof credentials and destroys pending unproved connections', async t => {
  const f = await fixture(t); const oldAgent = f.makeAgent(); t.after(() => oldAgent.destroy());
  await f.send(oldAgent); f.rotate(); f.received.length = 0;
  await assert.rejects(f.send(oldAgent), /proof failed/);
  assert.doesNotMatch(f.received.join(''), /Authorization|client-identity|PRIVATE-REQUEST/);
  oldAgent.destroy(); const replacement = f.makeAgent(); t.after(() => replacement.destroy()); await f.send(replacement);
});

test('timeout or explicit generation invalidation closes sockets without sending sensitive data', async t => {
  const f = await fixture(t, () => false); const agent = f.makeAgent(); t.after(() => agent.destroy());
  await assert.rejects(f.send(agent), /timed out/);
  const pending = f.send(agent); setTimeout(() => agent.destroy(), 10);
  await assert.rejects(pending, /generation ended/);
  assert.doesNotMatch(f.received.join(''), /Authorization|client-identity|PRIVATE-REQUEST/);
});

test('controller clears cached identity and refuses requests between child generations', async () => {
  const controller = new OrbitController({ requireLocalProof: true });
  controller.identity = { privateKeyPem: 'not-a-real-key' };
  let destroyed = 0; controller.setLocalControl({ destroy: () => destroyed++ }, 'token-a');
  assert.equal(controller.identity, null); controller.clearLocalControl(); assert.equal(destroyed, 1);
  await assert.rejects(controller.local('client-identity'), /not ready/);
});

test('a late private-identity response from a previous generation is discarded', async () => {
  const controller = new OrbitController({});
  let release;
  controller.local = () => new Promise(resolve => { release = resolve; });
  const pending = controller.getIdentity();
  controller.clearLocalControl(); release({ privateKeyPem: 'stale-test-value' });
  await assert.rejects(pending, /generation changed/);
  assert.equal(controller.identity, null);
});

test('Tailscale CLI discovery uses local known paths and never a host-supplied executable', () => {
  const visited = [];
  const cli = findTailscaleCli({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', PATH: '.;C:\\SafeBin' },
    exists: file => { visited.push(file); return file === 'C:\\SafeBin\\tailscale.exe'; } });
  assert.equal(cli, 'C:\\SafeBin\\tailscale.exe');
  assert.ok(visited.every(file => file !== '.\\tailscale.exe'));
  assert.equal(findTailscaleCli({ platform: 'linux', env: { PATH: './untrusted' }, exists: () => false }), null);
});
