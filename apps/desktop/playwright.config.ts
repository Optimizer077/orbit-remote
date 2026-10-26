import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // tests/lab is a node:test suite (npm run test:lab), not Playwright specs.
  testIgnore: ['**/lab/**'],
  timeout: 90_000,
  workers: 1,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
