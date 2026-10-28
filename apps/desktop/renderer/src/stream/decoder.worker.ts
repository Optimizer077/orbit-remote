/// <reference lib="webworker" />
import { StreamDecoderEngine } from './decoder-engine.ts';
import { AdmissionQueue, VIDEO_CREDIT_WINDOW } from './decoder-admission.ts';
import type { DecoderInput } from './types.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope & { requestAnimationFrame?: (callback: FrameRequestCallback) => number };
type Brands = { brands?: { brand: string }[] };
let initialized = false;
scope.onmessage = event => {
  if (initialized || event.data?.type !== 'init' || !(event.data.canvas instanceof OffscreenCanvas) || !(event.data.port instanceof MessagePort)) {
    scope.postMessage({ type: 'fault', reason: 'invalid-worker-initialization' }); scope.close(); return;
  }
  initialized = true;
  const port = event.data.port as MessagePort;
  let engine: StreamDecoderEngine;
  let ended = false;
  // Chromium answers isConfigSupported(prefer-hardware) with false and fails configure() when no hardware decoder
  // exists (measured on Electron 45 with --disable-accelerated-video-decode), so there a working prefer-hardware
  // decoder is a hardware decoder. Any other runtime reports 'unknown' instead.
  const strictHardwarePreference = ((scope.navigator as unknown as { userAgentData?: Brands }).userAgentData?.brands ?? [])
    .some(entry => entry.brand === 'Chromium');
  // OffscreenCanvas Workers have requestAnimationFrame in Chromium; without it frames are drawn when decoded.
  const animationFrame = typeof scope.requestAnimationFrame === 'function'
    ? (callback: () => void) => { scope.requestAnimationFrame!(() => callback()); } : undefined;
  // At most VIDEO_CREDIT_WINDOW admitted messages, handled one at a time in order. The transport sends one record per
  // credit, so more than the window is a credit violation; VideoDecoder's own queue stays bounded by the engine.
  // Declared before the engine, which reads its backlog; nothing is admitted until the port starts below.
  const admission = new AdmissionQueue<DecoderInput>({ window: VIDEO_CREDIT_WINDOW,
    handle: async message => {
      try { await engine.handle(message); }
      catch { port.postMessage({ type: 'fault', reason: 'worker-message-failed' }); engine.close(); }
    },
    credit: count => { if (!ended) port.postMessage({ type: 'credit', count }); },
    violation: () => { port.postMessage({ type: 'fault', reason: 'worker-credit-violation' }); engine.close(); port.close(); scope.close(); },
  });
  try { engine = new StreamDecoderEngine(event.data.canvas, { animationFrame, strictHardwarePreference, backlog: () => admission.size, post: message => {
    port.postMessage(message);
    if (message.type === 'closed') { ended = true; admission.close(); port.close(); scope.close(); }
  } }); }
  catch { port.postMessage({ type: 'fault', reason: 'worker-canvas-unavailable' }); port.close(); scope.close(); return; }
  port.onmessage = event => admission.push(event.data as DecoderInput);
  port.onmessageerror = () => { engine.close(); port.close(); scope.close(); };
  port.start(); admission.open();
};
