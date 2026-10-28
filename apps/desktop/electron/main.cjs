'use strict';
const { app, BrowserWindow, ipcMain, MessageChannelMain, Menu, Tray, nativeImage, dialog, session, clipboard, shell, screen, systemPreferences, desktopCapturer } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { OrbitController } = require('./controller.cjs');
const { streamOpenError, frameRequestError, wakeDisplayError } = require('./stream-session.cjs');
const { IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE } = require('./security-terminal.cjs');
const { NativeWindowVisibility, OwnerFrameGate } = require('./viewer-visibility.cjs');
const { NativeWindowFullscreen, fullscreenRequest } = require('./fullscreen-state.cjs');
const { createMacPermissionSetup } = require('./mac-permissions.cjs');
const { ChildProofAgent, findTailscaleCli } = require('./local-control.cjs');
const { hostEnvironment } = require('./host-environment.cjs');
const { isReleaseBuild, launchDecision, refusalMessage, noSandboxWarning, testSettings } = require('./launch-policy.cjs');
const { HostSupervisor, NetworkChangeTracker, tailscaleObservation, BoundedHostLog, IdentityRotationGuard, retryStep, retryRefusal, pairedDevicesSignature } = require('./host-supervisor.cjs');

let mainWindow, tray, hostProcess, controller, showMacPermissionSetup;
const viewerWindows = new Map();
const windowStates = new Map();
const fullscreenStates = new Map();
const windowInputs = new Map();
const frameGate = new OwnerFrameGate();
const windowReconnects = new Map();
const viewerActions = new Set(['viewer.context', 'viewer.close', 'session.monitors', 'session.frame', 'session.input',
  'session.reconnect', 'session.frame.presented', 'session.wake-display',
  'session.stream.open', 'session.stream.close',
  'session.release-inputs', 'clipboard.read', 'clipboard.write', 'clipboard.local.write', 'files.list', 'files.upload',
  'files.download', 'session.lock', 'session.restart']);
let quitting = false;
let restartTimer, healthTimer, healthBusy = false, lastProbeAt = 0, healthFailures = 0;
let lastIdentity = null, lastUiStatus = null, hostDirectory;
// The last raw host status from the health probe (cleared on each start) and
// the time of the last owner-requested restart, for the Retry guard.
let lastRawStatus = null, lastManualRestartAt = null;
const identityRotation = new IdentityRotationGuard();
const supervisor = new HostSupervisor();
const networkChanges = new NetworkChangeTracker();
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..', '..');
// An installed release ignores test switches from the environment and refuses Chromium debug and
// sandbox switches. The unfused end-to-end test build is marked at package time and keeps both.
const releaseBuild = isReleaseBuild(app.isPackaged, require('../package.json'));
const testing = testSettings(process.env, releaseBuild);
const launch = releaseBuild ? launchDecision({ argv: process.argv, hasSwitch: name => app.commandLine.hasSwitch(name),
  platform: process.platform, environment: process.env }) : { refused: [], warnings: [] };
const refusedLaunch = launch.refused;
const controlPort = testing.controlPort;
const allowLoopback = testing.loopbackTest;
// An installed build never loads its privileged UI from a dev server named by the environment.
const rendererUrl = app.isPackaged ? undefined : process.env.ORBIT_RENDERER_URL;
const isDevUrl = value => {
  try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === '5173'; }
  catch { return false; }
};
if (rendererUrl && !isDevUrl(rendererUrl)) throw new Error('Development renderer must use http://127.0.0.1:5173.');
const entryFile = path.join(appRoot, 'dist', 'index.html');

// A refused launch exits before any window, profile lock or host start.
// Isolate development/tests before Chromium creates caches or acquires its lock.
// Normal launches retain the per-user application directory and single instance.
if (testing.appData && !refusedLaunch.length) app.setPath('userData', path.resolve(testing.appData));
if (refusedLaunch.length) {
  // Visible as well as logged: showErrorBox works before ready (on Linux it writes to stderr instead).
  const refusal = refusalMessage(refusedLaunch);
  console.error(refusal.message);
  dialog.showErrorBox(refusal.title, refusal.message);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(start).catch(async error => {
    const help = app.isPackaged ? 'Check host.log in the Orbit profile, then reinstall the matching package if the native host is missing.' :
      'Build the host with ' + (process.platform === 'win32' ? 'scripts/start-dev.ps1' : 'bash scripts/start-dev.sh') + ' from the project folder.';
    dialog.showErrorBox('Orbit could not start', error.message + '\n\n' + help);
    quitting = true; hostProcess?.kill(); app.quit();
  });
}

function startHost(dataDirectory) {
  supervisor.started(); healthFailures = 0; networkChanges.reset(); lastRawStatus = null;
  controller.clearLocalControl();
  const controlToken = crypto.randomBytes(32).toString('base64url');
  const proofKey = crypto.randomBytes(32).toString('base64url');
  const published = path.join(process.resourcesPath, 'host', process.platform === 'win32' ? 'Orbit.Host.exe' : 'Orbit.Host');
  const development = path.join(workspaceRoot, 'src', 'Orbit.Host', 'bin', 'Debug', 'net10.0', 'Orbit.Host.dll');
  const nativeRuntime = ({ win32: 'win', darwin: 'osx', linux: 'linux' })[process.platform] + '-' + process.arch;
  const release = path.join(workspaceRoot, 'artifacts', 'host', nativeRuntime, 'Orbit.Host.dll');
  const executable = app.isPackaged ? published : 'dotnet';
  const args = app.isPackaged ? [] : [fs.existsSync(development) ? development : release];
  if (!app.isPackaged && !fs.existsSync(args[0])) throw new Error('The native host is not built. Run dotnet build src/Orbit.Host.');
  if (allowLoopback) args.push('--loopback-test');
  const child = spawn(executable, args, {
    cwd: app.isPackaged ? path.dirname(published) : appRoot, windowsHide: true,
    env: hostEnvironment(process.env, { packaged: app.isPackaged, release: releaseBuild, controlToken, dataDirectory: path.join(dataDirectory, 'host'), controlPort }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hostProcess = child;
  child.orbitStartedAt = Date.now();
  const log = new BoundedHostLog(path.join(dataDirectory, 'host.log'));
  child.stdout.on('data', chunk => log.write(chunk)); child.stderr.on('data', chunk => log.write(chunk));
  child.stdin.on('error', () => {});
  if (child.pid) {
    controller.setLocalControl(new ChildProofAgent({ proofKey, pid: child.pid, port: controlPort }), controlToken);
    child.stdin.write(JSON.stringify({ version: 1, proofKey }) + '\n');
  }
  let completed = false;
  const stopped = () => {
    if (completed) return; completed = true;
    if (hostProcess !== child) return;
    controller.clearLocalControl();
    hostProcess = null;
    updateTrayActivity({});
    if (!quitting && !restartTimer) {
      if (child.orbitManualRestart) { startHost(dataDirectory); return; }
      const delay = supervisor.exited(Date.now(), child.orbitRestartReason || 'The background host stopped.');
      notifyRuntimeChanged();
      if (delay !== null) restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!quitting) startHost(dataDirectory);
      }, delay);
    }
  };
  child.once('error', () => { log.write('Background host process could not start.\n'); stopped(); });
  child.once('exit', stopped);
  child.once('close', () => log.end());
}

function runtimeStatus() { return { supervisor: supervisor.snapshot(), identity: lastIdentity }; }
function notifyRuntimeChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('orbit:incoming-changed');
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildTrayMenu());
}
function notifyCleanupChanged(change) {
  if (!Number.isSafeInteger(change?.revision) || change.revision < 0) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    try { mainWindow.webContents.send('orbit:cleanup-changed', { revision: change.revision }); }
    catch { /* A closing owner window must not change remote cleanup outcome. */ }
  }
}
function stopForRecovery(reason, manual = false) {
  const child = hostProcess;
  if (!child || child.exitCode !== null || child.orbitStopping) return;
  child.orbitStopping = true; child.orbitRestartReason = reason; child.orbitManualRestart = manual;
  supervisor.stopping(reason); notifyRuntimeChanged();
  // EOF normally releases held input. The hard stop is only a bounded fallback
  // for a hung child; every future launch receives fresh D6 credentials.
  child.stdin.end();
  const force = setTimeout(() => { if (hostProcess === child && child.exitCode === null) child.kill(); }, 3000);
  force.unref(); child.once('exit', () => clearTimeout(force));
}
function retryHost() {
  // Also reached from the "Tailscale is on now" action: an offline host only
  // detects Tailscale when it starts, so the same local restart applies.
  const state = supervisor.snapshot().state, now = Date.now();
  const recheckingTailscale = state === 'offline';
  const step = retryStep(supervisor.canRetry(), hostProcess);
  if (step === 'none') return runtimeStatus();
  const refused = retryRefusal({ state, rawStatus: lastRawStatus, rotationInFlight: identityRotation.inFlight, lastManualAt: lastManualRestartAt, now });
  if (refused) return { ...runtimeStatus(), retryRefused: refused };
  lastManualRestartAt = now;
  clearTimeout(restartTimer); restartTimer = null;
  supervisor.retry(Date.now()); notifyRuntimeChanged();
  if (step === 'stop') stopForRecovery(recheckingTailscale ? 'Checking for Tailscale again.' : 'Retry requested locally.', true);
  else if (step === 'mark') hostProcess.orbitManualRestart = true;
  else startHost(hostDirectory);
  return runtimeStatus();
}

async function start() {
  app.setAppUserModelId('dev.orbit.remote');
  const directory = testing.appData || app.getPath('userData');
  hostDirectory = directory;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  controller = new OrbitController({
    directory, requireLocalProof: true, controlUrl: 'http://127.0.0.1:' + controlPort, allowLoopback,
    onFramePresented: entry => {
      const state = windowStates.get(entry.owner)?.current();
      if (!state || state.paused) return;
      const context = frameContext(entry.sessionId, entry.slotKey);
      if (frameGate.presented(entry.owner, entry.ownerCapture, context))
        controller.noteDisplayPresented(entry.sessionId, context.generation);
    },
    onSessionEnded: (sessionId, reason) => {
      for (const entry of viewerWindows.values()) if (entry.sessionId === sessionId) entry.endedReason = reason;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('orbit:incoming-changed');
    },
    onCleanupChanged: notifyCleanupChanged,
    onDisplayAsleep: sessionId => {
      for (const owner of windowStates.keys()) frameGate.invalidateSession(owner, sessionId);
    },
    onDisplayPendingInvalidated: sessionId => {
      for (const owner of windowStates.keys()) frameGate.invalidatePendingSession(owner, sessionId);
    },
    native: {
      getSettings: () => ({ startAtLoginSupported: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && ['win32', 'darwin'].includes(process.platform),
        startAtLogin: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && ['win32', 'darwin'].includes(process.platform) ?
          app.getLoginItemSettings(process.platform === 'win32' ? { args: ['--background'] } : {}).openAtLogin : false }),
      setStartAtLogin: async enabled => {
        if (!app.isPackaged) throw new Error('Automatic login startup is available in the installed desktop build. Development mode stays manual.');
        if (process.env.PORTABLE_EXECUTABLE_FILE) throw new Error('Use the installed build for automatic startup. Portable builds run from a temporary extracted location.');
        if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Use the documented Linux user service for automatic startup.');
        app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === 'win32' ? { args: ['--background'] } : {}) });
      },
      writeLocalClipboard: text => clipboard.writeText(text),
      openProject: () => shell.openExternal('https://github.com/Optimizer077/orbit-remote'),
      chooseFolder: async () => (await dialog.showOpenDialog(mainWindow, { title: 'Choose a dedicated Orbit transfer folder', properties: ['openDirectory', 'createDirectory'] })).filePaths[0],
      openFile: async () => (await dialog.showOpenDialog(mainWindow, { title: 'Send a file to the remote computer', properties: ['openFile'] })).filePaths[0],
      saveFile: async name => (await dialog.showSaveDialog(mainWindow, { title: 'Save remote file', defaultPath: path.basename(name) })).filePath,
    },
  });
  await controller.initialize();
  if (process.platform === 'darwin') showMacPermissionSetup = createMacPermissionSetup({
    dialog, systemPreferences, desktopCapturer, shell, getHostStatus: () => controller.local('status'),
  });
  startHost(directory);
  for (let attempt = 0; attempt < 80; attempt++) {
    try { const status = await controller.local('status'); lastRawStatus = status; lastIdentity = status.identity || null; supervisor.healthy(Date.now(), status.remoteEnabled); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  // Failed hosts still get an owner UI with a terminal Retry action instead of
  // disappearing or recovering forever in the background.
  ipcMain.handle('orbit:invoke', async (event, action, payload) => {
    const source = event.senderFrame?.url;
    const viewer = viewerWindows.get(event.sender.id);
    const owner = event.sender === mainWindow?.webContents;
    const trusted = !event.sender.isDestroyed() && source === pageUrl(!!viewer) && event.senderFrame === event.sender.mainFrame;
    if (!trusted || (!owner && !viewer)) throw new Error('Untrusted application frame.');
    if (typeof action !== 'string' || action.length > 60 || JSON.stringify(payload || {}).length > 1024 * 1024) throw new Error('Invalid application request.');
    if (payload == null) payload = {};
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid application request.');
    if (action === 'window.state') return windowStates.get(event.sender.id).current();
    if (action === 'window.fullscreen.get' || action === 'window.fullscreen.set')
      return fullscreenRequest(event, action, payload, fullscreenStates, pageUrl(!!viewer));
    if (viewer) {
      if (!viewerActions.has(action)) throw new Error('This screen window cannot perform that action.');
      if (action === 'viewer.context') {
        if (viewer.endedReason) return { session: { ...viewer.presentation, endedReason: viewer.endedReason, canReconnect: controller.canReconnect(viewer.sessionId) }, monitorId: viewer.monitorId };
        const s = controller.getSession(viewer);
        return { session: { sessionId: viewer.sessionId, device: { id: s.device.id, name: s.device.name,
          platform: s.device.platform, direction: 'outgoing' }, viewOnly: s.viewOnly, permissions: s.permissions,
          canScaleFrames: s.canScaleFrames, canConditionalFrames: s.canConditionalFrames, canJpegFrames: s.canJpegFrames, canLocalCursor: s.canLocalCursor,
          sessionGeneration: s.sessionGeneration ?? 0, availability: controller.availability(viewer.sessionId, s) }, monitorId: viewer.monitorId, independent: viewer.ownsSession === true };
      }
      if (action === 'viewer.close') { viewer.window.close(); return { ok: true }; }
      if (action !== 'clipboard.local.write' && payload.sessionId !== viewer.sessionId) throw new Error('This screen belongs to another session.');
      if (action === 'session.reconnect') payload = { ...payload, monitorId: viewer.monitorId };
      if (['session.frame', 'session.frame.presented', 'session.input', 'session.stream.open'].includes(action) && payload.monitorId !== viewer.monitorId)
        throw new Error('This screen belongs to another remote monitor.');
    } else {
      if (action === 'viewer.open') return openViewer(payload);
      if (action.startsWith('viewer.')) throw new Error('This action is only available inside a screen window.');
      if (action === 'host.runtime') return runtimeStatus();
      if (action === 'host.retry') return retryHost();
      // Opens the same native Mac permission setup as the app menu. It requests
      // nothing by itself: each macOS prompt still needs a button in that dialog.
      if (action === 'app.mac-permissions') {
        if (!showMacPermissionSetup) throw new Error('Permission setup is only available on a Mac.');
        await showMacPermissionSetup(mainWindow); return { ok: true };
      }
      if (action === 'identity.rotate') {
        return identityRotation.run(payload, {
          getStatus: () => controller.local('status'),
          confirm: async count => (await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Rotate Orbit identity?',
            message: `${count} devices will lose access and must pair again.`,
            detail: 'All incoming sessions will end and invitations will be invalidated. This computer must pair again with its saved remote computers. This cannot be undone.',
            buttons: ['Cancel', 'Rotate identity'], defaultId: 0, cancelId: 0, noLink: true })).response === 1,
          rotate: async () => {
            await controller.shutdown();
            const child = hostProcess;
            if (child) { child.orbitManualRestart = true; child.orbitRestartReason = 'Identity rotated. Pair every device again.'; }
            try { return await controller.local('identity/rotate', 'POST', { confirmRePair: true, expectedFingerprint: payload.expectedFingerprint }); }
            catch (error) { if (child) child.orbitManualRestart = false; throw error; }
          },
        });
      }
    }
    windowStates.get(event.sender.id)?.current();
    const ownerCapture = frameGate.capture(event.sender.id), originFrame = event.senderFrame;
    if (action === 'session.reconnect') {
      if (!windowReconnects.has(event.sender.id)) windowReconnects.set(event.sender.id, new Set());
      windowReconnects.get(event.sender.id).add(payload.sessionId);
    }
    try {
      if (action === 'session.frame.presented') {
        const context = frameContext(payload.sessionId, payload.monitorId || '');
        if (windowStates.get(event.sender.id)?.current().paused || !frameGate.acknowledge(event.sender.id, payload.deliveryId, context))
          throw new Error('Wait for a fresh screen before controlling the desktop.');
        controller.noteDisplayPresented(payload.sessionId, context.generation);
        return { ok: true };
      }
      if (action === 'session.stream.open') {
        if (windowStates.get(event.sender.id)?.current().paused) throw new Error('Screen updates are paused while this window is minimized or hidden.');
        if (typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.requestId))
          throw new Error('Invalid stream request.');
        const { port1, port2 } = new MessageChannelMain();
        try {
          const result = controller.videoStreams.open(payload, port1, event.sender.id);
          controller.videoStreams.entries.get(result.streamId).ownerCapture = ownerCapture;
          event.senderFrame.postMessage('orbit:video-port', { requestId: payload.requestId }, [port2]);
          return result;
        } catch (error) {
          port1.close(); port2.close();
          return streamOpenError(error, controller.endedSessions.get(payload.sessionId));
        }
      }
      if (action === 'session.stream.close') {
        controller.videoStreams.close(payload.streamId, event.sender.id); return { ok: true };
      }
      let result, frameSession, frameSleepReport;
      if (action === 'session.input' && windowStates.get(event.sender.id)?.current().paused)
        throw new Error('Screen input is paused while this window is minimized or hidden.');
      if (action === 'session.input') {
        controller.getSession(payload);
        if (!frameGate.allows(event.sender.id, frameContext(payload.sessionId, payload.monitorId || '')))
          throw new Error('Wait for a fresh screen before controlling the desktop.');
        if (!windowInputs.has(event.sender.id)) windowInputs.set(event.sender.id, new Set());
        const inputSessions = windowInputs.get(event.sender.id);
        for (const sessionId of inputSessions) if (!controller.sessions.has(sessionId)) inputSessions.delete(sessionId);
        inputSessions.add(payload.sessionId);
      }
      // Session-only sleep invalidation preserves ownerCapture. Its replacement
      // means native pause/navigation/process loss, even after a window restores.
      const assertWakeCurrent = () => {
        const state = windowStates.get(event.sender.id)?.current();
        if (!state || state.paused || event.sender.isDestroyed() || event.sender.mainFrame !== originFrame
          || frameGate.capture(event.sender.id) !== ownerCapture
          || (owner ? event.sender !== mainWindow?.webContents : viewerWindows.get(event.sender.id) !== viewer || viewer.sessionId !== payload.sessionId))
          throw Object.assign(new Error('The screen changed before display wake completed.'), { code: 'wake_cancelled' });
      };
      try {
        if (action === 'session.wake-display') {
          if (Object.keys(payload).length !== 1 || typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 128)
            throw new Error('Invalid display wake request.');
          assertWakeCurrent();
        }
        if (action === 'session.frame') {
          frameSession = controller.getSession(payload);
          frameSleepReport = frameSession.displaySleepReport;
        }
        result = await controller.invoke(action, payload, action === 'session.wake-display' ? assertWakeCurrent : undefined);
        if (action === 'session.wake-display') assertWakeCurrent();
      }
      catch (error) {
        if (action === 'session.wake-display') return wakeDisplayError(error, controller.endedSessions.get(payload.sessionId));
        if (['session.start', 'clipboard.read', 'clipboard.write', 'files.list', 'files.upload', 'files.download'].includes(action)
          && error?.status === undefined && IDENTITY_TERMINAL.has(error?.code))
          return { error: { code: error.code, message: IDENTITY_CHANGED_MESSAGE } };
        if (action === 'session.frame') {
          const result = frameRequestError(error, controller.endedSessions.get(payload.sessionId), controller.canReconnect(payload.sessionId));
          return result;
        }
        if (action === 'session.reconnect') return { error: { ...frameRequestError(error).error, canReconnect: controller.canReconnect(payload.sessionId) } };
        if (action !== 'status' || !lastUiStatus) throw error;
        result = { ...lastUiStatus, host: { ...lastUiStatus.host, online: false }, sessions: lastUiStatus.sessions.filter(s => s.direction === 'outgoing') };
      }
      if (action === 'session.frame' && result?.data?.byteLength && !windowStates.get(event.sender.id)?.current().paused
        && controller.sessions.get(payload.sessionId) === frameSession && frameSession.displaySleepReport === frameSleepReport) {
        const deliveryId = frameGate.issueFrame(event.sender.id, ownerCapture, payload.sessionId, payload.monitorId || '', result);
        if (deliveryId) result = { ...result, deliveryId };
      }
      if (action === 'session.reconnect' && (event.sender.isDestroyed() || event.sender.mainFrame !== originFrame || frameGate.capture(event.sender.id) !== ownerCapture)) {
        await controller.invoke('session.end', { sessionId: result.session.sessionId }).catch(() => {});
        throw new Error('This screen changed before reconnect completed.');
      }
      if (action === 'session.release-inputs') windowInputs.get(event.sender.id)?.delete(payload.sessionId);
      if (action === 'session.reconnect' && viewer) {
        if (viewer.window.isDestroyed() || !viewerWindows.has(event.sender.id)) {
          await controller.invoke('session.end', { sessionId: result.session.sessionId }).catch(() => {});
          throw new Error('This screen closed before reconnect completed.');
        }
        viewer.sessionId = result.session.sessionId; viewer.monitorId = result.monitorId; viewer.ownsSession = true; delete viewer.endedReason;
        viewer.presentation = { sessionId: result.session.sessionId, device: { id: result.session.device.id, name: result.session.device.name, platform: result.session.device.platform, direction: 'outgoing' }, viewOnly: true,
          permissions: { view: false, control: false, clipboard: false, files: false, power: false } };
      }
      if (action === 'status') {
        lastIdentity = controller.lastStatus?.identity || lastIdentity;
        result = { ...result, ...runtimeStatus() }; lastUiStatus = result; observeIncoming(result);
      }
      else if (['host.disconnect-all', 'session.end', 'device.revoke'].includes(action)) {
        observeIncoming(await controller.local('status'));
      }
      else if (['device.block', 'device.allow'].includes(action)) {
        // The mutation already succeeded; a later health probe must not turn
        // its authoritative response into an apparent failure.
        try { observeIncoming(await controller.local('status')); } catch { /* Next health poll refreshes the banner. */ }
      }
      return result;
    }
    finally {
      if (action === 'session.reconnect') windowReconnects.get(event.sender.id)?.delete(payload.sessionId);
      for (const entry of viewerWindows.values()) {
        // A terminal window retains an explanation, never a controller session.
        // Deliberate owner dismissal/forget still closes its attached windows.
        const dismissed = owner && ((action === 'session.end' && payload.sessionId === entry.sessionId) ||
          (action === 'device.forget' && payload.deviceId === entry.presentation.device.id));
        const reason = controller.endedSessions.get(entry.sessionId);
        if (reason) entry.endedReason = reason;
        if ((dismissed || (!controller.sessions.has(entry.sessionId) && !entry.endedReason)) && !entry.window.isDestroyed()) entry.window.close();
      }
    }
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // On the bundled file:// page, 'self' matches every file: URL, and a CSP source cannot narrow file: to one
  // folder. The other protections (no HTML sinks, sandbox, IPC sender checks) carry that gap until the renderer
  // moves to a custom protocol with its own origin.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = rendererUrl ? "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; frame-src 'none'" :
      "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  createWindow();
  createTray();
  if (launch.warnings.includes('no-sandbox')) warnNoSandboxOnce(directory);
  const loginLaunch = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!process.argv.includes('--background') && !loginLaunch) mainWindow.show();
  healthTimer = setInterval(async () => {
    if (healthBusy || quitting || hostProcess?.exitCode !== null) return;
    healthBusy = true;
    try {
      const status = await controller.local('status');
      if (hostProcess?.orbitStopping) return;
      observeIncoming(status);
      lastRawStatus = status; lastIdentity = status.identity || null; healthFailures = 0;
      supervisor.healthy(Date.now(), status.remoteEnabled);
      const tailscaleCli = findTailscaleCli();
      if (!allowLoopback && !status.identity?.expired && tailscaleCli && Date.now() - lastProbeAt >= 10000) {
        lastProbeAt = Date.now(); const observedChild = hostProcess;
        let observed;
        try {
          const { stdout } = await promisify(execFile)(tailscaleCli, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
          observed = tailscaleObservation(JSON.parse(stdout));
        } catch { /* Unknown must never restart or imply loss of the address. */ }
        if (hostProcess === observedChild && !observedChild.orbitStopping && networkChanges.observe(status.remoteEnabled ? status.transport?.address ?? null : null, observed))
          stopForRecovery('Tailscale address changed. Reconnecting.');
      }
    } catch {
      supervisor.failedHealth();
      if (hostProcess?.exitCode === null && !hostProcess.orbitStopping && Date.now() - hostProcess.orbitStartedAt >= 20000 && ++healthFailures >= 3)
        stopForRecovery('The background host stopped responding.');
    }
    finally { healthBusy = false; }
  }, 3000);
}

let incomingSignature = '', pairedSignature;
function observeIncoming(status) {
  const incoming = (status?.sessions || []).filter(s => s.direction !== 'outgoing');
  const signature = JSON.stringify(incoming.map(s => [s.id, s.permissions?.control === true]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  updateTrayActivity(trayActivityFromStatus(status));
  // A new or revoked pairing also refreshes the owner window, e.g. an open
  // invite dialog showing that the other computer joined.
  const paired = pairedDevicesSignature(status);
  const pairingChanged = paired !== undefined && pairedSignature !== undefined && paired !== pairedSignature;
  if (paired !== undefined) pairedSignature = paired;
  if (signature !== incomingSignature || pairingChanged) {
    incomingSignature = signature;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('orbit:incoming-changed');
  }
}

// AppImage on Linux only (launch-policy.cjs): logged on every launch, shown once per profile.
function warnNoSandboxOnce(directory) {
  const warning = noSandboxWarning();
  console.warn(warning.title + '. ' + warning.message);
  const marker = path.join(directory, 'no-sandbox-warning-shown');
  if (fs.existsSync(marker)) return;
  try { fs.writeFileSync(marker, new Date().toISOString() + '\n', { mode: 0o600 }); } catch { /* Warn again next time. */ }
  void dialog.showMessageBox({ type: 'warning', title: warning.title, message: warning.title, detail: warning.message, buttons: ['OK'] });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1000, minHeight: 700, show: false,
    backgroundColor: '#101615', title: 'Orbit Remote', autoHideMenuBar: true,
    icon: app.isPackaged ? path.join(process.resourcesPath, 'icons', 'icon.png') : path.join(appRoot, 'build', 'icons', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false, devTools: !releaseBuild },
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { label: app.name, submenu: [
      { role: 'about' }, { label: 'Set Up Mac Permissions…', click: () => openMacPermissionSetup() },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' }, { role: 'windowMenu' },
  ]) : null);
  hardenWindow(mainWindow);
  mainWindow.on('close', event => { if (!quitting && tray) { event.preventDefault(); mainWindow.hide(); } });
  if (rendererUrl) mainWindow.loadURL(rendererUrl); else mainWindow.loadFile(entryFile);
}

function pageUrl(viewer = false) {
  const url = new URL(rendererUrl || pathToFileURL(entryFile).href);
  if (viewer) url.searchParams.set('viewer', '1');
  return url.href;
}

function frameContext(sessionId, monitorId) {
  const session = controller.getSession({ sessionId });
  return { sessionId, monitorId, generation: session.sessionGeneration ?? 0, frame: session.frameSlots?.get(monitorId)?.frame };
}

function hardenWindow(window) {
  const owner = window.webContents.id;
  // Visible but unfocused/occluded viewers keep decoding. Explicit native
  // minimize/hide closes their delivery and releases input instead of silently
  // allowing Chromium's background scheduler to strand Worker credit.
  const pauseDelivery = state => {
    frameGate.invalidate(owner);
    for (const sessionId of windowReconnects.get(owner) || []) controller.cancelReconnect(sessionId);
    const sessions = new Set(windowInputs.get(owner) || []);
    for (const entry of controller?.videoStreams.entries.values() || []) if (entry.owner === owner) sessions.add(entry.sessionId);
    const viewer = viewerWindows.get(owner); if (viewer) sessions.add(viewer.sessionId);
    if (state?.paused === true) controller?.videoStreams.pauseOwner(owner, state);
    else controller?.videoStreams.closeOwner(owner);
    windowInputs.delete(owner);
    for (const sessionId of sessions) if (controller.sessions.has(sessionId))
      controller.invoke('session.release-inputs', { sessionId }).catch(() => {});
  };
  windowStates.set(owner, new NativeWindowVisibility(window, {
    notify: state => { frameGate.invalidate(owner); window.webContents.send('orbit:window-state', state); }, onPause: pauseDelivery,
  }));
  fullscreenStates.set(owner, new NativeWindowFullscreen(window, state => {
    if (!window.webContents.isDestroyed()) window.webContents.send('orbit:fullscreen-state', state);
  }));
  const closeFullscreen = () => { fullscreenStates.get(owner)?.close(); fullscreenStates.delete(owner); };
  window.once('closed', () => { pauseDelivery(); windowStates.get(owner)?.close(); windowStates.delete(owner); closeFullscreen(); frameGate.forget(owner); windowReconnects.delete(owner); });
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) pauseDelivery(); });
  window.webContents.on('render-process-gone', pauseDelivery);
  window.webContents.on('destroyed', () => { pauseDelivery(); closeFullscreen(); frameGate.forget(owner); windowReconnects.delete(owner); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

function openViewer(payload) {
  const s = controller.getSession(payload);
  const monitor = payload.monitorId ? s.monitors.find(m => m.id === payload.monitorId) :
    s.monitors.find(m => m.primary) || s.monitors[0];
  if (!monitor) throw new Error('Choose an available remote monitor.');
  for (const [id, entry] of viewerWindows) {
    if (entry.window.isDestroyed()) { viewerWindows.delete(id); continue; }
    if (entry.sessionId === payload.sessionId && entry.monitorId === monitor.id) {
      entry.window.show(); entry.window.focus(); return { ok: true };
    }
  }
  if (viewerWindows.size >= 8) throw new Error('Close a screen window before opening another.');
  const displays = screen.getAllDisplays();
  const ownerDisplay = screen.getDisplayMatching(mainWindow.getBounds());
  const display = displays.find(d => d.id !== ownerDisplay.id) || ownerDisplay;
  const area = display.workArea;
  const window = new BrowserWindow({
    x: area.x + 24, y: area.y + 24, width: Math.min(1200, area.width), height: Math.min(850, area.height),
    minWidth: 720, minHeight: 480, show: false, backgroundColor: '#101615', autoHideMenuBar: true,
    title: s.device.name + ' — ' + (monitor.name || 'Remote screen'),
    icon: app.isPackaged ? path.join(process.resourcesPath, 'icons', 'icon.png') : path.join(appRoot, 'build', 'icons', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false, devTools: !releaseBuild },
  });
  const id = window.webContents.id;
  viewerWindows.set(id, { window, sessionId: payload.sessionId, monitorId: monitor.id,
    presentation: { sessionId: payload.sessionId, device: { id: s.device.id, name: s.device.name, platform: s.device.platform, direction: 'outgoing' },
      viewOnly: true, permissions: { view: false, control: false, clipboard: false, files: false, power: false } } });
  hardenWindow(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    const closing = viewerWindows.get(id);
    viewerWindows.delete(id);
    // A screen closes independently; the owner and other screens keep their session.
    if (closing && controller.sessions.has(closing.sessionId)) controller.invoke(closing.ownsSession ? 'session.end' : 'session.release-inputs', { sessionId: closing.sessionId }).catch(() => {});
  });
  if (rendererUrl) window.loadURL(pageUrl(true)); else window.loadFile(entryFile, { query: { viewer: '1' } });
  return { ok: true };
}

// Tray "being viewed" state. trayBaseImage is the plain icon; badged variants are drawn once per colour and cached.
let trayBaseImage, trayActivity = { viewing: 0, controlling: false };
const trayBadgeCache = new Map();
const TRAY_IDLE_TOOLTIP = 'Orbit Remote — private remote access';
const TRAY_BADGE_RGB = { viewing: [245, 158, 11], controlling: [229, 57, 53] }; // amber: viewed · red: controlled

function createTray() {
  const trayName = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const image = nativeImage.createFromPath(app.isPackaged ? path.join(process.resourcesPath, 'icons', trayName) : path.join(appRoot, 'build', 'icons', trayName));
  if (process.platform === 'darwin') image.setTemplateImage(true);
  trayBaseImage = image;
  tray = new Tray(image);
  tray.setToolTip(TRAY_IDLE_TOOLTIP);
  tray.setContextMenu(buildTrayMenu());
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
}

function buildTrayMenu() {
  const { viewing } = trayActivity;
  return Menu.buildFromTemplate([
    ...(viewing > 0 ? [{ label: trayActivityText(trayActivity), enabled: false }, { type: 'separator' }] : []),
    { label: 'Open Orbit Remote', click: () => { mainWindow.show(); mainWindow.focus(); } },
    ...(supervisor.snapshot().state === 'stopped' ? [{ label: 'Remote access stopped. Retry', click: retryHost }] : []),
    ...(process.platform === 'darwin' ? [{ label: 'Set Up Mac Permissions…', click: () => openMacPermissionSetup() }] : []),
    { label: viewing > 0 ? `Disconnect all incoming sessions (${viewing})` : 'Disconnect all incoming sessions', click: async () => {
      try { await controller.invoke('host.disconnect-all'); observeIncoming(await controller.local('status')); }
      catch (error) { dialog.showErrorBox('Disconnect failed', error.message); }
    } },
    { type: 'separator' }, { label: 'Quit Orbit and stop remote access', click: () => app.quit() },
  ]);
}

function trayActivityText({ viewing, controlling }) {
  return `${viewing === 1 ? '1 device' : `${viewing} devices`} viewing this computer${controlling ? ' (1 has control)' : ''}`;
}

/** Incoming-session summary from either the raw host status (controller.local('status')) or controller.status(). */
function trayActivityFromStatus(status) {
  const incoming = (Array.isArray(status?.sessions) ? status.sessions : []).filter(s => s && s.direction !== 'outgoing');
  return { viewing: incoming.length, controlling: incoming.some(s => s.permissions?.control === true) };
}

/** Paints a filled dot with a transparent cut-out ring into the bottom-right of a BGRA (premultiplied) bitmap. */
function paintTrayBadge(bitmap, width, height, scale, [r, g, b]) {
  const out = Buffer.from(bitmap);
  const radius = 3.1 * scale, ring = radius + 1.3 * scale;
  const cx = width - radius - 0.4 * scale, cy = height - radius - 0.4 * scale;
  for (let y = Math.max(0, Math.floor(cy - ring - 1)); y < height; y++) {
    for (let x = Math.max(0, Math.floor(cx - ring - 1)); x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), i = (y * width + x) * 4;
      const clear = Math.min(1, Math.max(0, ring + 0.5 - d)); // 1 inside the ring: erase the icon there
      const fill = Math.min(1, Math.max(0, radius + 0.5 - d)); // 1 inside the dot
      if (clear <= 0) continue;
      for (let c = 0; c < 4; c++) out[i + c] = Math.round(out[i + c] * (1 - clear));
      if (fill > 0) {
        const src = [b, g, r, 255];
        for (let c = 0; c < 4; c++) out[i + c] = Math.round(src[c] * fill + out[i + c] * (1 - fill));
      }
    }
  }
  return out;
}

function badgedTrayImage(kind) {
  if (trayBadgeCache.has(kind)) return trayBadgeCache.get(kind);
  const result = nativeImage.createEmpty();
  const dip = trayBaseImage.getSize();
  const scales = typeof trayBaseImage.getScaleFactors === 'function' ? trayBaseImage.getScaleFactors() : [1];
  for (const scaleFactor of scales.length ? scales : [1]) {
    const bitmap = trayBaseImage.toBitmap({ scaleFactor });
    const width = Math.round(dip.width * scaleFactor), height = Math.round(dip.height * scaleFactor);
    if (!bitmap.length || width * height * 4 !== bitmap.length) continue;
    const painted = paintTrayBadge(bitmap, width, height, scaleFactor, TRAY_BADGE_RGB[kind]);
    const png = nativeImage.createFromBitmap(painted, { width, height, scaleFactor }).toPNG({ scaleFactor });
    result.addRepresentation({ scaleFactor, width, height, buffer: png });
  }
  const image = result.isEmpty() ? trayBaseImage : result;
  trayBadgeCache.set(kind, image);
  return image;
}

/**
 * Shows that another device is viewing or controlling THIS computer: badged tray icon (Windows/Linux) or a
 * "●" title (macOS, whose template icons are monochrome), a tooltip, and a status line in the tray menu.
 * Call with trayActivityFromStatus(status) whenever host status is refreshed. Cheap when nothing changed.
 */
function updateTrayActivity({ viewing = 0, controlling = false } = {}) {
  viewing = Math.max(0, Math.floor(Number(viewing) || 0));
  controlling = viewing > 0 && controlling === true;
  if (!tray || tray.isDestroyed() || !trayBaseImage) return;
  if (viewing === trayActivity.viewing && controlling === trayActivity.controlling) return;
  trayActivity = { viewing, controlling };
  try {
    if (process.platform === 'darwin') tray.setTitle(viewing > 0 ? (viewing > 1 ? `● ${viewing}` : '●') : '');
    else tray.setImage(viewing > 0 ? badgedTrayImage(controlling ? 'controlling' : 'viewing') : trayBaseImage);
  } catch { /* the tooltip and menu below still report the state */ }
  tray.setToolTip(viewing > 0 ? `Orbit Remote: ${trayActivityText(trayActivity)}` : TRAY_IDLE_TOOLTIP);
  tray.setContextMenu(buildTrayMenu());
}

function openMacPermissionSetup() {
  showMacPermissionSetup?.(mainWindow).catch(error => dialog.showErrorBox('Mac permission setup', error.message));
}

app.on('activate', () => mainWindow?.show());
app.on('window-all-closed', () => { /* the explicit tray menu controls host lifetime */ });
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  clearInterval(healthTimer); clearTimeout(restartTimer);
  for (const entry of viewerWindows.values()) if (!entry.window.isDestroyed()) entry.window.destroy();
  Promise.race([controller?.shutdown(), new Promise(resolve => setTimeout(resolve, 1500))])
    .finally(async () => {
      const child = hostProcess;
      if (child && child.exitCode === null) {
        child.stdin.end();
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
        if (child.exitCode === null) child.kill();
      }
      tray?.destroy(); app.quit();
    });
});
