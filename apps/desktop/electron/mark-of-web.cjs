'use strict';
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// Files received from a remote device get the same "downloaded from the internet" mark a browser adds,
// so SmartScreen (Windows) and Gatekeeper (macOS) still check them when opened. Best effort: a volume
// without alternate data streams or extended attributes keeps the file unmarked rather than failing the save.
async function markDownloaded(file, { platform = process.platform, writeFile = fs.writeFile, run = promisify(execFile), now = Date.now } = {}) {
  try {
    if (platform === 'win32') {
      await writeFile(file + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n');
      return true;
    }
    if (platform === 'darwin') {
      const stamp = Math.floor(now() / 1000).toString(16);
      await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;' + stamp + ';Orbit Remote;', file], { timeout: 5000, windowsHide: true });
      return true;
    }
  } catch { /* Unsupported file system: the file stays saved. */ }
  return false;
}

module.exports = { markDownloaded };
