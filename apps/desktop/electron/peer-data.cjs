'use strict';
// Everything a paired host sends is untrusted: a modified host is not bound by
// its own validation. Main checks type, length and characters here before any
// such value is stored in connections.json or reaches a window.

// Mirrors Security.IsSafeDisplayText on the host: no control characters (Cc),
// unpaired surrogates (Cs), line or paragraph separators (Zl, Zp), and no
// format characters (Cf: bidi embedding/override/isolate, zero-width space,
// word joiner, BOM, ...) except ZWNJ, ZWJ, LRM and RLM (U+200C to U+200F).
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]|(?![\u200C-\u200F])\p{Cf}/u;
const UNSAFE_DISPLAY_ALL = new RegExp(UNSAFE_DISPLAY.source, 'gu');
const NAME_LIMIT = 80; // HostState.cs: host and device names are 1 to 80 characters.
const MONITOR_LIMIT = 32;
const FILE_LIMIT = 500; // FileEndpoints.cs lists at most 500 files.
const DEVICE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
// Windows device names, with or without an extension. Matches ReservedDeviceNames in the host's
// Security.ValidateFileName (H-10): COM0/LPT0, the superscript forms, CONIN$, CONOUT$ and CLOCK$.
const RESERVED_DEVICES = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])$/;

function isSafeDisplayText(value) {
  return typeof value === 'string' && !UNSAFE_DISPLAY.test(value);
}

// A safe display string of 1 to `limit` UTF-16 units that is not only spaces, or null.
function displayText(value, limit = NAME_LIMIT) {
  return typeof value === 'string' && value.length <= limit && value.trim() !== '' && isSafeDisplayText(value) ? value : null;
}

// Free text such as a remote error message: unsafe characters become spaces and the
// result is cut to `limit` code points. Returns undefined when nothing readable is left.
function neutralText(value, limit = 500) {
  if (typeof value !== 'string') return undefined;
  const text = Array.from(value.slice(0, limit * 2).replace(UNSAFE_DISPLAY_ALL, ' ')).slice(0, limit).join('').trim();
  return text || undefined;
}

// The renderer shows only these names; anything else is "unknown".
function platformName(value) {
  if (typeof value !== 'string' || value.length > 64) return 'unknown';
  if (/darwin|mac/i.test(value)) return 'macOS';
  if (/win/i.test(value)) return 'Windows';
  if (/linux/i.test(value)) return 'Linux';
  return 'unknown';
}

function permissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return { view: value.view === true, control: value.control === true, clipboard: value.clipboard === true,
    files: value.files === true, power: value.power === true };
}

function timestamp(value) {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function deviceId(value) {
  return typeof value === 'string' && DEVICE_ID.test(value) ? value : null;
}

// Remote monitors: known fields only, a bounded identifier and integer geometry.
// Entries without a usable ID, or with a repeated one, are dropped; a bad name gets
// a neutral label and an invalid geometry field is left out. Input coordinates come
// from frame headers, not from this list.
function monitors(value) {
  if (!Array.isArray(value)) return [];
  const result = [], seen = new Set();
  const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  for (const monitor of value.slice(0, MONITOR_LIMIT)) {
    if (!monitor || typeof monitor !== 'object') continue;
    const id = displayText(monitor.id, 256);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = { id, name: displayText(monitor.name, 128) || 'Display ' + (result.length + 1) };
    for (const key of ['left', 'top']) if (integer(monitor[key], -1_000_000, 1_000_000)) entry[key] = monitor[key];
    for (const key of ['width', 'height']) if (integer(monitor[key], 1, 100_000)) entry[key] = monitor[key];
    entry.primary = monitor.primary === true;
    result.push(entry);
  }
  return result;
}

// A remote file name that is safe to show and to offer in a save dialog: the
// display rule above, no path or Windows-invalid characters, no trailing dot or
// space, and no reserved device name. Mirrors Security.ValidateFileName on the host.
function isSafeFileName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 180 && value !== '.' && value !== '..'
    && isSafeDisplayText(value) && !/[\\/:*?"<>|]/.test(value) && !/[. ]$/.test(value) && !isReservedFileName(value);
}

// Legacy Win32 path parsing ignores trailing spaces and dots before the extension, so
// "CON .txt" and "NUL. .log" still name a device. Same stem rule as the host.
function isReservedFileName(value) {
  return RESERVED_DEVICES.test(value.split('.')[0].replace(/[ .]+$/, '').toUpperCase());
}

// Remote file listing: entries with unsafe names are refused, not renamed, so a
// download always asks for exactly the name the host listed.
function fileEntries(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : [];
  const result = [];
  for (const entry of list.slice(0, FILE_LIMIT)) {
    if (!entry || typeof entry !== 'object' || !isSafeFileName(entry.name)) continue;
    const size = Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : undefined;
    const modifiedAt = timestamp(entry.modifiedAt);
    result.push({ name: entry.name, ...(size !== undefined ? { size } : {}), ...(modifiedAt ? { modifiedAt } : {}) });
  }
  return result;
}

// One saved outgoing device. Address and pin are checked by the caller (a bad
// one fails closed). Display fields are repaired; an invalid ID drops the entry.
function savedDevice(device) {
  if (!device || typeof device !== 'object' || Array.isArray(device)) return null;
  const id = deviceId(device.id);
  if (!id) return null;
  const result = { id, name: displayText(device.name) || 'Remote device', platform: platformName(device.platform),
    address: device.address, fingerprint: device.fingerprint };
  if (device.serverFingerprint !== undefined) result.serverFingerprint = device.serverFingerprint;
  const granted = permissions(device.permissions);
  if (granted) result.permissions = granted;
  for (const key of ['pairedAt', 'lastSeen']) { const at = timestamp(device[key]); if (at) result[key] = at; }
  if (typeof device.online === 'boolean') result.online = device.online;
  if (device.revoked === true) {
    result.revoked = true;
    result.statusReason = displayText(device.statusReason, 200) || 'Access revoked by the host.';
  }
  return result;
}

module.exports = { isSafeDisplayText, displayText, neutralText, platformName, permissions, deviceId, monitors,
  isSafeFileName, isReservedFileName, fileEntries, savedDevice, NAME_LIMIT };
