'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const environment = { ...process.env };
// Some development hosts run Electron as their Node runtime. That setting must
// not propagate to the desktop application, which needs Chromium's GUI process.
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), ['.', ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '..'), env: environment, windowsHide: true, stdio: 'inherit',
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
process.on('SIGINT', () => child.kill());
