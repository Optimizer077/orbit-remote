import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // tests/lab is a node:test suite (npm run test:lab), not Playwright specs.
  testIgnore: ['**/lab/**'],
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  // Native view-only checks can display a private desktop. Retain text diagnostics, not pixels.
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
