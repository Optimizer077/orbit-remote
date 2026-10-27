'use strict';

// Only native Electron window state can pause delivery. Renderer focus and
// document visibility are not authorization or native-window visibility signals.
class NativeWindowVisibility {
  constructor(window, { notify, onPause = () => {} }) {
    // Keep the WebContents reference: inside 'closed', window.webContents throws "Object has been destroyed",
    // and a throw there would skip every later 'closed' listener (session and pop-out cleanup).
    this.window = window; this.contents = window.webContents; this.notify = notify; this.onPause = onPause; this.closed = false;
    this.state = { ...this.read(), revision: 0 };
    this.changed = () => this.refresh();
    this.loaded = () => { if (!this.closed) { this.refresh(); this.publish(); } };
    this.disposed = () => this.close();
    for (const event of ['minimize', 'restore', 'hide', 'show']) window.on(event, this.changed);
    window.on('closed', this.disposed);
    this.contents.on('did-finish-load', this.loaded);
  }
  read() {
    if (this.window.isDestroyed()) return { paused: true, reason: 'hidden' };
    if (this.window.isMinimized()) return { paused: true, reason: 'minimized' };
    return this.window.isVisible() ? { paused: false, reason: null } : { paused: true, reason: 'hidden' };
  }
  refresh() {
    if (this.closed) return;
    const next = this.read();
    if (next.paused === this.state.paused && next.reason === this.state.reason) return;
    const wasPaused = this.state.paused;
    this.state = { ...next, revision: this.state.revision + 1 };
    // Notify before closing ports so a renderer can distinguish deliberate pause
    // from an unexpected port failure. Main closes delivery regardless of IPC.
    this.publish();
    if (next.paused && !wasPaused) this.onPause(this.snapshot());
  }
  publish() { try { this.notify(this.snapshot()); } catch { /* A closed renderer cannot prevent main-side pause. */ } }
  snapshot() { return { ...this.state }; }
  current() { this.refresh(); return this.snapshot(); }
  close() {
    if (this.closed) return; this.closed = true;
    for (const event of ['minimize', 'restore', 'hide', 'show']) this.window.removeListener(event, this.changed);
    this.window.removeListener('closed', this.disposed);
    this.contents.removeListener('did-finish-load', this.loaded);
  }
}

// Readiness belongs to a native window, never to another viewer sharing its session.
class OwnerFrameGate {
  constructor() { this.owners = new Map(); }
  capture(owner) { if (!this.owners.has(owner)) this.invalidate(owner); return this.owners.get(owner); }
  // Whole-owner replacement is a native pause/navigation/process lifetime fence.
  invalidate(owner) { this.owners.set(owner, { pending: new Map(), ready: new Map() }); }
  invalidateSession(owner, sessionId) {
    const capture = this.owners.get(owner);
    if (!capture) return;
    // Sleep retires only this session's readiness. Preserve captures retained by
    // unrelated live streams and the independent native-lifetime Wake fence.
    for (const entries of [capture.pending, capture.ready])
      for (const key of entries.keys()) if (JSON.parse(key)[0] === sessionId) entries.delete(key);
  }
  invalidatePendingSession(owner, sessionId) {
    const pending = this.owners.get(owner)?.pending;
    if (!pending) return;
    // Repeated sleep retires in-flight image receipts, without replacing the
    // native lifetime or another already-ready stream sharing this owner.
    for (const key of pending.keys()) if (JSON.parse(key)[0] === sessionId) pending.delete(key);
  }
  forget(owner) { this.owners.delete(owner); }
  tuple(value) {
    const frame = value?.frame;
    if (!value || typeof value.sessionId !== 'string' || typeof value.monitorId !== 'string' ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 || !frame ||
      ![frame.width, frame.height, frame.left ?? 0, frame.top ?? 0].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0) return null;
    return { key: JSON.stringify([value.sessionId, value.monitorId]), value: JSON.stringify([value.sessionId, value.monitorId, value.generation, frame.width, frame.height, frame.left ?? 0, frame.top ?? 0]) };
  }
  issueFrame(owner, capture, sessionId, monitorId, frame) {
    return this.issue(owner, capture, { sessionId, monitorId, generation: frame.sessionGeneration, frame });
  }
  issue(owner, capture, context) {
    const tuple = this.tuple(context);
    if (!tuple || this.owners.get(owner) !== capture) return undefined;
    const token = require('node:crypto').randomUUID();
    capture.pending.set(tuple.key, { token, value: tuple.value });
    if (capture.pending.size > 32) capture.pending.delete(capture.pending.keys().next().value);
    return token;
  }
  acknowledge(owner, token, context) {
    const capture = this.capture(owner), tuple = this.tuple(context), pending = tuple && capture.pending.get(tuple.key);
    if (!pending || pending.token !== token) return false;
    capture.pending.delete(tuple.key);
    if (pending.value !== tuple.value) return false;
    return this.presented(owner, capture, context);
  }
  presented(owner, capture, context) {
    const tuple = this.tuple(context);
    if (!tuple || this.owners.get(owner) !== capture) return false;
    capture.ready.set(tuple.key, tuple.value);
    if (capture.ready.size > 32) capture.ready.delete(capture.ready.keys().next().value);
    return true;
  }
  allows(owner, context) { const tuple = this.tuple(context); return !!tuple && this.capture(owner).ready.get(tuple.key) === tuple.value; }
}

module.exports = { NativeWindowVisibility, OwnerFrameGate };
