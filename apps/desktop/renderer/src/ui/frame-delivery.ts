import type { Frame } from '../api';

// Match the host's maximum pixel count. Geometry remains physical; the canvas
// backing store follows the encoded image and CSS provides fit or 1:1 sizing.
const MAX_PIXELS = 33_554_432;
export function frameDelay(unchanged: boolean, idleCount: number) {
  return unchanged ? Math.min(400, 50 * 2 ** Math.min(3, Math.max(0, idleCount - 1))) : 16;
}

export async function drawEncodedFrame(canvas: HTMLCanvasElement, frame: Frame, isCurrent: () => boolean) {
  if (!frame.data?.byteLength || !['image/png', 'image/jpeg'].includes(frame.contentType)) throw new Error('The remote image is unavailable.');
  const width = frame.encodedWidth ?? frame.width, height = frame.encodedHeight ?? frame.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS)
    throw new Error('The remote image dimensions are unsupported.');
  const bitmap = await createImageBitmap(new Blob([frame.data], { type: frame.contentType }));
  try {
    if (!isCurrent()) return false;
    if (bitmap.width !== width || bitmap.height !== height) throw new Error('The remote image dimensions changed unexpectedly.');
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('The screen canvas is unavailable.');
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    context.drawImage(bitmap, 0, 0);
    return true;
  } finally { bitmap.close(); }
}
