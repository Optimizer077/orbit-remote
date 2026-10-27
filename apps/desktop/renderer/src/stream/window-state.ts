export type WindowVisibility = { paused: boolean; reason: 'minimized' | 'hidden' | null; revision: number };
export type WindowStateBridge = {
  invoke(action: string): Promise<unknown>;
  onWindowState(callback: (state: unknown) => void): () => void;
};
/** Invalidates callbacks synchronously, before React can clean up an effect. */
export class DeliveryGate {
  private token: object | undefined;
  begin() { const token = {}; this.token = token; return () => this.token === token; }
  invalidate() { this.token = undefined; }
}
type Geometry = { width: number; height: number; left?: number; top?: number };
export type ControlContext = { sessionId: string; sessionGeneration?: number; monitorId: string; frame: Geometry | null; enabled: boolean; allowed: boolean; viewOnly: boolean; ended: boolean };

/** Restoring a window never replays held input or grants control on a new target. */
export class RememberedControl {
  private previous?: { sessionId: string; sessionGeneration: number; monitorId: string; width: number; height: number; left: number; top: number };
  pause(context: ControlContext) {
    this.previous = undefined;
    const frame = context.frame;
    if (context.enabled && context.allowed && !context.viewOnly && !context.ended && frame && frame.width > 0 && frame.height > 0
      && Number.isSafeInteger(context.sessionGeneration) && (context.sessionGeneration as number) >= 0)
      this.previous = { sessionId: context.sessionId, sessionGeneration: context.sessionGeneration as number, monitorId: context.monitorId, width: frame.width, height: frame.height, left: frame.left || 0, top: frame.top || 0 };
  }
  invalidate() { this.previous = undefined; }
  /** Call only after a new frame has actually been drawn, once per restore. */
  freshFrame(context: ControlContext): boolean {
    const previous = this.previous; this.previous = undefined;
    return !!previous && context.allowed && !context.viewOnly && !context.ended && !!context.frame
      && context.sessionId === previous.sessionId && context.monitorId === previous.monitorId
      && context.sessionGeneration === previous.sessionGeneration
      && context.frame.width === previous.width && context.frame.height === previous.height
      && (context.frame.left || 0) === previous.left && (context.frame.top || 0) === previous.top;
  }
}

/** An initial query can finish after a newer native event; it must not undo it. */
export class WindowStateTracker {
  private state: WindowVisibility = { paused: true, reason: 'hidden', revision: -1 };
  accept(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const next = value as Record<string, unknown>;
    if (typeof next.paused !== 'boolean' || !Number.isSafeInteger(next.revision) || (next.revision as number) < 0
      || (next.paused ? next.reason !== 'minimized' && next.reason !== 'hidden' : next.reason !== null)
      || (next.revision as number) <= this.state.revision) return false;
    this.state = { paused: next.paused, reason: next.reason as WindowVisibility['reason'], revision: next.revision as number };
    return true;
  }
  snapshot(): WindowVisibility { return { ...this.state }; }
}

/** Shared state machine for native IPC and the classified stream-port pause. */
export class WindowPlaybackState {
  readonly delivery = new DeliveryGate();
  private tracker = new WindowStateTracker();
  private remembered = new RememberedControl();
  private state: WindowVisibility;
  private ended = false;
  constructor(initiallyPaused = true) { this.state = { paused: initiallyPaused, reason: initiallyPaused ? 'hidden' : null, revision: -1 }; }
  receive(value: unknown, context: ControlContext) {
    if (!this.tracker.accept(value)) return null;
    const next = this.tracker.snapshot(), wasPaused = this.state.paused;
    this.state = next;
    if (this.ended || context.ended) { this.end(); return { state: next, transition: 'none' as const }; }
    if (next.paused && !wasPaused) {
      this.remembered.pause(context); this.delivery.invalidate();
      return { state: next, transition: 'paused' as const };
    }
    if (!next.paused && wasPaused) { this.delivery.invalidate(); return { state: next, transition: 'resumed' as const }; }
    return { state: next, transition: 'none' as const };
  }
  freshFrame(context: ControlContext, isCurrent: () => boolean) {
    return !this.ended && !this.state.paused && isCurrent() && this.remembered.freshFrame(context);
  }
  clearControl() { this.remembered.invalidate(); }
  end() { this.ended = true; this.remembered.invalidate(); this.delivery.invalidate(); }
}

/** Subscribe first, then query. Only the fixed preload callback supplies events. */
export function observeWindowState(bridge: WindowStateBridge, callback: (state: WindowVisibility) => void, onError: () => void, tracker = new WindowStateTracker()) {
  let closed = false;
  const receive = (value: unknown) => { if (!closed && tracker.accept(value)) callback(tracker.snapshot()); };
  const unsubscribe = bridge.onWindowState(receive);
  void bridge.invoke('window.state').then(receive).catch(() => { if (!closed) onError(); });
  return () => { closed = true; unsubscribe(); };
}
