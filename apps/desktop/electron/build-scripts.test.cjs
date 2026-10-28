'use strict';
// Security review D-8: both release build scripts refuse ORBIT_UNFUSED_TEST_BUILD=1 before doing any work.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scripts = path.resolve(__dirname, '../../../scripts');

test('each release build script refuses the unfused test build before restoring or publishing', () => {
  for (const [name, refusal] of [['build.ps1', /\$env:ORBIT_UNFUSED_TEST_BUILD -eq '1'\) \{ throw /], ['build.sh', /ORBIT_UNFUSED_TEST_BUILD:-\}" == 1 \]\]/]]) {
    const source = fs.readFileSync(path.join(scripts, name), 'utf8');
    const match = refusal.exec(source);
    assert.ok(match, name + ' refuses ORBIT_UNFUSED_TEST_BUILD=1');
    for (const step of ['electron-builder', 'package:win']) {
      const index = source.indexOf(step);
      if (index !== -1) assert.ok(match.index < index, `${name} refuses before ${step}`);
    }
  }
  const powershell = fs.readFileSync(path.join(scripts, 'build.ps1'), 'utf8');
  assert.ok(powershell.indexOf('ORBIT_UNFUSED_TEST_BUILD') < powershell.indexOf('dotnet restore'), 'build.ps1 refuses before any host build');
});

test('build.ps1 stops with the refusal when ORBIT_UNFUSED_TEST_BUILD=1', { skip: process.platform !== 'win32' && 'Windows PowerShell only' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scripts, 'build.ps1'), '-SkipInstall'],
    { env: { ...process.env, ORBIT_UNFUSED_TEST_BUILD: '1' }, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /builds a test-only app without security fuses/);
  assert.doesNotMatch(result.stdout + result.stderr, /Restored|Determining projects/, 'no dotnet step ran');
});
