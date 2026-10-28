import type { DecodeMode } from './types.ts';

export const PRESENTATION_WINDOW_MS = 2000;
const MIN_MEASUREMENT_MS = 500;
const MAX_SAMPLES = 512;
/** A frame is late when it arrives this much later than the host's capture spacing to the previous frame predicts. */
export const LATE_FRAME_MS = 50;
type Draw = { at: number; decodeMs: number; drawMs: number };
/** Per-frame timing ring: the last two seconds or this many frames, whichever is fewer. */
export const TIMING_FRAMES = 240;
const ROUND_TRIP_SAMPLES = 64;

/**
 * Video is rated on delivery, not on frame rate: only changed frames are sent, so a still screen draws few frames and is
 * perfectly healthy. Late frames (captured on time, delivered > 50 ms late) are what a viewer feels as stutter.
 */
export function videoQuality(stats: { fps?: number; lateFrames?: number }): { level: 'good' | 'fair' | 'slow' | 'unknown'; label: string } {
  if (stats.fps === undefined) return { level: 'unknown', label: 'Measuring…' };
  const late = stats.lateFrames;
  const level = late === undefined ? 'unknown' : late === 0 ? 'good' : late <= 2 ? 'fair' : 'slow';
  const label = stats.fps < 5 && (late ?? 0) === 0 ? 'Still screen' : `${Math.round(stats.fps)} fps`;
  return { level, label };
}
type Payload = { at: number; bytes: number; host?: number };
type Skip = { at: number; count: number };

/** Nearest-rank percentile of the first `count` ascending values. */
export function percentile(sorted: ArrayLike<number>, count: number, p: number): number {
  return sorted[Math.min(count - 1, Math.max(0, Math.ceil(p / 100 * count) - 1))];
}
export type Percentiles = { p50: number; p95: number; p99: number; min: number; samples: number };

/**
 * Fixed-size ring of timed samples with several value columns (NaN = not reported). Push is O(1) with no allocation;
 * percentiles copy the in-window values into a preallocated scratch array and sort it, once per snapshot.
 */
export class TimingRing {
  readonly capacity: number;
  private readonly at: Float64Array;
  private readonly columns: Float64Array[];
  private readonly scratch: Float64Array;
  private next = 0;
  private count = 0;
  constructor(columns: number, capacity = TIMING_FRAMES) {
    this.capacity = capacity; this.at = new Float64Array(capacity); this.scratch = new Float64Array(capacity);
    this.columns = Array.from({ length: columns }, () => new Float64Array(capacity).fill(NaN));
  }
  get size() { return this.count; }
  /** Starts a sample at `at` and returns its slot; every column is unreported until set. */
  push(at: number): number {
    const slot = this.next;
    this.at[slot] = at;
    for (const column of this.columns) column[slot] = NaN;
    this.next = (slot + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return slot;
  }
  set(slot: number, column: number, value: number | undefined) {
    this.columns[column][slot] = value !== undefined && Number.isFinite(value) && value >= 0 && value <= 60000 ? value : NaN;
  }
  /** Percentiles of one column over samples with cutoff < at <= now. */
  percentiles(column: number, cutoff: number, now: number): Percentiles | undefined {
    const values = this.columns[column];
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const at = this.at[i], value = values[i];
      if (at > cutoff && at <= now && !Number.isNaN(value)) this.scratch[n++] = value;
    }
    if (!n) return undefined;
    const sorted = this.scratch.subarray(0, n).sort();
    return { p50: percentile(sorted, n, 50), p95: percentile(sorted, n, 95), p99: percentile(sorted, n, 99), min: sorted[0], samples: n };
  }
}

/** Measured on this computer only; no value here includes host capture, encoding or one-way network time. */
export type ViewerLatency = {
  /** Window arrival to Worker hand-off, plus Worker receipt to drawn; each on its own clock. The hop between is excluded. */
  viewer?: Percentiles;
  /** VideoDecoder.decode() call to decoded output, including the decoder's internal queue. */
  decode?: Percentiles;
  draw?: Percentiles;
  /** Window arrival to hand-off, plus Worker receipt to the decode() call. */
  queue?: Percentiles;
  /** Record parsed in the main process to posted to the renderer (waiting for decoder credit). */
  mainQueue?: Percentiles;
  /** Stream control/acknowledgement POST, sent to response in the main process. Includes host handling and connection setup. */
  roundTrip?: Percentiles;
};
/** Optional per-frame timings from the stream client; all are durations measured within one process. */
export type PipelineTiming = { viewerMs?: number; queueMs?: number; mainQueueMs?: number };
const VIEWER = 0, DECODE = 1, DRAW = 2, QUEUE = 3, MAIN_QUEUE = 4;

/** Counts real canvas presentations, never access units, polls or an instantaneous gap estimate. */
export class PresentationWindow {
  private draws: Draw[] = [];
  private payloads: Payload[] = [];
  /** Decoded, then replaced by a newer frame within the same display refresh: normal pacing, never counted as a drop. */
  private supersessions: Skip[] = [];
  /** Never displayed because the decoder discarded them (waiting for a keyframe, overflow or reset). */
  private drops: Skip[] = [];
  private samples = 0;
  private timings = new TimingRing(5);
  private roundTrips = new TimingRing(1, ROUND_TRIP_SAMPLES);
  private decodeMode: DecodeMode = 'unknown';
  private startedAt: number;
  constructor(startedAt: number) { this.startedAt = startedAt; }
  decoder(mode: DecodeMode) { if (mode === 'hardware' || mode === 'software' || mode === 'unknown') this.decodeMode = mode; }
  presented(now: number, decodeMs: number, drawMs: number, timing?: PipelineTiming) {
    if (![now, decodeMs, drawMs].every(Number.isFinite) || now < this.startedAt || decodeMs < 0 || drawMs < 0) return;
    if (this.draws.length && now < this.draws[this.draws.length - 1].at) return;
    this.draws.push({ at: now, decodeMs, drawMs }); this.samples++;
    if (this.draws.length > MAX_SAMPLES) this.draws.shift();
    const slot = this.timings.push(now);
    this.timings.set(slot, DECODE, decodeMs); this.timings.set(slot, DRAW, drawMs);
    if (timing) {
      this.timings.set(slot, VIEWER, timing.viewerMs); this.timings.set(slot, QUEUE, timing.queueMs);
      this.timings.set(slot, MAIN_QUEUE, timing.mainQueueMs);
    }
  }
  /** One stream control round trip measured in the main process. */
  roundTrip(now: number, ms: number) {
    if (!Number.isFinite(now) || now < this.startedAt) return;
    this.roundTrips.set(this.roundTrips.push(now), 0, ms);
  }
  superseded(now: number, count = 1) { this.skip(this.supersessions, now, count); }
  dropped(now: number, count = 1) { this.skip(this.drops, now, count); }
  private skip(list: Skip[], now: number, count: number) {
    if (!Number.isFinite(now) || now < this.startedAt || !Number.isInteger(count) || count < 1 || count > 1024) return;
    list.push({ at: now, count });
    if (list.length > MAX_SAMPLES) list.shift();
  }
  /** <paramref name="hostMicros"/>: the record's host capture timestamp (µs), when known. */
  received(now: number, bytes: number, hostMicros?: number) {
    if (!Number.isFinite(now) || now < this.startedAt || !Number.isInteger(bytes) || bytes < 0 || bytes > 8 * 1024 * 1024) return;
    this.payloads.push({ at: now, bytes, host: Number.isFinite(hostMicros) ? hostMicros : undefined });
    if (this.payloads.length > MAX_SAMPLES) this.payloads.shift();
  }
  snapshot(now: number) {
    const cutoff = now - PRESENTATION_WINDOW_MS;
    this.draws = this.draws.filter(sample => sample.at > cutoff && sample.at <= now);
    this.payloads = this.payloads.filter(sample => sample.at > cutoff && sample.at <= now);
    this.supersessions = this.supersessions.filter(sample => sample.at > cutoff && sample.at <= now);
    this.drops = this.drops.filter(sample => sample.at > cutoff && sample.at <= now);
    const total = (list: Skip[]) => list.reduce((sum, sample) => sum + sample.count, 0);
    const elapsed = Math.min(PRESENTATION_WINDOW_MS, Math.max(0, now - this.startedAt));
    const measured = elapsed >= MIN_MEASUREMENT_MS;
    const average = (key: 'decodeMs' | 'drawMs') => this.draws.length ? this.draws.reduce((sum, sample) => sum + sample[key], 0) / this.draws.length : undefined;
    // Late frames: arrival spacing exceeds the host's capture spacing by LATE_FRAME_MS. A still screen sends nothing, so it
    // is never "late"; only frames the host captured on time and that reached us late count.
    let lateFrames = 0, timed = 0;
    for (let i = 1; i < this.payloads.length; i++) {
      const a = this.payloads[i], b = this.payloads[i - 1];
      if (a.host === undefined || b.host === undefined || a.host < b.host) continue;
      timed++;
      if ((a.at - b.at) - (a.host - b.host) / 1000 > LATE_FRAME_MS) lateFrames++;
    }
    let longestGapMs: number | undefined;
    for (let i = 1; i < this.draws.length; i++) longestGapMs = Math.max(longestGapMs ?? 0, this.draws[i].at - this.draws[i - 1].at);
    const latency: ViewerLatency = { viewer: this.timings.percentiles(VIEWER, cutoff, now), decode: this.timings.percentiles(DECODE, cutoff, now),
      draw: this.timings.percentiles(DRAW, cutoff, now), queue: this.timings.percentiles(QUEUE, cutoff, now),
      mainQueue: this.timings.percentiles(MAIN_QUEUE, cutoff, now), roundTrip: this.roundTrips.percentiles(0, cutoff, now) };
    return { mode: 'video' as const, samples: this.samples, fps: measured ? this.draws.length * 1000 / elapsed : undefined,
      decodeMs: average('decodeMs'), drawMs: average('drawMs'), kbps: measured ? this.payloads.reduce((sum, sample) => sum + sample.bytes, 0) * 8 / elapsed : undefined,
      lastBytes: this.payloads[this.payloads.length - 1]?.bytes, lateFrames: measured && timed > 0 ? lateFrames : undefined, longestGapMs,
      superseded: measured ? total(this.supersessions) : undefined, dropped: measured ? total(this.drops) : undefined,
      decodeMode: this.decodeMode, latency };
  }
}
