'use strict';
const https = require('node:https');
const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const crypto = require('node:crypto');

const MAX_RESPONSE = 24 * 1024 * 1024;

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

class PinnedAgent extends https.Agent {
  constructor(identity, fingerprint) {
    super({ keepAlive: false, maxSockets: 6 });
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
          throw new Error('Device identity changed. Connection blocked; pair again after verifying the computer.');
        }
        const certificate = new crypto.X509Certificate(raw);
        if (Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now() + 60000) {
          throw new Error('The device certificate is expired or not yet valid.');
        }
        socket.orbitLink = describeLink(socket);
        socket.setTimeout(15000, () => socket.destroy(new Error('Remote connection timed out.')));
        finish(null, socket);
      } catch (error) { finish(error); socket.destroy(); }
    });
    socket.once('error', error => finish(error));
    socket.setTimeout(10000, () => socket.destroy(new Error('Device TLS handshake timed out.')));
    // Intentionally no return value: HTTPS must wait for the verified callback.
  }
}

function request(options) {
  const { url, method = 'GET', body, headers = {}, agent, maxBytes = MAX_RESPONSE, timeout = 15000 } = options;
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
        if (bytes > maxBytes) { response.destroy(new Error('Response exceeds the application size limit.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json;
        if (String(response.headers['content-type']).includes('application/json')) {
          try { json = JSON.parse(buffer.toString('utf8')); } catch { return reject(new Error('Device returned invalid JSON.')); }
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(json?.error || json?.message || 'Device request failed (' + response.statusCode + ').');
          error.status = response.statusCode;
          return reject(error);
        }
        resolve({ json, buffer, headers: response.headers, status: response.statusCode, link });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Device request timed out.')));
    const deadline = setTimeout(() => req.destroy(new Error('Device request deadline exceeded.')), timeout);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', reject);
    req.end(data);
  });
}

async function remoteRequest(device, identity, route, options = {}, allowLoopback = false) {
  const base = validateAddress(device.address, allowLoopback);
  if (!route.startsWith('/api/') || route.includes('..')) throw new Error('Invalid device API route.');
  const agent = new PinnedAgent(identity, device.fingerprint || device.serverFingerprint);
  try { return await request({ ...options, url: new URL(route, base), agent }); }
  finally { agent.destroy(); }
}

module.exports = { normalizeFingerprint, validateAddress, parseInvite, PinnedAgent, request, remoteRequest, describeLink };
