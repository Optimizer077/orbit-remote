'use strict';
const fs = require('node:fs');

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const RETRY_WINDOW = 10 * 60 * 1000;
const HEALTHY_RESET = 5 * 60 * 1000;

// Time is supplied explicitly so recovery policy can be tested without a child,
// network changes, or waiting. A healthy response alone never erases the budget.
// Crashes, timeouts and confirmed network changes share the same restart budget.
class HostSupervisor {
  constructor() { this.retry(0); }
  retry(now) {
    this.attempts = []; this.healthySince = null; this.lastHealthyAt = null;
    this.value = { state: 'starting', reason: null, restartsLeft: 6, nextRetryAt: null };
    return this.snapshot();
  }
  failedHealth() { this.healthySince = null; this.lastHealthyAt = null; }
  started() { this.failedHealth(); this.value.state = 'starting'; this.value.nextRetryAt = null; }
  stopping(reason) { this.failedHealth(); this.value.state = 'reconnecting'; this.value.reason = reason; this.value.nextRetryAt = null; }
  healthy(now, remoteEnabled) {
    if (this.value.state === 'stopped') return this.snapshot();
    if (this.lastHealthyAt === null || now - this.lastHealthyAt > 10000) this.healthySince = now;
    this.lastHealthyAt = now;
    if (now - this.healthySince >= HEALTHY_RESET) this.attempts = [];
    this.value = { state: remoteEnabled ? 'running' : 'offline', reason: remoteEnabled ? null : 'Tailscale remote access is unavailable.',
      restartsLeft: Math.max(0, 6 - this.attempts.length), nextRetryAt: null };
    return this.snapshot();
  }
  exited(now, reason = 'The background host stopped.') {
    this.failedHealth();
    this.attempts = this.attempts.filter(at => now - at < RETRY_WINDOW);
    if (this.attempts.length >= 6) {
      this.value = { state: 'stopped', reason, restartsLeft: 0, nextRetryAt: null };
      return null;
    }
    const delay = RETRY_DELAYS[this.attempts.length];
    this.attempts.push(now);
    this.value = { state: 'reconnecting', reason, restartsLeft: 6 - this.attempts.length, nextRetryAt: new Date(now + delay).toISOString() };
    return delay;
  }
  snapshot() { return { ...this.value }; }
  // 'offline' is a healthy host without remote listening (Tailscale was off at
  // start). Only a fresh host start looks for Tailscale again, so the owner may
  // ask for one. A running host is never restarted from the UI.
  canRetry() { return ['stopped', 'reconnecting', 'offline'].includes(this.value.state); }
}

// The single local step a permitted Retry takes: stop a live child so the exit
// handler starts a fresh one, mark a child that is already stopping, or start
// a new child when none is alive. No step grants or changes any permission.
function retryStep(allowed, child) {
  if (!allowed) return 'none';
  if (child && child.exitCode === null) return child.orbitStopping ? 'mark' : 'stop';
  return 'start';
}

const MANUAL_RESTART_INTERVAL = 10000;

// Why a UI-requested restart must not happen now, or null when it may. 'offline'
// also covers an expired identity and an identity rotation, where a restart cannot
// help; only a host that truly saw Tailscale off may restart to look again, and
// never while a device is connected to it. Owner restarts are at least 10 s apart.
function retryRefusal({ state, rawStatus, rotationInFlight = false, lastManualAt = null, now }) {
  if (lastManualAt !== null && now - lastManualAt < MANUAL_RESTART_INTERVAL) return 'too_soon';
  if (state !== 'offline') return null;
  if (!rawStatus || typeof rawStatus !== 'object') return 'status_unknown';
  if (rawStatus.identity?.expired === true) return 'identity_expired';
  if (rotationInFlight || rawStatus.transport?.mode !== 'offline') return 'identity_rotating';
  if (Array.isArray(rawStatus.sessions) && rawStatus.sessions.length > 0) return 'sessions_active';
  return null;
}

function tailscaleObservation(value) {
  if (!value || typeof value !== 'object' || typeof value.BackendState !== 'string') return undefined;
  if (['Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState'].includes(value.BackendState)) return null;
  if (value.BackendState !== 'Running' || !Array.isArray(value.Self?.TailscaleIPs)) return undefined;
  return value.Self.TailscaleIPs.find(address => {
    if (typeof address !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
    const octets = address.split('.').map(Number);
    return octets.length === 4 && octets.every(n => n >= 0 && n <= 255) && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  }) ?? null;
}

// Stable list of active incoming pairings (id plus pairing time, so a re-pair
// that keeps its id still counts) from a raw host status, or undefined
// when the status does not carry them (the UI status omits pairedDevices).
// Main compares it on its existing health probe so a new pairing reaches the
// owner window through the existing change signal, without extra polling.
function pairedDevicesSignature(status) {
  if (!Array.isArray(status?.pairedDevices)) return undefined;
  return JSON.stringify(status.pairedDevices.filter(device => device && !device.revokedAt).map(device => String(device.id) + '@' + String(device.createdAt ?? device.pairedAt ?? '')).sort());
}

class NetworkChangeTracker {
  constructor() { this.reset(); }
  reset() { this.pending = undefined; this.count = 0; }
  observe(boundAddress, observedAddress) {
    // undefined means a failed/unparseable probe. Do not treat it as offline.
    if (observedAddress === undefined || observedAddress === boundAddress) { this.reset(); return false; }
    if (this.pending === observedAddress) this.count++; else { this.pending = observedAddress; this.count = 1; }
    return this.count >= 2;
  }
}

class IdentityRotationGuard {
  constructor() { this.inFlight = false; }
  async run(payload, { getStatus, confirm, rotate }) {
    if (payload.confirmRePair !== true || typeof payload.expectedFingerprint !== 'string') throw new Error('Confirm that all devices must pair again.');
    if (this.inFlight) throw new Error('Identity confirmation is already open.');
    this.inFlight = true;
    try {
      const before = await getStatus();
      if (payload.expectedFingerprint !== before.certificateFingerprint) throw new Error('The current identity changed. Review it before trying again.');
      const count = (before.pairedDevices || []).filter(device => !device.revokedAt).length;
      if (!await confirm(count)) return { state: 'cancelled' };
      const current = await getStatus();
      if (payload.expectedFingerprint !== current.certificateFingerprint || count !== (current.pairedDevices || []).filter(device => !device.revokedAt).length)
        throw new Error('The identity or paired devices changed. Review the confirmation again.');
      return await rotate();
    } finally { this.inFlight = false; }
  }
}

// Child output is deliberately bounded: one current file and one backup. Writes
// are synchronous and chunked; disk errors drop diagnostics, never crash main.
class BoundedHostLog {
  constructor(file, limit = 1024 * 1024) {
    this.file = file; this.limit = limit; this.closed = false;
    try {
      for (const candidate of [file, file + '.1']) if (fs.existsSync(candidate) && fs.statSync(candidate).size > limit) fs.truncateSync(candidate, limit);
      this.size = fs.statSync(file).size;
    } catch { this.size = 0; }
  }
  write(chunk) {
    if (this.closed) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    try {
      try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
      for (let offset = 0; offset < data.length;) {
        if (this.size >= this.limit) {
          fs.rmSync(this.file + '.1', { force: true });
          if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + '.1');
          this.size = 0;
        }
        const length = Math.min(this.limit - this.size, data.length - offset);
        fs.appendFileSync(this.file, data.subarray(offset, offset + length), { mode: 0o600 });
        this.size += length; offset += length;
      }
    } catch { /* Logs are optional; no secret or payload is copied elsewhere. */ }
  }
  end() { this.closed = true; }
}

module.exports = { HostSupervisor, NetworkChangeTracker, tailscaleObservation, BoundedHostLog, IdentityRotationGuard, retryStep, retryRefusal, pairedDevicesSignature };
