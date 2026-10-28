'use strict';
// Security review D-2 and D-5: an installed release refuses Chromium debug and sandbox
// switches and ignores test variables. Generated arguments only; no app is launched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { isReleaseBuild, launchDecision, refusedSwitches, refusalMessage, noSandboxWarning, testSettings } = require('./launch-policy.cjs');
const { hostEnvironment } = require('./host-environment.cjs');

const exe = 'Orbit Remote.exe';

test('a release build refuses debug and sandbox-weakening switches in every accepted spelling', () => {
  for (const argument of ['--remote-debugging-port=9222', '--remote-debugging-pipe', '--remote-allow-origins=*', '--inspect',
    '--inspect=9229', '--inspect-brk=0', '--inspect-port=1', '--no-sandbox', '--disable-web-security', '--js-flags=--allow-natives-syntax',
    '-remote-debugging-port=9222', '--NO-SANDBOX', '--renderer-cmd-prefix=evil', '--user-data-dir=/tmp/x', '--disable-site-isolation-trials'])
    assert.notDeepEqual(refusedSwitches({ argv: [exe, argument], platform: 'linux' }), [], argument);
  assert.deepEqual(refusedSwitches({ argv: [exe, '/no-sandbox'], platform: 'win32' }), ['no-sandbox'], 'Windows also reads "/" switches');
  assert.deepEqual(refusedSwitches({ argv: [exe], hasSwitch: name => name === 'remote-debugging-port' }), ['remote-debugging-port']);
});

test('feature overrides and the Linux zygote prefix are refused', () => {
  for (const argument of ['--enable-features=Foo', '--disable-features=SitePerProcess', '--zygote-cmd-prefix=evil'])
    assert.deepEqual(refusedSwitches({ argv: [exe, argument], platform: 'linux' }), [argument.slice(2, argument.indexOf('='))]);
});

test('a Linux AppImage may start with --no-sandbox, with a warning; debugging stays refused', () => {
  const appImage = { APPIMAGE: '/home/user/Orbit-Remote.AppImage' };
  assert.deepEqual(launchDecision({ argv: [exe, '--no-sandbox'], platform: 'linux', environment: appImage }), { refused: [], warnings: ['no-sandbox'] });
  assert.deepEqual(launchDecision({ argv: [exe], hasSwitch: name => name === 'no-sandbox', platform: 'linux', environment: appImage }),
    { refused: [], warnings: ['no-sandbox'] });
  assert.deepEqual(launchDecision({ argv: [exe, '--background'], platform: 'linux', environment: appImage }), { refused: [], warnings: [] });
  for (const argument of ['--remote-debugging-port=9222', '--remote-debugging-pipe', '--inspect=0', '--js-flags=x', '--disable-setuid-sandbox', '--disable-web-security'])
    assert.deepEqual(launchDecision({ argv: [exe, '--no-sandbox', argument], platform: 'linux', environment: appImage }).refused,
      [argument.slice(2).split('=')[0]], argument);
  for (const [platform, environment] of [['linux', {}], ['linux', { APPIMAGE: '' }], ['win32', appImage], ['darwin', appImage]])
    assert.deepEqual(launchDecision({ argv: [exe, '--no-sandbox'], platform, environment }), { refused: ['no-sandbox'], warnings: [] },
      platform + ' ' + JSON.stringify(environment));
});

test('the refusal message names the switch, not its value, and says why', () => {
  const { title, message } = refusalMessage(['remote-debugging-port']);
  assert.equal(title, 'Orbit Remote did not start');
  assert.match(message, /opened with --remote-debugging-port\. For security, the installed app refuses debugging and sandbox-weakening switches/);
  assert.match(refusalMessage(['inspect', 'no-sandbox']).message, /--inspect, --no-sandbox[\s\S]*without them\.$/);
  assert.match(noSandboxWarning().message, /--no-sandbox[\s\S]*Debugging switches are still refused\./);
});

test('main shows the AppImage warning once per profile and logs it each launch', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  assert.match(source, /if \(launch\.warnings\.includes\('no-sandbox'\)\) warnNoSandboxOnce\(directory\);/);
  const body = source.slice(source.indexOf('function warnNoSandboxOnce'), source.indexOf('function createWindow'));
  assert.match(body, /console\.warn\([\s\S]*if \(fs\.existsSync\(marker\)\) return;[\s\S]*fs\.writeFileSync\(marker[\s\S]*dialog\.showMessageBox\(/);
});

test('both window types disable DevTools in a release build', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const preferences = source.match(/webPreferences: \{[^}]*\}/g);
  assert.equal(preferences.length, 2);
  for (const value of preferences) assert.match(value, /devTools: !releaseBuild/);
});

test('ordinary launches are accepted', () => {
  for (const argv of [[exe], [exe, '--background'], [exe, '-psn_0_123456'], [exe, '--background', 'C:\\Users\\me\\file.txt']])
    assert.deepEqual(refusedSwitches({ argv, platform: 'win32' }), [], JSON.stringify(argv));
  assert.deepEqual(refusedSwitches({ argv: ['--inspect'], platform: 'linux' }), [], 'argv[0] is the executable');
  // Electron 45 adds this switch to its own browser command line (probe on Windows), so it must never refuse a launch.
  assert.deepEqual(refusedSwitches({ argv: [exe], hasSwitch: name => name === 'allow-file-access-from-files' }), []);
});

test('only a packaged build without the test marker is a release', () => {
  assert.equal(isReleaseBuild(true, { version: '0.1.0' }), true);
  assert.equal(isReleaseBuild(true, { orbitTestBuild: true }), false);
  assert.equal(isReleaseBuild(true, { orbitTestBuild: 'true' }), true, 'only the exact marker counts');
  assert.equal(isReleaseBuild(false, {}), false);
});

test('a release ignores test variables; development and the test build keep them', () => {
  const environment = { ORBIT_APP_DATA: '/tmp/profile', ORBIT_CONTROL_PORT: '47931', ORBIT_LOOPBACK_TEST: '1' };
  assert.deepEqual(testSettings(environment, true), { appData: undefined, controlPort: 47831, loopbackTest: false });
  assert.deepEqual(testSettings(environment, false), { appData: '/tmp/profile', controlPort: 47931, loopbackTest: true });
});

test('a release host child inherits no ORBIT_* variable in any letter case', () => {
  const inherited = { PATH: '/bin', ORBIT_REMOTE_PORT: '1', orbit_loopback_test: '1', Orbit_App_Data: '/x', ORBIT_DIAGNOSTIC_SYNTHETIC: '1',
    ORBIT_EXPERIMENTAL_SHORT_CODE: '1', ORBIT_CONTROL_TOKEN: 'stale' };
  const options = { controlToken: 'token', dataDirectory: '/profile/host', controlPort: 47831 };
  const release = hostEnvironment(inherited, { ...options, packaged: true, release: true });
  assert.deepEqual(Object.keys(release).filter(name => /^orbit_/i.test(name)).sort(),
    ['ORBIT_CONTROL_PORT', 'ORBIT_CONTROL_TOKEN', 'ORBIT_DATA_DIR', 'ORBIT_PARENT_PROOF', 'ORBIT_PARENT_WATCH']);
  assert.equal(release.ORBIT_CONTROL_TOKEN, 'token');
  assert.equal(hostEnvironment(inherited, { ...options, packaged: true }).ORBIT_REMOTE_PORT, undefined, 'packaged defaults to release');
  const testBuild = hostEnvironment(inherited, { ...options, packaged: true, release: false });
  assert.equal(testBuild.ORBIT_REMOTE_PORT, '1');
  assert.equal(testBuild.ORBIT_EXPERIMENTAL_SHORT_CODE, undefined, 'the experimental switch stays off in any package');
  assert.equal(hostEnvironment(inherited, { ...options, packaged: false }).ORBIT_REMOTE_PORT, '1');
});

test('main applies the policy before any window, lock or host start', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, text); return index; };
  const refusal = at('if (refusedLaunch.length) {');
  assert.match(source, /const releaseBuild = isReleaseBuild\(app\.isPackaged, require\('\.\.\/package\.json'\)\);/);
  assert.match(source, /launchDecision\(\{ argv: process\.argv, hasSwitch: name => app\.commandLine\.hasSwitch\(name\),\s+platform: process\.platform, environment: process\.env \}\)/);
  assert.ok(refusal < at('app.requestSingleInstanceLock()') && refusal < at('app.whenReady()') && refusal < at('function createWindow'));
  // Every refusal is visible: the error box comes before the exit.
  const block = source.slice(refusal, source.indexOf('app.exit(1)', refusal) + 'app.exit(1)'.length);
  assert.ok(block.length < 500, 'the exit follows the refusal directly');
  assert.match(block, /refusalMessage\(refusedLaunch\)[\s\S]*dialog\.showErrorBox\(refusal\.title, refusal\.message\);[\s\S]*app\.exit\(1\)$/);
  assert.match(source, /env: hostEnvironment\(process\.env, \{ packaged: app\.isPackaged, release: releaseBuild,/);
  assert.doesNotMatch(source, /process\.env\.ORBIT_(APP_DATA|CONTROL_PORT|LOOPBACK_TEST)/, 'test variables are read only through testSettings');
});

test('only the unfused test package carries the test-build marker; release packages keep the fuses', () => {
  const load = Module._load;
  const config = unfused => {
    const previous = process.env.ORBIT_UNFUSED_TEST_BUILD;
    if (unfused) process.env.ORBIT_UNFUSED_TEST_BUILD = '1'; else delete process.env.ORBIT_UNFUSED_TEST_BUILD;
    Module._load = function (request, ...rest) { return request === 'builder-util' ? { Arch: {} } : load.call(this, request, ...rest); };
    const file = require.resolve('../electron-builder.cjs');
    try { delete require.cache[file]; return require(file); } finally {
      Module._load = load; delete require.cache[file];
      if (previous === undefined) delete process.env.ORBIT_UNFUSED_TEST_BUILD; else process.env.ORBIT_UNFUSED_TEST_BUILD = previous;
    }
  };
  const release = config(false), testBuild = config(true);
  assert.equal(release.extraMetadata?.orbitTestBuild, undefined);
  assert.equal(release.electronFuses.runAsNode, false);
  assert.equal(release.electronFuses.enableNodeOptionsEnvironmentVariable, false);
  assert.equal(release.electronFuses.enableNodeCliInspectArguments, false);
  assert.equal(testBuild.extraMetadata.orbitTestBuild, true);
  assert.equal(testBuild.electronFuses, undefined);
  // D-6: while the renderer loads from file://, this fuse must stay on. An Electron 45 probe with it off left the
  // window empty and refused the module worker ("cannot be accessed from origin 'null'").
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  if (/mainWindow\.loadFile\(/.test(main)) assert.notEqual(release.electronFuses.grantFileProtocolExtraPrivileges, false);
});
