/**
 * Why a computer you could see has no access anymore, in plain words.
 * The main process records a 401 as "Access revoked by the host." (controller.cjs), and saved
 * devices may still carry that text, so it reads the same as the rest of the app here.
 */
export function revokedReason(reason?: string): string {
  const text = reason?.trim();
  return !text || /^access revoked by the host\.?$/i.test(text) ? 'Its owner removed your access.' : text;
}
