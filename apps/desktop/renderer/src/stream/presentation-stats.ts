export const PRESENTATION_WINDOW_MS = 2000;
const MIN_MEASUREMENT_MS = 500;
const MAX_SAMPLES = 512;
/** A frame is late when it arrives this much later than the host's capture spacing to the previous frame predicts. */
export const LATE_FRAME_MS = 50;
type Draw = { at: number; decodeMs: number; drawMs: number };

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

/** Counts real canvas presentations, never access units, polls or an instantaneous gap estimate. */
export class PresentationWindow {
  private draws: Draw[] = [];
  private payloads: Payload[] = [];
  private samples = 0;
  private startedAt: number;
  constructor(startedAt: number) { this.startedAt = startedAt; }
  presented(now: number, decodeMs: number, drawMs: number) {
    if (![now, decodeMs, drawMs].every(Number.isFinite) || now < this.startedAt || decodeMs < 0 || drawMs < 0) return;
    if (this.draws.length && now < this.draws[this.draws.length - 1].at) return;
    this.draws.push({ at: now, decodeMs, drawMs }); this.samples++;
    if (this.draws.length > MAX_SAMPLES) this.draws.shift();
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
    return { mode: 'video' as const, samples: this.samples, fps: measured ? this.draws.length * 1000 / elapsed : undefined,
      decodeMs: average('decodeMs'), drawMs: average('drawMs'), kbps: measured ? this.payloads.reduce((sum, sample) => sum + sample.bytes, 0) * 8 / elapsed : undefined,
      lastBytes: this.payloads[this.payloads.length - 1]?.bytes, lateFrames: measured && timed > 0 ? lateFrames : undefined, longestGapMs };
  }
}
