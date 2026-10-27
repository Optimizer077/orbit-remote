'use strict';

/** Own-window presentation state. It never changes visibility or session authority. */
class NativeWindowFullscreen {
  constructor(window, notify = () => {}) {
    this.window = window; this.notify = notify; this.closed = false; this.revision = 0;
    this.fullscreen = window.isFullScreen();
    this.changed = () => {
      try { if (!this.closed && !window.isDestroyed()) this.read(); }
      catch { /* Native teardown can race an event; keep the last observed state. */ }
    };
    window.on('enter-full-screen', this.changed); window.on('leave-full-screen', this.changed);
  }
  read() {
    if (this.closed || this.window.isDestroyed() || this.window.webContents.isDestroyed()) throw new Error('This window has closed.');
    const actual = this.window.isFullScreen();
    if (actual !== this.fullscreen) {
      this.fullscreen = actual; this.revision++;
      try { this.notify(this.current()); } catch { /* A closing renderer cannot invalidate native state. */ }
    }
    return this.current();
  }
  current() { return { fullscreen: this.fullscreen, revision: this.revision }; }
  set(fullscreen) {
    this.read();
    if (!this.window.isVisible() || this.window.isMinimized()) throw new Error('Return to this window before changing fullscreen.');
    this.window.setFullScreen(fullscreen);
    // Some platforms finish this asynchronously. Do not present desired state as
    // actual state: only native observation/event can advance the snapshot.
    return this.read();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.window.removeListener('enter-full-screen', this.changed); this.window.removeListener('leave-full-screen', this.changed);
  }
}

function fullscreenRequest(event, action, payload, states, expectedUrl) {
  const entry = states.get(event.sender?.id), window = entry?.window;
  if (!entry || !window || window.isDestroyed() || event.sender.isDestroyed() || window.webContents !== event.sender ||
    event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== expectedUrl)
    throw new Error('Untrusted application window.');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid fullscreen request.');
  const keys = Object.keys(payload);
  if (action === 'window.fullscreen.get') {
    if (keys.length) throw new Error('Fullscreen state takes no arguments.');
    return entry.read();
  }
  if (action !== 'window.fullscreen.set' || keys.length !== 1 || keys[0] !== 'fullscreen' || typeof payload.fullscreen !== 'boolean')
    throw new Error('Choose a boolean fullscreen state for this window.');
  return entry.set(payload.fullscreen);
}

module.exports = { NativeWindowFullscreen, fullscreenRequest };
