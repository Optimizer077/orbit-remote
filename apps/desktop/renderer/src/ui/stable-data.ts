// Host replies arrive over IPC as fresh objects every time, even when nothing changed. Keeping the
// previous object for an equal reply lets a React state setter bail out, so a background status poll
// with unchanged data renders nothing.

/** Deep equality for JSON-shaped data: primitives, arrays and plain objects (key order ignored). */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameData(a[i], other[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) if (!Object.hasOwn(right, key) || !sameData(left[key], right[key])) return false;
  return true;
}

/** `previous` when `next` holds the same data, otherwise `next`. Use as `setState(current => keepIfSame(current, reply))`. */
export function keepIfSame<T>(previous: T, next: T): T {
  return sameData(previous, next) ? previous : next;
}
