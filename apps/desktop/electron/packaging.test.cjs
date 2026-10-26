'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { binaryRuntime, verifyHostBundle } = require('../build/verify-host.cjs');

function binary(runtime) {
  const data = Buffer.alloc(256);
  if (runtime.startsWith('win')) {
    data.write('MZ'); data.writeUInt32LE(128, 0x3c); data.write('PE\0\0', 128);
    data.writeUInt16LE(runtime.endsWith('arm64') ? 0xaa64 : 0x8664, 132);
  } else if (runtime.startsWith('osx')) {
    data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(runtime.endsWith('arm64') ? 0x0100000c : 0x01000007, 4);
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(data);
    data.writeUInt16LE(runtime.endsWith('arm64') ? 0xb7 : 0x3e, 18);
  }
  return data;
}

test('packaging identifies native PE, Mach-O and ELF architectures', () => {
  for (const runtime of ['win-x64', 'win-arm64', 'osx-x64', 'osx-arm64', 'linux-x64', 'linux-arm64']) assert.equal(binaryRuntime(binary(runtime)), runtime);
  assert.throws(() => binaryRuntime(Buffer.from('broken')), /truncated/);
});

test('packaging refuses wrong OS, CPU, version or a host without its runtime', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-package-test-'));
  t.after(async () => {
    if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'orbit-package-test-'))) throw new Error('Unexpected test directory.');
    await fs.rm(directory, { recursive: true, force: true });
  });
  const metadata = { runtime: 'win-x64', version: '0.1.0', configuration: 'Release', selfContained: true };
  const metadataPath = path.join(directory, 'build-info.json');
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  for (const filename of ['Orbit.Host.dll', 'Orbit.Host.deps.json', 'Orbit.Host.runtimeconfig.json', 'hostfxr.dll']) await fs.writeFile(path.join(directory, filename), 'test-only');
  await fs.writeFile(path.join(directory, 'Orbit.Host.exe'), binary('win-x64'));
  assert.equal(verifyHostBundle(directory, 'win-x64', '0.1.0').runtime, 'win-x64');
  assert.throws(() => verifyHostBundle(directory, 'osx-arm64', '0.1.0'), /metadata/);
  assert.throws(() => verifyHostBundle(directory, 'win-x64', '0.2.0'), /metadata/);
  await fs.writeFile(path.join(directory, 'Orbit.Host.exe'), binary('win-arm64'));
  assert.throws(() => verifyHostBundle(directory, 'win-x64', '0.1.0'), /architecture/);
  await fs.writeFile(path.join(directory, 'Orbit.Host.exe'), binary('win-x64'));
  await fs.unlink(path.join(directory, 'hostfxr.dll'));
  assert.throws(() => verifyHostBundle(directory, 'win-x64', '0.1.0'));
});
