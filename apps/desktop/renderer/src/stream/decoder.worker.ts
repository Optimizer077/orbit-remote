/// <reference lib="webworker" />
import { StreamDecoderEngine } from './decoder-engine.ts';
import type { DecoderInput } from './types.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let initialized = false;
scope.onmessage = event => {
  if (initialized || event.data?.type !== 'init' || !(event.data.canvas instanceof OffscreenCanvas) || !(event.data.port instanceof MessagePort)) {
    scope.postMessage({ type: 'fault', reason: 'invalid-worker-initialization' }); scope.close(); return;
  }
  initialized = true;
  const port = event.data.port as MessagePort;
  let engine: StreamDecoderEngine;
  let ended = false;
  try { engine = new StreamDecoderEngine(event.data.canvas, { post: message => {
    port.postMessage(message);
    if (message.type === 'closed') { ended = true; port.close(); scope.close(); }
  } }); }
  catch { port.postMessage({ type: 'fault', reason: 'worker-canvas-unavailable' }); port.close(); scope.close(); return; }
  // Exactly one admitted message at a time. The transport must wait for this
  // credit before transferring another unit; VideoDecoder's own queue is bounded.
  let busy = false;
  port.onmessage = async event => {
    if (busy) { port.postMessage({ type: 'fault', reason: 'worker-credit-violation' }); engine.close(); port.close(); scope.close(); return; }
    busy = true;
    try { await engine.handle(event.data as DecoderInput); }
    catch { port.postMessage({ type: 'fault', reason: 'worker-message-failed' }); engine.close(); }
    finally { busy = false; if (!ended) port.postMessage({ type: 'credit', count: 1 }); }
  };
  port.onmessageerror = () => { engine.close(); port.close(); scope.close(); };
  port.start(); port.postMessage({ type: 'credit', count: 1 });
};
