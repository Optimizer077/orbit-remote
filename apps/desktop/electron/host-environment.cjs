'use strict';

// Experimental host switches a developer may set from the shell. An installed
// app must never inherit them from the user's environment.
const DEVELOPMENT_ONLY = ['ORBIT_EXPERIMENTAL_SHORT_CODE'];

// Builds the owned host child's environment. Windows variable names are
// case-insensitive, so names are removed in any letter case. A release build
// passes on no inherited ORBIT_* variable at all (for example ORBIT_REMOTE_PORT
// or ORBIT_LOOPBACK_TEST); the host gets only the values main sets below.
// `release` defaults to `packaged`; the unfused end-to-end test build is packaged
// but not a release, and keeps its test variables.
function hostEnvironment(baseEnvironment, { packaged, release = packaged, controlToken, dataDirectory, controlPort }) {
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    const upper = name.toUpperCase();
    if ((packaged && DEVELOPMENT_ONLY.includes(upper)) || (release && upper.startsWith('ORBIT_'))) delete environment[name];
  }
  return { ...environment, ORBIT_CONTROL_TOKEN: controlToken, ORBIT_DATA_DIR: dataDirectory,
    ORBIT_CONTROL_PORT: String(controlPort), ORBIT_PARENT_WATCH: '1', ORBIT_PARENT_PROOF: '1' };
}

module.exports = { hostEnvironment, DEVELOPMENT_ONLY };
