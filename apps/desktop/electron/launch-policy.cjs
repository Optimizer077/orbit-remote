'use strict';
// Launch policy for an installed (release) build. The Electron fuses turn off
// ELECTRON_RUN_AS_NODE, NODE_OPTIONS and Node's --inspect, but not Chromium's own
// switches. A same-user process could otherwise relaunch Orbit with a debugger or
// a weakened sandbox and act as Orbit, including its macOS privacy grants.

// Exact switch names (lower case, without the leading dashes).
const REFUSED_SWITCHES = new Set([
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-brk-node', 'inspect-publish-uid', 'debug', 'debug-brk', 'wait-for-debugger',
  'js-flags', 'no-sandbox', 'disable-web-security', 'disable-site-isolation-trials', 'disable-setuid-sandbox',
  'disable-gpu-sandbox', 'no-zygote', 'allow-running-insecure-content', 'unsafely-treat-insecure-origin-as-secure', 'user-data-dir',
  // Feature overrides can switch off site isolation or sandbox features. A normal Orbit launch never sets
  // them (Electron 45 probe; Orbit appends none, and its Linux host is X11-only, so no Wayland flags).
  'enable-features', 'disable-features',
  // Not --allow-file-access-from-files: Electron adds it to its own command line while the
  // GrantFileProtocolExtraPrivileges fuse is on, so refusing it would refuse every launch.
  // These start a chosen program as a child process of Orbit.
  'renderer-cmd-prefix', 'gpu-launcher', 'utility-cmd-prefix', 'browser-subprocess-path', 'zygote-cmd-prefix',
]);
const REFUSED_PREFIXES = ['inspect', 'remote-debugging'];

// The unfused end-to-end test build carries this marker in its packaged
// package.json (electron-builder extraMetadata). Release builds never do, and
// asar integrity stops it being added to one afterwards.
function isReleaseBuild(packaged, packageInfo) {
  return packaged === true && packageInfo?.orbitTestBuild !== true;
}

// Chromium reads switches with a "--" or "-" prefix, and also "/" on Windows; on
// Windows names are case-insensitive. Returns the refused names found, if any.
// One exception, on Linux only: an AppImage on Ubuntu 24.04 and later usually starts
// only with --no-sandbox because AppArmor restricts unprivileged user namespaces. When
// running as an AppImage (APPIMAGE is set), --no-sandbox is allowed with a warning.
// Debug and remote-debugging switches are refused on every platform.
function launchDecision({ argv = [], hasSwitch = () => false, platform = process.platform, environment = {} } = {}) {
  const found = collectSwitches({ argv, hasSwitch, platform });
  const appImage = platform === 'linux' && typeof environment.APPIMAGE === 'string' && environment.APPIMAGE !== '';
  const warnings = appImage && found.includes('no-sandbox') ? ['no-sandbox'] : [];
  return { refused: found.filter(name => !warnings.includes(name)), warnings };
}

function refusedSwitches(options) {
  return launchDecision(options).refused;
}

function collectSwitches({ argv, hasSwitch, platform }) {
  const found = new Set();
  for (const name of REFUSED_SWITCHES) if (hasSwitch(name)) found.add(name);
  for (const name of REFUSED_PREFIXES) if (hasSwitch(name)) found.add(name);
  const prefix = platform === 'win32' ? /^(?:--|-|\/)([^=\s]+)/ : /^(?:--|-)([^=\s]+)/;
  for (const argument of argv.slice(1)) {
    const match = typeof argument === 'string' ? prefix.exec(argument) : null;
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (REFUSED_SWITCHES.has(name) || REFUSED_PREFIXES.some(start => name.startsWith(start))) found.add(name);
  }
  return [...found];
}

// Test and development switches read from the environment. A release build
// ignores them: they move the profile, the local control port, or put the host
// into loopback test mode.
function testSettings(environment, release) {
  const source = release ? {} : environment;
  return { appData: source.ORBIT_APP_DATA || undefined, controlPort: Number(source.ORBIT_CONTROL_PORT || 47831),
    loopbackTest: source.ORBIT_LOOPBACK_TEST === '1' };
}

// What a refused launch shows before it exits. Names only; never a switch value.
function refusalMessage(refused) {
  const list = refused.map(name => '--' + name).join(', ');
  return { title: 'Orbit Remote did not start',
    message: `Orbit Remote was opened with ${list}. For security, the installed app refuses debugging and ` +
      `sandbox-weakening switches, because they could let another program control Orbit. Start Orbit Remote without ${refused.length === 1 ? 'it' : 'them'}.` };
}

// Shown once per profile when an AppImage runs with --no-sandbox.
function noSandboxWarning() {
  return { title: 'Orbit Remote is running without the Chromium sandbox',
    message: 'This AppImage was started with --no-sandbox, which Ubuntu 24.04 and later usually require for AppImages. ' +
      'Orbit works, but its windows lose a layer of protection. Where possible, use the Debian package, which installs ' +
      'Chromium\u2019s sandbox helper. Debugging switches are still refused.' };
}

module.exports = { isReleaseBuild, launchDecision, refusedSwitches, refusalMessage, noSandboxWarning, testSettings, REFUSED_SWITCHES };
