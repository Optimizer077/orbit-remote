// Main validates the wire contract before these messages reach a Worker.
export type StreamConfig = {
  codec: string; width: number; height: number; codedWidth: number; codedHeight: number;
  physicalLeft: number; physicalTop: number; physicalWidth: number; physicalHeight: number;
  scale: number; fps: number; monitorId: string;
  colorSpace: VideoColorSpaceInit;
};
export type CursorShape = { width: number; height: number; hotX: number; hotY: number; kind: 'color' | 'masked' | 'mono'; pngBase64: string; invertPngBase64?: string };
export type CursorState = { x: number; y: number; visible: boolean; shapeId: string; shape?: CursorShape };
export type DecoderInput =
  | { type: 'config'; config: StreamConfig }
  | { type: 'access-unit'; data: ArrayBuffer; sequence: number; timestamp: number; keyframe: boolean; windowQueueMs?: number }
  | { type: 'heartbeat' }
  | { type: 'terminal' | 'close' };
/**
 * 'hardware' only after a prefer-hardware decoder, accepted by isConfigSupported() in a runtime where prefer-hardware
 * means hardware only (Chromium), produced a frame; 'software' while the prefer-software decoder is in use; otherwise 'unknown'.
 */
export type DecodeMode = 'hardware' | 'software' | 'unknown';
export type DecoderOutput =
  | { type: 'configured'; generation: number; width: number; height: number; decodeMode: DecodeMode }
  | { type: 'consumed'; sequence: number; dropped: boolean }
  | { type: 'presented'; sequence: number; timestamp: number; decodeMs: number; drawMs: number; queueMs?: number; viewerMs?: number }
  /** Decoded, then replaced by a newer frame before the next display refresh. Not a drop. */
  | { type: 'superseded'; sequence: number }
  | { type: 'keyframe-needed'; reason: string }
  | { type: 'fault'; reason: string }
  | { type: 'closed' };
