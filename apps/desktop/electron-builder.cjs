'use strict';
const path = require('node:path');
const { Arch } = require('builder-util');
const { verifyHostBundle } = require('./build/verify-host.cjs');

const prefixes = { win32: 'win', darwin: 'osx', linux: 'linux' };
const runtime = process.env.ORBIT_HOST_RUNTIME || prefixes[process.platform] + '-' + process.arch;
if (!/^(win|osx|linux)-(x64|arm64)$/.test(runtime)) throw new Error('Unsupported native host runtime: ' + runtime);
const hostDirectory = path.resolve(__dirname, '../../artifacts/host', runtime);
// Playwright attaches through --inspect, which the fuses below disable. ORBIT_UNFUSED_TEST_BUILD=1 builds a
// test-only app into its own folder; release scripts refuse it.
const unfusedTest = process.env.ORBIT_UNFUSED_TEST_BUILD === '1';

module.exports = {
  appId: 'dev.orbit.remote', productName: 'Orbit Remote',
  directories: { output: unfusedTest ? 'release/unfused-test' : process.env.ORBIT_PACKAGE_OUTPUT || 'release/preview', buildResources: 'build' },
  // Fuses: no ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect/SIGUSR1 debugger in an installed build, and app code
  // only from a packaged asar whose integrity is checked. A local process could otherwise run code as Orbit and use
  // its keys and OS permissions (a per-user install lets the same user replace app.asar).
  // GrantFileProtocolExtraPrivileges stays on: the renderer is an ES-module bundle with a module worker loaded
  // from file://. With the fuse off (Electron 45 probe) the window stays empty and the decoder worker fails with
  // "cannot be accessed from origin 'null'". Turning it off needs a custom app:// protocol first.
  // The test build is marked so main still accepts Playwright's debug switches and the ORBIT_* test variables
  // (electron/launch-policy.cjs). A release build has no marker and refuses both.
  ...(unfusedTest ? { extraMetadata: { orbitTestBuild: true } } : { electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true } }),
  files: ['dist/**/*', 'electron/**/*', 'package.json', '!electron/*.test.cjs', '!electron/test-fixtures/**/*'],
  extraResources: [
    { from: hostDirectory, to: 'host' },
    { from: 'build/icons', to: 'icons', filter: ['icon.png', 'tray*.png'] },
    // Licence notices for third-party code in the host (Bouncy Castle C#, MIT).
    { from: '../../THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
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
