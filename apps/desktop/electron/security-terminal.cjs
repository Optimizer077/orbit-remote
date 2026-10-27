'use strict';

// These reasons invalidate any remembered ordinary-host-stop reconnect target.
// Ordinary session ends remain separate from a revoked security grant.
const IDENTITY_TERMINAL = new Set(['pin_mismatch', 'identity_mismatch']);
const IDENTITY_CHANGED_MESSAGE = "This device's identity changed. Forget it, then pair again.";
const SECURITY_TERMINAL = new Set(['access_revoked', 'permission_changed', 'identity_rotated', ...IDENTITY_TERMINAL]);

module.exports = { SECURITY_TERMINAL, IDENTITY_TERMINAL, IDENTITY_CHANGED_MESSAGE };
