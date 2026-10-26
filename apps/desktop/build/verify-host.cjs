'use strict';
const fs = require('node:fs');
const path = require('node:path');

function binaryRuntime(binary) {
  if (binary.length < 64) throw new Error('Native host executable is truncated.');
  if (binary[0] === 0x4d && binary[1] === 0x5a) {
    const offset = binary.readUInt32LE(0x3c);
    if (offset + 6 > binary.length || binary.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('Invalid Windows host executable.');
    return { 0x8664: 'win-x64', 0xaa64: 'win-arm64' }[binary.readUInt16LE(offset + 4)];
  }
  if (binary.readUInt32LE(0) === 0xfeedfacf) return { 0x01000007: 'osx-x64', 0x0100000c: 'osx-arm64' }[binary.readUInt32LE(4)];
  if (binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && binary[4] === 2 && binary[5] === 1) {
    return { 0x3e: 'linux-x64', 0xb7: 'linux-arm64' }[binary.readUInt16LE(18)];
  }
  throw new Error('Unrecognized native host executable format.');
}

function verifyHostBundle(directory, runtime, version) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(directory, 'build-info.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('Native host build metadata is missing. Run scripts/build.ps1 or bash scripts/build.sh before packaging.'); }
  if (info.runtime !== runtime || info.version !== version || info.configuration !== 'Release' || info.selfContained !== true) {
    throw new Error('Host build metadata does not match this package. Publish a self-contained Release host for ' + runtime + ' version ' + version + '.');
  }
  const executable = path.join(directory, runtime.startsWith('win-') ? 'Orbit.Host.exe' : 'Orbit.Host');
  if (binaryRuntime(fs.readFileSync(executable)) !== runtime) throw new Error('Native host binary architecture does not match ' + runtime + '.');
  for (const file of ['Orbit.Host.dll', 'Orbit.Host.deps.json', 'Orbit.Host.runtimeconfig.json']) {
    if (!fs.statSync(path.join(directory, file)).isFile()) throw new Error('Native host bundle is incomplete.');
  }
  const runtimeLibrary = runtime.startsWith('win-') ? 'hostfxr.dll' : runtime.startsWith('osx-') ? 'libhostfxr.dylib' : 'libhostfxr.so';
  if (!fs.statSync(path.join(directory, runtimeLibrary)).isFile()) throw new Error('Native host bundle must include its .NET runtime.');
  return info;
}
module.exports = { binaryRuntime, verifyHostBundle };
