import { useEffect, useRef, useState } from 'react';
import { observeWindowState } from '../stream/window-state';
import { windowHiddenTracker } from './window-hidden-tracker';

/** Background status refresh cadence while the window is on screen. */
export const HOST_POLL_MS = { viewed: 4000, idle: 15000 } as const;

/** Milliseconds between background refreshes, or null while the native window is minimized or hidden. */
export function hostPollDelay(hidden: boolean, viewed: boolean): number | null {
  if (hidden) return null;
  return viewed ? HOST_POLL_MS.viewed : HOST_POLL_MS.idle;
}

/**
 * True while main reports this native window minimized or hidden (for example, closed to the tray).
 * `onShown` runs when it comes back on screen. Without native window state, or if the first query fails,
 * the window counts as shown, so callers keep their usual behaviour; a late failure never undoes a received state.
 */
export function useWindowHidden(onShown?: () => void): boolean {
  const [hidden, setHidden] = useState(false);
  const shown = useRef(onShown); shown.current = onShown;
  useEffect(() => {
    const bridge = window.orbit;
    if (!bridge?.onWindowState) return;
    const tracker = windowHiddenTracker(setHidden, () => shown.current?.());
    return observeWindowState({ invoke: bridge.invoke, onWindowState: bridge.onWindowState },
      state => tracker.state(state.paused), () => tracker.queryFailed());
  }, []);
  return hidden;
}

/**
 * Calls `refresh` every 4 s while another computer is viewing this one, else every 15 s, but only while the
 * native window is on screen. Minimized or hidden to the tray, nobody can read the page, so it stops polling;
 * main still sends incoming-session and runtime changes, which the caller handles separately. When the window
 * is shown again it refreshes at once and resumes the cadence.
 */
export function useHostPolling(refresh: () => void, viewed: boolean) {
  const latest = useRef(refresh); latest.current = refresh;
  const hidden = useWindowHidden(() => latest.current());
  const delay = hostPollDelay(hidden, viewed);
  useEffect(() => {
    if (delay === null) return;
    const timer = window.setInterval(() => latest.current(), delay);
    return () => window.clearInterval(timer);
  }, [delay]);
}
