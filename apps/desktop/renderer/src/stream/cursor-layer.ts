import type { CursorShape, CursorState, StreamConfig } from './types';
import { predictedPointer } from './cursor-layout.ts';
import { createViewerLayout, cursorPlacementForLayout } from './viewer-layout.ts';

/** Two pointer-only layers. CSS difference blends white inversion pixels against the video beneath. */
export class CursorLayer {
  private viewer: HTMLElement; private video: HTMLCanvasElement; private invert: HTMLCanvasElement; private replace: HTMLCanvasElement;
  private invertContext: CanvasRenderingContext2D; private replaceContext: CanvasRenderingContext2D;
  private onError: () => void; private config?: StreamConfig; private pointer?: CursorState; private prediction?: CursorState;
  private shape?: CursorShape; private shapeId?: string; private replaceBitmap?: ImageBitmap; private invertBitmap?: ImageBitmap;
  private decoding = false; private queuedDecode?: { shape: CursorShape; generation: number };
  private generation = 0; private closed = false; private ready = false; private frame?: number; private observer?: ResizeObserver;
  constructor(viewer: HTMLElement, video: HTMLCanvasElement, invert: HTMLCanvasElement, replace: HTMLCanvasElement, onError: () => void) {
    const a = invert.getContext('2d'), b = replace.getContext('2d');
    if (!a || !b) throw new Error('Pointer layers unavailable.');
    this.viewer = viewer; this.video = video; this.invert = invert; this.replace = replace;
    this.invertContext = a; this.replaceContext = b; this.onError = onError;
    viewer.classList.add('local-cursor');
    viewer.addEventListener('scroll', this.schedule);
    window.addEventListener('resize', this.schedule);
    if (typeof ResizeObserver === 'function') { this.observer = new ResizeObserver(this.schedule); this.observer.observe(viewer); this.observer.observe(video); }
  }
  configure(config: StreamConfig) {
    this.generation++; this.config = config; this.ready = false; this.pointer = undefined; this.prediction = undefined;
    this.queuedDecode = undefined;
    this.shapeId = undefined; this.shape = undefined; this.disposeBitmaps(); this.hide();
  }
  setReady(ready: boolean) { this.ready = ready; if (!ready) this.prediction = undefined; this.schedule(); }
  receive(pointer: CursorState) {
    if (this.closed || !this.config) return;
    if (!pointer || typeof pointer.visible !== 'boolean' || !pointer.shapeId || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) throw new Error('Invalid pointer.');
    this.pointer = pointer; this.prediction = undefined;
    if (pointer.shape && (this.shapeId !== pointer.shapeId || !this.shape)) {
      this.shapeId = pointer.shapeId; this.shape = pointer.shape; this.disposeBitmaps(); this.hide();
      const generation = ++this.generation;
      this.queuedDecode = { shape: pointer.shape, generation }; this.drainDecode();
    } else if (this.shapeId !== pointer.shapeId) throw new Error('Unknown pointer shape.');
    if (!pointer.visible) this.hide();
    this.schedule();
  }
  predict(x: number, y: number) { if (this.config && this.ready && this.pointer?.visible && this.shape) { this.prediction = predictedPointer(this.config, this.pointer, x, y); this.schedule(); } }
  stopPrediction() { this.prediction = undefined; this.schedule(); }
  private drainDecode() {
    if (this.closed || this.decoding || !this.queuedDecode) return;
    const pending = this.queuedDecode; this.queuedDecode = undefined; this.decoding = true;
    void this.decode(pending.shape, pending.generation).catch(() => {
      if (!this.closed && pending.generation === this.generation) this.onError();
    }).finally(() => { this.decoding = false; this.drainDecode(); });
  }
  private async decode(shape: CursorShape, generation: number) {
    const decode = async (encoded: string) => {
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }), { colorSpaceConversion: 'none' });
    };
    const decoded = await Promise.allSettled([decode(shape.pngBase64), shape.invertPngBase64 ? decode(shape.invertPngBase64) : Promise.resolve(undefined)]);
    const bitmaps = decoded.filter((value): value is PromiseFulfilledResult<ImageBitmap | undefined> => value.status === 'fulfilled').map(value => value.value);
    if (this.closed || generation !== this.generation || decoded.some(value => value.status === 'rejected') || bitmaps.some(bitmap => bitmap && (bitmap.width !== shape.width || bitmap.height !== shape.height))) {
      bitmaps.forEach(bitmap => bitmap?.close());
      if (!this.closed && generation === this.generation) this.onError();
      return;
    }
    this.replaceBitmap = (decoded[0] as PromiseFulfilledResult<ImageBitmap>).value;
    this.invertBitmap = (decoded[1] as PromiseFulfilledResult<ImageBitmap | undefined>).value;
    for (const canvas of [this.invert, this.replace]) { canvas.width = shape.width; canvas.height = shape.height; }
    this.invertContext.clearRect(0, 0, shape.width, shape.height); this.replaceContext.clearRect(0, 0, shape.width, shape.height);
    if (this.invertBitmap) this.invertContext.drawImage(this.invertBitmap, 0, 0);
    this.replaceContext.drawImage(this.replaceBitmap, 0, 0); this.schedule();
  }
  private schedule = () => { if (!this.closed && this.frame === undefined) this.frame = window.requestAnimationFrame(() => { this.frame = undefined; this.paint(); }); };
  private paint() {
    const pointer = this.prediction || this.pointer;
    if (!this.ready || !this.config || !pointer?.visible || !this.shape || !this.replaceBitmap) { this.hide(); return; }
    const parent = this.viewer.getBoundingClientRect();
    const layout = createViewerLayout({ physical: { width: this.config.physicalWidth, height: this.config.physicalHeight, left: this.config.physicalLeft, top: this.config.physicalTop },
      viewport: { left: parent.left + this.viewer.clientLeft, top: parent.top + this.viewer.clientTop, width: this.viewer.clientWidth, height: this.viewer.clientHeight },
      mode: this.viewer.classList.contains('fit') ? 'fit' : 'one-to-one', scroll: { left: this.viewer.scrollLeft, top: this.viewer.scrollTop } });
    const placement = cursorPlacementForLayout(layout, pointer, this.shape);
    if (!placement) { this.hide(); return; }
    for (const canvas of [this.invert, this.replace]) {
      const bitmap = canvas === this.invert ? this.invertBitmap : this.replaceBitmap;
      const { width, height } = placement.visible;
      const left = placement.visible.left - parent.left - this.viewer.clientLeft + this.viewer.scrollLeft;
      const top = placement.visible.top - parent.top - this.viewer.clientTop + this.viewer.scrollTop;
      if (!bitmap || !width || !height) { canvas.style.display = 'none'; continue; }
      const { left: sx, top: sy, width: sw, height: sh } = placement.source;
      canvas.width = Math.max(1, Math.ceil(sw)); canvas.height = Math.max(1, Math.ceil(sh));
      const context = canvas === this.invert ? this.invertContext : this.replaceContext;
      context.imageSmoothingEnabled = false;
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      Object.assign(canvas.style, { display: 'block', left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    }
  }
  private hide() { this.invert.style.display = 'none'; this.replace.style.display = 'none'; }
  private disposeBitmaps() { this.replaceBitmap?.close(); this.invertBitmap?.close(); this.replaceBitmap = undefined; this.invertBitmap = undefined; }
  close() {
    if (this.closed) return; this.closed = true; this.generation++;
    this.queuedDecode = undefined;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.observer?.disconnect(); this.viewer.removeEventListener('scroll', this.schedule); window.removeEventListener('resize', this.schedule);
    this.viewer.classList.remove('local-cursor'); this.hide(); this.disposeBitmaps();
    for (const canvas of [this.invert, this.replace]) { canvas.width = 1; canvas.height = 1; }
  }
}

export function createCursorLayer(viewer: HTMLElement | null, video: HTMLCanvasElement, invert: HTMLCanvasElement | null, replace: HTMLCanvasElement | null, onError: () => void) {
  if (!viewer || !invert || !replace || typeof createImageBitmap !== 'function' || typeof CSS === 'undefined' || !CSS.supports('mix-blend-mode', 'difference')) return null;
  try { return new CursorLayer(viewer, video, invert, replace, onError); } catch { return null; }
}
