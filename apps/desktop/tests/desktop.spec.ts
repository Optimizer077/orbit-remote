import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

test('real desktop host: onboarding, pairing, native frames, settings and revocation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-electron-test-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.ORBIT_E2E_PACKAGED === '1';
  const application = await electron.launch({
    ...(packaged ? { executablePath: path.resolve('release/preview/win-unpacked/Orbit Remote.exe') } : {}),
    args: packaged ? ['--background'] : ['.', '--background'], cwd: process.cwd(),
    env: { ...environment, ORBIT_LOOPBACK_TEST: '1', ORBIT_APP_DATA: directory,
      ORBIT_CONTROL_PORT: '47931', ORBIT_REMOTE_PORT: '47932' },
  });
  try {
    const page = await application.firstWindow();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.getByRole('button', { name: 'Add a device', exact: true })).toBeVisible();
    await expect(page.getByText('Local test mode', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Meet your other computer.' })).toBeVisible();
    const invoke = <T,>(action: string, payload?: unknown) => page.evaluate(
      ({ action, payload }) => window.orbit!.invoke(action, payload), { action, payload }) as Promise<T>;
    const status = await invoke<any>('status');
    expect(status.host.name).toBeTruthy();
    expect(status.host.testMode).toBe(true);
    expect(status.capabilities.capture).toBe(true);
    expect(status.capabilities.monitors.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Orbit Remote.', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project on GitHub', exact: true })).toBeEnabled();
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
    const frame = await invoke<any>('session.frame', { sessionId: session.sessionId });
    expect(frame.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
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
      const nextWindow = application.waitForEvent('window');
      await invoke('viewer.open', { sessionId: session.sessionId, monitorId: primaryMonitor.id });
      const screen = await nextWindow;
      screen.on('pageerror', error => errors.push(error.message));
      await expect(screen.getByRole('button', { name: 'Close screen', exact: true })).toBeVisible();
      await expect(screen.getByRole('combobox', { name: 'Remote monitor', exact: true })).toBeDisabled();
      await expect(screen.getByRole('combobox', { name: 'Remote monitor', exact: true })).toHaveValue(primaryMonitor.id);
      await expect.poll(() => screen.locator('.remote-viewer img').evaluateAll(images => images.length > 0 && (images[0] as HTMLImageElement).naturalWidth > 0)).toBe(true);
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
    expect(recoveredFrame.width).toBe(frame.width);
    expect((await invoke<any>('status')).host.fingerprint).toBe(beforeRestart.host.fingerprint);
    // No keyboard, pointer, clipboard write, lock or restart is executed on the user's desktop.
    await expect(invoke('session.input', { sessionId: session.sessionId, event: { type: 'key', code: 'KeyA', down: true } })).rejects.toThrow(/view only/);
    const reopenedScreen = await openScreen();
    const ownerClosedScreen = reopenedScreen.waitForEvent('close');
    await invoke('session.end', { sessionId: session.sessionId });
    await ownerClosedScreen;
    await expect(invoke('session.frame', { sessionId: session.sessionId })).rejects.toThrow(/session has ended/i);

    // A deliberate host-side stop is terminal. Verify the actual viewer stops, rather than
    // treating this as the supervisor/crash recovery path tested above.
    await page.getByRole('button', { name: 'Manage Orbit workstation', exact: true }).first().click();
    await page.getByRole('button', { name: 'View only', exact: true }).click();
    await expect.poll(() => page.locator('.remote-viewer img').evaluateAll(images => images.length > 0 && (images[0] as HTMLImageElement).naturalWidth > 0)).toBe(true);
    const activeBeforeStop = (await invoke<any>('status')).sessions;
    const hostSide = activeBeforeStop.find((entry: any) => entry.direction === 'incoming');
    const viewerSide = activeBeforeStop.find((entry: any) => entry.direction === 'outgoing');
    expect(hostSide?.id).toBeTruthy();
    expect(viewerSide?.id).toBeTruthy();
    await expect(viewedBanner).toBeVisible();
    await viewedBanner.getByRole('button', { name: 'End session with Orbit workstation', exact: true }).click();
    await expect(invoke('session.frame', { sessionId: viewerSide.id })).rejects.toThrow(/ended by host/i);
    await expect(page.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
    await expect(page.locator('.session-identity')).toContainText('Session ended');
    await expect(page.locator('.session-statusbar .link-status')).toHaveText('Connection ended');
    await expect(page.locator('.session-identity')).not.toContainText('Reconnecting');
    await expect(page.locator('.remote-viewer img')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'View only', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Open screen in window', exact: true })).toBeDisabled();
    await expect(page.getByText('Choose Disconnect, then Connect to start a new session. Orbit will not reconnect to this ended session.', { exact: true })).toBeVisible();
    const unchangedUntil = Date.now() + 650;
    while (Date.now() < unchangedUntil) {
      expect((await invoke<any>('status')).sessions.filter((entry: any) => entry.direction === 'incoming')).toEqual([]);
      await page.waitForTimeout(100);
    }
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No active connection', exact: true })).toBeVisible();
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
      await expect(invoke('session.frame', { sessionId: ended.sessionId })).rejects.toThrow(/ended by host|session has ended/i);
      await invoke('session.end', { sessionId: ended.sessionId });
    }
    await expect.poll(async () => (await invoke<any>('status')).sessions.filter((entry: any) => entry.direction === 'incoming').length).toBe(0);
    await invoke('device.revoke', { deviceId: incoming.id });
    await expect(invoke('session.start', { deviceId: outgoing.id, viewOnly: true })).rejects.toThrow();
    await expect(invoke('pair', { invite: invitation })).rejects.toThrow();
    await expect(invoke('arbitrary.shell', { command: 'whoami' })).rejects.toThrow(/Unknown/);
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    // Keep only an application log on failure in the OS temporary folder; no real identity was used.
  }
});
