import type { CursorShape, CursorState, StreamConfig } from './types';
import { createViewerLayout, cursorPlacementForLayout } from './viewer-layout.ts';
export type SurfaceRect = { left: number; top: number; width: number; height: number };

/** Physical hotspot -> CSS pointer-layer bounds, including letterboxing and negative display origins. */
export function cursorPlacement(config: StreamConfig, pointer: CursorState, shape: CursorShape, surface: SurfaceRect, fit: boolean) {
  if (!pointer.visible) return null;
  const layout = createViewerLayout({ physical: { width: config.physicalWidth, height: config.physicalHeight, left: config.physicalLeft, top: config.physicalTop }, viewport: surface, mode: fit ? 'fit' : 'one-to-one' });
  const placement = cursorPlacementForLayout(layout, pointer, shape);
  return placement && layout?.visible ? { ...placement.rect, clipLeft: layout.visible.left, clipTop: layout.visible.top,
    clipRight: layout.visible.left + layout.visible.width, clipBottom: layout.visible.top + layout.visible.height } : null;
}

export function predictedPointer(config: StreamConfig, pointer: CursorState, x: number, y: number): CursorState {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return pointer;
  return { ...pointer, x: config.physicalLeft + Math.max(0, Math.min(config.physicalWidth - 1, x * config.physicalWidth)),
    y: config.physicalTop + Math.max(0, Math.min(config.physicalHeight - 1, y * config.physicalHeight)) };
}
