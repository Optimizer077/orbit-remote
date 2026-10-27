import { streamFallback, terminalStreamFailure, type StreamFallbackInfo } from './recovery.ts';

/** Gate the first transport recovery on a fresh authorized image; later attempts use bounded video backoff. */
export class HostReturnPolicy {
  private state: 'idle' | 'waiting' | 'attempted' | 'blocked' = 'idle';
  reset() { this.state = 'idle'; }
  failed(value: StreamFallbackInfo, source: 'stream' | 'image' = 'stream') {
    const info = streamFallback(value);
    if (source === 'image' && !terminalStreamFailure(info) && !info.retryable) return;
    if (terminalStreamFailure(info) || !info.retryable) { this.state = 'blocked'; return; }
    if (this.state === 'idle' && ['host_stopping', 'stream_restart', 'stream_eof', 'stream_unavailable', 'session_reconnected'].includes(info.code)) this.state = 'waiting';
  }
  /** Only an authorized, freshly drawn frame establishes that this host is back. */
  hostBack() {
    if (this.state !== 'waiting') return false;
    this.state = 'attempted'; return true;
  }
  deny() { this.state = 'blocked'; }
  awaitingHost() { return this.state === 'waiting'; }
  ownsRetry() { return this.state === 'waiting' || this.state === 'blocked'; }
}
