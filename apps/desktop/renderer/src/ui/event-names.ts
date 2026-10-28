// Plain names for the events the host records with AddAudit (HostState.cs, Program.cs, FileEndpoints.cs,
// WakeDisplayEndpoints.cs). Shared by Overview and Activity so both pages use the same wording.
export const EVENT_NAMES: Readonly<Record<string, string>> = {
  'session.started': 'Connection started',
  'session.ended': 'Connection ended',
  'sessions.disconnected': 'Everyone disconnected',
  'device.paired': 'Computer paired',
  'device.revoked': 'Access removed',
  'device.blocked_by_owner': 'Access paused by you',
  'device.allowed_by_owner': 'Allowed again by you',
  'invite.created': 'Invite created',
  'identity.rotated': 'Identity replaced',
  'settings.changed': 'Settings changed',
  'host.started': 'Orbit started',
  'file.upload': 'File received',
  'file.download': 'File sent',
  'power.lock': 'Locked remotely',
  'power.restart.requested': 'Restart requested',
  'display.wake.requested': 'Screen wake requested',
  'display.wake.outcome': 'Screen wake result',
};

/** A plain name for a host event; unknown actions fall back to a readable form of the action. */
export function eventName(action: string): string {
  return EVENT_NAMES[action] || action.replace(/[._-]/g, ' ').replace(/^\w/, char => char.toUpperCase());
}

/** Events about who may connect and what they may do (Activity's "Access & security" filter). */
export const SECURITY_EVENT = /pair|invite|revok|denied|auth|permission|block|allow|identity|settings/i;
