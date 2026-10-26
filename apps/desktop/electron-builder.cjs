'use strict';
const path = require('node:path');
const { Arch } = require('builder-util');
const { verifyHostBundle } = require('./build/verify-host.cjs');

const prefixes = { win32: 'win', darwin: 'osx', linux: 'linux' };
const runtime = process.env.ORBIT_HOST_RUNTIME || prefixes[process.platform] + '-' + process.arch;
if (!/^(win|osx|linux)-(x64|arm64)$/.test(runtime)) throw new Error('Unsupported native host runtime: ' + runtime);
const hostDirectory = path.resolve(__dirname, '../../artifacts/host', runtime);

module.exports = {
  appId: 'dev.orbit.remote', productName: 'Orbit Remote',
  directories: { output: process.env.ORBIT_PACKAGE_OUTPUT || 'release/preview', buildResources: 'build' },
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!electron/*.test.cjs', '!electron/test-fixtures/**/*'],
  extraResources: [
    { from: hostDirectory, to: 'host' },
    { from: 'build/icons', to: 'icons', filter: ['icon.png', 'tray*.png'] },
  ],
  beforePack(context) {
    verifyHostBundle(hostDirectory, prefixes[context.electronPlatformName] + '-' + Arch[context.arch], context.packager.appInfo.version);
  },
  win: { target: ['nsis', 'portable'], icon: 'build/icons/icon.ico', requestedExecutionLevel: 'asInvoker' },
  nsis: {
    artifactName: 'Orbit-Remote-Setup-${version}-${arch}.${ext}',
    oneClick: true, perMachine: false, packElevateHelper: false,
    runAfterFinish: false, deleteAppDataOnUninstall: false,
    createDesktopShortcut: false, createStartMenuShortcut: true,
  },
  portable: { artifactName: 'Orbit-Remote-Portable-${version}-${arch}.${ext}', requestExecutionLevel: 'user' },
  mac: {
    target: ['dmg'], icon: 'build/icons/icon.icns', category: 'public.app-category.productivity',
    artifactName: 'Orbit-Remote-${version}-${arch}.${ext}',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    binaries: ['Contents/Resources/host/Orbit.Host'],
    darkModeSupport: true,
    // A local preview can be ad-hoc signed without pretending to be a Developer
    // ID release. Hardened library validation requires a real shared Team ID.
    ...(process.env.ORBIT_MAC_ADHOC_SIGN === '1' ? { identity: '-', hardenedRuntime: false, notarize: false } : {}),
  },
  linux: { target: ['AppImage', 'deb'], icon: 'build/icons/icon.png', category: 'Network', artifactName: 'Orbit-Remote-${version}-${arch}.${ext}' },
};
