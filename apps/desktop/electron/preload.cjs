'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set([
  'status', 'devices', 'app.open-project', 'app.mac-permissions', 'invite.create', 'pair', 'session.start', 'session.frame',
  'session.input', 'session.release-inputs', 'session.end', 'session.monitors', 'session.lock', 'session.restart',
  'clipboard.read', 'clipboard.write', 'clipboard.local.write', 'files.list', 'files.upload', 'files.download',
  'device.revoke', 'device.forget', 'device.block', 'device.allow', 'audit', 'settings.update', 'network.refresh', 'host.disconnect-all',
  'viewer.open', 'viewer.context', 'viewer.close', 'host.runtime', 'host.retry', 'identity.rotate',
  'session.stream.open', 'session.stream.close',
  'session.reconnect', 'session.frame.presented', 'session.wake-display',
  'window.state', 'window.fullscreen.get', 'window.fullscreen.set', 'session.cleanup.list', 'session.cleanup.retry',
]);
// Transfer only the frame-bound port, without exposing Electron's event or IPC
// object to the main world. Main already authenticated this frame and session.
ipcRenderer.on('orbit:video-port', (event, message) => {
  if (event.ports.length !== 1 || typeof message?.requestId !== 'string' || message.requestId.length !== 36) {
    for (const port of event.ports) port.close(); return;
  }
  window.postMessage({ type: 'orbit:video-port', requestId: message.requestId }, '*', event.ports);
});
contextBridge.exposeInMainWorld('orbit', Object.freeze({
  invoke(action, payload) {
    if (!actions.has(action)) return Promise.reject(new Error('Unknown application action.'));
    return ipcRenderer.invoke('orbit:invoke', action, payload);
  },
  onCleanupChanged(callback) {
    if (typeof callback !== 'function') throw new Error('Expected a cleanup-change callback.');
    const listener = (_event, change) => {
      if (Number.isSafeInteger(change?.revision) && change.revision >= 0) callback({ revision: change.revision });
    };
    ipcRenderer.on('orbit:cleanup-changed', listener);
    return () => ipcRenderer.removeListener('orbit:cleanup-changed', listener);
  },
  onIncomingChanged(callback) {
    if (typeof callback !== 'function') throw new Error('Expected a session-change callback.');
    const listener = () => callback();
    ipcRenderer.on('orbit:incoming-changed', listener);
    return () => ipcRenderer.removeListener('orbit:incoming-changed', listener);
  },
  onWindowState(callback) {
    if (typeof callback !== 'function') throw new Error('Expected a window-state callback.');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('orbit:window-state', listener);
    return () => ipcRenderer.removeListener('orbit:window-state', listener);
  },
  onFullscreenState(callback) {
    if (typeof callback !== 'function') throw new Error('Expected a fullscreen-state callback.');
    const listener = (_event, state) => {
      if (typeof state?.fullscreen === 'boolean' && Number.isSafeInteger(state.revision) && state.revision >= 0)
        callback({ fullscreen: state.fullscreen, revision: state.revision });
    };
    ipcRenderer.on('orbit:fullscreen-state', listener);
    return () => ipcRenderer.removeListener('orbit:fullscreen-state', listener);
  },
}));
