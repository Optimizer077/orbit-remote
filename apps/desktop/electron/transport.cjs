'use strict';
const { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');
const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');

const MAX_RESPONSE = 24 * 1024 * 1024;
// Matches maxTransferBytes in src/Orbit.Host/Program.cs: the host lists, serves and accepts files up to this size.
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024;
const TRANSFER_IDLE_MS = 30000;
const DISPLAY_ASLEEP_MESSAGE = 'The remote display is asleep.';
const isDisplayAsleep = error => error?.status === 409 && error.code === 'display_asleep' && error.displayState === 'off';

// Remote JSON never supplies a local certificate-comparison code. Asleep needs
// the complete HTTP contract; neither a message nor an arbitrary409 implies it.
function remoteErrorMetadata(json, status, headers = {}) {
  const code = typeof json?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(json.code)
    && !IDENTITY_TERMINAL.has(json.code) ? json.code : undefined;
  const asleep = status === 409 && code === 'display_asleep' && json.displayState === 'off';
  // The agreed Wake limiter has a fixed local five-second cooldown. Honour
  // only its exact Retry-After value; arbitrary remote durations are not timers.
  const retry = String(headers['retry-after'] ?? '');
  return { ...(code && (code !== 'display_asleep' || asleep) ? { code } : {}),
    ...(asleep ? { displayState: 'off' } : {}),
    ...(status === 429 && code === 'wake_rate_limited' && retry === '5' ? { retryAfterSeconds: 5 } : {}) };
}

// File transfers get the normal 15 s budget plus one second per 64 KiB (a slow relayed link),
// capped at 10 minutes. Normal API calls keep the fixed 15 s deadline.
function transferDeadline(bytes) {
  const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.min(15000 + Math.ceil(size / (64 * 1024)) * 1000, 10 * 60 * 1000);
}

// Orbit's link policy, matching Security.IsStrongTls on the host: TLS 1.3, or TLS 1.2
// with ECDHE key exchange and AEAD ciphers. Every allowed suite is forward secret and
// authenticated. The TLS 1.3 names must stay listed: without them Node caps at TLS 1.2.
const TLS13_SUITES = ['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256'];
const TLS12_SUITES = ['ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384', 'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305', 'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256'];
const LINK_CIPHERS = [...TLS13_SUITES, ...TLS12_SUITES].join(':');
const GROUP_NAMES = { secp256r1: 'P-256', prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' };

// Describes the negotiated link for people and diagnostics; throws if it is below policy.
function describeLink(socket) {
  const protocol = socket.getProtocol();
  const cipher = socket.getCipher()?.name || '';
  const strong = protocol === 'TLSv1.3' ? TLS13_SUITES.includes(cipher) : protocol === 'TLSv1.2' && TLS12_SUITES.includes(cipher);
  if (!strong) throw new Error('The connection did not meet Orbit’s encryption policy. Connection blocked.');
  const group = socket.getEphemeralKeyInfo?.()?.name || '';
  return {
    protocol: protocol.replace('TLSv', 'TLS '),
    cipher: /CHACHA20/.test(cipher) ? 'ChaCha20-Poly1305' : /AES_?256/.test(cipher) ? 'AES-256-GCM' : 'AES-128-GCM',
    keyExchange: GROUP_NAMES[group] || group || 'ECDHE',
    forwardSecrecy: true,
    suite: cipher,
  };
}

function normalizeFingerprint(value) {
  if (typeof value !== 'string') throw new Error('Missing device certificate fingerprint.');
  const result = value.replace(/:/g, '').toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(result)) throw new Error('Invalid device certificate fingerprint.');
  return result;
}

function validateAddress(value, allowLoopback = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Device address must be a plain HTTPS Tailscale address.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const version = net.isIP(host);
  let allowed = false;
  if (version === 4) {
    const octets = host.split('.').map(Number);
    allowed = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
    if (allowLoopback) allowed ||= host === '127.0.0.1';
  } else if (version === 6) {
    // URL canonicalizes IPv6; this is Tailscale's documented ULA /48.
    allowed = host.toLowerCase().startsWith('fd7a:115c:a1e0:');
    if (allowLoopback) allowed ||= host === '::1';
  }
  if (!allowed) throw new Error('Only literal Tailscale IP addresses are accepted.');
  return url;
}

function parseInvite(value, allowLoopback = false, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 12000 || !value.trim().startsWith('orbit://pair/')) {
    throw new Error('Paste a complete Orbit pairing invitation.');
  }
  let invite;
  try { invite = JSON.parse(Buffer.from(value.trim().slice('orbit://pair/'.length), 'base64url').toString('utf8')); }
  catch { throw new Error('This pairing invitation is invalid.'); }
  if (invite.v !== 1 || typeof invite.secret !== 'string' || invite.secret.length < 32 || invite.secret.length > 256) {
    throw new Error('Invalid or unsupported pairing invitation.');
  }
  validateAddress(invite.address, allowLoopback);
  invite.fingerprint = normalizeFingerprint(invite.fingerprint);
  const expiresAt = Date.parse(invite.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('This pairing invitation has expired.');
  if (expiresAt > now + 10 * 60 * 1000) throw new Error('Pairing invitation validity is unexpectedly long.');
  return invite;
}

// Idle pooled sockets close after this, well before the host's 30 s keep-alive
// (Program.cs KeepAliveTimeout), so a reused socket is rarely one the host dropped.
const POOL_IDLE_MS = 15000;
const POOL_LIMIT = 8;

class PinnedAgent extends https.Agent {
  constructor(identity, fingerprint, keepAlive = false) {
    super({ keepAlive, maxSockets: 8, maxFreeSockets: 2, timeout: POOL_IDLE_MS });
    this.identity = identity;
    this.pin = normalizeFingerprint(fingerprint);
  }
  createConnection(options, callback) {
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      callback(error, socket);
    };
    // Self-signed device certificates use an out-of-band SHA-256 pin instead of Web PKI.
    // Do not give the HTTP agent a socket until pin verification succeeds: no invitation
    // secret, request headers or request body can be sent to an unverified server.
    const socket = tls.connect({
      host: String(options.hostname || options.host).replace(/^\[|\]$/g, ''),
      port: Number(options.port),
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      ciphers: LINK_CIPHERS,
      cert: this.identity.certificatePem,
      key: this.identity.privateKeyPem,
      ALPNProtocols: ['http/1.1'],
    }, () => {
      try {
        const raw = socket.getPeerCertificate(true).raw;
        if (!raw) throw new Error('The remote device did not present a certificate.');
        const actual = crypto.createHash('sha256').update(raw).digest();
        if (!crypto.timingSafeEqual(actual, Buffer.from(this.pin, 'hex'))) {
          throw Object.assign(new Error(IDENTITY_CHANGED_MESSAGE), { code: 'pin_mismatch' });
        }
        const certificate = new crypto.X509Certificate(raw);
        if (Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now() + 60000) {
          throw new Error('The device certificate is expired or not yet valid.');
        }
        socket.orbitLink = describeLink(socket);
        // From here the HTTP layer owns idle timeouts: request() and remoteStream() set their
        // own and the pool's agent timeout closes idle sockets. A leftover handshake listener
        // would fire on those later timeouts and misreport them as handshake failures.
        socket.removeListener('timeout', handshakeTimeout);
        socket.setTimeout(0);
        finish(null, socket);
      } catch (error) { finish(error); socket.destroy(); }
    });
    const handshakeTimeout = () => socket.destroy(Object.assign(new Error('Device TLS handshake timed out.'), { code: 'ORBIT_TLS_HANDSHAKE_TIMEOUT' }));
    socket.once('error', error => finish(error));
    socket.setTimeout(10000, handshakeTimeout);
    // Intentionally no return value: HTTPS must wait for the verified callback.
  }
}

function request(options) {
  const { url, method = 'GET', body, headers = {}, agent, maxBytes = MAX_RESPONSE, timeout = 15000,
    idleTimeout = timeout, tooLargeMessage = 'Response exceeds the application size limit.' } = options;
  // 304 is only a success for a request that actually asked a conditional question.
  const conditional = Object.keys(headers).some(name => name.toLowerCase() === 'if-none-match');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method, agent,
      headers: { ...(data ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': data.length } : {}), ...headers },
    }, response => {
      const link = response.socket?.orbitLink; // Read now: the socket is detached by 'end'.
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) { response.destroy(new Error(tooLargeMessage)); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        if (response.statusCode === 304) {
          if (!conditional) return reject(Object.assign(new Error('Device sent an unsolicited 304 Not Modified response.'), { status: 304 }));
          // Not Modified never carries a body; any bytes are discarded rather than trusted.
          return resolve({ json: undefined, buffer: Buffer.alloc(0), headers: response.headers, status: 304, link });
        }
        let json;
        if (String(response.headers['content-type']).includes('application/json')) {
          try { json = JSON.parse(buffer.toString('utf8')); } catch { return reject(new Error('Device returned invalid JSON.')); }
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(json?.error || json?.message || 'Device request failed (' + response.statusCode + ').');
          error.status = response.statusCode;
          Object.assign(error, remoteErrorMetadata(json, response.statusCode, response.headers));
          return reject(error);
        }
        resolve({ json, buffer, headers: response.headers, status: response.statusCode, link });
      });
    });
    req.setTimeout(idleTimeout, () => req.destroy(Object.assign(new Error('Device request timed out.'), { code: 'ORBIT_REQUEST_TIMEOUT' })));
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error('Device request deadline exceeded.'), { code: 'ORBIT_REQUEST_DEADLINE' })), timeout);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', error => { error.reusedSocket = req.reusedSocket; reject(error); });
    req.end(data);
  });
}

// Verified connections are reused per (address, server pin, our client certificate).
// The pin is checked when each connection opens, so a pooled socket has already passed
// it; a changed pin or a rotated client identity gets a different pool and never reuses one.
// On a weak link this saves the TLS handshake round trips on every frame.
const pool = new Map();
function pooledAgent(base, identity, fingerprint) {
  const pin = normalizeFingerprint(fingerprint);
  const client = crypto.createHash('sha256').update(String(identity?.certificatePem)).digest('hex');
  const key = `${base.host}|${pin}|${client}`;
  let agent = pool.get(key);
  if (agent) pool.delete(key); // Re-inserted below as most recently used.
  else agent = new PinnedAgent(identity, pin, true);
  pool.set(key, agent);
  if (pool.size > POOL_LIMIT) {
    const [oldest, old] = pool.entries().next().value;
    pool.delete(oldest); old.destroy();
  }
  return agent;
}

function closeRemoteConnections() {
  for (const agent of pool.values()) agent.destroy();
  pool.clear();
}

async function remoteRequest(device, identity, route, options = {}, allowLoopback = false) {
  const base = validateAddress(device.address, allowLoopback);
  if (!route.startsWith('/api/') || route.includes('..')) throw new Error('Invalid device API route.');
  const fingerprint = device.fingerprint || device.serverFingerprint;
  const url = new URL(route, base);
  try { return await request({ ...options, url, agent: pooledAgent(base, identity, fingerprint) }); }
  catch (error) {
    // A pooled socket the host already closed fails before any response arrives. Only
    // reads are retried, once, on a fresh connection; input, pairing and uploads never are.
    const method = (options.method || 'GET').toUpperCase();
    if (!error.reusedSocket || !['GET', 'HEAD'].includes(method) || !['ECONNRESET', 'EPIPE'].includes(error.code)) throw error;
    const fresh = new PinnedAgent(identity, fingerprint);
    try { return await request({ ...options, url, agent: fresh }); }
    finally { fresh.destroy(); }
  }
}

const STREAM_TYPE = 'application/vnd.orbit.stream';
const MAX_STREAM_ERROR_BYTES = 64 * 1024;

// A long-lived pinned GET whose body is handed to `onData` as it arrives (the D11 video
// stream; request() buffers whole bodies). The pin is verified before any request byte,
// as in remoteRequest, on a dedicated connection that never joins the pool. Resolves once
// a 200 stream starts; non-200 rejects with the status. `done` settles when the stream
// ends: resolved on EOF (the caller decides whether a terminal record arrived), rejected
// on stall, error or abort. The host sends a heartbeat every 2 s, so `idleTimeout`
// (default 5 s, per docs/PROTOCOL.md) detects a dead link. Returning false from
// `onData` pauses the body until `resume()`.
function remoteStream(device, identity, route, options = {}, allowLoopback = false) {
  const { headers = {}, onData, idleTimeout = 5000, connectTimeout = 15000, signal } = options;
  const base = validateAddress(device.address, allowLoopback);
  if (!route.startsWith('/api/') || route.includes('..')) throw new Error('Invalid device API route.');
  if (typeof onData !== 'function') throw new Error('A stream needs an onData callback.');
  if (signal?.aborted) return Promise.reject(new Error('Stream closed by the viewer.'));
  const agent = new PinnedAgent(identity, device.fingerprint || device.serverFingerprint);
  return new Promise((resolve, reject) => {
    let settled = false, finish;
    // Closing a viewer cancels the stream at any point, including while it connects.
    const onAbort = () => req.destroy(new Error('Stream closed by the viewer.'));
    const done = new Promise((ok, fail) => {
      finish = (error) => { signal?.removeEventListener('abort', onAbort); agent.destroy(); if (error) fail(error); else ok({ eof: true }); };
    });
    done.catch(() => {}); // The caller may only observe `done` after the stream started.
    const req = https.request(new URL(route, base), { method: 'GET', agent, headers: { accept: STREAM_TYPE, ...headers } }, response => {
      clearTimeout(connectTimer);
      const link = response.socket?.orbitLink;
      if (response.statusCode !== 200) {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes <= MAX_STREAM_ERROR_BYTES) chunks.push(chunk); else response.destroy(); });
        response.on('close', () => {
          let json; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* bodies are optional */ }
          const error = Object.assign(new Error(json?.error || 'Device stream request failed (' + response.statusCode + ').'),
            { status: response.statusCode }, remoteErrorMetadata(json, response.statusCode, response.headers));
          settled = true; agent.destroy(); reject(error);
        });
        return;
      }
      if (String(response.headers['content-type']).split(';')[0].trim().toLowerCase() !== STREAM_TYPE) {
        settled = true; req.destroy(); agent.destroy();
        return reject(new Error('The device did not answer with an Orbit stream.'));
      }
      req.setTimeout(idleTimeout, () => req.destroy(Object.assign(new Error('The screen stream stalled.'), { code: 'ORBIT_STREAM_STALLED' })));
      response.on('data', chunk => {
        // The parser throws on a protocol violation; that must end this stream, never crash main.
        let more;
        try { more = onData(chunk); } catch (error) { req.destroy(error instanceof Error ? error : new Error(String(error))); return; }
        if (more === false) response.pause();
      });
      response.on('end', () => finish());
      response.on('error', error => finish(error));
      settled = true;
      resolve({ status: 200, headers: response.headers, link, done,
        resume: () => response.resume(),
        abort: () => req.destroy(new Error('Stream closed by the viewer.')) });
    });
    const connectTimer = setTimeout(() => req.destroy(Object.assign(new Error('The screen stream did not start in time.'), { code: 'ORBIT_STREAM_CONNECT_TIMEOUT' })), connectTimeout);
    req.on('error', error => {
      clearTimeout(connectTimer);
      if (!settled) { settled = true; signal?.removeEventListener('abort', onAbort); agent.destroy(); reject(error); } else finish(error);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    req.end();
  });
}

module.exports = { normalizeFingerprint, validateAddress, parseInvite, PinnedAgent, request, remoteRequest, remoteStream, describeLink,
  closeRemoteConnections, transferDeadline, MAX_TRANSFER_BYTES, TRANSFER_IDLE_MS, STREAM_TYPE,
  DISPLAY_ASLEEP_MESSAGE, isDisplayAsleep };
