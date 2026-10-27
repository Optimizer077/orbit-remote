export type FullscreenState = { fullscreen: boolean; revision: number };

/** Native fullscreen has its own revisions; it cannot change visibility or input authority. */
export class FullscreenStateTracker {
  private state: FullscreenState | null = null;
  accept(value: unknown) {
    if (!value || typeof value !== 'object') return false;
    const next = value as Record<string, unknown>;
    if (typeof next.fullscreen !== 'boolean' || !Number.isSafeInteger(next.revision) || (next.revision as number) < 0) return false;
    if (this.state && ((next.revision as number) < this.state.revision ||
      (next.revision === this.state.revision && next.fullscreen !== this.state.fullscreen))) return false;
    this.state = { fullscreen: next.fullscreen, revision: next.revision as number }; return true;
  }
  snapshot() { return this.state && { ...this.state }; }
}
