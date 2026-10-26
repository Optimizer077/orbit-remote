'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const actions = new Set([
  'status', 'devices', 'app.open-project', 'invite.create', 'pair', 'session.start', 'session.frame',
  'session.input', 'session.release-inputs', 'session.end', 'session.monitors', 'session.lock', 'session.restart',
  'clipboard.read', 'clipboard.write', 'clipboard.local.write', 'files.list', 'files.upload', 'files.download',
  'device.revoke', 'device.forget', 'audit', 'settings.update', 'network.refresh', 'host.disconnect-all',
  'viewer.open', 'viewer.context', 'viewer.close',
]);
contextBridge.exposeInMainWorld('orbit', Object.freeze({
  invoke(action, payload) {
    if (!actions.has(action)) return Promise.reject(new Error('Unknown application action.'));
    return ipcRenderer.invoke('orbit:invoke', action, payload);
  },
  onIncomingChanged(callback) {
    if (typeof callback !== 'function') throw new Error('Expected a session-change callback.');
    const listener = () => callback();
    ipcRenderer.on('orbit:incoming-changed', listener);
    return () => ipcRenderer.removeListener('orbit:incoming-changed', listener);
  },
}));
