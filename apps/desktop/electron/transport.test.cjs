'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateAddress, parseInvite, normalizeFingerprint, remoteRequest, request, describeLink } = require('./transport.cjs');

// Deliberately public, test-only certificate. Never used by the application identity store.
const certificatePem = fs.readFileSync(path.join(__dirname, 'test-fixtures/test-cert.pem'), 'utf8');
const privateKeyPem = fs.readFileSync(path.join(__dirname, 'test-fixtures/test-private.pem'), 'utf8');
const identity = { certificatePem, privateKeyPem };
const fingerprint = new crypto.X509Certificate(certificatePem).fingerprint256.replace(/:/g, '');

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}
const invite = changes => 'orbit://pair/' + Buffer.from(JSON.stringify({
  v: 1, address: 'https://100.100.100.100:47832', fingerprint,
  secret: 'test-only-32-byte-invitation-secret-long',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), ...changes,
})).toString('base64url');

test('remote targets accept only literal Tailscale IPs; loopback needs explicit test mode', () => {
  for (const url of ['https://100.64.0.1:47832', 'https://100.127.255.254:47832', 'https://[fd7a:115c:a1e0::1]:47832']) assert.ok(validateAddress(url));
  for (const url of ['https://100.63.0.1', 'https://100.128.0.1', 'https://192.168.1.1', 'https://example.com',
    'https://127.0.0.1', 'http://100.100.100.100', 'https://100.100.100.100/path',
    'https://user:pass@100.100.100.100', 'https://[fd7a:115c:a1e1::1]', 'https://100.100.100.100?secret=1']) {
    assert.throws(() => validateAddress(url), undefined, url);
  }
  assert.ok(validateAddress('https://127.0.0.1:47832', true));
});

test('invitations reject malformed, expired, excessively long-lived and weak-secret payloads', () => {
  assert.equal(parseInvite(invite()).fingerprint, fingerprint);
  assert.throws(() => parseInvite(invite({ expiresAt: new Date(Date.now() - 1).toISOString() })), /expired/);
  assert.throws(() => parseInvite(invite({ expiresAt: new Date(Date.now() + 3600000).toISOString() })), /long/);
  assert.throws(() => parseInvite(invite({ secret: '1234' })), /Invalid/);
  assert.throws(() => parseInvite(invite({ address: 'https://evil.example' })), /Tailscale/);
  assert.throws(() => parseInvite('orbit://pair/not-json'), /invalid/);
  assert.throws(() => normalizeFingerprint('00'), /Invalid/);
});

test('pinned TLS sends the client certificate and authenticates the exact server certificate', async t => {
  let observedCertificate = false;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    observedCertificate = !!req.socket.getPeerCertificate().raw;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await listen(server, t);
  const result = await remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/info', {}, true);
  assert.deepEqual(result.json, { ok: true });
  assert.equal(observedCertificate, true);
});

test('certificate mismatch blocks all HTTP bytes, including the pairing secret', async t => {
  let requests = 0;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => { requests++; res.end(); });
  const port = await listen(server, t);
  await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint: '00'.repeat(32) },
    identity, '/api/pair', { method: 'POST', body: { secret: 'this-must-never-reach-the-server' } }, true), /identity changed/);
  assert.equal(requests, 0);
});

test('link policy reports the negotiated TLS 1.3 encryption on every response', async t => {
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const port = await listen(server, t);
  const { link } = await remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/info', {}, true);
  assert.equal(link.protocol, 'TLS 1.3');
  assert.match(link.cipher, /^(AES-256-GCM|AES-128-GCM|ChaCha20-Poly1305)$/);
  assert.equal(link.forwardSecrecy, true);
});

test('TLS 1.2 is accepted only with ECDHE and AEAD', async t => {
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem, maxVersion: 'TLSv1.2', ciphers: 'ECDHE-RSA-AES256-GCM-SHA384' }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const port = await listen(server, t);
  const { link } = await remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/info', {}, true);
  assert.deepEqual([link.protocol, link.cipher], ['TLS 1.2', 'AES-256-GCM']);
});

for (const [name, ciphers] of [['CBC', 'ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA'], ['static RSA key exchange', 'AES256-GCM-SHA384:AES128-GCM-SHA256']]) {
  test(`a server offering only ${name} suites never receives the pairing secret`, async t => {
    let requests = 0;
    const server = https.createServer({ cert: certificatePem, key: privateKeyPem, maxVersion: 'TLSv1.2', ciphers }, (_req, res) => { requests++; res.end(); });
    server.on('tlsClientError', () => {});
    const port = await listen(server, t);
    await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/pair',
      { method: 'POST', body: { secret: 'this-must-never-reach-the-server' } }, true));
    assert.equal(requests, 0);
  });
}

test('describeLink refuses a weak negotiated suite even if one slips through', () => {
  const socket = cipher => ({ getProtocol: () => 'TLSv1.2', getCipher: () => ({ name: cipher }), getEphemeralKeyInfo: () => ({ name: 'secp384r1' }) });
  assert.equal(describeLink(socket('ECDHE-RSA-CHACHA20-POLY1305')).cipher, 'ChaCha20-Poly1305');
  assert.equal(describeLink(socket('ECDHE-RSA-AES128-GCM-SHA256')).keyExchange, 'P-384');
  for (const weak of ['ECDHE-RSA-AES256-SHA', 'AES256-GCM-SHA384', 'TLS_AES_256_GCM_SHA384']) assert.throws(() => describeLink(socket(weak)), /encryption policy/);
});

test('remote API errors preserve the status needed for access-revocation handling', async t => {
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"Device access revoked"}');
  });
  const port = await listen(server, t);
  await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/info', {}, true),
    error => error.status === 401 && /revoked/.test(error.message));
});

test('unbounded response bodies are terminated', async t => {
  const server = http.createServer((_req, res) => { res.end(Buffer.alloc(1024)); });
  const port = await listen(server, t);
  await assert.rejects(request({ url: new URL('http://127.0.0.1:' + port), maxBytes: 32 }), /size limit/);
});

test('absolute deadline stops a slow response even when bytes keep arriving', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const timer = setInterval(() => res.write('x'), 10);
    res.once('close', () => clearInterval(timer));
  });
  const port = await listen(server, t);
  await assert.rejects(request({ url: new URL('http://127.0.0.1:' + port), timeout: 150 }), /deadline/);
});
