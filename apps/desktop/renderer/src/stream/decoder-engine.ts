import type { DecodeMode, DecoderInput, DecoderOutput, StreamConfig } from './types.ts';
import { FramePresenter } from './frame-presenter.ts';

/**
 * A decoder whose oldest undecoded frame waits longer than this is replaced (fresh keyframe). Shorter hiccups catch up on
 * their own: on Windows on ARM the hardware decoder pauses 86–254 ms now and then, and a count limit of four discarded the
 * decoder (and ~30% of frames) each time.
 */
export const DECODER_STALL_MS = 500;
/** Hard bound on undecoded work whatever its age (about 200 ms at 60 fps). */
export const MAX_PENDING_FRAMES = 12;
/** Timer coarsening tolerance: a duration this slightly negative is read as 0, anything below is invalid. */
const CLOCK_TOLERANCE_MS = .2;
type Presented = Extract<DecoderOutput, { type: 'presented' }>;
type Acceleration = 'prefer-hardware' | 'prefer-software';
const ACCELERATIONS: readonly Acceleration[] = ['prefer-hardware', 'prefer-software'];

type Dependencies = {
  post(message: DecoderOutput): void;
  now?: () => number;
  createDecoder?: (callbacks: VideoDecoderInit) => VideoDecoder;
  supports?: (config: VideoDecoderConfig) => Promise<boolean>;
  createChunk?: (value: EncodedVideoChunkInit) => EncodedVideoChunk;
  /** This Worker's requestAnimationFrame; without it every decoded frame is drawn at once. */
  animationFrame?: (callback: () => void) => void;
  timer?: (callback: () => void, ms: number) => void;
  /**
   * The runtime treats `prefer-hardware` as hardware only (Chromium: isConfigSupported is false and configure fails
   * without a hardware decoder). Only then can a working prefer-hardware decoder be reported as 'hardware'.
   */
  strictHardwarePreference?: boolean;
  /** Messages admitted to this Worker and not yet handled (decoder-admission.ts); each may hold a newer unit. */
  backlog?: () => number;
};
type Sample = { sequence: number; timestamp: number; started: number; received: number; windowQueueMs?: number };
type Decoded = { sample: Sample; config: StreamConfig; generation: number; decodedAt: number };

// No network access or application IPC lives here. Admission credits and
// consumed messages are distinct from presentation, so dropping deltas can
// release transport pressure while a requested keyframe restores the decoder.
export class StreamDecoderEngine {
  private readonly canvas: OffscreenCanvas;
  private readonly dependencies: Dependencies;
  private readonly context: OffscreenCanvasRenderingContext2D;
  private readonly now: () => number;
  private readonly createDecoder: (callbacks: VideoDecoderInit) => VideoDecoder;
  private readonly supports: (config: VideoDecoderConfig) => Promise<boolean>;
  private readonly createChunk: (value: EncodedVideoChunkInit) => EncodedVideoChunk;
  private decoder?: VideoDecoder;
  private config?: StreamConfig;
  private acceleration: Acceleration = 'prefer-hardware';
  private generation = 0;
  private closed = false;
  private needsKeyframe = true;
  private recovering = false;
  /** A decoder of the current configuration has produced a frame (hardware worked once, so a failure is not "early"). */
  private decoded = false;
  /** The installed decoder instance itself has produced a frame; a rebuilt decoder starts unconfirmed. */
  private instanceDecoded = false;
  /** isConfigSupported() answered exactly true for prefer-hardware with the current configuration. */
  private hardwareSupported = false;
  private reportedMode?: DecodeMode;
  private lastRecoveryAttempt = -Infinity;
  private lastKeyframeRequest = -Infinity;
  private pending: Sample[] = [];
  private readonly presenter: FramePresenter<Decoded>;

  constructor(canvas: OffscreenCanvas, dependencies: Dependencies) {
    this.canvas = canvas; this.dependencies = dependencies;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Stream canvas is unavailable.');
    this.context = context;
    this.now = dependencies.now ?? (() => performance.now());
    this.createDecoder = dependencies.createDecoder ?? (callbacks => new VideoDecoder(callbacks));
    this.supports = dependencies.supports ?? (async config => (await VideoDecoder.isConfigSupported(config)).supported === true);
    this.createChunk = dependencies.createChunk ?? (value => new EncodedVideoChunk(value));
    this.presenter = new FramePresenter<Decoded>({ animationFrame: dependencies.animationFrame, timer: dependencies.timer, now: this.now,
      // Called from the output callback, after the offered frame left `pending`: anything still tracked is newer input.
      newerPending: () => (this.decoder?.decodeQueueSize ?? 0) > 0 || this.pending.length > 0 || (dependencies.backlog?.() ?? 0) > 0,
      draw: (frame, decoded) => this.present(frame, decoded),
      superseded: decoded => { if (!this.closed && decoded.generation === this.generation) this.dependencies.post({ type: 'superseded', sequence: decoded.sample.sequence }); } });
  }

  private decoderConfig(config: StreamConfig, acceleration: Acceleration): VideoDecoderConfig {
    return { codec: config.codec, codedWidth: config.codedWidth, codedHeight: config.codedHeight,
      displayAspectWidth: config.width, displayAspectHeight: config.height,
      hardwareAcceleration: acceleration, optimizeForLatency: true,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
  }

  private discardDecoder() {
    // Units this decoder will never display: the decoded frame waiting for display and every unit still in the decoder.
    // Each is reported as dropped, so main and the window forget exactly these and keep units admitted after them
    // (a keyframe in flight during recovery is still presented, and nothing waits for the stall timer).
    const held = this.presenter.clear();
    const lost = held ? [held.sample, ...this.pending] : this.pending;
    const old = this.decoder; this.decoder = undefined; this.pending = []; this.instanceDecoded = false;
    if (old && old.state !== 'closed') { try { old.close(); } catch { /* Already closing. */ } }
    for (const sample of lost) this.dependencies.post({ type: 'consumed', sequence: sample.sequence, dropped: true });
  }

  private requestKeyframe(reason: string) {
    const now = this.now();
    if (now - this.lastKeyframeRequest < 500) return;
    this.lastKeyframeRequest = now;
    this.dependencies.post({ type: 'keyframe-needed', reason });
  }

  private recover(reason: string) {
    if (this.closed || !this.config) return;
    this.generation++;
    this.needsKeyframe = true; this.recovering = true; this.discardDecoder();
    // Re-create only when a new keyframe arrives. A decoder that errors during
    // configure must not create an autonomous close/configure error loop.
    this.requestKeyframe(reason);
  }

  private installDecoder(config: StreamConfig, generation: number) {
    this.instanceDecoded = false;
    const decoder: VideoDecoder = this.createDecoder({
      output: frame => {
        let handedOver = false, sample: Sample | undefined;
        try {
          if (this.closed || generation !== this.generation || decoder !== this.decoder) return;
          const index = this.pending.findIndex(value => value.timestamp === frame.timestamp);
          if (index < 0 || frame.displayWidth !== config.width || frame.displayHeight !== config.height) {
            this.recover('decoded-frame-mismatch'); return;
          }
          [sample] = this.pending.splice(index, 1);
          if (!this.instanceDecoded) { this.decoded = true; this.instanceDecoded = true; this.reportMode(generation, config); }
          // Every unit was decoded; display takes only the newest frame per animation frame (S2).
          handedOver = true;
          this.presenter.offer(frame, { sample, config, generation, decodedAt: this.now() });
        } catch {
          // The unit left `pending`, so the reset below cannot report it; report it here (a repeat is ignored).
          if (sample) this.dependencies.post({ type: 'consumed', sequence: sample.sequence, dropped: true });
          this.recover('frame-draw-failed');
        }
        finally { if (!handedOver) frame.close(); }
      },
      error: () => {
        if (generation !== this.generation) return;
        // A hardware decoder that fails before its first frame usually fails again,
        // so the next rebuild uses software when that is supported.
        const early = this.acceleration === 'prefer-hardware' && !this.decoded;
        this.recover('decoder-error');
        if (early) void this.fallBackToSoftware(config, this.generation);
      },
    });
    // Keep the reference before configure, so a synchronous failure also closes it.
    this.decoder = decoder;
    decoder.configure(this.decoderConfig(config, this.acceleration));
  }

  private async fallBackToSoftware(config: StreamConfig, generation: number) {
    let supported = false;
    try { supported = await this.supports(this.decoderConfig(config, 'prefer-software')); } catch { /* Keep hardware recovery. */ }
    if (this.closed || generation !== this.generation || !supported) return;
    this.acceleration = 'prefer-software';
  }

  /** Draws one decoded frame. Called by the presenter, which closes the frame afterwards. */
  private present(frame: VideoFrame, { sample, config, generation, decodedAt }: Decoded) {
    if (this.closed || generation !== this.generation) return;
    try {
      const beforeDraw = this.now();
      if (this.canvas.width !== config.width || this.canvas.height !== config.height) {
        this.canvas.width = config.width; this.canvas.height = config.height;
      }
      this.context.drawImage(frame, 0, 0, config.width, config.height);
      const drawn = this.now(), windowQueueMs = sample.windowQueueMs;
      // decodeMs runs from decode() to output, so it includes VideoDecoder's own queue; WebCodecs does not expose it.
      // Any wait for the animation frame lies between decodeMs and drawMs and is part of viewerMs only.
      const presented: Presented = { type: 'presented', sequence: sample.sequence, timestamp: sample.timestamp,
        decodeMs: Math.max(0, decodedAt - sample.started), drawMs: Math.max(0, drawn - beforeDraw) };
      // Window time and Worker time are each measured on their own clock and only added, never subtracted across
      // contexts. Without a valid window part neither total is reported, rather than a partial one.
      if (windowQueueMs !== undefined) {
        presented.queueMs = windowQueueMs + Math.max(0, sample.started - sample.received);
        presented.viewerMs = windowQueueMs + Math.max(0, drawn - sample.received);
      }
      this.dependencies.post(presented);
    } catch {
      this.dependencies.post({ type: 'consumed', sequence: sample.sequence, dropped: true });
      this.recover('frame-draw-failed');
    }
  }

  /**
   * 'software' while the prefer-software decoder is in use. 'hardware' only when the runtime treats prefer-hardware as
   * hardware only, isConfigSupported() accepted prefer-hardware for this configuration and the installed decoder has
   * produced a frame. Everything else, including a rebuilt decoder that has not decoded yet, is 'unknown'.
   */
  private decodeMode(): DecodeMode {
    if (this.acceleration === 'prefer-software') return 'software';
    return this.dependencies.strictHardwarePreference === true && this.hardwareSupported && this.instanceDecoded ? 'hardware' : 'unknown';
  }

  private reportMode(generation: number, config: StreamConfig) {
    const decodeMode = this.decodeMode();
    if (decodeMode === this.reportedMode) return;
    this.reportedMode = decodeMode;
    this.dependencies.post({ type: 'configured', generation, width: config.width, height: config.height, decodeMode });
  }

  private async configure(config: StreamConfig) {
    const generation = ++this.generation;
    this.discardDecoder(); this.config = undefined; this.needsKeyframe = true;
    this.recovering = false; this.decoded = false; this.hardwareSupported = false; this.lastRecoveryAttempt = -Infinity;
    // Defensive bounds supplement main's complete wire validation. Never resize
    // the canvas from unbounded metadata or assume a supported config is hardware.
    if (!config || !/^avc1\.[0-9A-F]{6}$/.test(config.codec) || !Number.isInteger(config.width) || !Number.isInteger(config.height)
      || config.width < 1 || config.height < 1 || config.width > 8192 || config.height > 8192 || config.width * config.height > 33_554_432
      || !Number.isInteger(config.codedWidth) || !Number.isInteger(config.codedHeight)
      || config.codedWidth < config.width || config.codedWidth > config.width + 16
      || config.codedHeight < config.height || config.codedHeight > config.height + 16) { this.fail('invalid-decoder-config'); return; }
    // One prefer-software retry before image polling. The prefer-hardware answer is kept: with a hardware-only
    // runtime it lets the first decoded frame be reported as hardware (see decodeMode()).
    // The hardware attempt's failure decides the reported reason (and so whether
    // video is retried later); the software attempt can only rescue the stream.
    let reason: string | undefined;
    for (const acceleration of ACCELERATIONS) {
      let supported = false;
      try { supported = await this.supports(this.decoderConfig(config, acceleration)); }
      catch { reason ??= 'decoder-configuration-failed'; }
      if (this.closed || generation !== this.generation) return;
      if (acceleration === 'prefer-hardware') this.hardwareSupported = supported === true;
      if (!supported) { reason ??= 'unsupported-decoder-config'; continue; }
      this.acceleration = acceleration; this.config = { ...config };
      try { this.installDecoder(this.config, generation); }
      catch { this.discardDecoder(); this.config = undefined; reason ??= 'decoder-configuration-failed'; continue; }
      this.reportedMode = undefined; this.reportMode(generation, config);
      return;
    }
    this.fail(reason ?? 'unsupported-decoder-config');
  }

  async handle(message: DecoderInput) {
    const received = this.now();
    if (this.closed) return;
    if (message.type === 'config') { await this.configure(message.config); return; }
    if (message.type === 'terminal' || message.type === 'close') { this.close(); return; }
    if (message.type === 'heartbeat') return;
    if (message.type !== 'access-unit') { this.fail('invalid-decoder-message'); return; }
    if (!(message.data instanceof ArrayBuffer) || message.data.byteLength < 1 || message.data.byteLength > 8 * 1024 * 1024
      || !Number.isSafeInteger(message.timestamp) || message.timestamp < 0 || !Number.isInteger(message.sequence)
      || message.sequence < 0 || message.sequence > 0xffffffff || typeof message.keyframe !== 'boolean') { this.fail('invalid-access-unit'); return; }
    let dropped = true;
    try {
      if (!this.config) return;
      if (!this.decoder) {
        if (!message.keyframe || (this.recovering && this.now() - this.lastRecoveryAttempt < 500)) {
          this.requestKeyframe('waiting-for-keyframe'); return;
        }
        if (this.recovering) this.lastRecoveryAttempt = this.now();
        this.installDecoder(this.config, this.generation);
        this.reportMode(this.generation, this.config);
      }
      const decoder = this.decoder;
      if (!decoder) { this.requestKeyframe('waiting-for-keyframe'); return; }
      const oldest = this.pending[0];
      if (decoder.decodeQueueSize >= MAX_PENDING_FRAMES || this.pending.length >= MAX_PENDING_FRAMES
        || oldest !== undefined && this.now() - oldest.started > DECODER_STALL_MS) { this.recover('decode-queue-overflow'); return; }
      if (this.needsKeyframe && !message.keyframe) { this.requestKeyframe('waiting-for-keyframe'); return; }
      const chunk = this.createChunk({ type: message.keyframe ? 'key' : 'delta', timestamp: message.timestamp, data: message.data });
      const fromWindow = message.windowQueueMs;
      const windowQueueMs = typeof fromWindow === 'number' && fromWindow >= -CLOCK_TOLERANCE_MS && fromWindow <= 60000 ? Math.max(0, fromWindow) : undefined;
      this.pending.push({ sequence: message.sequence, timestamp: message.timestamp, started: this.now(), received, windowQueueMs });
      const generation = this.generation;
      decoder.decode(chunk);
      if (generation === this.generation) { this.needsKeyframe = false; dropped = false; }
    } catch { this.recover('decode-failed'); }
    finally { this.dependencies.post({ type: 'consumed', sequence: message.sequence, dropped }); }
  }

  private fail(reason: string) {
    this.dependencies.post({ type: 'fault', reason });
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.generation++; this.discardDecoder(); this.presenter.close(); this.config = undefined;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dependencies.post({ type: 'closed' });
  }
}
