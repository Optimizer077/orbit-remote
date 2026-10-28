import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
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
  const keychainBefore = keychainCounts();
  const keychainSamples: Record<string, ReturnType<typeof keychainCounts>> = { before: keychainBefore };
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
    test.skip(status.sessionState !== 'interactive', 'Unlock the Mac locally before capture, control and clipboard checks.');
    keychainSamples.running = keychainCounts();
    expect(keychainSamples.running).toEqual(keychainBefore);
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
    await presentNativeFrame(page, viewOnly.sessionId, status.capabilities.monitors[0].id);
    await expect(invoke('session.input', { sessionId: viewOnly.sessionId, monitorId: status.capabilities.monitors[0].id,
      event: { type: 'key', code: 'KeyA', down: true } })).rejects.toThrow(/view only/);
    await expect(invoke('clipboard.write', { sessionId: viewOnly.sessionId, text: 'not allowed' })).rejects.toThrow();
    await invoke('session.end', { sessionId: viewOnly.sessionId });

    const session = await invoke<any>('session.start', { deviceId: device.id, viewOnly: false });
    if (status.capabilities.capture) {
      for (const monitor of status.capabilities.monitors) {
        const frame = await presentNativeFrame(page, session.sessionId, monitor.id);
        expect(frame.width).toBe(monitor.width);
        expect(frame.height).toBe(monitor.height);
        expect(frame.contentType).toBe('image/png');
        expect(frame.binary).toBe(true);
        expect(frame.hasDataUrl).toBe(false);
        expect(frame.presented).toBe(true);
        expect(frame.bytes).toBeGreaterThan(0);
        expect(frame.decodedWidth).toBe(monitor.width);
        expect(frame.decodedHeight).toBe(monitor.height);
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
      const clipboardStarted = performance.now();
      const original = await application.evaluateHandle(async ({ clipboard, ClipboardItem }) => {
        const hadText = await clipboard.has('text/plain');
        const items = await clipboard.read();
        if (hadText && items.length === 0) throw new Error('Clipboard snapshot was unavailable; the test will not overwrite it.');
        return Promise.all(items.map(async item => new ClipboardItem(Object.fromEntries(
          await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
      });
      const snapshotMs = performance.now() - clipboardStarted;
      try {
        // Snapshot providers/OS consent can outlast the host's idle lease. A
        // real viewer keeps frames flowing; renew here before each data action.
        await presentNativeFrame(page, session.sessionId, status.capabilities.monitors[0].id);
        const writeStarted = performance.now();
        await invoke('clipboard.write', { sessionId: session.sessionId, text: 'Orbit Mac clipboard test' });
        const writeMs = performance.now() - writeStarted;
        await presentNativeFrame(page, session.sessionId, status.capabilities.monitors[0].id);
        const readStarted = performance.now();
        expect((await invoke<any>('clipboard.read', { sessionId: session.sessionId })).text).toBe('Orbit Mac clipboard test');
        console.log('Mac clipboard timings (no content):', JSON.stringify({ snapshotMs, writeMs, readMs: performance.now() - readStarted }));
      } finally {
        try { await application.evaluate(({ clipboard }, saved) => saved.length ? clipboard.write(saved) : clipboard.clear(), original); }
        finally { await original.dispose(); }
      }
      for (const monitor of status.capabilities.monitors)
        await checkNativeInput(application, page, invoke, session.sessionId, monitor.id);
    }
    // Terminate only this app's child, then verify supervised restart, identity
    // persistence and authorized session renewal through a real native frame.
    const beforeRestart = await invoke<any>('status');
    const parent = await application.evaluate(() => process.pid);
    const children = execFileSync('/usr/bin/pgrep', ['-P', String(parent), '-f', 'Orbit.Host'], { encoding: 'utf8' }).trim().split(/\s+/);
    expect(children).toHaveLength(1);
    const hostPid = Number(children[0]);
    expect(Number.isInteger(hostPid) && hostPid > 0).toBe(true);
    process.kill(hostPid, 'SIGKILL');
    await expect.poll(async () => {
      try { return (await invoke<any>('status')).host.startedAt; } catch { return beforeRestart.host.startedAt; }
    }, { timeout: 20_000 }).not.toBe(beforeRestart.host.startedAt);
    expect((await invoke<any>('status')).host.fingerprint).toBe(beforeRestart.host.fingerprint);
    keychainSamples.crashRestart = keychainCounts();
    expect(keychainSamples.crashRestart).toEqual(keychainBefore);
    expect((await invoke<any>('session.frame', { sessionId: session.sessionId })).width).toBeGreaterThan(0);

    // An intentional host stop remains terminal; it cannot use crash recovery
    // to recreate a session without the owner's explicit connection action.
    const receiving = (await invoke<any>('status')).sessions.find((entry: any) => entry.direction === 'incoming');
    expect(receiving).toBeTruthy();
    await invoke('session.end', { sessionId: receiving.id });
    const stopped = await invoke<any>('session.frame', { sessionId: session.sessionId });
    expect(stopped.error).toMatchObject({ code: 'permission_changed', status: 403, retryable: false });
    expect(stopped.error.message).toMatch(/owner ended|stopped/i);
    expect(stopped.data).toBeUndefined();
    await invoke('session.end', { sessionId: session.sessionId });
    const incoming = (await invoke<any>('devices')).devices.find((entry: any) => entry.direction === 'incoming');
    await invoke('device.revoke', { deviceId: incoming.id });
    await expect(invoke('session.start', { deviceId: device.id, viewOnly: true })).rejects.toThrow();
    await expect(invoke('pair', { invite: invitation.invite })).rejects.toThrow();
    const audit = await invoke<any>('audit');
    expect(JSON.stringify(audit)).not.toContain(invitation.invite);
    console.log(`Mac session checks: displays=${status.capabilities.monitors.length}, capture=${status.capabilities.capture}, input=${status.capabilities.input}, ` +
      `native-control-test=${process.env.ORBIT_MAC_TEST_CONTROL === '1'}, packaged=${!!packaged}`);
  } finally {
    await application?.close();
    await fs.rm(directory, { recursive: true, force: true });
    keychainSamples.afterQuit = keychainCounts();
    console.log('Login-keychain lifecycle counts:', JSON.stringify(keychainSamples));
    expect(keychainSamples.afterQuit).toEqual(keychainBefore);
  }
});

test('Mac locked desktop: capability and session denial', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-mac-locked-test-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.ORBIT_MAC_TEST_APP;
  let application: ElectronApplication | undefined;
  const before = keychainCounts();
  try {
    application = await electron.launch({
      ...(packaged ? { executablePath: path.join(packaged, 'Contents/MacOS/Orbit Remote') } : {}),
      args: packaged ? ['--background'] : ['.', '--background'], cwd: process.cwd(),
      env: { ...environment, ORBIT_LOOPBACK_TEST: '1', ORBIT_APP_DATA: directory,
        ORBIT_CONTROL_PORT: '47961', ORBIT_REMOTE_PORT: '47962' },
    });
    const page = await application.firstWindow();
    const invoke = <T,>(action: string, payload?: unknown) => page.evaluate(
      ({ action, payload }) => window.orbit!.invoke(action, payload), { action, payload }) as Promise<T>;
    const status = await invoke<any>('status');
    test.skip(status.sessionState !== 'locked', 'Requires a Mac that is already locked locally; the test never locks it.');
    expect(status.host.platform).toBe('macOS');
    expect(status.host.testMode).toBe(true);
    expect(status.capabilities).toMatchObject({ capture: false, input: false, clipboard: false, monitors: [] });
    const invitation = await invoke<any>('invite.create', { deviceName: 'Orbit locked desktop test',
      permissions: { view: true, control: true, clipboard: true, files: false, power: false } });
    const device = await invoke<any>('pair', { invite: invitation.invite });
    for (const viewOnly of [true, false])
      await expect(invoke('session.start', { deviceId: device.id, viewOnly })).rejects.toThrow(/capture.*unavailable/i);
    expect((await invoke<any>('status')).sessions).toHaveLength(0);
    const incoming = (await invoke<any>('devices')).devices.find((entry: any) => entry.direction === 'incoming');
    expect(incoming).toBeTruthy();
    await invoke('device.revoke', { deviceId: incoming.id });
    await expect(invoke('pair', { invite: invitation.invite })).rejects.toThrow();
    console.log(`Mac locked-desktop denial passed; no capture/input/clipboard performed; packaged=${!!packaged}`);
  } finally {
    await application?.close();
    await fs.rm(directory, { recursive: true, force: true });
    expect(keychainCounts()).toEqual(before);
  }
});

function keychainCounts(): { certificates: number; keys: number; identities: number; orbitCertificates: number } {
  const result = execFileSync('dotnet', [path.resolve('../../tests/Orbit.Mac.Tests/bin/Debug/net10.0/Orbit.Mac.Tests.dll'),
    '--keychain-counts'], { encoding: 'utf8' });
  return JSON.parse(result);
}

async function presentNativeFrame(page: Page, sessionId: string, monitorId: string) {
  return page.evaluate(async payload => {
    const result = await window.orbit!.invoke('session.frame', payload) as any;
    if (!(result.data instanceof Uint8Array) || typeof result.deliveryId !== 'string')
      throw new Error('A fresh binary frame and presentation receipt are required.');
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(result.data)], { type: result.contentType }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The native test frame could not be drawn.');
      context.drawImage(bitmap, 0, 0);
      // Follow the real owner receipt contract after decode/draw. Desktop
      // pixels stay in memory and never enter test output or screenshots.
      await window.orbit!.invoke('session.frame.presented', { ...payload, deliveryId: result.deliveryId });
      return { width: result.width, height: result.height, contentType: result.contentType, binary: true,
        decodedWidth: bitmap.width, decodedHeight: bitmap.height, bytes: result.data.byteLength,
        hasDataUrl: 'dataUrl' in result, link: result.link, presented: true };
    } finally { bitmap.close(); canvas.width = canvas.height = 1; }
  }, { sessionId, monitorId });
}

async function checkNativeInput(application: ElectronApplication, page: Page,
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
      expectedPoint: { x: content.x + rect.x, y: content.y + rect.y },
      x: (content.x + rect.x - display.bounds.x) / display.bounds.width,
      y: (content.y + rect.y - display.bounds.y) / display.bounds.height,
      restore: { monitorId: String(cursorDisplay.id), x: (cursor.x - cursorDisplay.bounds.x) / cursorDisplay.bounds.width,
        y: (cursor.y - cursorDisplay.bounds.y) / cursorDisplay.bounds.height } };
  }, displayId);
  const targetHasFocus = () => application.evaluate(async ({ BrowserWindow }, id) => {
    const window = BrowserWindow.fromId(id);
    return window?.isFocused() === true && await window.webContents.executeJavaScript(
      'document.hasFocus() && document.activeElement === document.querySelector("textarea")');
  }, target.windowId);
  try {
    // Native activation settles asynchronously. Send real keys only after this
    // dedicated window owns both OS focus and the textarea's document focus.
    await expect.poll(targetHasFocus).toBe(true);
    await presentNativeFrame(page, sessionId, target.displayId);
    await invoke('session.input', { sessionId, monitorId: target.displayId,
      event: { type: 'pointer.move', x: target.x, y: target.y } });
    await expect.poll(async () => application.evaluate(({ screen }, point) => {
      const actual = screen.getCursorScreenPoint();
      return Math.max(Math.abs(actual.x - point.x), Math.abs(actual.y - point.y));
    }, target.expectedPoint), { message: 'Native pointer movement must arrive before a click.' }).toBeLessThanOrEqual(2);
    // Check the real OS cursor against our owned textarea before any click.
    // A geometry regression must not click or type into an unrelated window.
    const hit = await application.evaluate(async ({ BrowserWindow, screen }, id) => {
      const window = BrowserWindow.fromId(id)!;
      const cursor = screen.getCursorScreenPoint(), content = window.getContentBounds();
      const textarea = await window.webContents.executeJavaScript(`(() => {
        const element = document.elementFromPoint(${cursor.x - content.x}, ${cursor.y - content.y});
        return element === document.querySelector('textarea');
      })()`);
      return { cursor, content, textarea, focused: window.isFocused() };
    }, target.windowId);
    expect(Math.abs(hit.cursor.x - target.expectedPoint.x), JSON.stringify({ hit, expected: target.expectedPoint })).toBeLessThanOrEqual(2);
    expect(Math.abs(hit.cursor.y - target.expectedPoint.y), JSON.stringify({ hit, expected: target.expectedPoint })).toBeLessThanOrEqual(2);
    expect(hit.textarea, JSON.stringify(hit)).toBe(true);
    for (const event of [{ type: 'pointer.button', x: target.x, y: target.y, button: 0, down: true },
      { type: 'pointer.button', x: target.x, y: target.y, button: 0, down: false }])
      await invoke('session.input', { sessionId, monitorId: target.displayId, event });
    await expect.poll(targetHasFocus).toBe(true);
    for (const code of ['KeyO', 'KeyR', 'KeyB', 'KeyI', 'KeyT']) {
      expect(await targetHasFocus(), 'Native test window lost focus before key injection.').toBe(true);
      await invoke('session.input', { sessionId, monitorId: target.displayId, event: { type: 'key', code, down: true } });
      await invoke('session.input', { sessionId, monitorId: target.displayId, event: { type: 'key', code, down: false } });
    }
    await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('orbit');
    const key = async (code: string, down: boolean) => {
      if (down) expect(await targetHasFocus(), 'Native test window lost focus before key injection.').toBe(true);
      return invoke('session.input', { sessionId, monitorId: target.displayId, event: { type: 'key', code, down } });
    };
    try {
      await key('ShiftLeft', true);
      await key('KeyA', true); await key('KeyA', false);
    } finally { await key('ShiftLeft', false); }
    await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('orbitA');
    for (let attempt = 1; attempt <= 5; attempt++) {
      await key('ShiftLeft', true);
      await invoke('session.release-inputs', { sessionId });
      await key('KeyB', true); await key('KeyB', false);
      await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
        BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('orbitA' + 'b'.repeat(attempt));
    }
    // Exercise a real Mac shortcut in the owned textarea. Z has no clipboard
    // side effect if Command were to remain stuck after the forced release.
    try {
      await key('MetaLeft', true);
      await key('KeyA', true); await key('KeyA', false);
      await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
        BrowserWindow.fromId(id)?.webContents.executeJavaScript(`(() => {
          const element = document.querySelector('textarea');
          return element.selectionStart === 0 && element.selectionEnd === element.value.length;
        })()`), target.windowId)).toBe(true);
    } finally { await invoke('session.release-inputs', { sessionId }); }
    await key('KeyZ', true); await key('KeyZ', false);
    await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
      BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('z');
    if (process.env.ORBIT_MAC_TEST_BATCH === '1') {
      await presentNativeFrame(page, sessionId, target.displayId);
      expect(await targetHasFocus(), 'Owned textarea must retain focus before the queued burst.').toBe(true);
      const wire = await application.evaluateHandle(() => {
        const https = process.getBuiltinModule('node:https');
        const original = https.request;
        const counts = { requests: 0, batches: 0, events: 0, maxEvents: 0, inFlight: 0, maxInFlight: 0, parseErrors: 0 };
        https.request = function (this: any, ...args: any[]) {
          const request = original.apply(this, args as any);
          if (request.method !== 'POST' || !/^\/api\/sessions\/[^/]+\/input$/.test(request.path)) return request;
          counts.requests++; counts.inFlight++; counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
          let complete = false;
          const finished = () => { if (!complete) { complete = true; counts.inFlight--; } };
          request.once('error', finished);
          request.once('response', response => { response.once('end', finished); response.once('close', finished); });
          const chunks: Buffer[] = []; let bytes = 0;
          const capture = (value: unknown) => {
            if (typeof value !== 'string' && !(value instanceof Uint8Array)) return;
            const buffer = Buffer.from(value as any); bytes += buffer.byteLength;
            if (bytes <= 16_384) chunks.push(buffer);
          };
          const write = request.write, end = request.end;
          request.write = function (this: any, ...parts: any[]) { capture(parts[0]); return write.apply(this, parts as any); } as any;
          request.end = function (this: any, ...parts: any[]) {
            capture(parts[0]);
            try {
              if (bytes > 16_384) throw new Error('Input probe exceeded its bound.');
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const events = Array.isArray(body.events) ? body.events.length : 1;
              counts.events += events; counts.maxEvents = Math.max(counts.maxEvents, events);
              if (events > 1) counts.batches++;
            } catch { counts.parseErrors++; }
            chunks.length = 0;
            return end.apply(this, parts as any);
          } as any;
          return request;
        } as any;
        return { snapshot: () => ({ ...counts }), restore: () => { https.request = original; } };
      });
      try {
        const events = ['KeyM', 'KeyA', 'KeyC', 'KeyB', 'KeyA', 'KeyT', 'KeyC', 'KeyH']
          .flatMap(code => [{ type: 'key', code, down: true }, { type: 'key', code, down: false }]);
        events.push({ type: 'key', code: 'ShiftLeft', down: true }, { type: 'key', code: 'KeyX', down: true },
          { type: 'key', code: 'KeyX', down: false }, { type: 'key', code: 'ShiftLeft', down: false },
          { type: 'key', code: 'KeyY', down: true }, { type: 'key', code: 'KeyY', down: false });
        await page.evaluate(({ sessionId, monitorId, events }) => Promise.all(events.map(event =>
          window.orbit!.invoke('session.input', { sessionId, monitorId, event }))), { sessionId, monitorId: target.displayId, events });
        await expect.poll(() => application.evaluate(({ BrowserWindow }, id) =>
          BrowserWindow.fromId(id)?.webContents.executeJavaScript('document.querySelector("textarea").value'), target.windowId)).toBe('zmacbatchXy');
        const counts = await wire.evaluate(value => value.snapshot());
        expect(counts.parseErrors).toBe(0); expect(counts.events).toBe(22);
        expect(counts.batches, 'The host must negotiate batching for this opt-in check.').toBeGreaterThan(0);
        expect(counts.maxEvents).toBeGreaterThan(1);
        expect(counts.maxInFlight).toBe(1); expect(counts.inFlight).toBe(0);
        console.log('Mac native batch counts (synthetic input only):', JSON.stringify(counts));
      } finally { await wire.evaluate(value => value.restore()); await wire.dispose(); }
    }
  } finally {
    await invoke('session.release-inputs', { sessionId }).catch(() => {});
    await presentNativeFrame(page, sessionId, target.restore.monitorId).then(() =>
      invoke('session.input', { sessionId, monitorId: target.restore.monitorId,
        event: { type: 'pointer.move', x: target.restore.x, y: target.restore.y } })).catch(() => {});
    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), target.windowId);
  }
}
