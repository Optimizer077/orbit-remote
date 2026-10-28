// Plain-language wording for pairing and connection failures. Each result says
// what happened and the one thing to do next; the original text stays available
// as details. Kept free of runtime imports so Node's unit tests load it directly.

export type FriendlyError = { title: string; action: string; details: string };
type Wording = { title: string; action: string };

/** What the renderer already knows about this computer, used to pick the right cause. */
export type ErrorContext = { tailscaleConnected?: boolean; identityExpired?: boolean };

type Rule = { codes?: readonly string[]; codesWithoutStatus?: readonly string[]; status?: number; text?: RegExp; wording: Wording | ((context: ErrorContext) => Wording) };

// Errors thrown in Electron's main process reach the renderer as text only, wrapped
// in this prefix; codes and statuses survive only when main returns them as data.
const IPC_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;

export const TAILSCALE_OFF: Wording = { title: 'Tailscale is off on this computer.', action: 'Open Tailscale and sign in, then choose “Tailscale is on now — check again”.' };
export const IDENTITY_EXPIRED: Wording = { title: 'This computer’s identity has expired.', action: 'Replace it under Settings → Identity, then pair again.' };
export const IDENTITY_ROTATING: Wording = { title: 'This computer is replacing its identity.', action: 'Wait a moment, then try again.' };

/**
 * The host refuses remote listening for three reasons. Tailscale being off is the only one
 * a Tailscale check can fix, so the renderer's own state picks the cause.
 */
export function remoteListeningWording(context: ErrorContext): Wording {
  if (context.tailscaleConnected === false) return TAILSCALE_OFF;
  if (context.identityExpired === true) return IDENTITY_EXPIRED;
  return IDENTITY_ROTATING;
}

const RULES: readonly Rule[] = [
  // Same condition as errorMessage(): a local identity check, not an HTTP reply.
  { codesWithoutStatus: ['pin_mismatch', 'identity_mismatch'], text: /identity changed/i, wording: {
    title: 'The other computer’s identity changed.',
    action: 'Forget it under Devices, then pair again with a new invite from that computer.' } },
  { text: /Remote listening is (?:unavailable|disabled)/i, wording: remoteListeningWording },
  { text: /validity is unexpectedly long|certificate is expired or not yet valid/i, wording: {
    title: 'The two computers’ clocks may not match.',
    action: 'Check the date, time and time zone on both computers, then create a new invite and try again. If the clocks are right, the other computer may need to replace its identity under Settings → Identity.' } },
  // Checked on this computer against its own clock before anything is sent.
  { text: /invitation has expired/i, wording: {
    title: 'This invite can’t be used anymore.',
    action: 'On the computer you want to see, open Orbit and create a new invite. Then paste the new one here. If a new invite also fails, check both computers’ date and time.' } },
  { text: /invite expired|already (?:been )?used/i, wording: {
    title: 'This invite can’t be used anymore.',
    action: 'On the computer you want to see, open Orbit and create a new invite. Then paste the new one here.' } },
  { text: /complete Orbit pairing invitation|invitation is invalid|unsupported pairing invitation/i, wording: {
    title: 'That doesn’t look like a complete invite.',
    action: 'On the other computer, copy the whole invite again and paste all of it here.' } },
  { status: 401, text: /\(401\)|access revoked/i, wording: {
    title: 'This computer no longer has access.',
    action: 'Ask for a new invite from the other computer and pair again.' } },
  { codes: ['ORBIT_REQUEST_TIMEOUT', 'ORBIT_TLS_HANDSHAKE_TIMEOUT', 'ORBIT_REQUEST_DEADLINE', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN'],
    text: /timed out|deadline exceeded|\b(?:ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN)\b/i, wording: {
      title: 'The other computer didn’t answer.',
      action: 'On the other computer, check that Orbit is open, the screen is unlocked, and Tailscale is on. Then try again.' } },
];

const FALLBACK: Wording = { title: 'Something went wrong.', action: 'Try again. If it keeps happening, restart Orbit on both computers.' };

/** The original error text, without Electron's IPC wrapper. */
export function rawErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error ?? '');
  return text.replace(IPC_PREFIX, '').trim() || 'No further details.';
}

export function friendlyError(error: unknown, context: ErrorContext = {}): FriendlyError {
  const details = rawErrorText(error);
  const fields = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown } : {};
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const status = typeof fields.status === 'number' ? fields.status : undefined;
  const rule = RULES.find(item => (code !== undefined && item.codes?.includes(code))
    || (code !== undefined && status === undefined && item.codesWithoutStatus?.includes(code))
    || (status !== undefined && item.status === status) || item.text?.test(details));
  const wording = !rule ? FALLBACK : typeof rule.wording === 'function' ? rule.wording(context) : rule.wording;
  return { title: wording.title, action: wording.action, details };
}

export type RecheckOutcome = { tone: 'success' | 'problem'; message: string };

/**
 * What to tell the owner after "Tailscale is on now — check again", decided from the
 * refreshed status rather than the supervisor state. `refused` is the main-process
 * reason for not restarting; `hostOnline` is whether the host listens remotely.
 */
export function recheckOutcome({ refused, tailscaleConnected, identityExpired, hostOnline, stopped, pending }: { refused?: string; tailscaleConnected?: boolean; identityExpired?: boolean; hostOnline?: boolean; stopped?: boolean; pending?: boolean }): RecheckOutcome {
  const problem = (wording: Wording): RecheckOutcome => ({ tone: 'problem', message: `${wording.title} ${wording.action}` });
  if (refused === 'too_soon') return { tone: 'problem', message: 'Orbit just checked. Wait a few seconds, then check again.' };
  if (refused === 'sessions_active') return { tone: 'problem', message: 'Another computer is connected to this one. Check again after it disconnects.' };
  if (refused === 'status_unknown') return { tone: 'problem', message: 'Orbit is still starting. Wait a moment, then check again.' };
  if (refused === 'identity_expired') return problem(IDENTITY_EXPIRED);
  if (refused === 'identity_rotating') return problem(IDENTITY_ROTATING);
  if (stopped) return { tone: 'problem', message: 'Orbit’s background service stopped. Choose Retry above, then check again.' };
  if (pending) return { tone: 'problem', message: 'Still checking for Tailscale. This page updates by itself in a moment.' };
  if (tailscaleConnected === false) return { tone: 'problem', message: 'Orbit still can’t find Tailscale. Open Tailscale, check that it says Connected, then check again.' };
  if (identityExpired === true) return problem(IDENTITY_EXPIRED);
  if (hostOnline === false) return problem(IDENTITY_ROTATING);
  if (tailscaleConnected === true) return { tone: 'success', message: 'Tailscale is connected. You can pair now.' };
  return { tone: 'problem', message: 'Still checking for Tailscale. This page updates by itself in a moment.' };
}
