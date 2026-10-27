import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test.skip(process.platform !== 'darwin', 'Requires native macOS.');

test('Mac UI v2: native appearance, Cmd+K, Retina HUD, popouts and menu template metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-mac-ui-v2-'));
  const snapshots = path.resolve('../../artifacts/mac-ui-v2');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const packaged = process.env.ORBIT_MAC_TEST_APP;
  const application = await electron.launch({
    ...(packaged ? { executablePath: path.join(packaged, 'Contents/MacOS/Orbit Remote') } : {}),
    args: packaged ? ['--background'] : ['.', '--background'], cwd: process.cwd(),
    env: { ...environment, ORBIT_APP_DATA: directory, ORBIT_LOOPBACK_TEST: '1',
      ORBIT_CONTROL_PORT: '47981', ORBIT_REMOTE_PORT: '47982' },
  });
  const originalAppearance = await application.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
  try {
    const page = await application.firstWindow();
    await page.emulateMedia({ colorScheme: null });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const invoke = <T,>(action: string, payload?: unknown) => page.evaluate(
      ({ action, payload }) => window.orbit!.invoke(action, payload), { action, payload }) as Promise<T>;
    const initialStatus = await invoke<any>('status');
    test.skip(initialStatus.sessionState !== 'interactive', 'Unlock the Mac locally before live viewer and native UI checks.');
    await application.evaluate(({ app, BrowserWindow, screen }) => {
      const area = screen.getPrimaryDisplay().workArea;
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: area.x + 16, y: area.y + 16, width: Math.min(1440, area.width - 32), height: Math.min(900, area.height - 32) });
      window.show(); app.focus({ steal: true }); window.focus();
    });
    await invoke('settings.update', { hostName: 'Orbit Mac UI test' });
    await page.getByRole('button', { name: 'Refresh host and check device availability', exact: true }).click();
    await expect(page.locator('.local-user strong')).toHaveText('Orbit Mac UI test');
    await fs.mkdir(snapshots, { recursive: true });
    await fs.rm(path.join(snapshots, 'native-menu-icon.png'), { force: true });
    // App-scoped native appearance changes exercise Electron/Chromium's real
    // media-query propagation without modifying the user's global macOS theme.
    for (const [appearance, resolved] of [['light', 'daylight'], ['dark', 'graphite']] as const) {
      await application.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, appearance);
      await expect(page.locator('html')).toHaveAttribute('data-theme', resolved);
    }
    for (const [name, value] of [['Daylight', 'daylight'], ['Graphite', 'graphite'], ['Midnight', 'midnight'], ['Paper', 'paper']]) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: `Use ${name} theme`, exact: true }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', value);
      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      const geometry = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }));
      const png = await page.screenshot({ path: path.join(snapshots, `${value}.png`), animations: 'disabled', scale: 'device' });
      expect(geometry.ratio).toBeGreaterThanOrEqual(2);
      expect(png.readUInt32BE(16)).toBe(Math.round(geometry.width * geometry.ratio));
      expect(await page.locator('.nav-item').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    }
    await page.keyboard.press('Meta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true });
    await expect(palette).toBeVisible();
    await page.locator('[data-command-palette-input]').fill('Theme: Match system');
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('orbit.theme'))).toBe('system');
    await application.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'daylight');

    const status = await invoke<any>('status');
    expect(status.capabilities.capture).toBe(true);
    const invite = await invoke<any>('invite.create', { deviceName: 'Mac UI controller',
      permissions: { view: true, control: true, clipboard: false, files: false, power: false } });
    await invoke('pair', { invite: invite.invite });
    await page.getByRole('button', { name: 'Refresh host and check device availability', exact: true }).click();
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await page.locator('[data-command-palette-input]').fill('Connect to Orbit Mac UI test');
    await expect(palette.getByRole('option').filter({ hasText: 'Connect to Orbit Mac UI test' })).toBeVisible();
    await page.keyboard.press('Enter');
    const viewer = page.locator('.remote-viewer');
    const primary = status.capabilities.monitors.find((monitor: any) => monitor.primary) || status.capabilities.monitors[0];
    await expect(viewer.locator('canvas[role="img"]')).toBeVisible();
    await expect.poll(() => viewer.locator('canvas[role="img"]').evaluate(element => (element as HTMLCanvasElement).width)).toBe(primary.width);
    await expect.poll(() => viewer.locator('canvas[role="img"]').evaluate(element => (element as HTMLCanvasElement).height)).toBe(primary.height);
    await expect(page.locator('.hud-live')).toBeVisible();
    const active = (await invoke<any>('status')).sessions.find((entry: any) => entry.direction === 'outgoing');
    const cursor = await application.evaluate(({ screen }) => {
      const point = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(point);
      return { monitorId: String(display.id), x: (point.x - display.bounds.x) / display.bounds.width,
        y: (point.y - display.bounds.y) / display.bounds.height };
    });

    // Exercise the actual native menu image without storing the surrounding
    // screen. The screenshot contains only this temporary tray icon's bounds.
    const tray = await application.evaluateHandle(({ app, nativeImage, Tray }) => {
      const image = nativeImage.createFromPath((app.isPackaged ? process.resourcesPath + '/icons' : app.getAppPath() + '/build/icons') + '/trayTemplate.png');
      image.setTemplateImage(true);
      const item = new Tray(image);
      item.setTitle('Orbit test'); item.setToolTip('Orbit native menu icon validation');
      return { tray: item, size: image.getSize(), scales: image.getScaleFactors(), template: image.isTemplateImage() };
    });
    try {
      await expect.poll(() => tray.evaluate(value => value.tray.getBounds().height), { timeout: 10_000 }).toBeGreaterThan(0);
      const metadata = await tray.evaluate(value => ({ size: value.size, scales: value.scales, template: value.template, bounds: value.tray.getBounds() }));
      expect(metadata.size).toEqual({ width: 16, height: 16 });
      expect(metadata.scales).toEqual(expect.arrayContaining([1, 2]));
      expect(metadata.template).toBe(true);
      expect(metadata.bounds.width).toBeGreaterThan(0);
      if (process.env.ORBIT_MAC_TEST_MENU_CAPTURE === '1') {
      const display = await application.evaluate(({ screen }, value) => {
        const selected = screen.getDisplayMatching(value.tray.getBounds());
        return { id: String(selected.id), bounds: selected.bounds };
      }, tray);
      const monitors = (await invoke<any>('status')).capabilities.monitors;
      const index = monitors.findIndex((monitor: any) => monitor.id === display.id);
      expect(index).toBeGreaterThanOrEqual(0);
      // Reveal an auto-hidden menu bar without clicking any menu or touching a
      // screen corner. The normal viewer remains in local-keyboard mode.
      await invoke('session.frame', { sessionId: active.id, monitorId: display.id });
      await invoke('session.input', { sessionId: active.id, monitorId: display.id,
        event: { type: 'pointer.move', x: 0.3, y: 1 / display.bounds.height } });
      await expect.poll(() => tray.evaluate((value, area) => {
        const current = value.tray.getBounds();
        return current.width > 0 && current.height > 0 && current.x >= area.x && current.y >= area.y &&
          current.x + current.width <= area.x + area.width && current.y + current.height <= area.y + area.height;
      }, display.bounds), { timeout: 10_000 }).toBe(true);
      let visibleBounds = await tray.evaluate(value => value.tray.getBounds());
      // macOS can expose a collapsed status-item proxy at this rectangle.
      // Clicking our test item's reported location reveals that overflow UI;
      // a normal test item has no click action or context menu attached.
      for (const down of [true, false]) await invoke('session.input', { sessionId: active.id, monitorId: display.id,
        event: { type: 'pointer.button', button: 0, down,
          x: (visibleBounds.x + visibleBounds.width / 2 - display.bounds.x) / display.bounds.width,
          y: (visibleBounds.y + visibleBounds.height / 2 - display.bounds.y) / display.bounds.height } });
      visibleBounds = await tray.evaluate(value => value.tray.getBounds());
      const temporaryImage = path.join(directory, 'transient-menu-display.png');
      try {
        // The backend's display-index path also handles negative monitor
        // origins, which screencapture -R does not. Delete the transient full
        // image immediately; only the icon crop is retained as evidence.
        execFileSync('/usr/sbin/screencapture', ['-x', '-t', 'png', '-D', String(index + 1), temporaryImage]);
        const png = await application.evaluate(({ nativeImage }, value) => {
          const image = nativeImage.createFromBuffer(Buffer.from(value.png, 'base64'));
          const size = image.getSize();
          const sx = size.width / value.display.width, sy = size.height / value.display.height;
          const crop = { x: Math.round((value.icon.x - value.display.x) * sx),
            y: Math.round((value.icon.y - value.display.y) * sy), width: Math.round(value.icon.width * sx),
            height: Math.round(value.icon.height * sy) };
          if (image.isEmpty() || crop.x < 0 || crop.y < 0 || crop.x + crop.width > size.width || crop.y + crop.height > size.height)
            throw new Error('Native menu icon is outside the selected display: ' + JSON.stringify({ size, crop }));
          const cropped = image.crop(crop);
          const bitmap = cropped.toBitmap();
          let low = 255, high = 0;
          for (let index = 0; index < bitmap.length; index += 4) {
            const luminance = (bitmap[index] + bitmap[index + 1] + bitmap[index + 2]) / 3;
            low = Math.min(low, luminance); high = Math.max(high, luminance);
          }
          return { png: cropped.toPNG().toString('base64'), contrastRange: high - low };
        }, { png: (await fs.readFile(temporaryImage)).toString('base64'), display: display.bounds, icon: visibleBounds });
        expect(png.contrastRange, 'The native icon crop must contain a visible glyph, not only a hidden-menu backdrop.').toBeGreaterThan(90);
        expect(Buffer.from(png.png, 'base64').length).toBeGreaterThan(64);
        await fs.writeFile(path.join(snapshots, 'native-menu-position-probe.png'), Buffer.from(png.png, 'base64'));
      } finally { await fs.rm(temporaryImage, { force: true }); }
      }
    } finally {
      if (process.env.ORBIT_MAC_TEST_MENU_CAPTURE === '1') {
      for (const down of [true, false]) await invoke('session.input', { sessionId: active.id,
        event: { type: 'key', code: 'Escape', down } }).catch(() => {});
      await invoke('session.frame', { sessionId: active.id, monitorId: cursor.monitorId }).then(() =>
        invoke('session.input', { sessionId: active.id, monitorId: cursor.monitorId,
          event: { type: 'pointer.move', x: cursor.x, y: cursor.y } })).catch(() => {});
      }
      await tray.evaluate(value => value.tray.destroy()); await tray.dispose();
    }
    const nextWindow = application.waitForEvent('window');
    await page.getByRole('button', { name: 'Open screen in window', exact: true }).click();
    const popup = await nextWindow;
    await expect(popup.locator('.remote-viewer canvas[role="img"]')).toBeVisible();
    await expect.poll(() => popup.locator('.remote-viewer canvas[role="img"]').evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(1);
    await expect(popup.getByRole('combobox', { name: 'Remote monitor' })).toBeDisabled();
    const popupFits = await popup.locator('.session-statusbar').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1);
    expect(popupFits).toBe(true);
    // Hide both renderer surfaces before saving UI evidence, including the
    // incoming binary-frame canvas path. Desktop pixels must stay in memory.
    await popup.addStyleTag({ content: '.remote-viewer img,.remote-viewer canvas{visibility:hidden!important}.remote-viewer{background:#14232b!important}' });
    await popup.screenshot({ path: path.join(snapshots, 'popup-hud-sanitized.png'), animations: 'disabled' });
    await popup.getByRole('button', { name: 'Close screen', exact: true }).click();
    await expect(palette).toBeHidden();

    // Isolate only this UI-shortcut probe from native injection. Otherwise a
    // loopback viewer feeds its own Cmd+K back into the same desktop. The pinned
    // Electron test instance retains the real handler for every other action;
    // mac.spec.ts separately exercises actual native input in test windows.
    const inputProbe = await application.evaluateHandle(({ ipcMain }, sessionId) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: any[]) => any> })._invokeHandlers;
      const original = handlers.get('orbit:invoke');
      if (!original) throw new Error('The pinned Electron IPC handler is unavailable to the UI test.');
      let keyK = 0, escape = 0;
      ipcMain.removeHandler('orbit:invoke');
      ipcMain.handle('orbit:invoke', (event, action, payload) => {
        if (action === 'session.input' && payload?.sessionId === sessionId) {
          if (payload.event?.code === 'KeyK') keyK++;
          if (payload.event?.code === 'Escape') escape++;
          return { ok: true };
        }
        return original(event, action, payload);
      });
      return { count: () => keyK, escapes: () => escape, restore: () => { ipcMain.removeHandler('orbit:invoke'); ipcMain.handle('orbit:invoke', original); } };
    }, active.id);
    try {
      await page.locator('.hud').hover({ position: { x: 30, y: 20 } });
      await page.getByRole('button', { name: 'Take control', exact: true }).click();
      await expect(viewer).toHaveClass(/controlling/);
      await expect(palette).toBeHidden();
      await viewer.focus();
      await page.keyboard.press('Meta+k');
      await expect(palette).toBeHidden();
      await expect.poll(() => inputProbe.evaluate(value => value.count())).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      await expect.poll(() => inputProbe.evaluate(value => value.escapes())).toBeGreaterThan(0);
      await expect(viewer).toHaveClass(/controlling/);
      await page.locator('.hud').hover({ position: { x: 30, y: 20 } });
      await page.getByRole('button', { name: 'Control enabled', exact: true }).click();
      await expect(viewer).not.toHaveClass(/controlling/);
    } finally { await inputProbe.evaluate(value => value.restore()); await inputProbe.dispose(); }
    await application.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0].focus(); });
    await viewer.focus();
    await page.keyboard.press('Meta+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    const receiving = (await invoke<any>('status')).sessions.find((entry: any) => entry.direction === 'incoming');
    await invoke('session.end', { sessionId: receiving.id });
    await expect(page.locator('.hud-ended')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'This session has ended.', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    console.log(`Mac UI v2 passed: native appearance, four 2x themes, palette, real-frame HUD/popout, safe control shortcut boundary, menu-template metadata; live menu glyph needs manual review; packaged=${!!packaged}`);
  } finally {
    await application.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, originalAppearance).catch(() => {});
    await application.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
