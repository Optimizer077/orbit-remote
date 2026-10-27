'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { markDownloaded } = require('./mark-of-web.cjs');

test('Windows downloads get Zone.Identifier ZoneId=3 on NTFS', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-motw-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'report.pdf'); await fs.writeFile(file, 'x');
  assert.equal(await markDownloaded(file), true);
  assert.match(await fs.readFile(file + ':Zone.Identifier', 'utf8'), /\[ZoneTransfer\]\r\nZoneId=3/);
  assert.equal(await fs.readFile(file, 'utf8'), 'x');
});
test('macOS downloads get a com.apple.quarantine attribute', async () => {
  const calls = [];
  assert.equal(await markDownloaded('/tmp/a.zip', { platform: 'darwin', now: () => 0x65000000 * 1000, run: async (...args) => calls.push(args) }), true);
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;65000000;Orbit Remote;', '/tmp/a.zip']]);
});
test('a file system without streams or attributes leaves the saved file alone', async () => {
  assert.equal(await markDownloaded('x', { platform: 'win32', writeFile: async () => { throw new Error('EINVAL'); } }), false);
  assert.equal(await markDownloaded('x', { platform: 'darwin', run: async () => { throw new Error('ENOTSUP'); } }), false);
  assert.equal(await markDownloaded('x', { platform: 'linux' }), false);
});
