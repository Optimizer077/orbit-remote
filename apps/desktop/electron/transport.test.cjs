'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateAddress, parseInvite, normalizeFingerprint, remoteRequest, remoteStream, request, describeLink, closeRemoteConnections } = require('./transport.cjs');

// Deliberately public, test-only certificate. Never used by the application identity store.
const certificatePem = fs.readFileSync(path.join(__dirname, 'test-fixtures/test-cert.pem'), 'utf8');
const privateKeyPem = fs.readFileSync(path.join(__dirname, 'test-fixtures/test-private.pem'), 'utf8');
const identity = { certificatePem, privateKeyPem };
const fingerprint = new crypto.X509Certificate(certificatePem).fingerprint256.replace(/:/g, '');
const isPinMismatch = error => error.code === 'pin_mismatch' && error.message === "This device's identity changed. Forget it, then pair again.";

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

test('certificate mismatch is typed and blocks all HTTP bytes, including the pairing secret', async t => {
  let requests = 0, connections = 0;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => { requests++; res.end(); });
  server.on('connection', () => connections++);
  const port = await listen(server, t);
  await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint: '00'.repeat(32) },
    identity, '/api/pair', { method: 'POST', body: { secret: 'this-must-never-reach-the-server' } }, true), isPinMismatch);
  assert.equal(requests, 0);
  assert.equal(connections, 1, 'a pin failure cannot retry the TLS connection');
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
  await assert.rejects(request({ url: new URL('http://127.0.0.1:' + port), timeout: 150 }),
    error => error.code === 'ORBIT_REQUEST_DEADLINE' && /deadline/.test(error.message));
});

test('a conditional request over pinned TLS resolves 304 as an empty successful result', async t => {
  const tag = '"orbit-frame-v1-' + 'AB'.repeat(32) + '"';
  const seen = [];
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (req, res) => {
    seen.push(req.headers['if-none-match']);
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag, 'x-orbit-width': '1920' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png', etag: tag }); res.end(Buffer.from('png-bytes'));
  });
  const port = await listen(server, t);
  const device = { address: 'https://127.0.0.1:' + port, fingerprint };
  const fresh = await remoteRequest(device, identity, '/api/sessions/s/frame', {}, true);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.buffer.toString(), 'png-bytes');
  const unchanged = await remoteRequest(device, identity, '/api/sessions/s/frame', { headers: { 'If-None-Match': fresh.headers.etag } }, true);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.buffer.length, 0);
  assert.equal(unchanged.headers.etag, tag);
  assert.equal(unchanged.headers['x-orbit-width'], '1920');
  assert.equal(unchanged.link.protocol, 'TLS 1.3', 'a 304 still reports the verified link');
  assert.deepEqual(seen, [undefined, tag]);
});

test('an unsolicited 304 is rejected rather than treated as an empty frame', async t => {
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => { res.writeHead(304); res.end(); });
  const port = await listen(server, t);
  await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/sessions/s/frame', {}, true),
    error => error.status === 304 && /unsolicited/.test(error.message));
});

test('conditional requests keep the pin check: a mismatched certificate receives no validator', async t => {
  let requests = 0;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => { requests++; res.writeHead(304); res.end(); });
  const port = await listen(server, t);
  await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint: '00'.repeat(32) }, identity,
    '/api/sessions/s/frame', { headers: { 'if-none-match': '"x"' } }, true), isPinMismatch);
  assert.equal(requests, 0);
});

test('pinned connections are reused across requests, and every reused response still reports the link', async t => {
  t.after(closeRemoteConnections);
  let handshakes = 0;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  server.on('secureConnection', () => handshakes++);
  const port = await listen(server, t);
  const device = { address: 'https://127.0.0.1:' + port, fingerprint };
  for (let i = 0; i < 3; i++) {
    const { link } = await remoteRequest(device, identity, '/api/info', {}, true);
    assert.equal(link.protocol, 'TLS 1.3');
  }
  assert.equal(handshakes, 1, 'one TLS handshake for three sequential requests');
});

test('a pooled verified connection is never reused for a different pin', async t => {
  t.after(closeRemoteConnections);
  let requests = 0;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => {
    requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const port = await listen(server, t);
  await remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint }, identity, '/api/info', {}, true);
  await assert.rejects(remoteRequest({ address: 'https://127.0.0.1:' + port, fingerprint: '00'.repeat(32) }, identity,
    '/api/pair', { method: 'POST', body: { secret: 'this-must-never-reach-the-server' } }, true), isPinMismatch);
  assert.equal(requests, 1, 'the mismatched pin sent no request over the pooled socket');
});

// The host drops the socket on its second request, as if its keep-alive expired mid-reuse.
async function stalePoolServer(t) {
  const seen = [];
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (req, res) => {
    req.socket.orbitCount = (req.socket.orbitCount || 0) + 1;
    seen.push(req.method + ' ' + req.socket.orbitCount);
    if (req.socket.orbitCount === 2) { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  return { seen, device: { address: 'https://127.0.0.1:' + await listen(server, t), fingerprint } };
}

test('a read on a stale pooled socket is retried once on a fresh pinned connection', async t => {
  t.after(closeRemoteConnections);
  const { seen, device } = await stalePoolServer(t);
  await remoteRequest(device, identity, '/api/info', {}, true);
  const { link } = await remoteRequest(device, identity, '/api/info', {}, true);
  assert.equal(link.protocol, 'TLS 1.3');
  assert.deepEqual(seen, ['GET 1', 'GET 2', 'GET 1']);
});

test('input and other POSTs on a stale pooled socket are never retried', async t => {
  t.after(closeRemoteConnections);
  const { seen, device } = await stalePoolServer(t);
  await remoteRequest(device, identity, '/api/info', {}, true);
  await assert.rejects(remoteRequest(device, identity, '/api/sessions/s/input', { method: 'POST', body: { type: 'click' } }, true));
  assert.deepEqual(seen, ['GET 1', 'POST 2'], 'the POST reached the host at most once');
});

// D11 video stream transport (remoteStream).
const streamServer = (t, handler) => {
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, handler);
  return listen(server, t).then(port => ({ address: 'https://127.0.0.1:' + port, fingerprint }));
};

test('a stream delivers body chunks as they arrive, over the verified link', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const device = await streamServer(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.orbit.stream' });
    res.write(Buffer.from('first'));
    await gate; // The second chunk is sent only after the client saw the first.
    res.end(Buffer.from('second'));
  });
  const seen = [];
  const stream = await remoteStream(device, identity, '/api/sessions/s/stream', {
    onData: chunk => { seen.push(chunk.toString()); if (seen.length === 1) release(); },
  }, true);
  assert.equal(stream.link.protocol, 'TLS 1.3');
  assert.deepEqual(await stream.done, { eof: true });
  assert.deepEqual(seen, ['first', 'second']);
});

test('a refused stream rejects with the status and protocol code', async t => {
  const device = await streamServer(t, (_req, res) => {
    res.writeHead(410, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Session ended by host. Connect again explicitly.', code: 'session_ended_by_host' }));
  });
  await assert.rejects(remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => {} }, true),
    error => error.status === 410 && error.code === 'session_ended_by_host');
});

for (const code of ['pin_mismatch', 'identity_mismatch']) for (const status of [403, 503])
  test(`remote JSON cannot supply local identity code ${code} at HTTP ${status}`, async t => {
    const device = await streamServer(t, (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Generated remote denial.', code }));
    });
    await assert.rejects(remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => {} }, true),
      error => error.status === status && error.code === undefined);
    await assert.rejects(remoteRequest(device, identity, '/api/info', {}, true),
      error => error.status === status && error.code === undefined);
  });

test('a stream with a mismatched pin never reaches the host', async t => {
  let requests = 0, connections = 0, chunks = 0;
  const server = https.createServer({ cert: certificatePem, key: privateKeyPem }, (_req, res) => { requests++; res.end(); });
  server.on('connection', () => connections++);
  const device = { address: 'https://127.0.0.1:' + await listen(server, t), fingerprint: '00'.repeat(32) };
  await assert.rejects(remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => { chunks++; } }, true), isPinMismatch);
  assert.equal(requests, 0);
  assert.equal(chunks, 0); assert.equal(connections, 1);
});

test('a silent stream is detected as stalled', async t => {
  const device = await streamServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.orbit.stream' });
    res.write(Buffer.from('header')); // ...then nothing, not even heartbeats.
  });
  const stream = await remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => {}, idleTimeout: 200 }, true);
  await assert.rejects(stream.done, error => error.code === 'ORBIT_STREAM_STALLED' && /stalled/.test(error.message));
});

test('a verified peer that never starts its stream has a typed transient connect timeout', async t => {
  const device = await streamServer(t, () => {});
  await assert.rejects(remoteStream(device, identity, '/api/sessions/s/stream', {
    onData: () => {}, connectTimeout: 100,
  }, true), error => error.code === 'ORBIT_STREAM_CONNECT_TIMEOUT');
});

test('abort closes the stream and a non-stream answer is refused', async t => {
  let closed;
  const serverClosed = new Promise(resolve => { closed = resolve; });
  const device = await streamServer(t, (req, res) => {
    if (req.url.endsWith('/wrong')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('x'); return; }
    res.writeHead(200, { 'content-type': 'application/vnd.orbit.stream' });
    res.write('x');
    req.socket.once('close', closed);
  });
  const stream = await remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => {} }, true);
  stream.abort();
  await assert.rejects(stream.done, /closed by the viewer/);
  await serverClosed;
  await assert.rejects(remoteStream(device, identity, '/api/sessions/s/wrong', { onData: () => {} }, true), /Orbit stream/);
});

test('an exception from onData ends the stream instead of escaping', async t => {
  const device = await streamServer(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.orbit.stream' });
    res.write('bad record');
  });
  const stream = await remoteStream(device, identity, '/api/sessions/s/stream', {
    onData: () => { throw new Error('Stream protocol violation: bad header.'); },
  }, true);
  await assert.rejects(stream.done, /protocol violation/);
});

test('an AbortSignal cancels a stream before and after it starts', async t => {
  const aborted = new AbortController(); aborted.abort();
  let requests = 0;
  const device = await streamServer(t, (_req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/vnd.orbit.stream' });
    res.write('x');
  });
  await assert.rejects(remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => {}, signal: aborted.signal }, true), /closed by the viewer/);
  assert.equal(requests, 0, 'an already-aborted signal sends nothing');
  const live = new AbortController();
  const stream = await remoteStream(device, identity, '/api/sessions/s/stream', { onData: () => {}, signal: live.signal }, true);
  live.abort();
  await assert.rejects(stream.done, /closed by the viewer/);
});
