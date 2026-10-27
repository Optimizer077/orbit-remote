import type { StreamConfig } from './types';

/** The monitor and physical desktop rectangle a stream config maps viewer input onto. */
export function streamGeometry(config: Pick<StreamConfig, 'monitorId' | 'physicalLeft' | 'physicalTop' | 'physicalWidth' | 'physicalHeight'>) {
  return `${config.monitorId}|${config.physicalLeft},${config.physicalTop},${config.physicalWidth}x${config.physicalHeight}`;
}

/**
 * A config record that keeps the previous geometry (a keyframe refresh, a scale or bitrate change, an encoder switch)
 * maps input exactly as before, so Control may stay on. A first config or any geometry change turns it off.
 */
export function keepsControl(previous: string | null, next: string) {
  return previous !== null && previous === next;
}
