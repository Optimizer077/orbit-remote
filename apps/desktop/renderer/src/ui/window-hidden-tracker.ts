/**
 * Tracks whether the native window is hidden from main's window-state reports.
 * A failed initial query falls back to "shown" only while no state has been accepted yet: once a real state
 * arrived, a late rejection of the older query must not undo it.
 */
export function windowHiddenTracker(setHidden: (hidden: boolean) => void, onShown: () => void) {
  let accepted = false;
  let wasHidden = false;
  return {
    state(paused: boolean) {
      if (wasHidden && !paused) onShown();
      accepted = true; wasHidden = paused; setHidden(paused);
    },
    queryFailed() {
      if (accepted) return;
      wasHidden = false; setHidden(false);
    },
  };
}
