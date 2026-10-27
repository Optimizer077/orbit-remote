export type RemoteInputEvent = Record<string, unknown>;

/** One move per animation frame; discrete input preserves its order after the latest preceding move. */
export class FrameInputCoalescer {
  private pending: RemoteInputEvent | undefined;
  private frame: number | undefined;
  private dispatch: (event: RemoteInputEvent) => void;
  private request: (callback: () => void) => number;
  private cancelFrame: (frame: number) => void;
  constructor(dispatch: (event: RemoteInputEvent) => void, request: (callback: () => void) => number, cancel: (frame: number) => void) {
    this.dispatch = dispatch; this.request = request; this.cancelFrame = cancel;
  }
  move(event: RemoteInputEvent) {
    this.pending = event;
    if (this.frame === undefined) this.frame = this.request(() => { this.frame = undefined; const latest = this.pending; this.pending = undefined; if (latest) this.dispatch(latest); });
  }
  immediate(event: RemoteInputEvent) {
    this.flush(); this.dispatch(event);
  }
  flush() {
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined;
    const latest = this.pending; this.pending = undefined;
    if (latest) this.dispatch(latest);
  }
  /** Blur, release or geometry/epoch change drops a pending move instead of sending stale input. */
  cancel() {
    if (this.frame !== undefined) this.cancelFrame(this.frame);
    this.frame = undefined; this.pending = undefined;
  }
}
