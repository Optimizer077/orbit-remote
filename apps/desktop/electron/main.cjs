'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, dialog, session, clipboard, shell, screen, systemPreferences, desktopCapturer } = require('electron');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { OrbitController } = require('./controller.cjs');
const { createMacPermissionSetup } = require('./mac-permissions.cjs');
const { ChildProofAgent, findTailscaleCli } = require('./local-control.cjs');

let mainWindow, tray, hostProcess, controller, showMacPermissionSetup;
const viewerWindows = new Map();
const viewerActions = new Set(['viewer.context', 'viewer.close', 'session.monitors', 'session.frame', 'session.input',
  'session.release-inputs', 'clipboard.read', 'clipboard.write', 'clipboard.local.write', 'files.list', 'files.upload',
  'files.download', 'session.lock', 'session.restart']);
let quitting = false;
let restartTimer, healthTimer, healthBusy = false, restartAttempts = 0;
const appRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(appRoot, '..', '..');
const controlPort = Number(process.env.ORBIT_CONTROL_PORT || 47831);
const allowLoopback = process.env.ORBIT_LOOPBACK_TEST === '1';
const rendererUrl = process.env.ORBIT_RENDERER_URL;
const isDevUrl = value => {
  try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === '5173'; }
  catch { return false; }
};
if (rendererUrl && !isDevUrl(rendererUrl)) throw new Error('Development renderer must use http://127.0.0.1:5173.');
const entryFile = path.join(appRoot, 'dist', 'index.html');

// Isolate development/tests before Chromium creates caches or acquires its lock.
// Normal launches retain the per-user application directory and single instance.
if (process.env.ORBIT_APP_DATA) app.setPath('userData', path.resolve(process.env.ORBIT_APP_DATA));
if (!app.requestSingleInstanceLock()) app.quit();
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
    env: { ...process.env, ORBIT_CONTROL_TOKEN: controlToken, ORBIT_DATA_DIR: path.join(dataDirectory, 'host'),
      ORBIT_CONTROL_PORT: String(controlPort), ORBIT_PARENT_WATCH: '1', ORBIT_PARENT_PROOF: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  hostProcess = child;
  const log = fs.createWriteStream(path.join(dataDirectory, 'host.log'), { flags: 'a', mode: 0o600 });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.stdin.on('error', () => {});
  if (child.pid) {
    controller.setLocalControl(new ChildProofAgent({ proofKey, pid: child.pid, port: controlPort }), controlToken);
    child.stdin.write(JSON.stringify({ version: 1, proofKey }) + '\n');
  }
  child.once('error', error => log.write(error.message + '\n'));
  child.once('exit', () => {
    if (hostProcess === child) controller.clearLocalControl();
    if (!quitting && mainWindow && !restartTimer) {
      restartAttempts++;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!quitting) startHost(dataDirectory);
      }, Math.min(30000, 1000 * 2 ** Math.min(restartAttempts - 1, 5)));
    }
  });
  child.once('close', () => log.end());
}

async function start() {
  app.setAppUserModelId('dev.orbit.remote');
  const directory = process.env.ORBIT_APP_DATA || app.getPath('userData');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  controller = new OrbitController({
    directory, requireLocalProof: true, controlUrl: 'http://127.0.0.1:' + controlPort, allowLoopback,
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
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { await controller.local('status'); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    if (hostProcess.exitCode !== null) break;
  }
  if (!ready) throw new Error('The background host did not become ready. Check ' + path.join(directory, 'host.log'));
  ipcMain.handle('orbit:invoke', async (event, action, payload) => {
    const source = event.senderFrame?.url;
    const viewer = viewerWindows.get(event.sender.id);
    const owner = event.sender === mainWindow?.webContents;
    const trusted = source === pageUrl(!!viewer) && event.senderFrame === event.sender.mainFrame;
    if (!trusted || (!owner && !viewer)) throw new Error('Untrusted application frame.');
    if (typeof action !== 'string' || action.length > 60 || JSON.stringify(payload || {}).length > 1024 * 1024) throw new Error('Invalid application request.');
    if (payload == null) payload = {};
    if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid application request.');
    if (viewer) {
      if (!viewerActions.has(action)) throw new Error('This screen window cannot perform that action.');
      if (action === 'viewer.context') {
        const s = controller.getSession(viewer);
        return { session: { sessionId: viewer.sessionId, device: { id: s.device.id, name: s.device.name,
          platform: s.device.platform, direction: 'outgoing' }, viewOnly: s.viewOnly, permissions: s.permissions,
          canScaleFrames: s.canScaleFrames, canConditionalFrames: s.canConditionalFrames }, monitorId: viewer.monitorId };
      }
      if (action === 'viewer.close') { viewer.window.close(); return { ok: true }; }
      if (action !== 'clipboard.local.write' && payload.sessionId !== viewer.sessionId) throw new Error('This screen belongs to another session.');
      if (['session.frame', 'session.input'].includes(action) && payload.monitorId !== viewer.monitorId)
        throw new Error('This screen belongs to another remote monitor.');
    } else {
      if (action === 'viewer.open') return openViewer(payload);
      if (action.startsWith('viewer.')) throw new Error('This action is only available inside a screen window.');
    }
    try {
      const result = await controller.invoke(action, payload);
      if (action === 'status') observeIncoming(result);
      else if (['host.disconnect-all', 'session.end', 'device.revoke'].includes(action)) {
        observeIncoming(await controller.local('status'));
      }
      return result;
    }
    finally {
      // Owner disconnection also closes screens whose session was removed by forget.
      for (const entry of viewerWindows.values()) if (!controller.sessions.has(entry.sessionId)) entry.window.close();
    }
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const csp = rendererUrl ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; frame-src 'none'" :
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'";
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  createWindow();
  createTray();
  const loginLaunch = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  if (!process.argv.includes('--background') && !loginLaunch) mainWindow.show();
  healthTimer = setInterval(async () => {
    if (healthBusy || quitting || hostProcess?.exitCode !== null) return;
    healthBusy = true;
    try {
      const status = await controller.local('status');
      observeIncoming(status);
      restartAttempts = 0;
      const tailscaleCli = findTailscaleCli();
      if (!allowLoopback && !status.remoteEnabled && tailscaleCli) {
        const { stdout } = await promisify(execFile)(tailscaleCli, ['status', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        if (JSON.parse(stdout).BackendState === 'Running') hostProcess.stdin.end();
      }
    } catch { /* the next health tick or child exit restarts recovery */ }
    finally { healthBusy = false; }
  }, 3000);
}

let incomingSignature = '';
function observeIncoming(status) {
  const incoming = (status?.sessions || []).filter(s => s.direction !== 'outgoing');
  const signature = JSON.stringify(incoming.map(s => [s.id, s.permissions?.control === true]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  updateTrayActivity(trayActivityFromStatus(status));
  if (signature !== incomingSignature) {
    incomingSignature = signature;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('orbit:incoming-changed');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 960, minWidth: 1000, minHeight: 700, show: false,
    backgroundColor: '#101615', title: 'Orbit Remote', autoHideMenuBar: true,
    icon: app.isPackaged ? path.join(process.resourcesPath, 'icons', 'icon.png') : path.join(appRoot, 'build', 'icons', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
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

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
}

function openViewer(payload) {
  const s = controller.getSession(payload);
  const monitor = payload.monitorId ? s.monitors.find(m => m.id === payload.monitorId) :
    s.monitors.find(m => m.primary) || s.monitors[0];
  if (!monitor) throw new Error('Choose an available remote monitor.');
  for (const entry of viewerWindows.values()) {
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
      sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  const id = window.webContents.id;
  viewerWindows.set(id, { window, sessionId: payload.sessionId, monitorId: monitor.id });
  hardenWindow(window);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    viewerWindows.delete(id);
    // A screen closes independently; the owner and other screens keep their session.
    if (controller.sessions.has(payload.sessionId)) controller.invoke('session.release-inputs', { sessionId: payload.sessionId }).catch(() => {});
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
  for (const entry of viewerWindows.values()) entry.window.destroy();
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
