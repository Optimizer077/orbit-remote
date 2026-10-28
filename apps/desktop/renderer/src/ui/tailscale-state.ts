import type { HostStatus } from '../api';

type Tailscale = Partial<HostStatus['host']['tailscale']>;
export type TailscaleProblem = 'off' | 'not-found' | 'unknown';

/**
 * Why Tailscale is not usable on this computer, or null when it is connected or in test mode.
 * Uses the host's stable `state` (TailscaleNetwork.cs). Older hosts omit it: there "available" only
 * means the host found the Tailscale CLI, and its fixed text for a failed status call means "unknown"
 * (the same reading as the top bar's label in App.tsx).
 */
export function tailscaleProblem(tailscale?: Tailscale | null): TailscaleProblem | null {
  if (!tailscale || tailscale.connected === true) return null;
  switch (tailscale.state) {
    case 'connected': case 'loopback-test': return null;
    case 'off': case 'not-found': case 'unknown': return tailscale.state;
  }
  if (tailscale.available === false) return 'not-found';
  return /could not verify tailscale status/i.test(tailscale.error || '') ? 'unknown' : 'off';
}

/** Plain wording for each problem: a short state, a title, the exact fix, and a status line. */
export const TAILSCALE_FIX: Record<TailscaleProblem, { state: string; title: string; fix: string; line: string; step: string }> = {
  'not-found': {
    state: 'Not installed', title: 'Tailscale isn’t installed', step: 'Not installed here',
    fix: 'Install Tailscale on this computer, open it and sign in. Orbit uses it as a private link between your computers.',
    line: 'Tailscale isn’t installed on this computer',
  },
  off: {
    state: 'Not connected', title: 'Tailscale is off', step: 'Off here',
    fix: 'Open Tailscale on this computer and sign in. Orbit uses it to reach your other computers.',
    line: 'Tailscale is off on this computer',
  },
  unknown: {
    state: 'Unknown', title: 'Couldn’t check Tailscale', step: 'Couldn’t check here',
    fix: 'Orbit couldn’t read Tailscale’s status. Open Tailscale and make sure you are signed in, then check again.',
    line: 'Orbit couldn’t check Tailscale on this computer',
  },
};

/** The pairing dialog's one-line notice: the cause, then the fix. Both computers need Tailscale. */
export function pairingTailscaleNotice(problem: TailscaleProblem | null) {
  const lead = problem === 'not-found' ? 'Tailscale isn’t installed on this computer. Install it, open it and sign in.'
    : problem === 'unknown' ? 'Orbit couldn’t check Tailscale on this computer. Open Tailscale and make sure you are signed in.'
    : 'Tailscale is off on this computer. Open Tailscale and sign in.';
  return `${lead} Both computers need it to find each other.`;
}
