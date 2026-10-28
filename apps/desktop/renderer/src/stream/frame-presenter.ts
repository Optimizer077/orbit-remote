/** Longest a decoded frame waits for an animation frame before it is drawn anyway (rAF throttled or stopped). */
export const PRESENT_FALLBACK_MS = 50;
/**
 * Draw the newest frame at once, once per display refresh, instead of waiting for the next animation frame,
 * when nothing newer is pending. A steady stream then gains no wait, and a burst's last frame is drawn as soon as it is
 * decoded; frames with a newer one on its way, or a second frame in the same refresh, wait for rAF (S2 measurement).
 */
export const DRAW_WHEN_IDLE = true;

type PresenterOptions<T> = {
  /** This Worker's requestAnimationFrame. Absent when the Worker has none: every frame is then drawn when decoded. */
  animationFrame?: (callback: () => void) => void;
  timer?: (callback: () => void, ms: number) => void;
  now?: () => number;
  /**
   * A newer frame is already on its way (queued in the decoder, decoded-but-undelivered, or admitted and not yet
   * decoded). Then the offered frame is not the newest the viewer can have, so it waits for rAF and may be superseded.
   */
  newerPending?: () => boolean;
  /** Draws one frame. The presenter closes the frame afterwards, also when this throws. */
  draw(frame: VideoFrame, meta: T): void;
  /** A decoded frame was replaced by a newer one before it could be drawn. Its VideoFrame is already closed. */
  superseded(meta: T): void;
  drawWhenIdle?: boolean;
};

/**
 * Display side of the decoder. Every access unit is still decoded, so reference frames stay intact. Per display
 * refresh, display draws at most one waiting frame on requestAnimationFrame (always the newest) plus at most one frame
 * at once: the newest frame there is (nothing newer pending), in a refresh with no earlier immediate draw. A frame
 * replaced before it was drawn is closed at once and reported as superseded, which is normal pacing, not a drop.
 */
export class FramePresenter<T> {
  private readonly options: PresenterOptions<T>;
  private readonly timer: (callback: () => void, ms: number) => void;
  private readonly now: () => number;
  /**
   * The waiting frame and when the display slot became occupied since the last draw. A newer frame that supersedes it
   * keeps that time, so a stopped rAF cannot starve display while frames keep replacing each other.
   */
  private held?: { frame: VideoFrame; meta: T; since: number };
  /** A frame was drawn at once (outside requestAnimationFrame) since the last animation frame callback. */
  private drewThisFrame = false;
  private frameRequested = false;
  private fallbackArmed = false;
  private closed = false;

  constructor(options: PresenterOptions<T>) {
    this.options = options;
    this.timer = options.timer ?? ((callback, ms) => { setTimeout(callback, ms); });
    this.now = options.now ?? (() => performance.now());
  }

  /** Takes ownership of `frame`, also when this throws. */
  offer(frame: VideoFrame, meta: T) {
    if (this.closed) { frame.close(); return; }
    let since: number | undefined;
    try { since = this.supersede(); }
    catch (error) { frame.close(); throw error; }
    // One immediate draw per refresh, and only for the newest frame there is. A rAF draw of a frame that turned out not
    // to be the newest does not block it: a burst's last frame is never held behind its own earlier frames.
    if (!this.options.animationFrame) { this.draw(frame, meta); return; }
    if ((this.options.drawWhenIdle ?? DRAW_WHEN_IDLE) && !this.drewThisFrame && this.options.newerPending?.() !== true) {
      this.drewThisFrame = true; this.draw(frame, meta); return;
    }
    this.held = { frame, meta, since: since ?? this.now() };
    this.request();
    this.armFallback(PRESENT_FALLBACK_MS);
  }

  /** Closes a frame waiting for display without drawing or reporting it, and returns its metadata (decoder reset). */
  clear(): T | undefined {
    const held = this.held; this.held = undefined;
    held?.frame.close();
    return held?.meta;
  }

  close() { this.closed = true; this.clear(); }

  /** Closes and reports the waiting frame; returns when its slot became occupied. */
  private supersede(): number | undefined {
    const held = this.held; if (!held) return undefined;
    this.held = undefined; held.frame.close(); this.options.superseded(held.meta);
    return held.since;
  }

  private draw(frame: VideoFrame, meta: T) {
    try { this.options.draw(frame, meta); }
    finally {
      frame.close();
      // Learn when this display refresh ends, so the next frame knows whether it may draw at once.
      if (this.options.animationFrame) this.request();
    }
  }

  private drawHeld() {
    const held = this.held; this.held = undefined;
    if (held && !this.closed) this.draw(held.frame, held.meta);
  }

  private request() {
    if (this.frameRequested || this.closed) return;
    this.frameRequested = true;
    this.options.animationFrame!(() => { this.frameRequested = false; this.drewThisFrame = false; this.drawHeld(); });
  }

  private armFallback(ms: number) {
    if (this.fallbackArmed) return;
    this.fallbackArmed = true;
    this.timer(() => {
      this.fallbackArmed = false;
      if (!this.held || this.closed) return;
      // A timer armed for an earlier, already drawn frame must not draw this one early: wait out its own remainder.
      const waited = this.now() - this.held.since;
      if (waited < PRESENT_FALLBACK_MS) { this.armFallback(PRESENT_FALLBACK_MS - waited); return; }
      this.drawHeld();
    }, ms);
  }
}
