'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { request, remoteRequest, parseInvite, validateAddress, normalizeFingerprint } = require('./transport.cjs');

class OrbitController {
  constructor(options) {
    this.controlUrl = options.controlUrl || 'http://127.0.0.1:47831';
    this.controlToken = options.controlToken;
    this.directory = options.directory;
    this.allowLoopback = options.allowLoopback === true;
    this.native = options.native || {};
    this.connections = [];
    this.sessions = new Map();
    this.endedSessions = new Map();
    this.identity = null;
    this.saveQueue = Promise.resolve();
  }
  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.directory, 'connections.json'), 'utf8'));
      if (!Array.isArray(data) || data.length > 200) throw new Error('Invalid saved connections.');
      this.connections = data.map(device => {
        validateAddress(device.address, this.allowLoopback);
        return { ...device, fingerprint: normalizeFingerprint(device.fingerprint) };
      });
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Saved device configuration is invalid: ' + error.message); }
  }
  async local(route, method = 'GET', body) {
    return (await request({ url: new URL('/api/' + route, this.controlUrl), method, body,
      headers: { authorization: 'Bearer ' + this.controlToken }, maxBytes: 4 * 1024 * 1024 })).json;
  }
  async getIdentity() {
    if (!this.identity) this.identity = await this.local('client-identity');
    return this.identity;
  }
  async save() {
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      const destination = path.join(this.directory, 'connections.json');
      const temporary = destination + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(this.connections, null, 2), { mode: 0o600 });
      await fs.rename(temporary, destination);
    });
    return this.saveQueue;
  }
  getSession(payload) {
    const session = this.sessions.get(payload?.sessionId);
    if (!session || session.closed) throw new Error(this.endedSessions.get(payload?.sessionId) || 'This session has ended. Connect to the device again.');
    return session;
  }
  assertSession(id, session) {
    if (session.closed || this.sessions.get(id) !== session) throw new Error('This session has ended.');
  }
  async enqueueInput(id, session, input) {
    if (session.releasePending) throw new Error('Remote input is being released. Enable control again after it completes.');
    if (input.kind === 'pointerMove' && session.pendingMove) {
      session.pendingMove.input = input;
      return session.pendingMove.promise;
    }
    if ((session.pendingInputCount || 0) >= 64) {
      await this.invoke('session.release-inputs', { sessionId: id });
      throw new Error('The connection is too slow for control. Input was released; reconnect before continuing.');
    }
    const item = { input, epoch: session.inputEpoch || 0, promise: null };
    session.pendingInputCount = (session.pendingInputCount || 0) + 1;
    session.inputQueue = (session.inputQueue || Promise.resolve()).catch(() => {}).then(async () => {
      if (session.pendingMove === item) session.pendingMove = null;
      if (session.closed || (session.inputEpoch || 0) !== item.epoch || this.sessions.get(id) !== session) return;
      await this.remote(session.device, '/api/sessions/' + encodeURIComponent(session.remoteId) + '/input', { method: 'POST', body: item.input });
    }).finally(() => { session.pendingInputCount--; });
    item.promise = session.inputQueue;
    session.pendingMove = input.kind === 'pointerMove' ? item : null;
    return item.promise;
  }
  getDevice(id) {
    const device = this.connections.find(d => d.id === id);
    if (!device) throw new Error('Device is not paired.');
    return device;
  }
  async remote(device, route, options) {
    return remoteRequest(device, await this.getIdentity(), route, options, this.allowLoopback);
  }
  async status() {
    const raw = await this.local('status');
    this.lastStatus = raw;
    const platform = raw.platform || {};
    const transport = raw.transport || {};
    const nativeSettings = this.native.getSettings?.() || {};
    const platformName = platform.operatingSystem || process.platform;
    return {
      host: {
        id: raw.hostId, name: raw.hostName, platform: platformName, version: raw.version || '0.1.0', testMode: transport.mode === 'loopback-test',
        address: raw.remoteAddress, online: raw.remoteEnabled, startedAt: raw.startedAt,
        fingerprint: raw.certificateFingerprint,
        tailscale: {
          available: transport.mode === 'tailscale' || !!transport.executable, connected: transport.mode === 'tailscale' || transport.mode === 'loopback-test',
          ip: transport.address || transport.ip || (raw.remoteAddress ? new URL(raw.remoteAddress).hostname : undefined),
          dnsName: transport.nodeName || transport.dnsName, error: transport.error || transport.message ||
            (transport.mode === 'loopback-test' ? 'Local integration test mode. Remote access is bound to loopback.' : undefined),
        },
      },
      capabilities: {
        capture: !!platform.canCapture, input: !!platform.canInput, clipboard: !!platform.canClipboard,
        files: true, power: true,
        monitors: platform.monitors || [], lock: !!platform.canLock,
      },
      settings: {
        hostName: raw.hostName, allowControl: true, allowClipboard: !!platform.canClipboard,
        allowFiles: !!raw.settings?.fileTransferEnabled, allowPower: !!raw.settings?.allowRemotePower,
        fileTransferRoot: raw.settings?.fileTransferRoot || '', listenPort: 47832,
        startAtLogin: !!nativeSettings.startAtLogin, startAtLoginSupported: !!nativeSettings.startAtLoginSupported,
      },
      sessions: [...(raw.sessions || []).map(({ resumeEpoch: _resumeEpoch, ...s }) => ({ ...s, startedAt: s.createdAt, direction: 'incoming' })),
        ...[...this.sessions.entries()].filter(([, s]) => !s.closed).map(([id, s]) => ({ id,
          deviceId: s.device.id, deviceName: s.device.name, startedAt: s.startedAt, direction: 'outgoing' }))],
      limitations: platform.limitations || [], sessionState: platform.sessionState,
      diagnostics: { transport: transport.mode, remoteEnabled: raw.remoteEnabled, startedAt: raw.startedAt },
    };
  }
  async devices() {
    const incoming = await this.local('peers');
    const peers = Array.isArray(incoming) ? incoming : incoming.devices || incoming.peers || [];
    return { devices: [
      ...this.connections.map(d => ({ ...d, direction: 'outgoing', online: d.online ?? null, status: d.online === true ? 'online' : d.online === false ? 'offline' : 'unknown' })),
      ...peers.filter(p => !p.revokedAt).map(p => ({ id: p.id, name: p.name, platform: 'unknown',
        direction: 'incoming', online: null, status: 'authorized', permissions: p.permissions,
        fingerprint: p.fingerprint, pairedAt: p.createdAt })),
    ] };
  }
  async invoke(action, payload = {}) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid application request.');
    switch (action) {
      case 'status': return this.status();
      case 'app.open-project': await this.native.openProject?.(); return { ok: true };
      case 'clipboard.local.write': {
        if (typeof payload.text !== 'string' || payload.text.length > 16384) throw new Error('Copy text exceeds the clipboard limit.');
        this.native.writeLocalClipboard?.(payload.text);
        return { ok: true };
      }
      case 'devices': return this.devices();
      case 'audit': {
        const raw = await this.local('audit');
        return { entries: (Array.isArray(raw) ? raw : raw.entries || []).map((e, i) => ({
          id: String(i), at: e.at, timestamp: e.at, kind: e.kind, action: e.kind,
          deviceId: e.deviceId, detail: e.detail, message: e.detail,
        })) };
      }
      case 'invite.create': {
        const p = payload.permissions || { view: true, control: false, clipboard: false, files: false, power: false };
        const result = await this.local('invites', 'POST', { deviceName: payload.deviceName || null, permissions: {
          view: p.view === true, control: p.control === true, clipboard: p.clipboard === true,
          files: p.files === true, power: p.power === true,
        } });
        return { ...result, invite: result.inviteUri };
      }
      case 'pair': {
        const invite = parseInvite(payload.invite, this.allowLoopback);
        const status = await this.local('status');
        const result = await this.remote({ address: invite.address, fingerprint: invite.fingerprint }, '/api/pair', {
          method: 'POST', body: { secret: invite.secret, deviceName: status.hostName },
        });
        const info = result.json;
        const device = { id: info.hostId, name: info.hostName || invite.hostName, platform: 'unknown',
          address: invite.address, fingerprint: invite.fingerprint, serverFingerprint: invite.fingerprint,
          permissions: info.permissions, pairedAt: new Date().toISOString(), online: true };
        if (typeof device.id !== 'string' || !device.id) throw new Error('Device returned an invalid identity.');
        // The remote host chooses its own ID. A hostile invite could reuse a trusted device's ID
        // to replace that saved entry's address and certificate, so a different pin never overwrites.
        const existing = this.connections.find(d => d.id === device.id);
        if (existing && existing.fingerprint !== device.fingerprint) {
          throw new Error(`This invitation claims to be “${existing.name}” but presents a different certificate. Nothing was changed. If that computer was reinstalled, forget it first, then pair again.`);
        }
        this.connections = this.connections.filter(d => d.id !== device.id);
        this.connections.push(device);
        await this.save();
        return device;
      }
      case 'network.refresh': {
        await Promise.allSettled(this.connections.map(async device => {
          try {
            const info = (await this.remote(device, '/api/info')).json;
            device.online = true;
            device.platform = info.platform?.operatingSystem || info.operatingSystem || device.platform;
            device.name = info.hostName || device.name;
            device.lastSeen = new Date().toISOString();
          } catch { device.online = false; }
        }));
        await this.save();
        return this.devices();
      }
      case 'session.start': {
        const device = this.getDevice(payload.deviceId);
        const info = (await this.remote(device, '/api/info')).json;
        const created = await this.remote(device, '/api/sessions', { method: 'POST', body: {
          monitorId: payload.monitorId || null, viewOnly: payload.viewOnly === true,
        } });
        const result = created.json;
        const remoteId = result.id || result.sessionId;
        if (!remoteId) throw new Error('Device did not create a session.');
        const localId = crypto.randomUUID();
        const monitors = info.platform?.monitors || info.monitors || [];
        this.sessions.set(localId, { device, remoteId, monitors, monitorId: payload.monitorId || null,
          resumeEpoch: typeof result.resumeEpoch === 'string' && result.resumeEpoch.length <= 128 ? result.resumeEpoch : null,
          permissions: result.permissions || device.permissions, viewOnly: payload.viewOnly === true,
          startedAt: new Date().toISOString(), frame: null, frameSlots: new Map(), renewPending: null, inputQueue: Promise.resolve(),
          closed: false, inputEpoch: 0, pendingInputCount: 0, pendingMove: null });
        return { sessionId: localId, deviceId: device.id, permissions: result.permissions || device.permissions, monitors, link: created.link };
      }
      case 'session.monitors': {
        const s = this.getSession(payload);
        return { monitors: s.monitors };
      }
      case 'session.release-inputs': {
        const s = this.getSession(payload);
        if (s.viewOnly || !s.permissions?.control) return { ok: true };
        if (s.releasePending) { await s.releasePending; return { ok: true }; }
        s.inputEpoch = (s.inputEpoch || 0) + 1;
        s.pendingMove = null;
        s.inputQueue = (s.inputQueue || Promise.resolve()).catch(() => {}).then(() =>
          this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/release-inputs', { method: 'POST' }));
        s.releasePending = s.inputQueue;
        try { await s.releasePending; } finally { s.releasePending = null; }
        return { ok: true };
      }
      case 'session.frame': {
        const s = this.getSession(payload);
        const requestedMonitor = Object.hasOwn(payload, 'monitorId') ? payload.monitorId || null : s.monitorId;
        if (requestedMonitor !== null && (typeof requestedMonitor !== 'string' || !s.monitors.some(m => m.id === requestedMonitor)))
          throw new Error('Choose an available remote monitor.');
        const key = requestedMonitor || '';
        const slots = s.frameSlots ||= new Map();
        const slot = slots.get(key) || { frame: null, pending: null };
        slots.set(key, slot);
        if (slot.pending) return slot.pending;
        slot.pending = (async () => {
          const renewSession = async failedId => {
            this.assertSession(payload.sessionId, s);
            if (s.renewPending) return s.renewPending;
            if (s.remoteId !== failedId) return;
            if (!s.resumeEpoch) throw Object.assign(new Error('This host cannot safely resume this session. Connect again explicitly.'), { status: 410 });
            const renewal = (async () => {
              s.inputEpoch = (s.inputEpoch || 0) + 1;
              s.pendingMove = null;
              s.frame = null;
              for (const entry of slots.values()) entry.frame = null;
              await (s.inputQueue || Promise.resolve()).catch(() => {});
              this.assertSession(payload.sessionId, s);
              const replacement = (await this.remote(s.device, '/api/sessions', { method: 'POST', body: {
                monitorId: s.monitorId, viewOnly: s.viewOnly, resumeEpoch: s.resumeEpoch,
              } })).json;
              if (!(replacement.id || replacement.sessionId)) throw new Error('Device did not renew the session.');
              // Record a late response even after disconnect so session.end can delete it.
              s.remoteId = replacement.id || replacement.sessionId;
              s.permissions = replacement.permissions || {};
              s.resumeEpoch = typeof replacement.resumeEpoch === 'string' && replacement.resumeEpoch.length <= 128 ? replacement.resumeEpoch : null;
              this.assertSession(payload.sessionId, s);
            })();
            s.renewPending = renewal;
            try { await renewal; } finally { if (s.renewPending === renewal) s.renewPending = null; }
          };
          if (s.renewPending) await s.renewPending;
          const failedId = s.remoteId;
          let capturedId;
          const capture = () => {
            capturedId = s.remoteId;
            return this.remote(s.device, '/api/sessions/' + encodeURIComponent(capturedId) + '/frame' +
              (requestedMonitor ? '?monitorId=' + encodeURIComponent(requestedMonitor) : ''), { maxBytes: 24 * 1024 * 1024 });
          };
          let frame;
          try {
            frame = await capture();
          } catch (error) {
            if (error.status !== 404) throw error;
            // A service restart or expired idle session requires fresh server-side authorization.
            // A revoked identity receives 401 and can never be renewed through this path.
            await renewSession(failedId);
            this.assertSession(payload.sessionId, s);
            frame = await capture();
          }
          this.assertSession(payload.sessionId, s);
          if (capturedId !== s.remoteId || s.renewPending) throw new Error('The session reconnected. Wait for a fresh screen.');
          const number = (name, fallback = 0) => Number(frame.headers[name] ?? fallback);
          slot.frame = { width: number('x-orbit-width'), height: number('x-orbit-height'),
            left: number('x-orbit-left'), top: number('x-orbit-top') };
          if (requestedMonitor === (s.monitorId || null)) s.frame = slot.frame;
          return { ...slot.frame, dataUrl: 'data:image/png;base64,' + frame.buffer.toString('base64'), link: frame.link };
        })();
        try { return await slot.pending; }
        catch (error) {
          if (error.status === 410) {
            this.endedSessions.set(payload.sessionId, String(error.message || 'Session ended by host. Connect again explicitly.').slice(0, 500));
            if (this.endedSessions.size > 64) this.endedSessions.delete(this.endedSessions.keys().next().value);
            s.closed = true;
            s.inputEpoch = (s.inputEpoch || 0) + 1;
            s.pendingMove = null;
            s.frame = null;
            for (const entry of slots.values()) entry.frame = null;
            if (this.sessions.get(payload.sessionId) === s) this.sessions.delete(payload.sessionId);
          }
          throw error;
        } finally { slot.pending = null; }
      }
      case 'session.input': {
        const s = this.getSession(payload);
        if (s.viewOnly || !s.permissions?.control) throw new Error('This session is view only.');
        if (s.renewPending) throw new Error('The session is reconnecting. Wait for a fresh screen.');
        const e = payload.event;
        if (!e || typeof e !== 'object') throw new Error('Invalid remote input.');
        const geometry = Object.hasOwn(payload, 'monitorId') ? s.frameSlots?.get(payload.monitorId || '')?.frame : s.frame;
        if (!geometry) throw new Error('Wait for the first frame before controlling the desktop.');
        let input;
        const x = () => geometry.left + Math.round(Math.max(0, Math.min(1, Number(e.x) || 0)) * (geometry.width - 1));
        const y = () => geometry.top + Math.round(Math.max(0, Math.min(1, Number(e.y) || 0)) * (geometry.height - 1));
        switch (e.type) {
          case 'pointer.move': input = { kind: 'pointerMove', x: x(), y: y() }; break;
          case 'pointer.button': input = { kind: 'pointerButton', x: x(), y: y(),
            button: ({ 0: 'left', 1: 'middle', 2: 'right' })[e.button], isDown: e.down === true }; break;
          case 'pointer.wheel': input = { kind: 'wheel', x: x(), y: y(),
            deltaX: Math.max(-1200, Math.min(1200, Math.round(Number(e.deltaX) || 0))),
            deltaY: Math.max(-1200, Math.min(1200, Math.round(Number(e.deltaY) || 0))) }; break;
          case 'key': input = { kind: 'key', key: e.code || e.key, isDown: e.down === true }; break;
          default: throw new Error('Unsupported remote input.');
        }
        await this.enqueueInput(payload.sessionId, s, input);
        return { ok: true };
      }
      case 'session.end': {
        const s = this.sessions.get(payload.sessionId);
        if (s) {
          s.closed = true;
          s.inputEpoch = (s.inputEpoch || 0) + 1;
          s.pendingMove = null;
          this.sessions.delete(payload.sessionId);
          await (s.inputQueue || Promise.resolve()).catch(() => {});
          await Promise.allSettled([...(s.frameSlots?.values() || [])].map(slot => slot.pending).filter(Boolean));
          await s.renewPending?.catch(() => {});
          await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId), { method: 'DELETE' });
        } else if (this.endedSessions.has(payload.sessionId)) {
          this.endedSessions.delete(payload.sessionId);
        } else if (typeof payload.sessionId === 'string') {
          await this.local('sessions/' + encodeURIComponent(payload.sessionId), 'DELETE');
        }
        return { ok: true };
      }
      case 'clipboard.read':
      case 'clipboard.write': {
        const s = this.getSession(payload);
        const writing = action === 'clipboard.write';
        const result = await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/clipboard', {
          method: writing ? 'PUT' : 'GET', ...(writing ? { body: { text: String(payload.text || '') } } : {}),
        });
        return result.json || { ok: true };
      }
      case 'session.lock':
      case 'session.restart': {
        const s = this.getSession(payload);
        return (await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/power', {
          method: 'POST', body: { action: action === 'session.lock' ? 'lock' : 'restart' },
        })).json;
      }
      case 'files.list': {
        const s = this.getSession(payload);
        const result = (await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/files')).json;
        return { entries: (Array.isArray(result) ? result : result.entries || []).map(f => ({ ...f, path: f.name, isDirectory: false })), path: '/' };
      }
      case 'files.upload': {
        const s = this.getSession(payload);
        const selection = await this.native.openFile?.();
        if (!selection) return { cancelled: true };
        const stat = await fs.stat(selection);
        if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Choose a file up to 16 MiB.');
        const data = await fs.readFile(selection);
        return (await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/files/' +
          encodeURIComponent(path.basename(selection)), { method: 'PUT', body: data })).json || { ok: true };
      }
      case 'files.download': {
        const s = this.getSession(payload);
        const name = payload.name;
        if (typeof name !== 'string' || name !== path.basename(name) || /[\\/:\x00-\x1f]/.test(name)) throw new Error('Invalid file name.');
        const destination = await this.native.saveFile?.(name);
        if (!destination) return { cancelled: true };
        const result = await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/files/' + encodeURIComponent(name), { maxBytes: 16 * 1024 * 1024 });
        await fs.writeFile(destination, result.buffer, { mode: 0o600 });
        return { savedPath: destination };
      }
      case 'device.revoke': {
        const id = payload.deviceId || payload.id;
        await this.local('peers/' + encodeURIComponent(id), 'DELETE');
        return { ok: true };
      }
      case 'device.forget': {
        const id = payload.deviceId || payload.id;
        for (const [sessionId, s] of this.sessions) if (s.device.id === id) await this.invoke('session.end', { sessionId });
        this.connections = this.connections.filter(d => d.id !== id);
        await this.save();
        return { ok: true };
      }
      case 'settings.update': {
        const raw = await this.local('settings');
        const next = { ...raw };
        if ('allowFiles' in payload) next.fileTransferEnabled = payload.allowFiles === true;
        if ('allowPower' in payload) next.allowRemotePower = payload.allowPower === true;
        if ('hostName' in payload) next.hostName = String(payload.hostName).slice(0, 80);
        if ('fileTransferRoot' in payload) next.fileTransferRoot = payload.fileTransferRoot || null;
        if (next.fileTransferEnabled && !next.fileTransferRoot) {
          next.fileTransferRoot = await this.native.chooseFolder?.();
          if (!next.fileTransferRoot) throw new Error('Select a dedicated folder before enabling file transfer.');
        }
        if ('startAtLogin' in payload && (payload.startAtLogin === true) !== !!this.native.getSettings?.().startAtLogin) {
          await this.native.setStartAtLogin?.(payload.startAtLogin === true);
        }
        await this.local('settings', 'PUT', next);
        return this.status();
      }
      default: throw new Error('Unknown application action.');
    }
  }
  async shutdown() {
    await Promise.allSettled([...this.sessions.keys()].map(sessionId => this.invoke('session.end', { sessionId })));
    this.identity = null;
  }
}
module.exports = { OrbitController };
