import type { DecoderInput, DecoderOutput, StreamConfig } from './types.ts';

/**
 * A decoder whose oldest undecoded frame waits longer than this is replaced (fresh keyframe). Shorter hiccups catch up on
 * their own: on Windows on ARM the hardware decoder pauses 86–254 ms now and then, and a count limit of four discarded the
 * decoder (and ~30% of frames) each time.
 */
export const DECODER_STALL_MS = 500;
/** Hard bound on undecoded work whatever its age (about 200 ms at 60 fps). */
export const MAX_PENDING_FRAMES = 12;

type Dependencies = {
  post(message: DecoderOutput): void;
  now?: () => number;
  createDecoder?: (callbacks: VideoDecoderInit) => VideoDecoder;
  supports?: (config: VideoDecoderConfig) => Promise<boolean>;
  createChunk?: (value: EncodedVideoChunkInit) => EncodedVideoChunk;
};

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
  private generation = 0;
  private closed = false;
  private needsKeyframe = true;
  private recovering = false;
  private lastRecoveryAttempt = -Infinity;
  private lastKeyframeRequest = -Infinity;
  private pending: { sequence: number; timestamp: number; started: number }[] = [];

  constructor(canvas: OffscreenCanvas, dependencies: Dependencies) {
    this.canvas = canvas; this.dependencies = dependencies;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Stream canvas is unavailable.');
    this.context = context;
    this.now = dependencies.now ?? (() => performance.now());
    this.createDecoder = dependencies.createDecoder ?? (callbacks => new VideoDecoder(callbacks));
    this.supports = dependencies.supports ?? (async config => (await VideoDecoder.isConfigSupported(config)).supported === true);
    this.createChunk = dependencies.createChunk ?? (value => new EncodedVideoChunk(value));
  }

  private decoderConfig(config: StreamConfig): VideoDecoderConfig {
    return { codec: config.codec, codedWidth: config.codedWidth, codedHeight: config.codedHeight,
      displayAspectWidth: config.width, displayAspectHeight: config.height,
      hardwareAcceleration: 'prefer-hardware', optimizeForLatency: true,
      colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
  }

  private discardDecoder() {
    const old = this.decoder; this.decoder = undefined; this.pending = [];
    if (old && old.state !== 'closed') { try { old.close(); } catch { /* Already closing. */ } }
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
    const decoder = this.createDecoder({
      output: frame => {
        try {
          if (this.closed || generation !== this.generation) return;
          const index = this.pending.findIndex(value => value.timestamp === frame.timestamp);
          if (index < 0 || frame.displayWidth !== config.width || frame.displayHeight !== config.height) {
            this.recover('decoded-frame-mismatch'); return;
          }
          const [sample] = this.pending.splice(index, 1);
          const beforeDraw = this.now();
          if (this.canvas.width !== config.width || this.canvas.height !== config.height) {
            this.canvas.width = config.width; this.canvas.height = config.height;
          }
          this.context.drawImage(frame, 0, 0, config.width, config.height);
          this.dependencies.post({ type: 'presented', sequence: sample.sequence, timestamp: sample.timestamp,
            decodeMs: Math.max(0, beforeDraw - sample.started), drawMs: Math.max(0, this.now() - beforeDraw) });
        } catch { this.recover('frame-draw-failed'); }
        finally { frame.close(); }
      },
      error: () => { if (generation === this.generation) this.recover('decoder-error'); },
    });
    // Keep the reference before configure, so a synchronous failure also closes it.
    this.decoder = decoder;
    decoder.configure(this.decoderConfig(config));
  }

  private async configure(config: StreamConfig) {
    const generation = ++this.generation;
    this.discardDecoder(); this.config = undefined; this.needsKeyframe = true;
    this.recovering = false; this.lastRecoveryAttempt = -Infinity;
    // Defensive bounds supplement main's complete wire validation. Never resize
    // the canvas from unbounded metadata or assume a supported config is hardware.
    if (!config || !/^avc1\.[0-9A-F]{6}$/.test(config.codec) || !Number.isInteger(config.width) || !Number.isInteger(config.height)
      || config.width < 1 || config.height < 1 || config.width > 8192 || config.height > 8192 || config.width * config.height > 33_554_432
      || !Number.isInteger(config.codedWidth) || !Number.isInteger(config.codedHeight)
      || config.codedWidth < config.width || config.codedWidth > config.width + 16
      || config.codedHeight < config.height || config.codedHeight > config.height + 16) { this.fail('invalid-decoder-config'); return; }
    try {
      const supported = await this.supports(this.decoderConfig(config));
      if (this.closed || generation !== this.generation) return;
      if (!supported) { this.fail('unsupported-decoder-config'); return; }
      this.config = { ...config };
      this.installDecoder(this.config, generation);
      this.dependencies.post({ type: 'configured', generation, width: config.width, height: config.height });
    } catch { if (!this.closed && generation === this.generation) this.fail('decoder-configuration-failed'); }
  }

  async handle(message: DecoderInput) {
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
      }
      const decoder = this.decoder;
      if (!decoder) { this.requestKeyframe('waiting-for-keyframe'); return; }
      const oldest = this.pending[0];
      if (decoder.decodeQueueSize >= MAX_PENDING_FRAMES || this.pending.length >= MAX_PENDING_FRAMES
        || oldest !== undefined && this.now() - oldest.started > DECODER_STALL_MS) { this.recover('decode-queue-overflow'); return; }
      if (this.needsKeyframe && !message.keyframe) { this.requestKeyframe('waiting-for-keyframe'); return; }
      const chunk = this.createChunk({ type: message.keyframe ? 'key' : 'delta', timestamp: message.timestamp, data: message.data });
      this.pending.push({ sequence: message.sequence, timestamp: message.timestamp, started: this.now() });
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
    this.closed = true; this.generation++; this.discardDecoder(); this.config = undefined;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.dependencies.post({ type: 'closed' });
  }
}
