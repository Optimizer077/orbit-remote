'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { SessionVideoStreams, sessionAvailability, streamErrorPolicy } = require('./stream-session.cjs');
const { SECURITY_TERMINAL, IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');
const { markDownloaded } = require('./mark-of-web.cjs');
const { request, remoteRequest, parseInvite, validateAddress, normalizeFingerprint,
  transferDeadline, MAX_TRANSFER_BYTES, TRANSFER_IDLE_MS, isDisplayAsleep, DISPLAY_ASLEEP_MESSAGE } = require('./transport.cjs');
const peerData = require('./peer-data.cjs');

const MIN_FRAME_SCALE = 0.33; // Matches FrameQuality.MinimumScale on the host.
const CLEANUP_RETRY_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const CLEANUP_RETRY_NETWORK = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ORBIT_TLS_HANDSHAKE_TIMEOUT', 'ORBIT_REQUEST_TIMEOUT', 'ORBIT_REQUEST_DEADLINE']);
const tooLarge = name => `${name} is larger than ${MAX_TRANSFER_BYTES / (1024 * 1024)} MiB, Orbit’s transfer limit.`;

// The port the host's remote listener actually uses (ORBIT_REMOTE_PORT), or undefined when it is not listening.
function remotePort(address) {
  try {
    const url = new URL(address);
    return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  } catch { return undefined; }
}

// Optional renderer-requested downscale. Absent means lossless full resolution.
function frameScale(value) {
  if (value === undefined || value === null) return 1;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid frame scale.');
  return Math.min(1, Math.max(MIN_FRAME_SCALE, Math.round(value * 1000) / 1000));
}

function frameEncoding(payload, supported) {
  const requested = payload.format ?? 'png';
  if (!['png', 'jpeg'].includes(requested)) throw new Error('Invalid frame format.');
  const quality = payload.quality ?? 75;
  if (!Number.isInteger(quality)) throw new Error('Invalid frame quality.');
  return { format: supported ? requested : 'png', quality: Math.min(90, Math.max(40, quality)) };
}

// Mirrors FrameQuality.ParseConditionalTag: one bounded, quoted, printable-ASCII validator.
function isValidator(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 128 && value[0] === '"' && value.at(-1) === '"' &&
    !/[",\\]/.test(value.slice(1, -1)) && /^[\x21-\x7e]+$/.test(value);
}

function positive(value) {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

class OrbitController {
  constructor(options) {
    this.controlUrl = options.controlUrl || 'http://127.0.0.1:47831';
    this.controlToken = options.controlToken;
    this.requireLocalProof = options.requireLocalProof === true;
    this.localAgent = null;
    this.localGeneration = 0;
    this.directory = options.directory;
    this.allowLoopback = options.allowLoopback === true;
    this.native = options.native || {};
    this.onDisplayAsleep = options.onDisplayAsleep || (() => {});
    this.onDisplayPendingInvalidated = options.onDisplayPendingInvalidated || (() => {});
    this.requestRemote = options.remoteRequest || remoteRequest;
    this.inputBatchLimit = options.inputBatchLimit || 64; // InputEndpoints.MaximumBatchEvents on the host.
    this.connections = [];
    this.sessions = new Map();
    this.identityFailures = new WeakMap();
    this.cleanupRetiredDevices = new WeakSet();
    this.sessionCleanups = new Map();
    this.cleanupRevision = 0; this.cleanupSequence = 0; this.cleanupAutoStopped = false;
    this.cleanupScheduler = options.cleanupScheduler || { setTimeout, clearTimeout };
    this.onCleanupChanged = options.onCleanupChanged || (() => {});
    this.endedSessions = new Map();
    this.reconnectTargets = new Map();
    this.reconnectPending = new Map();
    this.videoStreams = new SessionVideoStreams(this, { onTerminal: options.onSessionEnded, onPresented: options.onFramePresented });
    this.identity = null;
    this.saveQueue = Promise.resolve();
  }
  async initialize() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.directory, 'connections.json'), 'utf8'));
      if (!Array.isArray(data) || data.length > 200) throw new Error('Invalid saved connections.');
      // A paired host's name, platform and grants were saved from untrusted replies:
      // repair them, and drop entries without a usable ID. Address and pin fail closed.
      this.connections = data.map(peerData.savedDevice).filter(Boolean).map(device => {
        validateAddress(device.address, this.allowLoopback);
        const repaired = { ...device, fingerprint: normalizeFingerprint(device.fingerprint) };
        if ('serverFingerprint' in repaired) {
          try { repaired.serverFingerprint = normalizeFingerprint(repaired.serverFingerprint); } catch { delete repaired.serverFingerprint; }
        }
        return repaired;
      });
      // Rewrite the file only when the repair changed something (key order alone is not a change).
      if (!isDeepStrictEqual(this.connections, data)) await this.save().catch(() => {});
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Saved device configuration is invalid: ' + error.message); }
  }
  async local(route, method = 'GET', body) {
    if (this.requireLocalProof && !this.localAgent) throw Object.assign(new Error('The authenticated background host is not ready.'), { code: 'ORBIT_LOCAL_HOST_RESTARTING' });
    const generation = this.localGeneration;
    const result = await request({ url: new URL('/api/' + route, this.controlUrl), method, body, agent: this.localAgent || undefined,
      headers: { authorization: 'Bearer ' + this.controlToken }, maxBytes: 4 * 1024 * 1024 });
    if (generation !== this.localGeneration) throw Object.assign(new Error('The background host restarted; retry this operation.'), { code: 'ORBIT_LOCAL_HOST_RESTARTED' });
    return result.json;
  }
  setLocalControl(agent, bearer) {
    const cleanups = this.sessionCleanups;
    if (cleanups?.size) {
      // A supervisor reset updates live authorization synchronously. Only the
      // detached, already-closed cleanup targets get one final old-identity pass.
      this.sessionCleanups = new Map();
      this.cleanupChanged();
      const resetting = Promise.allSettled([this.cleanupReset, this.finishSessionCleanups(cleanups)]);
      this.cleanupReset = resetting;
      void resetting.then(() => { if (this.cleanupReset === resetting) this.cleanupReset = null; });
    }
    this.localAgent?.destroy(); this.localAgent = agent; this.controlToken = bearer;
    if (agent && bearer) this.cleanupAutoStopped = false;
    this.localGeneration++; this.identity = null;
    return this.cleanupReset || Promise.resolve();
  }
  clearLocalControl() {
    return this.setLocalControl(null, null);
  }
  async getIdentity() {
    if (!this.identity) {
      const generation = this.localGeneration;
      const identity = await this.local('client-identity');
      if (generation !== this.localGeneration) throw Object.assign(new Error('The background identity generation changed.'), { code: 'ORBIT_LOCAL_HOST_RESTARTED' });
      this.identity = identity;
    }
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
    if (!session || session.closed) throw Object.assign(new Error(this.endedSessions.get(payload?.sessionId) || 'This session has ended. Connect to the device again.'), { status: 410, code: 'session_ended' });
    return session;
  }
  assertSession(id, session) {
    if (session.closed || this.sessions.get(id) !== session) throw Object.assign(new Error('This session has ended.'), { status: 410, code: 'session_ended' });
  }
  availability(id, session = this.getSession({ sessionId: id })) {
    this.assertSession(id, session);
    return sessionAvailability(id, session);
  }
  noteDisplayAsleep(id, session) {
    this.assertSession(id, session);
    // A private report revision fences receipt issuance after an await. Use an
    // opaque token so every report is distinct, including repeats after a draw.
    session.displaySleepReport = {};
    const generation = session.sessionGeneration ?? 0;
    // Even a latched repeat retires requests/receipts that began before this
    // report. Keep already-ready frames and transition-only input cleanup intact.
    for (const slot of session.frameSlots?.values() || []) slot.deliveryToken = {};
    const repeated = session.displayAsleepGeneration === generation;
    if (repeated) {
      try { this.onDisplayPendingInvalidated(id); } catch { /* A closing window cannot retain a valid request token. */ }
    } else {
      // A current draw receipt alone resets the input/readiness transition latch.
      session.displayAsleepGeneration = generation;
      session.inputEpoch = (session.inputEpoch || 0) + 1;
      session.pendingMove = null; session.frame = null;
      for (const slot of session.frameSlots?.values() || []) {
        slot.frame = null; slot.cache = null;
      }
      // A following image of identical geometry still needs its own draw receipt.
      // This local observer only invalidates readiness; it never grants authority.
      try { this.onDisplayAsleep(id); } catch { /* A closing window cannot change the remote result. */ }
    }
    // Retire decoded-but-unpresented samples on repeats too. A late receipt from
    // those streams must not clear the sleep latch or restore input readiness.
    const availability = this.availability(id, session);
    for (const entry of this.videoStreams.entries.values()) if (entry.session === session)
      this.videoStreams.finish(entry, { state: 'fallback', code: 'display_asleep', status: 409, displayState: 'off',
        error: DISPLAY_ASLEEP_MESSAGE, retryable: true, ...(availability ? { availability } : {}) });
    return !repeated;
  }
  noteDisplayPresented(id, generation) {
    const session = this.sessions.get(id);
    if (!session || session.closed || (session.sessionGeneration ?? 0) !== generation
      || session.displayAsleepGeneration !== generation) return false;
    // Main calls this only after accepting the current image receipt or bound
    // video presentation. GET/304 responses and Wake202 never clear asleep.
    delete session.displayAsleepGeneration;
    return true;
  }
  noteHostStopping(id, code) {
    const session = this.sessions.get(id);
    if (!session || session.closed || !['host_stopping', 'stream_restart'].includes(code)) return;
    const fingerprint = session.device.fingerprint || session.device.serverFingerprint;
    if (!/^[a-f0-9]{64}$/i.test(fingerprint || '')) return;
    this.reconnectTargets.set(id, { deviceId: session.device.id, fingerprint, viewOnly: session.viewOnly, monitorId: session.monitorId });
    if (this.reconnectTargets.size > 64) this.reconnectTargets.delete(this.reconnectTargets.keys().next().value);
  }
  canReconnect(id) {
    const target = this.reconnectTargets.get(id), device = target && this.connections.find(value => value.id === target.deviceId);
    return !this.sessions.has(id) && this.endedSessions.has(id) && !!device && !device.revoked && (device.fingerprint || device.serverFingerprint) === target.fingerprint;
  }
  cancelReconnect(id) { const operation = this.reconnectPending.get(id); if (operation) operation.cancelled = true; }
  cleanupChanged() {
    this.cleanupRevision++;
    try { this.onCleanupChanged({ revision: this.cleanupRevision }); } catch { /* Observers cannot change cleanup authority. */ }
  }
  cleanupState(device, neverAuto = false) {
    const safeName = typeof device.name === 'string' ? device.name.replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim() : '';
    const name = Array.from(safeName).slice(0, 128).join('');
    return { deviceName: name || 'Remote device', version: ++this.cleanupSequence, failedOnce: false, retrying: false,
      retryTimer: null, autoUsed: false, neverAuto: neverAuto || this.cleanupAutoStopped, confirmed: false };
  }
  consumeCleanupRetry(cleanup) {
    const changed = !cleanup.autoUsed || cleanup.retryTimer !== null;
    cleanup.autoUsed = true;
    if (cleanup.retryTimer !== null) this.cleanupScheduler.clearTimeout(cleanup.retryTimer);
    cleanup.retryTimer = null;
    if (changed) this.cleanupChanged();
  }
  scheduleCleanupRetry(id, cleanup, error) {
    // DELETE has no stream parser today. Keep typed protocol failures manual if
    // a future transport wrapper also attaches a transient HTTP status.
    if (cleanup.disposed || cleanup.neverAuto || cleanup.autoUsed || this.cleanupAutoStopped || cleanup.retryTimer !== null
      || error?.code === 'stream_protocol_error'
      || !(CLEANUP_RETRY_HTTP.has(error?.status) || (error?.status === undefined && CLEANUP_RETRY_NETWORK.has(error?.code)))) return;
    const version = cleanup.version;
    // Only an opaque local ID and version survive in the timer closure. The
    // original identity binding stays in the bounded, disposable record.
    cleanup.retryTimer = this.cleanupScheduler.setTimeout(() => {
      const current = this.sessionCleanups.get(id);
      if (!current || current.version !== version || current.disposed || current.autoUsed || current.neverAuto || this.cleanupAutoStopped) return;
      current.retryTimer = null; current.autoUsed = true;
      void this.closeSession(id, this.sessionCleanups, { automatic: true }).catch(() => {});
    }, 10000);
    cleanup.retryTimer?.unref?.();
  }
  cleanupList() {
    return { revision: this.cleanupRevision, entries: [...this.sessionCleanups].filter(([, value]) => value.failedOnce && !value.disposed && !value.silent).slice(0, 64)
      .map(([id, value]) => ({ id, deviceName: value.deviceName, state: value.retrying ? 'retrying' : 'failed', retryScheduled: value.retryTimer !== null })) };
  }
  async retryCleanup(id) {
    const cleanup = typeof id === 'string' && id.length <= 128 ? this.sessionCleanups.get(id) : undefined;
    if (!cleanup || cleanup.disposed) return { cleared: true, confirmed: false };
    this.consumeCleanupRetry(cleanup);
    await this.closeSession(id, this.sessionCleanups, { manual: true }).catch(() => {});
    return { cleared: this.sessionCleanups.get(id) !== cleanup, confirmed: cleanup.confirmed === true };
  }
  cleanupIdentityFailure(cleanup) {
    const failure = cleanup.deviceRef && this.identityFailures.get(cleanup.deviceRef);
    return failure?.pin === cleanup.pin ? failure?.error : undefined;
  }
  cleanupBlocked(cleanup) {
    return cleanup.disposed || this.cleanupIdentityFailure(cleanup);
  }
  disposeCleanup(id, cleanup, cleanups) {
    const removed = cleanups.get(id) === cleanup;
    if (removed) cleanups.delete(id);
    if (cleanup.retryTimer !== null && cleanup.retryTimer !== undefined) this.cleanupScheduler.clearTimeout(cleanup.retryTimer);
    cleanup.retryTimer = null; cleanup.autoUsed = true; cleanup.retrying = false;
    cleanup.disposed = true; cleanup.deleteRemote = null; cleanup.device = null; cleanup.deviceRef = null; cleanup.pin = null; cleanup.session = null;
    if (removed) this.cleanupChanged();
  }
  disposeDeviceCleanups(deviceId, origins = new Set(), retire = false) {
    for (const device of this.connections) if (device.id === deviceId) origins.add(device);
    for (const session of this.sessions.values()) if (session.device.id === deviceId) origins.add(session.device);
    for (const [id, cleanup] of this.sessionCleanups) if (cleanup.deviceRef?.id === deviceId) {
      origins.add(cleanup.deviceRef); this.disposeCleanup(id, cleanup, this.sessionCleanups);
    }
    if (retire) for (const device of origins) this.cleanupRetiredDevices.add(device);
    return origins;
  }
  async closeSession(id, cleanups = this.sessionCleanups, options = {}) {
    // A cleanup target never participates in session lookup or authorization.
    // Keep it after a failed DELETE so an explicit retry addresses the remote
    // session, not the unrelated local viewer-session ID.
    let cleanup = cleanups.get(id);
    if (cleanup && !options.automatic && !options.initial && !options.finalPass) this.consumeCleanupRetry(cleanup);
    const s = this.sessions.get(id), retired = this.retiredOutgoingSessions ||= new Set();
    const alreadyRetired = retired.has(id);
    if (cleanup || s || this.endedSessions.has(id)) {
      retired.add(id);
      while (retired.size > 256) retired.delete(retired.values().next().value);
    }
    if (!cleanup) {
      if (s) {
        s.closed = true;
        s.inputEpoch = (s.inputEpoch || 0) + 1;
        s.pendingMove = null;
        s.frame = null;
        for (const slot of s.frameSlots?.values() || []) { slot.frame = null; slot.cache = null; }
        this.sessions.delete(id);
        cleanup = { session: s, device: { address: s.device.address, fingerprint: s.device.fingerprint || s.device.serverFingerprint },
          deviceRef: s.device, pin: s.remotePin || s.device.fingerprint || s.device.serverFingerprint,
          pending: null, drained: false, deleteRemote: null, ...this.cleanupState(s.device) };
        cleanups.set(id, cleanup);
        this.cleanupChanged();
      } else if (retired.has(id)) {
        this.endedSessions.delete(id);
        return alreadyRetired ? { ok: true, alreadyEnded: true } : { ok: true };
      } else if (!this.reconnectPending.has(id) && typeof id === 'string') {
        await this.local('sessions/' + encodeURIComponent(id), 'DELETE');
      }
    }
    // Cleanup is best effort and bounded, including targets from cancelled
    // session creation that never entered the active authority map.
    while (cleanups.size > 64) {
      const [oldId, old] = cleanups.entries().next().value;
      this.disposeCleanup(oldId, old, cleanups);
    }
    if (cleanup) {
      if (this.cleanupBlocked(cleanup)) {
        this.disposeCleanup(id, cleanup, cleanups); return { ok: true };
      }
      if (!cleanup.pending) cleanup.pending = Promise.resolve().then(async () => {
        if (this.cleanupBlocked(cleanup)) { this.disposeCleanup(id, cleanup, cleanups); return; }
        if (cleanup.failedOnce) { cleanup.retrying = true; this.cleanupChanged(); }
        if (this.cleanupBlocked(cleanup)) { this.disposeCleanup(id, cleanup, cleanups); return; }
        if (!cleanup.drained) {
          const s = cleanup.session;
          await (s.inputQueue || Promise.resolve()).catch(() => {});
          await Promise.allSettled([...(s.frameSlots?.values() || [])].map(slot => slot.pending).filter(Boolean));
          await s.renewPending?.catch(() => {});
          if (this.cleanupBlocked(cleanup)) { this.disposeCleanup(id, cleanup, cleanups); return; }
          // Renewal records a late replacement before rejecting closed delivery.
          cleanup.remoteId = s.remoteId;
          if (s.deleteRemote) {
            const remove = s.deleteRemote, remoteId = cleanup.remoteId;
            cleanup.deleteRemote = () => remove(remoteId);
            cleanup.device = null;
          }
          cleanup.session = null;
          cleanup.drained = true;
        }
        if (this.cleanupBlocked(cleanup)) { this.disposeCleanup(id, cleanup, cleanups); return; }
        try {
          if (cleanup.deleteRemote) await cleanup.deleteRemote();
          else await this.remote(cleanup.device, '/api/sessions/' + encodeURIComponent(cleanup.remoteId), { method: 'DELETE' }, remove => {
            if (cleanup.disposed) throw new Error('Session cleanup is no longer available.');
            const failure = this.cleanupIdentityFailure(cleanup); if (failure) throw failure;
            // Retry with the same pin and client identity even after pairing or
            // local identity changes. This closure can only delete this target.
            cleanup.deleteRemote = () => remove(cleanup.remoteId);
            cleanup.device = null;
          });
        } catch (error) {
          if (this.cleanupBlocked(cleanup)) { this.disposeCleanup(id, cleanup, cleanups); return; }
          if (cleanup.deviceRef) this.retireIdentity(cleanup.deviceRef, error, cleanup.pin);
          // No usable cleanup authorization remains, or the target is gone.
          if (![401, 403, 404, 410].includes(error?.status) &&
            !(SECURITY_TERMINAL.has(error?.code) && (!IDENTITY_TERMINAL.has(error.code) || error.status === undefined))) {
            cleanup.failedOnce = true; cleanup.retrying = false;
            this.scheduleCleanupRetry(id, cleanup, error); this.cleanupChanged(); throw error;
          }
          this.disposeCleanup(id, cleanup, cleanups); return;
        }
        if (cleanup.disposed) return;
        cleanup.confirmed = true;
        this.disposeCleanup(id, cleanup, cleanups);
      });
      const pending = cleanup.pending;
      try { await pending; } finally { if (cleanup.pending === pending) cleanup.pending = null; }
    }
    return { ok: true };
  }
  async finishSessionCleanups(cleanups = this.sessionCleanups) {
    if (!cleanups?.size) return;
    const entries = [...cleanups];
    for (const [, cleanup] of entries) { cleanup.neverAuto = true; this.consumeCleanupRetry(cleanup); }
    try {
      // Do not race a DELETE already in flight. Failed pending work gets at most
      // one final retry, using the same original pin/client identity binding.
      await Promise.allSettled(entries.map(([, cleanup]) => cleanup.pending).filter(Boolean));
      await Promise.allSettled(entries.filter(([id, cleanup]) => cleanups.get(id) === cleanup)
        .map(([id]) => this.closeSession(id, cleanups, { finalPass: true })));
    } finally {
      for (const cleanup of new Set([...entries.map(([, value]) => value), ...cleanups.values()])) {
        this.disposeCleanup('', cleanup, cleanups); cleanup.pending = null;
      }
      cleanups.clear();
      this.cleanupChanged();
    }
  }
  async cleanupCreated(device, remoteId, remove, final = false, pin = device.fingerprint || device.serverFingerprint) {
    // Late orphans still get one original-pinned DELETE after Forget/revoke.
    // Mark it final before the request: no retry, name or notice may survive it.
    if (this.cleanupRetiredDevices.has(device)) final = true;
    const cleanupId = crypto.randomUUID();
    const cleanup = {
      session: null, device: remove ? null : { address: device.address, fingerprint: device.fingerprint || device.serverFingerprint },
      deviceRef: device, pin,
      pending: null, drained: true, remoteId, deleteRemote: remove ? () => remove(remoteId) : null, ...this.cleanupState(device, final), silent: final,
    };
    (this.sessionCleanups ||= new Map()).set(cleanupId, cleanup);
    this.cleanupChanged();
    await this.closeSession(cleanupId, this.sessionCleanups, { initial: true }).catch(() => {});
    // A pin-terminal cancellation cannot retain another cleanup attempt.
    if (final) {
      this.disposeCleanup(cleanupId, cleanup, this.sessionCleanups);
    }
  }
  retireIdentity(device, error, pin = device.fingerprint || device.serverFingerprint) {
    if (!IDENTITY_TERMINAL.has(error?.code) || error.status !== undefined || typeof pin !== 'string') return error;
    const previous = this.identityFailures.get(device);
    const failure = previous?.pin === pin ? previous : { pin, error: Object.assign(new Error(IDENTITY_CHANGED_MESSAGE),
      { code: error.code, ...(Number.isInteger(error.status) ? { status: error.status } : {}) }) };
    const matches = value => value === device && (value?.fingerprint || value?.serverFingerprint) === pin;
    // The saved object is replaced by re-pairing. Keep no persisted denial or
    // grant here, and never let an old-pin failure retire a new-pin object.
    if (matches(device)) this.identityFailures.set(device, failure);
    // Drop cleanup notices silently: the delivery/request path already shows
    // the canonical identity error, and this target must never offer Retry.
    for (const [id, cleanup] of this.sessionCleanups || []) if (cleanup.deviceRef === device && cleanup.pin === pin)
      this.disposeCleanup(id, cleanup, this.sessionCleanups);
    for (const [id, target] of this.reconnectTargets) if (this.connections.includes(device) &&
      target.deviceId === device.id && target.fingerprint === pin) {
      this.reconnectTargets.delete(id); this.cancelReconnect(id);
    }
    for (const [id, s] of this.sessions) if (matches(s.device)) {
      s.identityFailure = failure.error; s.closed = true;
      s.inputEpoch = (s.inputEpoch || 0) + 1; s.pendingMove = null; s.frame = null;
      for (const slot of s.frameSlots?.values() || []) { slot.frame = null; slot.cache = null; }
      this.sessions.delete(id); this.endedSessions.set(id, IDENTITY_CHANGED_MESSAGE);
      if (this.endedSessions.size > 64) this.endedSessions.delete(this.endedSessions.keys().next().value);
      for (const entry of this.videoStreams.entries.values()) if (entry.session === s)
        this.videoStreams.finish(entry, { state: 'ended', code: failure.error.code, error: IDENTITY_CHANGED_MESSAGE });
      this.videoStreams.onTerminal(id, IDENTITY_CHANGED_MESSAGE);
    }
    return failure.error;
  }
  async enqueueInput(id, session, input) {
    if (session.releasePending && session.overflowRelease) throw new Error('The connection is too slow for control. Input was released; reconnect before continuing.');
    // Control re-enabled while a normal release is still in flight: wait for it, so this input follows the release in
    // order instead of failing (which turned control off again in the viewer).
    while (session.releasePending) {
      await session.releasePending.catch(() => {});
      this.assertSession(id, session);
    }
    if (input.kind === 'pointerMove' && session.pendingMove) {
      session.pendingMove.input = input;
      return session.pendingMove.promise;
    }
    if ((session.pendingInputCount || 0) >= 64) {
      session.overflowRelease = true;
      try { await this.invoke('session.release-inputs', { sessionId: id }); } finally { session.overflowRelease = false; }
      throw new Error('The connection is too slow for control. Input was released; reconnect before continuing.');
    }
    const item = { input, epoch: session.inputEpoch || 0, promise: null };
    session.pendingInputCount = (session.pendingInputCount || 0) + 1;
    if (session.canInputBatch) {
      item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
      (session.inputPending ||= []).push(item);
      this.scheduleInputBatch(id, session);
    } else {
      session.inputQueue = (session.inputQueue || Promise.resolve()).catch(() => {}).then(async () => {
        if (session.pendingMove === item) session.pendingMove = null;
        if (session.closed || (session.inputEpoch || 0) !== item.epoch || this.sessions.get(id) !== session) return;
        await this.remote(session.device, '/api/sessions/' + encodeURIComponent(session.remoteId) + '/input', { method: 'POST', body: item.input });
      }).finally(() => { session.pendingInputCount--; });
      item.promise = session.inputQueue;
    }
    session.pendingMove = input.kind === 'pointerMove' ? item : null;
    return item.promise;
  }
  // One request in flight; everything queued behind it leaves as one ordered batch when it returns.
  scheduleInputBatch(id, session) {
    if (session.inputBatchScheduled) return;
    session.inputBatchScheduled = true;
    session.inputQueue = (session.inputQueue || Promise.resolve()).catch(() => {}).then(() => this.sendInputBatch(id, session));
  }
  async sendInputBatch(id, session) {
    session.inputBatchScheduled = false;
    const items = session.inputPending.splice(0, this.inputBatchLimit);
    if (items.includes(session.pendingMove)) session.pendingMove = null;
    if (session.inputPending.length) this.scheduleInputBatch(id, session);
    const current = !session.closed && this.sessions.get(id) === session;
    const live = current ? items.filter(item => item.epoch === (session.inputEpoch || 0)) : [];
    for (const item of items) if (!live.includes(item)) { session.pendingInputCount--; item.resolve(); }
    if (!live.length) return;
    let failure;
    try {
      await this.remote(session.device, '/api/sessions/' + encodeURIComponent(session.remoteId) + '/input',
        { method: 'POST', body: live.length === 1 ? live[0].input : { events: live.map(item => item.input) } });
    } catch (error) { failure = error; }
    for (const item of live) { session.pendingInputCount--; if (failure) item.reject(failure); else item.resolve(); }
  }
  getDevice(id) {
    const device = this.connections.find(d => d.id === id);
    if (!device) throw new Error('Device is not paired.');
    return device;
  }
  async remote(device, route, options, bindCleanup, assertCurrent) {
    const pin = device.fingerprint || device.serverFingerprint;
    const epoch = this.identityFailures.get(device);
    if (epoch && epoch.pin === pin) throw epoch.error;
    const identity = await this.getIdentity();
    const target = { address: device.address, fingerprint: device.fingerprint || device.serverFingerprint };
    const failure = this.identityFailures.get(device);
    if (failure !== epoch && failure?.pin === target.fingerprint) throw failure.error;
    assertCurrent?.();
    // A cancelled in-flight creation can be deleted with its original pin and
    // client identity, even after the local host or saved pairing changes.
    bindCleanup?.(id => this.requestRemote(target, identity, '/api/sessions/' + encodeURIComponent(id), { method: 'DELETE' }, this.allowLoopback), target.fingerprint);
    let result;
    try { result = await this.requestRemote(target, identity, route, options, this.allowLoopback); }
    catch (error) { throw this.retireIdentity(device, error, target.fingerprint); }
    const current = this.identityFailures.get(device);
    // Creation results must reach the caller's cancellation cleanup with their
    // remote ID; other late data must never reach a retired session or a file.
    if (route !== '/api/sessions' && current !== epoch && current?.pin === target.fingerprint) throw current.error;
    assertCurrent?.();
    return result;
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
          // Machine-readable host state; absent from older hosts, so the renderer keeps a text fallback.
          ...(typeof transport.state === 'string' ? { state: transport.state } : {}),
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
        fileTransferRoot: raw.settings?.fileTransferRoot || '', listenPort: raw.remoteAddress ? remotePort(raw.remoteAddress) : undefined,
        startAtLogin: !!nativeSettings.startAtLogin, startAtLoginSupported: !!nativeSettings.startAtLoginSupported,
      },
      sessions: [...(raw.sessions || []).map(({ resumeEpoch: _resumeEpoch, ...s }) => ({ ...s, startedAt: s.createdAt, direction: 'incoming' })),
        ...[...this.sessions.entries()].filter(([, s]) => !s.closed).map(([id, s]) => ({ id,
          deviceId: s.device.id, deviceName: s.device.name, startedAt: s.startedAt, direction: 'outgoing', sessionGeneration: s.sessionGeneration ?? 0 }))],
      limitations: platform.limitations || [], sessionState: platform.sessionState,
      diagnostics: { transport: transport.mode, remoteEnabled: raw.remoteEnabled, startedAt: raw.startedAt },
    };
  }
  async devices() {
    const incoming = await this.local('peers');
    const peers = Array.isArray(incoming) ? incoming : incoming.devices || incoming.peers || [];
    return { devices: [
      ...this.connections.map(d => ({ ...d, direction: 'outgoing', online: d.online ?? null,
        status: d.revoked === true ? 'revoked' : d.online === true ? 'online' : d.online === false ? 'offline' : 'unknown' })),
      ...peers.filter(p => !p.revokedAt).map(p => ({ id: p.id, name: p.name, platform: 'unknown',
        direction: 'incoming', online: null, status: 'authorized', permissions: p.permissions,
        blockedByOwner: p.blockedByOwner === true, fingerprint: p.fingerprint, pairedAt: p.createdAt })),
    ] };
  }
  async invoke(action, payload = {}, assertCurrent = () => {}) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid application request.');
    switch (action) {
      case 'status': return this.status();
      case 'host.disconnect-all': await this.local('disconnect-all', 'POST'); return { ok: true };
      case 'device.block':
      case 'device.allow': {
        const id = payload.deviceId;
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid paired device.');
        const peer = await this.local('peers/' + encodeURIComponent(id) + (action === 'device.allow' ? '/allow' : '/block'), 'POST');
        if (action === 'device.block') return { ok: true };
        return { id: peer.id, name: peer.name, platform: 'unknown', direction: 'incoming', online: null,
          status: 'authorized', permissions: peer.permissions, blockedByOwner: peer.blockedByOwner === true,
          fingerprint: peer.fingerprint, pairedAt: peer.createdAt };
      }
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
        const info = result.json || {};
        const device = { id: peerData.deviceId(info.hostId),
          name: peerData.displayText(info.hostName) || peerData.displayText(invite.hostName) || 'Remote device', platform: 'unknown',
          address: invite.address, fingerprint: invite.fingerprint, serverFingerprint: invite.fingerprint,
          permissions: peerData.permissions(info.permissions), pairedAt: new Date().toISOString(), online: true };
        if (!device.id) throw new Error('Device returned an invalid identity.');
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
            delete device.revoked; delete device.statusReason;
            const operatingSystem = info.platform?.operatingSystem || info.operatingSystem;
            if (operatingSystem) device.platform = peerData.platformName(operatingSystem);
            device.name = peerData.displayText(info.hostName) || device.name;
            // The host reports this pairing's current grants; reflect host-side permission changes.
            const granted = peerData.permissions(info.permissions);
            if (granted) device.permissions = granted;
            device.lastSeen = new Date().toISOString();
          } catch (error) {
            device.online = false;
            // 401 means the host no longer recognizes this certificate: revoked, not unreachable.
            if (error.status === 401) { device.revoked = true; device.statusReason = 'Access revoked by the host.'; }
            else { delete device.revoked; delete device.statusReason; }
          }
        }));
        await this.save();
        return this.devices();
      }
      case 'session.start': {
        const device = this.getDevice(payload.deviceId);
        assertCurrent();
        // A failed Forget can leave the saved device available. A new explicit
        // connection permits cleanup again; automatic callbacks never clear it.
        this.cleanupRetiredDevices.delete(device);
        const pin = device.fingerprint || device.serverFingerprint, epoch = this.identityFailures.get(device);
        const current = () => {
          const failure = this.identityFailures.get(device);
          if (failure !== epoch && failure?.pin === pin) throw failure.error;
          assertCurrent();
        };
        current();
        const info = (await this.remote(device, '/api/info')).json;
        current();
        const monitors = peerData.monitors(info?.platform?.monitors || info?.monitors);
        if (payload.monitorId && (typeof payload.monitorId !== 'string' || !monitors.some(m => m.id === payload.monitorId)))
          throw new Error('The selected remote monitor is no longer available. Choose a display and connect again.');
        let deleteCreated, createdPin = pin;
        const created = await this.remote(device, '/api/sessions', { method: 'POST', body: {
          monitorId: payload.monitorId || null, viewOnly: payload.viewOnly === true,
        } }, (cleanup, cleanupPin) => { deleteCreated = cleanup; createdPin = cleanupPin; });
        const result = created.json || {};
        const remoteId = result.id || result.sessionId;
        if (typeof remoteId !== 'string' || !remoteId || remoteId.length > 128) throw new Error('Device did not create a session.');
        const granted = peerData.permissions(result.permissions);
        try { current(); } catch (error) {
          await this.cleanupCreated(device, remoteId, deleteCreated, IDENTITY_TERMINAL.has(error?.code), createdPin);
          throw error;
        }
        const localId = crypto.randomUUID();
        // Hosts advertise raw-frame features only when they can honor them (Windows today).
        // Mac/Linux omit them and keep receiving full-scale, unconditional PNG frames.
        this.sessions.set(localId, { device, remoteId, remotePin: createdPin, deleteRemote: deleteCreated, monitors, monitorId: payload.monitorId || null,
          canScaleFrames: info.platform?.canScaleFrames === true, canConditionalFrames: info.platform?.canConditionalFrames === true,
          canJpegFrames: info.platform?.canJpegFrames === true,
          canLocalCursor: info.platform?.canLocalCursor === true, canInputBatch: info.platform?.canInputBatch === true,
          resumeEpoch: typeof result.resumeEpoch === 'string' && result.resumeEpoch.length <= 128 ? result.resumeEpoch : null,
          permissions: granted || device.permissions, viewOnly: payload.viewOnly === true,
          canWakeDisplay: result.canWakeDisplay === true,
          startedAt: new Date().toISOString(), frame: null, frameSlots: new Map(), renewPending: null, inputQueue: Promise.resolve(),
          closed: false, sessionGeneration: 0, inputEpoch: 0, pendingInputCount: 0, pendingMove: null, inputPending: [] });
        return { sessionId: localId, sessionGeneration: 0, deviceId: device.id, permissions: granted || device.permissions, monitors, link: created.link,
          availability: this.availability(localId),
          canScaleFrames: info.platform?.canScaleFrames === true, canConditionalFrames: info.platform?.canConditionalFrames === true,
          canJpegFrames: info.platform?.canJpegFrames === true, canLocalCursor: info.platform?.canLocalCursor === true };
      }
      case 'session.reconnect': {
        const id = payload.sessionId;
        if (this.reconnectPending.has(id)) throw new Error('Reconnect is already in progress.');
        if (!this.canReconnect(id)) throw new Error('Reconnect is unavailable. Choose the saved device and connect explicitly.');
        const target = this.reconnectTargets.get(id);
        const monitorId = Object.hasOwn(payload, 'monitorId') ? payload.monitorId || null : target.monitorId;
        if (monitorId !== null && (typeof monitorId !== 'string' || monitorId.length > 512)) throw new Error('Invalid remote monitor.');
        const device = this.getDevice(target.deviceId), generation = this.localGeneration;
        const operation = { cancelled: false, deviceId: target.deviceId, promise: null };
        const current = () => {
          if (operation.cancelled || this.reconnectPending.get(id) !== operation || this.localGeneration !== generation)
            throw new Error('Reconnect cancelled. Connect again explicitly.');
          const saved = this.connections.find(value => value.id === target.deviceId);
          if (saved !== device || saved.revoked || (saved.fingerprint || saved.serverFingerprint) !== target.fingerprint)
            throw new Error('The paired identity changed. Connect again explicitly after checking the device.');
        };
        this.reconnectPending.set(id, operation);
        operation.promise = (async () => {
          current();
          const started = await this.invoke('session.start', { deviceId: target.deviceId, viewOnly: target.viewOnly, monitorId }, current);
          try { current(); } catch (error) { await this.closeSession(started.sessionId).catch(() => {}); throw error; }
          const session = this.getSession(started);
          const monitor = monitorId ? session.monitors.find(value => value.id === monitorId) : session.monitors.find(value => value.primary) || session.monitors[0];
          this.reconnectTargets.delete(id);
          return { session: { ...started, device: { id: session.device.id, name: session.device.name, platform: session.device.platform, direction: 'outgoing' }, viewOnly: session.viewOnly }, monitorId: monitor?.id || '', independent: true };
        })();
        try { return await operation.promise; } catch (error) {
            if ([401, 403].includes(error.status) || (SECURITY_TERMINAL.has(error.code) &&
              (!IDENTITY_TERMINAL.has(error.code) || error.status === undefined))) this.reconnectTargets.delete(id);
          throw error;
        } finally { if (this.reconnectPending.get(id) === operation) this.reconnectPending.delete(id); }
      }
      case 'session.monitors': {
        const s = this.getSession(payload);
        return { monitors: s.monitors };
      }
      case 'session.wake-display': {
        if (Object.keys(payload).length !== 1 || typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 128)
          throw new Error('Invalid display wake request.');
        const s = this.getSession(payload), device = s.device, remoteId = s.remoteId, generation = s.sessionGeneration ?? 0,
          pin = device.fingerprint || device.serverFingerprint, localGeneration = this.localGeneration;
        const current = () => {
          assertCurrent();
          this.assertSession(payload.sessionId, s);
          if (this.localGeneration !== localGeneration || s.remoteId !== remoteId || (s.sessionGeneration ?? 0) !== generation || s.renewPending
            || this.connections.find(value => value.id === device.id) !== device || device.revoked
            || (device.fingerprint || device.serverFingerprint) !== pin || (s.remotePin && s.remotePin !== pin))
            throw Object.assign(new Error('The screen changed before display wake completed.'), { code: 'wake_cancelled' });
          if (s.viewOnly !== false || s.permissions?.view !== true || s.permissions?.control !== true)
            throw Object.assign(new Error('Control permission is required to request display wake.'), { code: 'wake_not_permitted' });
          if (s.canWakeDisplay !== true)
            throw Object.assign(new Error('Display wake is unavailable for this session.'), { status: 409, code: 'wake_unsupported' });
        };
        current();
        let result;
        try {
          result = await this.remote(device, '/api/sessions/' + encodeURIComponent(remoteId) + '/wake-display',
            { method: 'POST', headers: { 'content-length': '0' } }, undefined, current);
        } catch (error) {
          // Local TLS identity failures already quarantine this pairing and can
          // remove the session themselves. Preserve that authoritative cause.
          if (error.status === undefined && IDENTITY_TERMINAL.has(error.code)) throw error;
          // Protected renewal mutates the same session object. An old request
          // must not retire it, or forward stale denial/feedback as if from G1.
          current();
          if ([401, 403, 410].includes(error.status) && this.sessions.get(payload.sessionId) === s) {
            if (error.status !== 410) { this.reconnectTargets.delete(payload.sessionId); this.cancelReconnect(payload.sessionId); }
            const reason = String(error.message || 'This session has ended. Connect again explicitly.').slice(0, 500);
            this.endedSessions.set(payload.sessionId, reason);
            if (this.endedSessions.size > 64) this.endedSessions.delete(this.endedSessions.keys().next().value);
            s.closed = true; s.inputEpoch = (s.inputEpoch || 0) + 1; s.pendingMove = null; s.frame = null;
            for (const slot of s.frameSlots.values()) { slot.frame = null; slot.cache = null; slot.deliveryToken = {}; }
            this.sessions.delete(payload.sessionId);
            for (const entry of this.videoStreams.entries.values()) if (entry.session === s)
              this.videoStreams.finish(entry, { state: 'ended', code: streamErrorPolicy(error).terminal, error: reason });
            this.videoStreams.onTerminal(payload.sessionId, reason);
          }
          throw error;
        }
        current();
        if (result.status !== 202 || result.json?.state !== 'requested') throw new Error('The device did not acknowledge the display wake request.');
        return { state: 'requested' };
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
        const requestedScale = frameScale(payload.scale); // Validates even when the host cannot scale.
        const scale = s.canScaleFrames ? requestedScale : 1;
        const { format, quality } = frameEncoding(payload, s.canJpegFrames);
        const encodingKey = `${scale}:${format}:${quality}`;
        // An idle reply normally sends metadata alone. A newly mounted viewer or
        // changed monitor asks for the cached image explicitly. Apply this per
        // caller after coalescing, so two windows cannot lose their first image.
        const deliver = frame => frame.unchanged && payload.includeImage !== true ? { ...frame, data: undefined } : frame;
        const key = requestedMonitor || '';
        const slots = s.frameSlots ||= new Map();
        const slot = slots.get(key) || { frame: null, pending: null, cache: null };
        slots.set(key, slot);
        const deliveryToken = slot.deliveryToken;
        const assertDelivery = (asleepResult = false) => {
          if (s.identityFailure) throw s.identityFailure;
          this.assertSession(payload.sessionId, s);
          // A current asleep reply publishes no image or geometry. Other sleep
          // reports may retire its token without erasing that typed result.
          if (slot.deliveryToken !== deliveryToken && !(asleepResult && s.displayAsleepGeneration === (s.sessionGeneration ?? 0)))
            throw new Error('Screen delivery changed. Wait for a fresh screen.');
        };
        const deliverCurrent = frame => {
          assertDelivery();
          if (frame.sessionGeneration !== (s.sessionGeneration ?? 0)) throw new Error('The session reconnected. Wait for a fresh screen.');
          this.reconnectTargets.delete(payload.sessionId);
          return deliver({ ...frame, availability: this.availability(payload.sessionId, s) });
        };
        if (slot.pending) {
          if (slot.pendingKey === encodingKey) return slot.pending.then(deliverCurrent);
          const pendingRemoteId = s.remoteId, pendingGeneration = s.sessionGeneration ?? 0;
          await slot.pending.catch(error => {
            if (!isDisplayAsleep(error)) return;
            if (s.identityFailure) throw s.identityFailure;
            this.assertSession(payload.sessionId, s);
            if (s.remoteId !== pendingRemoteId || (s.sessionGeneration ?? 0) !== pendingGeneration || s.renewPending
              || error.availability?.sessionId !== payload.sessionId || error.availability.sessionGeneration !== pendingGeneration)
              throw new Error('The session reconnected. Wait for a fresh screen.');
            assertDelivery(true);
            throw error;
          });
          assertDelivery();
          return this.invoke('session.frame', payload);
        }
        if (slot.cache && slot.cache.encodingKey !== encodingKey) slot.cache = null;
        slot.pendingKey = encodingKey;
        slot.pending = (async () => {
          const renewSession = async failedId => {
            assertDelivery();
            if (s.renewPending) { await s.renewPending; assertDelivery(); return; }
            if (s.remoteId !== failedId) return;
            if (!s.resumeEpoch) throw Object.assign(new Error('This host cannot safely resume this session. Connect again explicitly.'), { status: 410 });
            const renewal = (async () => {
              s.inputEpoch = (s.inputEpoch || 0) + 1;
              s.pendingMove = null;
              s.frame = null;
              for (const entry of slots.values()) { entry.frame = null; entry.cache = null; }
              await (s.inputQueue || Promise.resolve()).catch(() => {});
              assertDelivery();
              const generation = s.sessionGeneration ?? 0;
              if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER)
                throw Object.assign(new Error('This host cannot safely resume this session. Connect again explicitly.'), { status: 410 });
              let deleteRenewed;
              let renewedPin = s.device.fingerprint || s.device.serverFingerprint;
              const replacement = (await this.remote(s.device, '/api/sessions', { method: 'POST', body: {
                monitorId: s.monitorId, viewOnly: s.viewOnly, resumeEpoch: s.resumeEpoch,
              } }, (cleanup, cleanupPin) => { deleteRenewed = cleanup; renewedPin = cleanupPin; })).json;
              if (!(replacement.id || replacement.sessionId)) throw new Error('Device did not renew the session.');
              if (s.identityFailure) {
                await this.cleanupCreated(s.device, replacement.id || replacement.sessionId, deleteRenewed, true, renewedPin);
                throw s.identityFailure;
              }
              // Record a late response even after disconnect so session.end can delete it.
              s.remoteId = replacement.id || replacement.sessionId;
              s.remotePin = renewedPin;
              s.deleteRemote = deleteRenewed;
              s.sessionGeneration = generation + 1;
              this.reconnectTargets.delete(payload.sessionId);
              s.permissions = replacement.permissions || {};
              s.canWakeDisplay = replacement.canWakeDisplay === true;
              s.resumeEpoch = typeof replacement.resumeEpoch === 'string' && replacement.resumeEpoch.length <= 128 ? replacement.resumeEpoch : null;
              assertDelivery();
            })();
            s.renewPending = renewal;
            try { await renewal; assertDelivery(); } finally { if (s.renewPending === renewal) s.renewPending = null; }
          };
          if (s.renewPending) await s.renewPending;
          assertDelivery();
          const failedId = s.remoteId;
          let capturedId, capturedGeneration;
          let sentTag = null;
          const assertAsleepDelivery = () => {
            if (s.identityFailure) throw s.identityFailure;
            this.assertSession(payload.sessionId, s);
            if (capturedId !== s.remoteId || capturedGeneration !== (s.sessionGeneration ?? 0) || s.renewPending)
              throw new Error('The session reconnected. Wait for a fresh screen.');
            assertDelivery(true);
          };
          const capture = async () => {
            assertDelivery();
            capturedId = s.remoteId;
            capturedGeneration = s.sessionGeneration ?? 0;
            const query = new URLSearchParams();
            if (requestedMonitor) query.set('monitorId', requestedMonitor);
            if (scale < 1) query.set('scale', String(scale));
            if (format === 'jpeg') { query.set('format', format); query.set('quality', String(quality)); }
            // Revalidate only this slot's own image, from this exact remote session and scale.
            const cache = slot.cache;
            sentTag = s.canConditionalFrames && cache && cache.remoteId === capturedId && cache.resumeEpoch === s.resumeEpoch &&
              cache.encodingKey === encodingKey ? cache.etag : null;
            const search = query.toString();
            try {
              return await this.remote(s.device, '/api/sessions/' + encodeURIComponent(capturedId) + '/frame' + (search ? '?' + search : ''),
                { maxBytes: 24 * 1024 * 1024, ...(sentTag ? { headers: { 'if-none-match': sentTag } } : {}) });
            } catch (error) {
              if (isDisplayAsleep(error)) {
                assertAsleepDelivery();
                throw Object.assign(new Error(DISPLAY_ASLEEP_MESSAGE), { status: 409, code: 'display_asleep', displayState: 'off',
                  availability: this.availability(payload.sessionId, s) });
              }
              throw error;
            }
          };
          let frame;
          try {
            frame = await capture();
            assertDelivery();
          } catch (error) {
            if (isDisplayAsleep(error)) assertAsleepDelivery();
            else assertDelivery();
            if (error.status !== 404) throw error;
            // A service restart or expired idle session requires fresh server-side authorization.
            // A revoked identity receives 401 and can never be renewed through this path.
            await renewSession(failedId);
            assertDelivery();
            frame = await capture();
            assertDelivery();
          }
          assertDelivery();
          if (capturedId !== s.remoteId || s.renewPending) throw new Error('The session reconnected. Wait for a fresh screen.');
          const headers = frame.headers || {};
          const number = (name, fallback = 0) => Number(headers[name] ?? fallback);
          if (frame.status === 304) {
            const cache = slot.cache;
            // Only an answer to the exact validator sent for this slot can reuse its pixels and geometry.
            const echoed = headers.etag === undefined || headers.etag === sentTag;
            const sameGeometry = !cache || ['width', 'height', 'left', 'top'].every(name =>
              headers['x-orbit-' + name] === undefined || number('x-orbit-' + name) === cache.frame[name]);
            if (!sentTag || !cache || cache.etag !== sentTag || !echoed || !sameGeometry) {
              slot.cache = null;
              throw Object.assign(new Error('The device sent an unexpected unchanged-screen reply. Wait for a fresh screen.'), { status: 304 });
            }
            slot.frame = cache.frame;
            if (requestedMonitor === (s.monitorId || null)) s.frame = slot.frame;
            return { ...cache.frame, encodedWidth: cache.encodedWidth, encodedHeight: cache.encodedHeight, scale: cache.scale,
              data: cache.data, contentType: cache.contentType, link: frame.link, unchanged: true, bytes: 0, sessionGeneration: s.sessionGeneration ?? 0 };
          }
          slot.frame = { width: number('x-orbit-width'), height: number('x-orbit-height'),
            left: number('x-orbit-left'), top: number('x-orbit-top') };
          if (requestedMonitor === (s.monitorId || null)) s.frame = slot.frame;
          const encodedWidth = positive(headers['x-orbit-encoded-width']) ?? slot.frame.width;
          const encodedHeight = positive(headers['x-orbit-encoded-height']) ?? slot.frame.height;
          const reportedScale = Number(headers['x-orbit-scale']);
          const actualScale = Number.isFinite(reportedScale) && reportedScale > 0 && reportedScale <= 1 ? reportedScale : 1;
          const buffer = frame.buffer || Buffer.alloc(0);
          const contentType = String(headers['content-type'] || 'image/png').split(';')[0].trim().toLowerCase();
          if (!['image/png', 'image/jpeg'].includes(contentType)) throw new Error('The device sent an unsupported frame image type.');
          if (contentType === 'image/jpeg' && format !== 'jpeg') throw new Error('The device sent a JPEG frame without negotiation.');
          const etag = s.canConditionalFrames && isValidator(headers.etag) ? headers.etag : null;
          slot.cache = etag ? { etag, scale: actualScale, encodingKey, remoteId: capturedId, resumeEpoch: s.resumeEpoch, frame: slot.frame,
            encodedWidth, encodedHeight, data: buffer, contentType } : null;
          return { ...slot.frame, encodedWidth, encodedHeight, scale: actualScale, data: buffer, contentType, link: frame.link,
            unchanged: false, bytes: buffer.length, sessionGeneration: s.sessionGeneration ?? 0 };
        })();
        try { return deliverCurrent(await slot.pending); }
        catch (error) {
          // Any failure (401 revocation, 410 host stop, network) forgets this slot's validator.
          slot.cache = null;
          if (isDisplayAsleep(error)) {
            if (s.identityFailure) throw s.identityFailure;
            this.assertSession(payload.sessionId, s);
            if (error.availability?.sessionGeneration !== (s.sessionGeneration ?? 0)) throw new Error('The session reconnected. Wait for a fresh screen.');
            this.noteDisplayAsleep(payload.sessionId, s);
          }
          if ([401, 403, 410].includes(error.status)) {
            if (error.status !== 410) { this.reconnectTargets.delete(payload.sessionId); this.cancelReconnect(payload.sessionId); }
            this.endedSessions.set(payload.sessionId, String(error.message || 'Session ended by host. Connect again explicitly.').slice(0, 500));
            if (this.endedSessions.size > 64) this.endedSessions.delete(this.endedSessions.keys().next().value);
            s.closed = true;
            s.inputEpoch = (s.inputEpoch || 0) + 1;
            s.pendingMove = null;
            s.frame = null;
            for (const entry of slots.values()) { entry.frame = null; entry.cache = null; }
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
        this.cancelReconnect(payload.sessionId);
        this.reconnectTargets.delete(payload.sessionId);
        return this.closeSession(payload.sessionId);
      }
      case 'session.cleanup.list': return this.cleanupList();
      case 'session.cleanup.retry': return this.retryCleanup(payload.cleanupId);
      case 'clipboard.read':
      case 'clipboard.write': {
        const s = this.getSession(payload);
        const writing = action === 'clipboard.write';
        const result = await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/clipboard', {
          method: writing ? 'PUT' : 'GET', ...(writing ? { body: { text: String(payload.text || '') } } : {}),
        });
        // Clipboard text is the remote user's content and keeps its characters; only its type is checked.
        if (!writing) return { text: typeof result.json?.text === 'string' ? result.json.text : '' };
        return { ok: true };
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
        // Names with bidi, format or control characters are refused, so a listed
        // "invoice<RLO>fdp.exe" is never shown or saved as "invoiceexe.pdf".
        const entries = peerData.fileEntries(result).map(f => ({ ...f, path: f.name, isDirectory: false }));
        // Remember listed sizes so a download can scale its deadline and refuse oversize files up front.
        s.fileSizes = new Map(entries.filter(f => typeof f.name === 'string' && Number.isFinite(f.size)).map(f => [f.name, f.size]));
        return { entries, path: '/' };
      }
      case 'files.upload': {
        const s = this.getSession(payload);
        const selection = await this.native.openFile?.();
        if (!selection) return { cancelled: true };
        const stat = await fs.stat(selection);
        if (!stat.isFile()) throw new Error('Choose a file, not a folder.');
        if (stat.size > MAX_TRANSFER_BYTES) throw new Error(tooLarge(path.basename(selection)));
        const data = await fs.readFile(selection);
        return (await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/files/' +
          encodeURIComponent(path.basename(selection)), { method: 'PUT', body: data,
          timeout: transferDeadline(data.length), idleTimeout: TRANSFER_IDLE_MS })).json || { ok: true };
      }
      case 'files.download': {
        const s = this.getSession(payload);
        const name = payload.name;
        if (!peerData.isSafeFileName(name) || name !== path.basename(name)) throw new Error('Invalid file name.');
        const listedSize = s.fileSizes?.get(name);
        if (listedSize > MAX_TRANSFER_BYTES) throw new Error(tooLarge(name));
        const destination = await this.native.saveFile?.(name);
        if (!destination) return { cancelled: true };
        // Unknown size (not listed this session): budget for the largest file the host will serve.
        const result = await this.remote(s.device, '/api/sessions/' + encodeURIComponent(s.remoteId) + '/files/' + encodeURIComponent(name), {
          maxBytes: MAX_TRANSFER_BYTES, tooLargeMessage: tooLarge(name),
          timeout: transferDeadline(listedSize ?? MAX_TRANSFER_BYTES), idleTimeout: TRANSFER_IDLE_MS });
        await fs.writeFile(destination, result.buffer, { mode: 0o600 });
        await markDownloaded(destination);
        return { savedPath: destination };
      }
      case 'device.revoke': {
        const id = payload.deviceId || payload.id;
        const cleanupOrigins = this.disposeDeviceCleanups(id);
        try { await this.local('peers/' + encodeURIComponent(id), 'DELETE'); }
        finally { this.disposeDeviceCleanups(id, cleanupOrigins, true); }
        return { ok: true };
      }
      case 'device.forget': {
        const id = payload.deviceId || payload.id;
        for (const operation of this.reconnectPending.values()) if (operation.deviceId === id) operation.cancelled = true;
        for (const [sessionId, target] of this.reconnectTargets) if (target.deviceId === id) this.reconnectTargets.delete(sessionId);
        const cleanupOrigins = this.disposeDeviceCleanups(id);
        try { for (const [sessionId, s] of this.sessions) if (s.device.id === id) await this.invoke('session.end', { sessionId }); }
        finally { this.disposeDeviceCleanups(id, cleanupOrigins, true); }
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
        // The transfer folder is never taken from the renderer: only a folder chosen in the native
        // dialog below is stored. A `fileTransferRoot` in the payload (the renderer echoes status) is ignored.
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
    this.cleanupAutoStopped = true;
    for (const cleanup of this.sessionCleanups.values()) { cleanup.neverAuto = true; this.consumeCleanupRetry(cleanup); }
    for (const operation of this.reconnectPending.values()) operation.cancelled = true;
    this.reconnectTargets.clear();
    this.videoStreams.shutdown();
    await Promise.allSettled([...this.sessions.keys()].map(sessionId => this.invoke('session.end', { sessionId })));
    await Promise.allSettled([...this.reconnectPending.values()].map(operation => operation.promise));
    await this.finishSessionCleanups();
    await this.cleanupReset;
    this.identity = null;
  }
}
module.exports = { OrbitController };
