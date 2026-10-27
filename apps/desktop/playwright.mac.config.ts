import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /mac(?:-ui)?\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
