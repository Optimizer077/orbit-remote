'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;

class ChildProofAgent extends http.Agent {
  constructor({ proofKey, pid, port, timeout = 3000 }) {
    super({ keepAlive: false, maxSockets: 8 });
    if (!token(proofKey) || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local child credentials.');
    this.key = Buffer.from(proofKey, 'base64url'); this.pid = pid; this.port = port; this.timeout = timeout;
    this.active = true; this.pendingProofs = new Set();
  }
  createConnection(options, callback) {
    if (!this.active || this.pendingProofs.size >= 8 || String(options.hostname || options.host) !== '127.0.0.1' || Number(options.port) !== this.port) {
      queueMicrotask(() => callback(new Error('The local host generation is unavailable.'))); return;
    }
    const challenge = crypto.randomBytes(32).toString('base64url');
    const socket = net.createConnection({ host: '127.0.0.1', port: this.port });
    this.pendingProofs.add(socket);
    let settled = false, buffer = Buffer.alloc(0), headerSize, bodySize;
    const finish = (error) => {
      if (settled) return;
      settled = true; this.pendingProofs.delete(socket); socket.removeListener('data', receive);
      if (error) { socket.destroy(); callback(error); }
      else { socket.setTimeout(0); callback(null, socket); }
    };
    const receive = data => {
      try {
        buffer = Buffer.concat([buffer, data]);
        if (buffer.length > 5120) throw new Error('Local host proof exceeded its size limit.');
        if (headerSize === undefined) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) { if (buffer.length > 4096) throw new Error('Local host proof headers exceeded their limit.'); return; }
          if (end > 4096) throw new Error('Local host proof headers exceeded their limit.');
          const lines = buffer.subarray(0, end).toString('ascii').split('\r\n');
          if (!/^HTTP\/1\.1 200(?: |$)/.test(lines.shift())) throw new Error('The local listener did not prove its child identity.');
          const headers = new Map();
          for (const line of lines) {
            const match = /^([a-z0-9-]+):[ \t]*(.*)$/i.exec(line);
            if (!match || headers.has(match[1].toLowerCase())) throw new Error('Malformed local host proof headers.');
            headers.set(match[1].toLowerCase(), match[2]);
          }
          if (headers.has('transfer-encoding') || headers.has('content-encoding') || /close/i.test(headers.get('connection') || '') ||
              !/^application\/json(?:;|$)/i.test(headers.get('content-type') || '') || !/^[1-9][0-9]{0,3}$/.test(headers.get('content-length') || '')) throw new Error('Unsupported local host proof framing.');
          bodySize = Number(headers.get('content-length')); headerSize = end + 4;
          if (bodySize > 1024) throw new Error('Local host proof body exceeded its limit.');
        }
        if (buffer.length < headerSize + bodySize) return;
        if (buffer.length !== headerSize + bodySize) throw new Error('Unexpected bytes after local host proof.');
        const value = JSON.parse(buffer.subarray(headerSize).toString('utf8'));
        const message = `orbit-child-proof-v1\n${challenge}\n${this.pid}\n${this.port}\n${socket.localPort}`;
        const expected = crypto.createHmac('sha256', this.key).update(message).digest();
        if (!this.active || value.version !== 1 || value.pid !== this.pid || value.clientPort !== socket.localPort || value.challenge !== challenge || !token(value.proof) || !crypto.timingSafeEqual(expected, Buffer.from(value.proof, 'base64url'))) throw new Error('Local host identity proof failed.');
        finish();
      } catch (error) { finish(error); }
    };
    socket.on('data', receive);
    socket.once('error', error => finish(error));
    socket.once('end', () => finish(new Error('Local host closed before proving its identity.')));
    socket.setTimeout(this.timeout, () => finish(new Error('Local host identity proof timed out.')));
    socket.once('connect', () => socket.write(`GET /api/parent-proof HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nX-Orbit-Challenge: ${challenge}\r\nConnection: keep-alive\r\n\r\n`));
    // Do not return the unproved socket. Node must wait for the verified callback
    // before it can flush Authorization, an identity route, or a request body.
  }
  destroy() {
    this.active = false; this.key.fill(0);
    for (const socket of this.pendingProofs) socket.destroy(new Error('The local host generation ended.'));
    this.pendingProofs.clear(); super.destroy();
  }
}

function findTailscaleCli({ platform = process.platform, env = process.env, exists = value => { try { return fs.statSync(value).isFile(); } catch { return false; } } } = {}) {
  const executable = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const known = platform === 'win32' ? [path.win32.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', executable)] :
    ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  const separator = platform === 'win32' ? ';' : ':'; const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const candidates = [...known, ...(env.PATH || '').split(separator).filter(value => value && (platform === 'win32' ? path.win32 : path.posix).isAbsolute(value)).map(directory => join(directory, executable))];
  return candidates.find(exists) || null;
}
module.exports = { ChildProofAgent, findTailscaleCli };
