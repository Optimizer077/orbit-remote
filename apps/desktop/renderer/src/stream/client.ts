import { api, type Link } from '../api';
import { MAX_CLIENT_PENDING, VIDEO_CREDIT_WINDOW } from './decoder-admission';
import type { CursorState, DecodeMode, DecoderOutput, StreamConfig } from './types';
import { streamFallback, terminalStreamFailure, type StreamFallbackInfo } from './recovery';
import { WindowStateTracker, type WindowVisibility } from './window-state';

type Presentation = { sequence: number; timestamp: number; decodeMs: number; drawMs: number; bytes: number; queueMs?: number; viewerMs?: number; mainQueueMs?: number };
// Main-process durations ride on record messages; each is measured on main's own clock.
const mainDuration = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 60000 ? value : undefined;
type Callbacks = {
  onConfig(config: StreamConfig, sessionGeneration?: number): void;
  onPresented(config: StreamConfig, presentation: Presentation, link?: Link, sessionGeneration?: number): void;
  onReceived?(bytes: number, hostMicros: number): void;
  /** One stream control round trip timed in main (request sent to response received), measured ageMs before it arrived. */
  onRoundTrip?(ms: number, ageMs: number): void;
  onDecodeMode?(mode: DecodeMode): void;
  /** A decoded frame was replaced by a newer one before display (normal pacing, not a drop). */
  onSuperseded?(): void;
  /** Units the decoder discarded and will never display. */
  onDropped?(count: number): void;
  onCursor?(config: StreamConfig, cursor: CursorState): void;
  onRecovering(): void;
  onEnded(reason: string, canReconnect?: boolean): void;
  onFallback(info: StreamFallbackInfo): void;
  onWindowState?(state: WindowVisibility): void;
};

// Main owns TLS, wire validation and authorization. This renderer owns only
// its bound port, a fresh canvas and the decoder Worker. No compressed image
// is retained in React state or copied through a contextBridge callback.
export function startVideoStream(canvas: HTMLCanvasElement, sessionId: string, monitorId: string, scale: number, callbacks: Callbacks, options: { localCursor?: boolean } = {}) {
  let stopped = false, streamId: string | undefined, mainPort: MessagePort | undefined;
  let worker: Worker | undefined, workerPort: MessagePort | undefined, waitingCredit = 0, currentConfig: StreamConfig | undefined, link: Link | undefined;
  const requestId = crypto.randomUUID();
  let sessionGeneration: number | undefined;
  let desiredScale = scale, pendingScale: number | undefined;
  const sendSettings = () => {
    if (stopped || !mainPort || pendingScale === undefined) return;
    const next = pendingScale; pendingScale = undefined;
    mainPort.postMessage({ type: 'settings', scale: next });
  };
  const setScale = (next: number) => {
    if (stopped || !Number.isFinite(next) || next < .33 || next > 1 || next === desiredScale) return;
    desiredScale = next; pendingScale = next;
    try { sendSettings(); } catch { localFallback('worker_channel_error', 'The video settings channel closed. Using image updates.', true); }
  };
  const pending = new Map<number, { config: StreamConfig; bytes: number; sessionGeneration?: number; mainQueueMs?: number }>();
  const pauseState = new WindowStateTracker();
  let arrivalTimer: number | undefined;

  const close = () => {
    if (stopped) return;
    stopped = true; window.clearTimeout(arrivalTimer); window.removeEventListener('message', receivePort);
    pending.clear(); pendingScale = undefined; mainPort?.close();
    try { workerPort?.postMessage({ type: 'close' }); } catch { /* Worker is already closed. */ }
    workerPort?.close(); worker?.terminate();
    if (streamId) void api.closeStream(sessionId, streamId).catch(() => undefined);
  };
  const ended = (reason: string, canReconnect = false) => { if (!stopped) { close(); callbacks.onEnded(reason.slice(0, 500), canReconnect); } };
  const fallback = (value: unknown) => { if (!stopped) { const info = streamFallback(value); if (terminalStreamFailure(info)) { ended(info.reason); return; } close(); callbacks.onFallback(info); } };
  const localFallback = (code: string, reason: string, retryable: boolean) => fallback({ code, reason, retryable });
  const forwardCredit = () => {
    if (stopped || !mainPort || !waitingCredit) return;
    const count = waitingCredit; waitingCredit = 0; mainPort.postMessage({ type: 'credit', count });
  };

  function receivePort(event: MessageEvent) {
    if (event.source !== window || event.data?.type !== 'orbit:video-port' || event.data.requestId !== requestId) return;
    if (stopped || mainPort || event.ports.length !== 1) { for (const port of event.ports) port.close(); return; }
    window.clearTimeout(arrivalTimer); mainPort = event.ports[0];
    mainPort.onmessage = event => {
      if (stopped) return;
      const message = event.data;
      if (message?.type === 'cursor') {
        if (!options.localCursor || !currentConfig || !callbacks.onCursor || !Number.isInteger(message.sequence) || message.sequence < 0 || message.sequence > 0xffffffff) {
          localFallback('invalid_cursor_record', 'The video cursor channel failed. Using image updates.', false); return;
        }
        try { callbacks.onCursor(currentConfig, message.cursor as CursorState); mainPort?.postMessage({ type: 'cursor-consumed', sequence: message.sequence }); }
        catch { localFallback('invalid_cursor_record', 'The video cursor channel failed. Using image updates.', false); }
        return;
      }
      if (message?.type === 'status') {
        if (message.state === 'paused') {
          if (!pauseState.accept(message.windowState) || !pauseState.snapshot().paused) {
            localFallback('invalid_window_state', 'The native window state could not be verified. Using image updates.', false); return;
          }
          callbacks.onWindowState?.(pauseState.snapshot()); close(); return;
        }
        if (message.link) link = message.link as Link;
        if (message.state === 'ended') ended(String(message.error || 'This session has ended. Connect again explicitly.'), message.canReconnect === true);
        else if (message.state === 'fallback') fallback(message);
        else if (message.state === 'recovering') callbacks.onRecovering();
        return;
      }
      if (message?.type !== 'record' || !workerPort) { localFallback('invalid_worker_message', 'The video decoder channel failed. Using image updates.', false); return; }
      const record = message.record, arrivedAt = performance.now();
      const roundTrip = mainDuration(message.rttMs);
      if (roundTrip !== undefined) callbacks.onRoundTrip?.(roundTrip, mainDuration(message.rttAgeMs) ?? 0);
      try {
        if (record?.type === 'config') {
          sessionGeneration = Number.isSafeInteger(message.sessionGeneration) && message.sessionGeneration >= 0 ? message.sessionGeneration : undefined;
          currentConfig = record.config as StreamConfig; pending.clear(); callbacks.onConfig(currentConfig, sessionGeneration);
          workerPort.postMessage({ type: 'config', config: currentConfig });
        } else if (record?.type === 'access-unit' && currentConfig && record.data instanceof ArrayBuffer
          && record.data.byteLength > 0 && record.data.byteLength <= 8 * 1024 * 1024 && pending.size < MAX_CLIENT_PENDING) {
          callbacks.onReceived?.(record.data.byteLength, record.timestamp);
          pending.set(record.sequence, { config: currentConfig, bytes: record.data.byteLength, sessionGeneration, mainQueueMs: mainDuration(message.mainQueueMs) });
          // Window part only, on this window's clock; the Worker times its own part.
          record.windowQueueMs = performance.now() - arrivedAt;
          workerPort.postMessage(record, [record.data]);
        } else localFallback('invalid_video_record', 'The video decoder received an invalid record. Using image updates.', false);
      } catch { localFallback('decoder_fault', 'Video decoding failed. Using image updates.', true); }
    };
    mainPort.onmessageerror = () => localFallback('worker_channel_error', 'The video decoder channel failed. Using image updates.', true);
    // Electron adds a close event to MessagePort, including renderer teardown.
    mainPort.addEventListener('close', () => localFallback('video_channel_closed', 'The video stream closed. Using image updates.', true));
    mainPort.start(); forwardCredit(); sendSettings();
  }

  window.addEventListener('message', receivePort);
  try {
    if (typeof VideoDecoder !== 'function' || typeof Worker !== 'function' || typeof canvas.transferControlToOffscreen !== 'function')
      throw new Error('Video decoding is unavailable. Using image updates.');
    const offscreen = canvas.transferControlToOffscreen();
    worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' });
    const channel = new MessageChannel(); workerPort = channel.port1;
    workerPort.onmessage = event => {
      if (stopped) return;
      const message = event.data as DecoderOutput | { type: 'credit'; count: number };
      if (message.type === 'credit') {
        // Credit held here before main's port opens plus credit just returned never exceeds the Worker's window.
        if (!Number.isInteger(message.count) || message.count < 1 || waitingCredit + message.count > VIDEO_CREDIT_WINDOW) {
          localFallback('invalid_worker_message', 'The video decoder lost synchronization. Using image updates.', false); return;
        }
        waitingCredit += message.count; forwardCredit(); return;
      }
      if (message.type === 'configured') { callbacks.onDecodeMode?.(message.decodeMode); return; }
      if (message.type === 'presented') {
        const sample = pending.get(message.sequence);
        if (sample) { pending.delete(message.sequence); callbacks.onPresented(sample.config, { ...message, bytes: sample.bytes, mainQueueMs: sample.mainQueueMs }, link, sample.sessionGeneration); }
      } else if (message.type === 'superseded') { if (pending.delete(message.sequence)) callbacks.onSuperseded?.(); }
      else if (message.type === 'consumed' && message.dropped) { if (pending.delete(message.sequence)) callbacks.onDropped?.(1); }
      // No blanket clear: the decoder reports each discarded unit as consumed/dropped (counted once, above). A unit
      // admitted after the reset, such as the keyframe that ends recovery, is still presented and clears this state.
      else if (message.type === 'keyframe-needed') callbacks.onRecovering();
      if (message.type === 'fault' || message.type === 'closed') {
        const unsupported = message.type === 'fault' && message.reason === 'unsupported-decoder-config';
        mainPort?.postMessage(message); localFallback(unsupported ? 'decoder_unsupported' : 'decoder_unavailable', 'Video decoding is unavailable. Using image updates.', !unsupported); return;
      }
      mainPort?.postMessage(message);
    };
    workerPort.onmessageerror = () => localFallback('worker_channel_error', 'The video Worker channel failed. Using image updates.', true);
    worker.onerror = () => localFallback('decoder_fault', 'The video Worker could not start. Using image updates.', true);
    workerPort.start(); worker.postMessage({ type: 'init', canvas: offscreen, port: channel.port2 }, [offscreen, channel.port2]);
    arrivalTimer = window.setTimeout(() => localFallback('video_channel_timeout', 'The video channel did not open. Using image updates.', true), 10000);
    void api.openStream(sessionId, monitorId, scale, requestId, options.localCursor === true).then(result => {
      streamId = result.streamId;
      if (stopped) void api.closeStream(sessionId, streamId).catch(() => undefined);
    }).catch(error => fallback(error));
  } catch (error) {
    // Defer so React can finish installing its effect cleanup before switching
    // back to a newly mounted PNG canvas.
    queueMicrotask(() => localFallback('decoder_unsupported', error instanceof Error ? error.message : 'Video unavailable. Using image updates.', false));
  }
  return Object.assign(close, { setScale });
}
