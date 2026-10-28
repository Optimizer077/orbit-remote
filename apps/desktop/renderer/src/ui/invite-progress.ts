// Invite dialog progress: time left on an invite and which computer just joined.
// Kept free of runtime imports so Node's unit tests load it directly.
import type { Device, Invite } from '../api';

/** Host invites are single-use and valid for five minutes (HostState.CreateInvite). */
export const INVITE_LIFETIME_MS = 5 * 60_000;

/**
 * Milliseconds until the invite expires: never negative and never above the invite
 * lifetime (a clock ahead of this one cannot show more than 5:00). Null when unknown.
 */
export function inviteRemaining(expiresAt: string | undefined, now: number): number | null {
  const at = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(at) ? Math.min(INVITE_LIFETIME_MS, Math.max(0, at - now)) : null;
}

/** "4:32" for 272 000 ms. Rounds up so the label reaches 0:00 only when the invite has expired. */
export function countdownLabel(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const isActiveIncoming = (device: Device) => device.direction === 'incoming' && device.revoked !== true && device.status !== 'revoked';

/**
 * The first active incoming pairing made after this invite was created. Both times come
 * from the host's clock: pairedAt is the pairing's creation time, and the invite was
 * created INVITE_LIFETIME_MS before it expires. A re-pair keeps its id but gets a new
 * pairedAt, so it counts; devices paired earlier never do, whatever the device list
 * looked like when the invite was created.
 */
export function newlyJoined(invite: Pick<Invite, 'expiresAt'>, devices: readonly Device[]): Device | undefined {
  const expires = Date.parse(invite.expiresAt ?? '');
  if (!Number.isFinite(expires)) return undefined;
  const createdAt = expires - INVITE_LIFETIME_MS;
  return devices.find(device => isActiveIncoming(device) && Date.parse(device.pairedAt ?? '') >= createdAt);
}
