import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test.skip(process.platform !== 'darwin', 'Requires native macOS.');

test('Mac app: native host, permissions, paired session, clipboard and shutdown', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-mac-ui-test-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.ORBIT_MAC_TEST_APP;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      ...(packaged ? { executablePath: path.join(packaged, 'Contents/MacOS/Orbit Remote') } : {}),
      args: packaged ? ['--background'] : ['.', '--background'], cwd: process.cwd(),
      env: { ...environment, ORBIT_LOOPBACK_TEST: '1', ORBIT_APP_DATA: directory,
        ORBIT_CONTROL_PORT: '47941', ORBIT_REMOTE_PORT: '47942' },
    });
    const page = await application.firstWindow();
    const invoke = <T,>(action: string, payload?: unknown) => page.evaluate(
      ({ action, payload }) => window.orbit!.invoke(action, payload), { action, payload }) as Promise<T>;
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    const status = await invoke<any>('status');
    expect(status.host.platform).toBe('macOS');
    expect(status.host.testMode).toBe(true);
    expect(status.sessionState).toBe('interactive');
    expect(status.capabilities.monitors.length).toBeGreaterThan(0);
    const menuLabels = await application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.flatMap(
      item => [item.label, ...(item.submenu?.items.map(child => child.label) || [])]));
    expect(menuLabels).toContain('Set Up Mac Permissions…');
    expect(menuLabels).toContain('Copy');
    expect(menuLabels).toContain('Paste');

    // Native permission denial must remain visible; do not turn it into an
    // assertion that recording/control was exercised when macOS refused it.
    const invitation = await invoke<any>('invite.create', { deviceName: 'Orbit Mac loopback test',
      permissions: { view: true, control: true, clipboard: true, files: false, power: false } });
    const device = await invoke<any>('pair', { invite: invitation.invite });
    if (!status.capabilities.capture) {
      await expect(invoke('session.start', { deviceId: device.id, viewOnly: true })).rejects.toThrow(/capture.*unavailable/i);
      const incoming = (await invoke<any>('devices')).devices.find((entry: any) => entry.direction === 'incoming');
      await invoke('device.revoke', { deviceId: incoming.id });
      await expect(invoke('pair', { invite: invitation.invite })).rejects.toThrow();
      expect(process.env.ORBIT_MAC_TEST_CONTROL !== '1', 'Approve Screen Recording before full-control testing.').toBe(true);
      console.log(`Mac startup/pairing/denied-permission/revocation passed; actual capture unavailable; packaged=${!!packaged}`);
      return;
    }
    const viewOnly = await invoke<any>('session.start', { deviceId: device.id, viewOnly: true });
    await expect(invoke('session.input', { sessionId: viewOnly.sessionId,
      event: { type: 'key', code: 'KeyA', down: true } })).rejects.toThrow(/view only/);
    await expect(invoke('clipboard.write', { sessionId: viewOnly.sessionId, text: 'not allowed' })).rejects.toThrow();
    await invoke('session.end', { sessionId: viewOnly.sessionId });

    const session = await invoke<any>('session.start', { deviceId: device.id, viewOnly: false });
    if (status.capabilities.capture) {
      for (const monitor of status.capabilities.monitors) {
        const frame = await invoke<any>('session.frame', { sessionId: session.sessionId, monitorId: monitor.id });
        expect(frame.width).toBe(monitor.width);
        expect(frame.height).toBe(monitor.height);
        expect(frame.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
        expect(frame.link).toMatchObject({ protocol: expect.stringMatching(/^TLS 1\.[23]$/), forwardSecrecy: true });
      }
    } else {
      await expect(invoke('session.frame', { sessionId: session.sessionId })).rejects.toThrow(/Screen Recording|screen-permission/i);
    }
    // Restore all available clipboard formats, including non-text content.
    if (process.env.ORBIT_MAC_TEST_CONTROL === '1') {
      expect(status.capabilities.capture, 'Approve Screen Recording before full-control testing.').toBe(true);
      expect(status.capabilities.input, 'Approve Accessibility before full-control testing.').toBe(true);
      // Keep an eager snapshot in the main process; private clipboard contents
      // never enter test logs, renderer IPC, traces, or generated files.
      const original = await application.evaluateHandle(async ({ clipboard, ClipboardItem }) =>
        Promise.all((await clipboard.read()).map(async item => new ClipboardItem(Object.fromEntries(
          await Promise.all(item.types.map(async type => [type, await item.getType(type)])))))));
      try {
        await invoke('clipboard.write', { sessionId: session.sessionId, text: 'Orbit Mac clipboard test' });
        expect((await invoke<any>('clipboard.read', { sessionId: session.sessionId })).text).toBe('Orbit Mac clipboard test');
      } finally {
        try { await application.evaluate(({ clipboard }, saved) => saved.length ? clipboard.write(saved) : clipboard.clear(), original); }
        finally { await original.dispose(); }
      }
      for (const monitor of status.capabilities.monitors)
        await checkNativeInput(application, invoke, session.sessionId, monitor.id);
    }
    // Terminate only this app's child, then verify supervised restart, identity
    // persistence and authorized session renewal through a real native frame.
    const beforeRestart = await invoke<any>('status');
    const parent = await application.evaluate(() => process.pid);
    const children = execFileSync('/usr/bin/pgrep', ['-P', String(parent), '-f', 'Orbit.Host'], { encoding: 'utf8' }).trim().split(/\s+/);
    expect(children).toHaveLength(1);
    const hostPid = Number(children[0]);
    expect(Number.isInteger(hostPid) && hostPid > 0).toBe(true);
    process.kill(hostPid);
    await expect.poll(async () => {
      try { return (await invoke<any>('status')).host.startedAt; } catch { return beforeRestart.host.startedAt; }
    }, { timeout: 20_000 }).not.toBe(beforeRestart.host.startedAt);
    expect((await invoke<any>('status')).host.fingerprint).toBe(beforeRestart.host.fingerprint);
    expect((await invoke<any>('session.frame', { sessionId: session.sessionId })).width).toBeGreaterThan(0);

    // An intentional host stop remains terminal; it cannot use crash recovery
    // to recreate a session without the owner's explicit connection action.
    const receiving = (await invoke<any>('status')).sessions.find((entry: any) => entry.direction === 'incoming');
    expect(receiving).toBeTruthy();
    await invoke('session.end', { sessionId: receiving.id });
    await expect(invoke('session.frame', { sessionId: session.sessionId })).rejects.toThrow(/ended|stopped/i);
    await invoke('session.end', { sessionId: session.sessionId });
    const incoming = (await invoke<any>('devices')).devices.find((entry: any) => entry.direction === 'incoming');
    await invoke('device.revoke', { deviceId: incoming.id });
    await expect(invoke('session.start', { deviceId: device.id, viewOnly: true })).rejects.toThrow();
    await expect(invoke('pair', { invite: invitation.invite })).rejects.toThrow();
    const audit = await invoke<any>('audit');
    expect(JSON.stringify(audit)).not.toContain(invitation.invite);
    console.log(`Mac session checks: capture=${status.capabilities.capture}, input=${status.capabilities.input}, ` +
      `native-control-test=${process.env.ORBIT_MAC_TEST_CONTROL === '1'}, packaged=${!!packaged}`);
  } finally {
    await application?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function checkNativeInput(application: ElectronApplication,
  invoke: <T>(action: string, payload?: unknown) => Promise<T>, sessionId: string, displayId: string) {
  const target = await application.evaluate(async ({ app, BrowserWindow, screen }, selectedId) => {
    const display = screen.getAllDisplays().find(candidate => String(candidate.id) === selectedId);
    if (!display) throw new Error('Selected test display is unavailable.');
    const window = new BrowserWindow({ x: display.workArea.x + 80, y: display.workArea.y + 80,
      width: 500, height: 280, title: 'Orbit native input test',
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<title>Orbit native input test</title><p>Temporary local input test.</p>' +
      '<textarea id="target" autofocus style="width:350px;height:100px"></textarea>'));
    window.show(); app.focus({ steal: true }); window.focus();
    const content = window.getContentBounds();
    const rect = await window.webContents.executeJavaScript('(() => { const e=document.querySelector("textarea"); e.focus(); const r=e.getBoundingClientRect(); return {x:r.x+30,y:r.y+30}; })()');
    const cursor = screen.getCursorScreenPoint();
    const cursorDisplay = screen.getDisplayNearestPoint(cursor);
    return { windowId: window.id, displayId: String(display.id),
      x: (content.x + rect.x - display.bounds.x) / display.bounds.width,
      y: (content.y + rect.y - display.bounds.y) / display.bounds.height,
      restore: { monitorId: String(cursorDisplay.id), x: (cursor.x - cursorDisplay.bounds.x) / cursorDisplay.bounds.width,
        y: (cursor.y - cursorDisplay.bounds.y) / cursorDisplay.bounds.height } };
  }, displayId);
  try {
    await invoke('session.frame', { sessionId, monitorId: target.displayId });
    for (const event of [{ type: 'pointer.move', x: target.x, y: target.y },
      { type: 'pointer.button', x: target.x, y: target.y, button: 0, down: true },
      { type: 'pointer.button', x: target.x, y: target.y, button: 0, down: false }])
      await invoke('session.input', { sessionId, monitorId: target.displayId, event });
    for (const code of ['KeyO', 'KeyR', 'KeyB', 'KeyI', 'KeyT']) {
      await invoke('session.input', { sessionId, monitorId: target.displayId, event: { type: 'key', code, down: true } });
      await invoke('session.input', { sessionId, monitorId: target.displayId, event: { type: 'key', code, down: false } });
    }
    await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('orbit');
    const key = (code: string, down: boolean) => invoke('session.input', { sessionId, monitorId: target.displayId,
      event: { type: 'key', code, down } });
    try {
      await key('ShiftLeft', true);
      await key('KeyA', true); await key('KeyA', false);
    } finally { await key('ShiftLeft', false); }
    await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('orbitA');
    await key('ShiftLeft', true);
    await invoke('session.release-inputs', { sessionId });
    await key('KeyB', true); await key('KeyB', false);
    await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('orbitAb');
  } finally {
    await invoke('session.release-inputs', { sessionId }).catch(() => {});
    await invoke('session.frame', { sessionId, monitorId: target.restore.monitorId }).then(() =>
      invoke('session.input', { sessionId, monitorId: target.restore.monitorId,
        event: { type: 'pointer.move', x: target.restore.x, y: target.restore.y } })).catch(() => {});
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), target.windowId);
  }
}
