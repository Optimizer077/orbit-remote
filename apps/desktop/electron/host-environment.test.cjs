'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hostEnvironment } = require('./host-environment.cjs');

const options = { controlToken: 'token', dataDirectory: '/profile/host', controlPort: 47831 };

test('packaged app drops the experimental short-code switch from the inherited environment', () => {
  const inherited = { PATH: '/bin', ORBIT_EXPERIMENTAL_SHORT_CODE: '1', orbit_experimental_short_code: '1', Orbit_Experimental_Short_Code: '1' };
  const environment = hostEnvironment(inherited, { ...options, packaged: true });
  assert.equal(Object.keys(environment).some(name => name.toUpperCase() === 'ORBIT_EXPERIMENTAL_SHORT_CODE'), false);
  assert.equal(environment.PATH, '/bin');
  assert.equal(inherited.ORBIT_EXPERIMENTAL_SHORT_CODE, '1', 'the caller environment is not mutated');
});

test('development runs keep the experimental switch for local testing', () => {
  const environment = hostEnvironment({ ORBIT_EXPERIMENTAL_SHORT_CODE: '1' }, { ...options, packaged: false });
  assert.equal(environment.ORBIT_EXPERIMENTAL_SHORT_CODE, '1');
});

test('main process builds the host child environment through the packaged-aware helper', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'main.cjs'), 'utf8');
  assert.match(source, /env: hostEnvironment\(process\.env, \{ packaged: app\.isPackaged,/);
  assert.doesNotMatch(source, /env: \{ \.\.\.process\.env/);
});

test('owned-host settings always override inherited values', () => {
  const environment = hostEnvironment({ ORBIT_CONTROL_TOKEN: 'stale', ORBIT_PARENT_PROOF: '0' }, { ...options, packaged: true });
  assert.deepEqual(
    [environment.ORBIT_CONTROL_TOKEN, environment.ORBIT_DATA_DIR, environment.ORBIT_CONTROL_PORT, environment.ORBIT_PARENT_WATCH, environment.ORBIT_PARENT_PROOF],
    ['token', '/profile/host', '47831', '1', '1']);
});
