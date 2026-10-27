export type StreamFallbackInfo = { code: string; reason: string; retryable: boolean; status?: number; displayState?: 'off'; availability?: unknown };

const TRANSIENT_CODES = new Set(['stream_eof', 'stream_stalled', 'decoder_stalled', 'decoder_unavailable',
  'decoder_fault', 'stream_restart', 'stream_error', 'host_stopping', 'session_reconnected', 'stream_unavailable',
  'video_channel_timeout', 'video_channel_closed', 'worker_channel_error', 'stream_capacity']);
export const VIDEO_RETRY_DELAYS = [1000, 2000, 5000, 15000] as const;
export const VIDEO_HEALTHY_RESET_MS = 60000;

export function terminalStreamFailure(value: Pick<StreamFallbackInfo, 'code' | 'status'>) {
  return [401, 403, 410].includes(value.status || 0) || value.code.startsWith('session_ended') ||
    ['access_revoked', 'permission_changed', 'identity_rotated', 'stream_replaced'].includes(value.code) ||
    (value.status === undefined && ['pin_mismatch', 'identity_mismatch'].includes(value.code));
}

/** Unknown, bare IPC and protocol errors fail closed to images, with no automatic video retry. */
export function streamFallback(value: unknown, defaultCode = 'stream_open_failed'): StreamFallbackInfo {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const code = typeof input.code === 'string' && /^[a-z0-9_]{1,80}$/.test(input.code) ? input.code : defaultCode;
  const status = typeof input.status === 'number' && Number.isInteger(input.status) ? input.status : undefined;
  const reason = status === undefined && ['pin_mismatch', 'identity_mismatch'].includes(code) ? "This device's identity changed. Forget it, then pair again."
    : String(input.reason || input.error || input.message || 'Video unavailable. Using image updates.').slice(0, 500);
  const asleep = code === 'display_asleep' && status === 409 && input.displayState === 'off';
  const info: StreamFallbackInfo = { code, reason, status, retryable: false, ...(asleep ? { displayState: 'off', availability: input.availability } : {}) };
  info.retryable = input.retryable === true && (code === 'display_asleep' ? asleep : TRANSIENT_CODES.has(code)) && !terminalStreamFailure(info) && (status !== 409 || asleep);
  return info;
}

/** At most one caller-owned timer; the capped schedule never creates a retry loop for terminal failures. */
export class VideoRetryPolicy {
  private index = 0;
  private healthySince: number | undefined;
  reset() { this.index = 0; this.healthySince = undefined; }
  presented(now: number) {
    if (!Number.isFinite(now)) return;
    this.healthySince ??= now;
    if (now - this.healthySince >= VIDEO_HEALTHY_RESET_MS) this.index = 0;
  }
  failed(info: StreamFallbackInfo): number | null {
    this.healthySince = undefined;
    if (!streamFallback(info).retryable) return null;
    const delay = VIDEO_RETRY_DELAYS[this.index];
    this.index = Math.min(this.index + 1, VIDEO_RETRY_DELAYS.length - 1);
    return info.code === 'stream_capacity' || (info.code === 'display_asleep' && info.status === 409 && info.displayState === 'off') ? Math.max(15000, delay) : delay;
  }
}
