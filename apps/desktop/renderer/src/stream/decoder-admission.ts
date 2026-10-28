import { MAX_PENDING_FRAMES } from './decoder-engine.ts';

/**
 * Records the decoder Worker admits before it returns credit (S2). Electron main posts one record per credit and holds
 * the rest in its bounded queue, so at most this many records are ever between main and the decoder. Must equal
 * VIDEO_CREDIT_WINDOW in electron/stream-session.cjs, which rejects any credit that would exceed it.
 */
export const VIDEO_CREDIT_WINDOW = 3;
/**
 * Units the window may have posted to the Worker and not yet seen presented, superseded or dropped: the decoder's own
 * cap, the credit window and the one decoded frame waiting for display, plus the same margin of three as before the
 * window. Must equal MAX_UNCONSUMED_UNITS in electron/stream-session.cjs.
 */
export const MAX_CLIENT_PENDING = MAX_PENDING_FRAMES + VIDEO_CREDIT_WINDOW + 1 + 3;

type AdmissionOptions<T> = {
  window: number;
  /** Handles one message; reports its own failures. The next message starts only after this settles. */
  handle(message: T): Promise<void>;
  /** Returns `count` credits to the sender. */
  credit(count: number): void;
  /** The sender exceeded the credit it was given. Admission stops for good. */
  violation(): void;
};

/** In-order admission of up to `window` messages, one credit back per handled message. */
export class AdmissionQueue<T> {
  private readonly options: AdmissionOptions<T>;
  private readonly items: T[] = [];
  private draining = false;
  private closed = false;
  constructor(options: AdmissionOptions<T>) {
    if (!Number.isInteger(options.window) || options.window < 1) throw new Error('Invalid admission window.');
    this.options = options;
  }
  /** Grants the whole window once, before any message can arrive. */
  open() { if (!this.closed) this.options.credit(this.options.window); }
  /** Admitted and not yet handled, including the one being handled. */
  get size() { return this.items.length; }
  push(message: T) {
    if (this.closed) return;
    if (this.items.length >= this.options.window) { this.close(); this.options.violation(); return; }
    this.items.push(message);
    if (!this.draining) void this.drain();
  }
  close() { this.closed = true; this.items.length = 0; }
  private async drain() {
    this.draining = true;
    try {
      while (this.items.length && !this.closed) {
        try { await this.options.handle(this.items[0]); } catch { /* handle() reports its own faults. */ }
        this.items.shift();
        if (!this.closed) this.options.credit(1);
      }
    } finally { this.draining = false; }
  }
}
