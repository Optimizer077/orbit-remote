/** All rectangles and client points use getBoundingClientRect CSS coordinates. */
export type ViewerRect = Readonly<{ left: number; top: number; width: number; height: number }>;
export type ViewerPoint = Readonly<{ x: number; y: number }>;
export type ViewerMode = 'fit' | 'one-to-one';
export type ViewerPhysicalDesktop = Readonly<{ width: number; height: number; left?: number; top?: number }>;
export type ViewerScroll = Readonly<{ left: number; top: number }>;
export type ViewerLayoutInput = Readonly<{
  physical: ViewerPhysicalDesktop;
  viewport: ViewerRect;
  mode: ViewerMode;
  scroll?: ViewerScroll;
}>;
export type ViewerLayout = Readonly<{
  physical: ViewerRect;
  viewport: ViewerRect;
  mode: ViewerMode;
  scroll: ViewerScroll;
  scale: number;
  painted: ViewerRect;
  /** Null means no visible area: reject input and hide both cursor layers. */
  visible: ViewerRect | null;
}>;
export type ViewerCursorShape = Readonly<{ width: number; height: number; hotX: number; hotY: number }>;
export type ViewerCursorPlacement = Readonly<{
  rect: ViewerRect;
  visible: ViewerRect;
  /** Crop in the cursor bitmap's physical pixel coordinates. */
  source: ViewerRect;
}>;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validRect = (rect: ViewerRect | undefined | null): rect is ViewerRect => !!rect &&
  finite(rect.left) && finite(rect.top) && finite(rect.width) && finite(rect.height) && rect.width > 0 && rect.height > 0 &&
  finite(rect.left + rect.width) && finite(rect.top + rect.height) && rect.left + rect.width > rect.left && rect.top + rect.height > rect.top;
const intersection = (a: ViewerRect, b: ViewerRect): ViewerRect | null => {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const width = Math.min(a.left + a.width, b.left + b.width) - left;
  const height = Math.min(a.top + a.height, b.top + b.height) - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
};
const contains = (rect: ViewerRect, x: number, y: number) =>
  x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;

/**
 * Fit centers the complete physical display. 1:1 starts at the viewport's top
 * left and subtracts CSS scroll offsets. Fit ignores valid supplied scroll.
 * viewport is the CSS content box in client coordinates; callers account for
 * element borders. There is no encoded-size, quality, zoom or DPR multiplier.
 * Invalid/overflowing geometry returns null; a fully scrolled-out image has
 * visible:null, so callers can safely hide cursors and reject pointer input.
 */
export function createViewerLayout(input: ViewerLayoutInput): ViewerLayout | null {
  if (!input || !input.physical || !validRect(input.viewport) || !['fit', 'one-to-one'].includes(input.mode)) return null;
  const physical = { left: input.physical.left === undefined ? 0 : input.physical.left,
    top: input.physical.top === undefined ? 0 : input.physical.top, width: input.physical.width, height: input.physical.height };
  if (!validRect(physical)) return null;
  const requestedScroll = input.scroll === undefined ? { left: 0, top: 0 } : input.scroll;
  if (!requestedScroll || !finite(requestedScroll.left) || !finite(requestedScroll.top) || requestedScroll.left < 0 || requestedScroll.top < 0) return null;
  // DOMRect fields may live on its prototype rather than enumerate in a spread.
  const viewport = { left: input.viewport.left, top: input.viewport.top, width: input.viewport.width, height: input.viewport.height };
  const fit = input.mode === 'fit';
  const scroll = fit ? { left: 0, top: 0 } : { left: requestedScroll.left, top: requestedScroll.top };
  const scale = fit ? Math.min(viewport.width / physical.width, viewport.height / physical.height) : 1;
  if (!finite(scale) || scale <= 0) return null;
  const width = physical.width * scale, height = physical.height * scale;
  const painted = { left: viewport.left + (fit ? (viewport.width - width) / 2 : -scroll.left),
    top: viewport.top + (fit ? (viewport.height - height) / 2 : -scroll.top), width, height };
  if (!validRect(painted)) return null;
  return { physical, viewport, mode: input.mode, scroll, scale, painted, visible: intersection(painted, viewport) };
}

/** Reject outside either rectangle; exact edges are inclusive, never clamped. */
export function normalizedClientPoint(layout: ViewerLayout | null, clientX: number, clientY: number): ViewerPoint | null {
  if (!layout?.visible || !validRect(layout.painted) || !validRect(layout.viewport) || !finite(clientX) || !finite(clientY) ||
    !contains(layout.painted, clientX, clientY) || !contains(layout.viewport, clientX, clientY)) return null;
  // Canonicalize an exact edge to 0/1; fractional CSS addition can otherwise
  // divide an accepted right edge to 1.0000000000000002. Outside never reaches here.
  const fraction = (value: number, origin: number, extent: number) => value === origin ? 0 : value === origin + extent ? 1 : (value - origin) / extent;
  const x = fraction(clientX, layout.painted.left, layout.painted.width), y = fraction(clientY, layout.painted.top, layout.painted.height);
  return finite(x) && finite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

/** Global physical hotspot -> client CSS position; off-image points may be clipped later. */
export function physicalPointToClient(layout: ViewerLayout | null, x: number, y: number): ViewerPoint | null {
  if (!layout || !validRect(layout.physical) || !validRect(layout.painted) || !finite(layout.scale) || layout.scale <= 0 || !finite(x) || !finite(y)) return null;
  const clientX = layout.painted.left + (x - layout.physical.left) * layout.scale;
  const clientY = layout.painted.top + (y - layout.physical.top) * layout.scale;
  return finite(clientX) && finite(clientY) ? { x: clientX, y: clientY } : null;
}

/** Both cursor layers share this clip/crop. No visible intersection returns null. */
export function cursorPlacementForLayout(layout: ViewerLayout | null, point: ViewerPoint, shape: ViewerCursorShape): ViewerCursorPlacement | null {
  if (!layout?.visible || !validRect(layout.visible) || !point || !shape ||
    !finite(shape.width) || !finite(shape.height) || shape.width <= 0 || shape.height <= 0 ||
    !finite(shape.hotX) || !finite(shape.hotY) || shape.hotX < 0 || shape.hotY < 0 || shape.hotX >= shape.width || shape.hotY >= shape.height) return null;
  const hotspot = physicalPointToClient(layout, point.x, point.y);
  if (!hotspot) return null;
  const rect = { left: hotspot.x - shape.hotX * layout.scale, top: hotspot.y - shape.hotY * layout.scale,
    width: shape.width * layout.scale, height: shape.height * layout.scale };
  if (!validRect(rect)) return null;
  const visible = intersection(rect, layout.visible);
  if (!visible) return null;
  // This bounds the clipped bitmap crop against floating-point edge roundoff;
  // pointer normalization above deliberately never clamps an outside point.
  const sourceX = (x: number) => Math.max(0, Math.min(shape.width, (x - rect.left) / layout.scale));
  const sourceY = (y: number) => Math.max(0, Math.min(shape.height, (y - rect.top) / layout.scale));
  const left = sourceX(visible.left), top = sourceY(visible.top);
  const source = { left, top, width: sourceX(visible.left + visible.width) - left, height: sourceY(visible.top + visible.height) - top };
  return validRect(source) && source.left + source.width <= shape.width && source.top + source.height <= shape.height
    ? { rect, visible, source } : null;
}
