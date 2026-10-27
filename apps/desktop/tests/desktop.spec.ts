import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('real desktop host: onboarding, pairing, native frames, settings and revocation', async () => {
  // Keep the complete UI flow and terminal hold when Chromium's window is hidden.
  // Per-action and explicit recovery deadlines are unchanged.
  if (process.env.ORBIT_E2E_HIDDEN === '1') test.setTimeout(180000);
  const began = performance.now();
  const mark = (phase: string) => console.log(`desktop e2e (${Math.round(performance.now() - began)} ms): ${phase}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-electron-test-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.ORBIT_E2E_PACKAGED === '1';
  const application = await electron.launch({
    ...(packaged ? { executablePath: path.resolve('release/unfused-test/win-unpacked/Orbit Remote.exe') } : {}),
    args: packaged ? ['--background'] : ['.', '--background'], cwd: process.cwd(),
    env: { ...environment, ORBIT_LOOPBACK_TEST: '1', ORBIT_APP_DATA: directory,
      ORBIT_CONTROL_PORT: '47931', ORBIT_REMOTE_PORT: '47932' },
  });
  try {
    mark('app launched');
    const page = await application.firstWindow();
    mark('owner window created');
    const hiddenWindows = process.env.ORBIT_E2E_HIDDEN === '1';
    if (hiddenWindows) {
      // --background keeps the initial window hidden. Install before opening any
      // popout so the real app flow can run without showing/focusing the desktop.
      await application.evaluate(({ app, BrowserWindow }) => {
        for (const name of ['show', 'showInactive', 'focus', 'restore', 'moveTop'] as const) {
          BrowserWindow.prototype[name] = function () {};
        }
        const keepHidden = (window: InstanceType<typeof BrowserWindow>) => {
          if (window.isVisible()) throw new Error('Test window became visible before its hidden guard.');
          window.setFocusable(false); window.setSkipTaskbar(true);
          window.webContents.setBackgroundThrottling(false);
          window.on('show', () => { window.hide(); throw new Error('A hidden test window was shown.'); });
        };
        BrowserWindow.getAllWindows().forEach(keepHidden);
        app.on('browser-window-created', (_event, window) => keepHidden(window));
      });
    } else await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    mark('window visibility configured');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'Add a device', exact: true })).toBeVisible();
    await expect(page.getByText('Local test mode', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Meet your other computer.' })).toBeVisible();
    const invoke = async <T,>(action: string, payload?: unknown): Promise<T> => {
      mark('starting ' + action);
      const result = await page.evaluate(({ action, payload }) => window.orbit!.invoke(action, payload), { action, payload }) as T;
      mark('finished ' + action);
      return result;
    };
    const ownerEndedMessage = 'The owner ended this session. Ask them to allow you again.';
    const ownerEndedMessages = [ownerEndedMessage, 'This session has ended.', 'This session has ended. Connect to the device again.', 'Session ended by host. Connect again explicitly.'];
    const expectEndedFrame = async (request: Promise<unknown>, message: RegExp | string[]) => {
      const result = await request as { error?: { code?: string; status?: number; retryable?: boolean; message?: string }; data?: unknown };
      expect(Object.hasOwn(result, 'data')).toBe(false);
      expect(result.error?.retryable).toBe(false);
      expect(['410/session_ended_by_host', '403/permission_changed']).toContain(String(result.error?.status) + '/' + result.error?.code);
      if (Array.isArray(message)) expect(message).toContain(result.error?.message);
      else expect(result.error?.message).toMatch(message);
    };
    const status = await invoke<any>('status');
    mark('host status ready');
    expect(status.host.name).toBeTruthy();
    expect(status.host.testMode).toBe(true);
    expect(status.capabilities.capture).toBe(true);
    expect(status.capabilities.monitors.length).toBeGreaterThan(0);
    const runtime = await invoke<any>('host.runtime');
    expect(runtime.supervisor.state).toBe('running');
    expect(runtime.identity.expired).toBe(false);
    expect(runtime.identity.expiresAt).toBeTruthy();
    // A healthy Retry is a no-op; the supervisor tests cover terminal retry policy.
    expect((await invoke<any>('host.retry')).supervisor.state).toBe('running');
    expect((await invoke<any>('status')).host.startedAt).toBe(status.host.startedAt);
    await expect(invoke('identity.rotate', { confirmRePair: true, expectedFingerprint: '0'.repeat(64) })).rejects.toThrow(/identity changed/i);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Orbit Remote.', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project on GitHub', exact: true })).toBeEnabled();
    await expect(page.getByRole('heading', { name: 'This computer’s identity', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Replace identity…', exact: true }).click();
    const identityConfirmation = page.getByRole('group', { name: 'Confirm identity replacement', exact: true });
    await expect(identityConfirmation.getByRole('checkbox')).not.toBeChecked();
    await expect(identityConfirmation.getByRole('button', { name: 'Continue to system confirmation', exact: true })).toBeDisabled();
    await identityConfirmation.getByRole('checkbox').check();
    await expect(identityConfirmation.getByRole('button', { name: 'Continue to system confirmation', exact: true })).toBeEnabled();
    await identityConfirmation.getByRole('button', { name: 'Cancel replacement', exact: true }).click();
    await expect(identityConfirmation).toHaveCount(0);
    expect((await invoke<any>('status')).host.fingerprint).toBe(status.host.fingerprint);
    const about = page.locator('#about-orbit');
    await expect(about.getByText('Development preview', { exact: true })).toBeVisible();
    await expect(about.getByRole('img', { name: /^Explanatory diagram:/ })).toBeVisible();
    const connectionTab = about.getByRole('tab', { name: 'Connection', exact: true });
    const permissionsTab = about.getByRole('tab', { name: 'Permissions', exact: true });
    const recoveryTab = about.getByRole('tab', { name: 'Recovery', exact: true });
    await expect(connectionTab).toHaveAttribute('aria-selected', 'true');
    await connectionTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(permissionsTab).toBeFocused();
    await expect(permissionsTab).toHaveAttribute('aria-selected', 'true');
    await expect(about.getByRole('tabpanel')).toContainText('Only the access you grant.');
    await page.keyboard.press('ArrowRight');
    await expect(recoveryTab).toBeFocused();
    await expect(about.getByRole('tabpanel')).toContainText('locked-screen access and pre-login recovery are unavailable');
    await page.keyboard.press('Home');
    await expect(connectionTab).toBeFocused();
    await page.keyboard.press('End');
    await expect(recoveryTab).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(connectionTab).toBeFocused();
    await expect(about.getByRole('tabpanel')).toContainText('A private route. Explicit trust.');
    // Capture just explanatory product content before pairing; no invitation, identity, or device data.
    await fs.mkdir(path.resolve('../../artifacts'), { recursive: true });
    await connectionTab.evaluate(element => (element as HTMLElement).blur());
    await about.screenshot({ path: path.resolve('../../artifacts/orbit-about.png'), animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await about.locator('.flow-arrow > i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    expect(await about.locator('.flow-arrow > i').first().evaluate(element => getComputedStyle(element).display)).toBe('none');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    expect(await page.locator('.ov-rise').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(await about.locator('.flow-arrow > i').first().evaluate(element => getComputedStyle(element).animationName)).toBe('diagram-flow');
    for (const [name, value] of [['Midnight', 'midnight'], ['Paper', 'paper'], ['Graphite', 'graphite'], ['Daylight', 'daylight']]) {
      const choice = page.getByRole('button', { name: 'Use ' + name + ' theme', exact: true });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    }
    await page.getByRole('button', { name: 'Use Paper theme', exact: true }).click();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    expect(await page.evaluate(() => localStorage.getItem('orbit.theme'))).toBe('paper');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('switch', { name: 'Follow system appearance', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    await page.getByRole('button', { name: 'Use Daylight theme', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'File transfer', exact: true })).toBeEnabled();
    await expect(page.getByRole('switch', { name: 'Lock & restart', exact: true })).toBeEnabled();
    if (packaged) await expect(page.getByRole('switch', { name: 'Start Orbit at sign-in', exact: true })).toBeEnabled();
    else await expect(page.getByRole('switch', { name: 'Start Orbit at sign-in', exact: true })).toBeDisabled();
    await page.getByLabel('COMPUTER NAME', { exact: true }).fill('Orbit workstation');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(async () => (await invoke<any>('status')).host.name).toBe('Orbit workstation');
    const notification = page.getByRole('button', { name: 'Dismiss notification', exact: true });
    if (await notification.isVisible()) await notification.click();

    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await fs.mkdir(path.resolve('../../artifacts'), { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.resolve('../../artifacts/orbit-overview.png'), fullPage: true, animations: 'disabled' });
    for (const [name, value] of [['Graphite', 'graphite'], ['Midnight', 'midnight'], ['Paper', 'paper']]) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Use ' + name + ' theme', exact: true }).click();
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.resolve('../../artifacts/orbit-' + value + '.png'), fullPage: true, animations: 'disabled' });
    }
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Use Daylight theme', exact: true }).click();
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('button', { name: 'Add a device', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Mouse & keyboard', exact: true })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Create invite', exact: true }).click();
    const invitation = await page.getByLabel('PAIRING INVITATION', { exact: true }).inputValue();
    expect(invitation.startsWith('orbit://pair/')).toBe(true);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('button', { name: 'Join with an invite', exact: true }).click();
    await page.getByLabel('PAIRING INVITATION', { exact: true }).fill(invitation);
    await page.getByRole('button', { name: 'Pair this computer' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const { devices } = await invoke<any>('devices');
    const outgoing = devices.find((d: any) => d.direction === 'outgoing');
    const incoming = devices.find((d: any) => d.direction === 'incoming');
    expect(outgoing.permissions.control).toBe(false);
    expect(incoming).toBeTruthy();

    const session = await invoke<any>('session.start', { deviceId: outgoing.id, viewOnly: true });
    mark('paired view-only session started');
    const frame = await invoke<any>('session.frame', { sessionId: session.sessionId });
    mark('first native frame delivered');
    expect(frame.contentType).toBe('image/png');
    expect(frame.data).toBeTruthy();
    expect(frame.dataUrl).toBeUndefined();
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    expect(frame.bytes).toBeGreaterThan(0);
    expect(typeof frame.unchanged).toBe('boolean');
    if (session.canScaleFrames) {
      const scaled = await invoke<any>('session.frame', { sessionId: session.sessionId, scale: 0.5 });
      expect(scaled.width).toBe(frame.width);
      expect(scaled.height).toBe(frame.height);
      expect(scaled.encodedWidth).toBe(Math.max(1, Math.round(frame.width * 0.5)));
      expect(scaled.encodedHeight).toBe(Math.max(1, Math.round(frame.height * 0.5)));
      expect(scaled.scale).toBe(0.5);
    }
    const viewedBanner = page.getByRole('region', { name: 'Remote access to this computer', exact: true });
    await expect(viewedBanner).toBeVisible();
    await expect(viewedBanner).toContainText('is viewing this screen');
    await expect(viewedBanner).toContainText('It cannot use your mouse or keyboard.');
    // Encryption shown to people is measured on the real TLS socket to the real host.
    // Policy allows TLS 1.2 (ECDHE + AEAD) because .NET on macOS may not serve TLS 1.3.
    expect(session.link).toMatchObject({ protocol: expect.stringMatching(/^TLS 1\.[23]$/), forwardSecrecy: true });
    expect(frame.link).toMatchObject({ protocol: expect.stringMatching(/^TLS 1\.[23]$/), forwardSecrecy: true });
    expect(frame.link.cipher).toMatch(/^(AES-256-GCM|AES-128-GCM|ChaCha20-Poly1305)$/);
    // Self-pairing: this computer's security code must equal the code shown for the paired device.
    const expectedCode = outgoing.fingerprint.slice(0, 32).match(/.{4}/g).join(' ');
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(page.locator('.ov-device[data-session-state="active"]')).toHaveCount(2);
    for (const direction of ['incoming', 'outgoing']) {
      const card = page.locator(`.ov-device[data-direction="${direction}"]`);
      await expect(card).toContainText('In session');
      await expect(card.locator('[data-permission]')).toHaveCount(5);
      await expect(card.locator('[data-granted="true"]')).toHaveCount(1);
      await expect(card.locator('[data-granted="false"]')).toHaveCount(4);
    }
    await expect(page.locator('.host-details .security-code')).toHaveText(expectedCode);
    await page.getByRole('button', { name: 'Manage Orbit workstation', exact: true }).first().click();
    await expect(page.locator('.security-code-card code')).toHaveText(expectedCode);
    await page.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Devices/ }).click();
    await expect(page.locator('.op-device-card[data-session-state="active"]')).toHaveCount(2);
    await expect(page.locator('.op-device-card [data-permission]')).toHaveCount(10);
    const primaryMonitor = session.monitors.find((monitor: any) => monitor.primary) || session.monitors[0];
    expect(primaryMonitor?.id).toBeTruthy();
    const openScreen = async () => {
      mark('opening native screen window');
      const nextWindow = application.waitForEvent('window');
      await invoke('viewer.open', { sessionId: session.sessionId, monitorId: primaryMonitor.id });
      const screen = await nextWindow;
      mark('native screen window created');
      screen.on('pageerror', error => errors.push(error.message));
      await expect(screen.getByRole('button', { name: 'Close screen', exact: true })).toBeVisible();
      const videoPreference = screen.getByRole('switch', { name: 'Video stream (beta)', exact: true });
      const revealControls = async () => {
        const bounds = await screen.locator('.hud').boundingBox();
        expect(bounds).not.toBeNull();
        // Chromium-only pointer events: no OS cursor movement or remote input.
        // Two different positions also wake a new popout when its pointer starts
        // at the same toolbar coordinates as the previously closed window.
        await screen.mouse.move(bounds!.x + 4, bounds!.y + 4);
        await screen.mouse.move(bounds!.x + 5, bounds!.y + 5);
        await expect(screen.locator('.hud-bar')).toHaveAttribute('data-visible', 'true');
      };
      await expect(videoPreference).toHaveAttribute('aria-checked', 'true');
      await expect(screen.getByRole('combobox', { name: 'Remote monitor', exact: true })).toBeDisabled();
      await expect(screen.getByRole('combobox', { name: 'Remote monitor', exact: true })).toHaveValue(primaryMonitor.id);
      await expect.poll(() => screen.locator('.remote-viewer canvas[role=img]').evaluateAll(images => images.length > 0 && (images[0] as HTMLCanvasElement).width > 1)).toBe(true);
      await expect(screen.locator('.session-statusbar')).toContainText(/Video stream|Image stream/);
      const quality = screen.getByRole('combobox', { name: 'Screen image quality', exact: true });
      if (await quality.count()) await expect(quality).toHaveValue('1');
      // Explicit image preference cancels automatic video retries and mounts a
      // fresh canvas; a received image must actually draw before input can resume.
      await revealControls();
      await videoPreference.click();
      await expect(videoPreference).toHaveAttribute('aria-checked', 'false');
      await expect(screen.locator('.remote-session')).toHaveAttribute('data-stream-mode', 'image');
      await expect(screen.locator('.session-statusbar')).toContainText('Image stream');
      mark('image stream drawn');
      await revealControls();
      await videoPreference.click();
      await expect(videoPreference).toHaveAttribute('aria-checked', 'true');
      await expect(screen.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0);
      await expect(screen.getByRole('button', { name: 'View only', exact: true })).toBeDisabled();
      await expect(screen.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
      await expect(screen.locator('.link-status')).toContainText(/Encrypted end to end.*TLS 1\.[23]/);
      return screen;
    };
    // This is a logical window on one existing hardware display, not a virtual-display driver test.
    const screen = await openScreen();
    const screenInvoke = <T,>(action: string, payload?: unknown) => screen.evaluate(
      ({ action, payload }) => window.orbit!.invoke(action, payload), { action, payload }) as Promise<T>;
    const context = await screenInvoke<any>('viewer.context');
    expect(context.session.sessionId).toBe(session.sessionId);
    expect(context.monitorId).toBe(primaryMonitor.id);
    expect(context.session.viewOnly).toBe(true);
    await expect(screenInvoke('devices')).rejects.toThrow(/cannot perform that action/);
    await expect(screenInvoke('session.end', { sessionId: session.sessionId })).rejects.toThrow(/cannot perform that action/);
    await expect(screenInvoke('host.disconnect-all')).rejects.toThrow(/cannot perform that action/);
    for (const ownerAction of ['host.runtime', 'host.retry', 'identity.rotate']) await expect(screenInvoke(ownerAction)).rejects.toThrow(/cannot perform that action/);
    await expect(screenInvoke('session.frame', { sessionId: 'another-session', monitorId: primaryMonitor.id })).rejects.toThrow(/another session/);
    await expect(screenInvoke('session.frame', { sessionId: session.sessionId, monitorId: 'another-monitor' })).rejects.toThrow(/another remote monitor/);
    const closedScreen = screen.waitForEvent('close');
    await screen.getByRole('button', { name: 'Close screen', exact: true }).click();
    await closedScreen;
    const ownerFrameAfterClose = await invoke<any>('session.frame', { sessionId: session.sessionId });
    expect(ownerFrameAfterClose.width).toBe(frame.width);
    const beforeRestart = await invoke<any>('status');
    const ownedParentPid = await application.evaluate(() => process.pid);
    const childQuery = 'Get-CimInstance Win32_Process -Filter "ParentProcessId = ' + ownedParentPid +
      '" | Where-Object { $_.CommandLine -like "*Orbit.Host*" } | Select-Object -ExpandProperty ProcessId';
    const ownedHostPid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', childQuery], { windowsHide: true, encoding: 'utf8' }).trim());
    expect(Number.isInteger(ownedHostPid) && ownedHostPid > 0).toBe(true);
    process.kill(ownedHostPid);
    await expect.poll(async () => {
      try { return (await invoke<any>('status')).host.startedAt; } catch { return beforeRestart.host.startedAt; }
    }, { timeout: 12000 }).not.toBe(beforeRestart.host.startedAt);
    const recoveredFrame = await invoke<any>('session.frame', { sessionId: session.sessionId });
    mark('native host recovered');
    expect(recoveredFrame.width).toBe(frame.width);
    expect((await invoke<any>('status')).host.fingerprint).toBe(beforeRestart.host.fingerprint);
    // No keyboard, pointer, clipboard write, lock or restart is executed on the user's desktop.
    // This owner window has not painted a frame since restart. Its native owner gate denies first.
    await expect(invoke('session.input', { sessionId: session.sessionId, event: { type: 'key', code: 'KeyA', down: true } })).rejects.toThrow(/fresh screen before controlling/);
    const reopenedScreen = await openScreen();
    // The popout owns its own fresh-frame receipt. Wait for that real receipt; never forge an ACK.
    // The session's immutable View-only grant prevents native input on every poll.
    await expect.poll(async () => {
      try {
        await reopenedScreen.evaluate(({ sessionId, monitorId }) => window.orbit!.invoke('session.input', { sessionId, monitorId, event: { type: 'key', code: 'KeyA', down: true } }), { sessionId: session.sessionId, monitorId: primaryMonitor.id });
        return 'Unexpectedly allowed';
      } catch (error) { return String((error as Error).message); }
    }).toMatch(/view only/);
    const ownerClosedScreen = reopenedScreen.waitForEvent('close');
    await invoke('session.end', { sessionId: session.sessionId });
    await ownerClosedScreen;
    await expectEndedFrame(invoke('session.frame', { sessionId: session.sessionId }), /session has ended/i);

    // A deliberate host-side stop is terminal. Verify the actual viewer stops, rather than
    // treating this as the supervisor/crash recovery path tested above.
    await page.getByRole('button', { name: 'Manage Orbit workstation', exact: true }).first().click();
    await page.getByRole('button', { name: 'View only', exact: true }).click();
    await expect.poll(() => page.locator('.remote-viewer canvas[role=img]').evaluateAll(images => images.length > 0 && (images[0] as HTMLCanvasElement).width > 1)).toBe(true);
    const activeBeforeStop = (await invoke<any>('status')).sessions;
    const hostSide = activeBeforeStop.find((entry: any) => entry.direction === 'incoming');
    const viewerSide = activeBeforeStop.find((entry: any) => entry.direction === 'outgoing');
    expect(hostSide?.id).toBeTruthy();
    expect(viewerSide?.id).toBeTruthy();
    const terminalWindow = application.waitForEvent('window');
    await invoke('viewer.open', { sessionId: viewerSide.id, monitorId: primaryMonitor.id });
    const terminalScreen = await terminalWindow;
    terminalScreen.on('pageerror', error => errors.push(error.message));
    await expect.poll(() => terminalScreen.locator('.remote-viewer canvas[role=img]').evaluateAll(canvases => canvases.length > 0 && (canvases[0] as HTMLCanvasElement).width > 1)).toBe(true);
    await expect(viewedBanner).toBeVisible();
    await viewedBanner.getByRole('button', { name: 'End session with Orbit workstation', exact: true }).click();
    await expectEndedFrame(invoke('session.frame', { sessionId: viewerSide.id }), ownerEndedMessages);
    await expect(page.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
    await expect(page.locator('.session-identity')).toContainText('Session ended');
    await expect(page.locator('.session-statusbar .link-status')).toHaveText('Connection ended');
    await expect(page.locator('.session-identity')).not.toContainText('Reconnecting');
    await expect(page.locator('.remote-viewer canvas[role=img]')).toBeHidden();
    await expect(page.getByRole('button', { name: 'View only', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open screen in window', exact: true })).toBeDisabled();
    await expect(page.getByText('Choose Disconnect, then Connect to start a new session. Orbit will not reconnect to this ended session.', { exact: true })).toBeVisible();
    await expect(terminalScreen.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
    await expect(terminalScreen.locator('.remote-viewer canvas[role=img]')).toBeHidden();
    // Navigation/remounting and the ordinary 15 s status refresh must preserve the
    // explanation. The main process retains no authorized session for either view.
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Connections', exact: true }).click();
    await terminalScreen.reload();
    await expect(terminalScreen.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
    const terminalContext = await terminalScreen.evaluate(() => window.orbit!.invoke('viewer.context')) as any;
    expect(ownerEndedMessages).toContain(terminalContext.session.endedReason);
    expect(Object.values(terminalContext.session.permissions)).toEqual([false, false, false, false, false]);
    await expectEndedFrame(terminalScreen.evaluate(({ sessionId, monitorId }) => window.orbit!.invoke('session.frame', { sessionId, monitorId }), { sessionId: viewerSide.id, monitorId: primaryMonitor.id }), ownerEndedMessages);
    const unchangedUntil = Date.now() + 16000;
    while (Date.now() < unchangedUntil) {
      expect((await invoke<any>('status')).sessions).toEqual([]);
      await expect(page.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
      expect(terminalScreen.isClosed()).toBe(false);
      await expect(terminalScreen.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
      await page.waitForTimeout(500);
    }
    const terminalClosed = terminalScreen.waitForEvent('close');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await terminalClosed;
    await expect(page.getByRole('heading', { name: 'No active connection', exact: true })).toBeVisible();
    // Owner stop blocks new sessions until the local owner explicitly allows this paired device.
    await expect(invoke('session.start', { deviceId: outgoing.id, viewOnly: true })).rejects.toThrow(ownerEndedMessage);
    const allowed = await invoke<any>('device.allow', { deviceId: incoming.id });
    expect(allowed.blockedByOwner).toBe(false);
    expect(allowed.permissions).toMatchObject({ view: true, control: false, clipboard: false, files: false, power: false });
    // Two sessions from the same device remain two independently stoppable viewers.
    // Disconnect all uses the host route that also invalidates queued resume authorization.
    const twoSessions = [];
    for (let index = 0; index < 2; index++) twoSessions.push(await invoke<any>('session.start', { deviceId: outgoing.id, viewOnly: true }));
    await expect(viewedBanner.locator('.viewed-count')).toHaveText('2');
    await viewedBanner.getByRole('button', { name: /^Devices/ }).click();
    await expect(viewedBanner.getByRole('group', { name: 'Connected devices' }).locator('li')).toHaveCount(2);
    await viewedBanner.getByRole('button', { name: 'Disconnect all', exact: true }).click();
    await expect(viewedBanner).toHaveCount(0);
    for (const ended of twoSessions) {
      await expectEndedFrame(invoke('session.frame', { sessionId: ended.sessionId }), ownerEndedMessages);
      await invoke('session.end', { sessionId: ended.sessionId });
    }
    await expect.poll(async () => (await invoke<any>('status')).sessions.filter((entry: any) => entry.direction === 'incoming').length).toBe(0);
    await invoke('device.revoke', { deviceId: incoming.id });
    await expect(invoke('session.start', { deviceId: outgoing.id, viewOnly: true })).rejects.toThrow();
    await expect(invoke('pair', { invite: invitation })).rejects.toThrow();
    await expect(invoke('arbitrary.shell', { command: 'whoami' })).rejects.toThrow(/Unknown/);
    expect(errors).toEqual([]);
    mark('terminal and revocation assertions complete');
    if (hiddenWindows) expect(await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()))).toBe(true);
  } finally {
    mark('closing own application');
    await application.close();
    mark('own application closed');
    // Keep only an application log on failure in the OS temporary folder; no real identity was used.
  }
});
