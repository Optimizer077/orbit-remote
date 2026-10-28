'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Keeps the Daylight and Graphite tokens at WCAG AA contrast with distinguishable status colours.
test('bold themes keep WCAG AA contrast and colour-blind status separation', () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, '../tests/theme-contrast.cjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
