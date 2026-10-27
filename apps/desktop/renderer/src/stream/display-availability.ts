export type WakeAvailability = {
  sessionId: string;
  sessionGeneration: number;
  canWakeDisplay: boolean;
  controlGranted: boolean;
  viewOnly: boolean;
};

export const WAKE_COOLDOWN_MS = 5000;
const generation = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** This is a bounded local-main snapshot, never a replacement for host authorization. */
export function readWakeAvailability(value: unknown, sessionId: string): WakeAvailability | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length !== 5 || !['sessionId', 'sessionGeneration', 'canWakeDisplay', 'controlGranted', 'viewOnly'].every(key => keys.includes(key)) ||
    data.sessionId !== sessionId || !generation(data.sessionGeneration) || typeof data.canWakeDisplay !== 'boolean' ||
    typeof data.controlGranted !== 'boolean' || typeof data.viewOnly !== 'boolean') return null;
  return { sessionId, sessionGeneration: data.sessionGeneration, canWakeDisplay: data.canWakeDisplay, controlGranted: data.controlGranted, viewOnly: data.viewOnly };
}

export function isDisplayAsleep(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return data.code === 'display_asleep' && data.status === 409 && data.displayState === 'off';
}

type WakeAttempt = { scope: object; generation: number };
export type DisplayAvailabilityView = { asleep: boolean; eligible: boolean; pending: boolean; remainingMs: number; message: string; sessionGeneration?: number };

/** Local UI state only. No timer, network call, input, session creation or wake side effect. */
export class DisplayAvailabilityState {
  private sessionId: string;
  private monitorId: string;
  private scope = {};
  private currentGeneration: number | undefined;
  private unsupportedGeneration: number | undefined;
  private availability: WakeAvailability | null = null;
  private sleeping = false;
  private request: WakeAttempt | null = null;
  private nextWakeAt = 0;
  private message = '';
  constructor(sessionId: string, monitorId: string) { this.sessionId = sessionId; this.monitorId = monitorId; }

  reset(sessionId: string, monitorId: string) {
    if (sessionId === this.sessionId && monitorId === this.monitorId) return;
    const changedSession = sessionId !== this.sessionId;
    this.sessionId = sessionId; this.monitorId = monitorId; this.scope = {};
    if (changedSession) { this.currentGeneration = undefined; this.unsupportedGeneration = undefined; }
    this.availability = null; this.sleeping = false; this.request = null; this.message = '';
  }

  observe(value: unknown, deliveredGeneration?: number): boolean {
    const next = readWakeAvailability(value, this.sessionId);
    const incoming = generation(deliveredGeneration) ? deliveredGeneration : next?.sessionGeneration;
    if (incoming !== undefined && this.currentGeneration !== undefined && incoming < this.currentGeneration) return false;
    if (incoming !== undefined && incoming !== this.currentGeneration) {
      this.currentGeneration = incoming; this.request = null; this.message = '';
    }
    if (!next || (incoming !== undefined && next.sessionGeneration !== incoming)) {
      this.availability = null; this.request = null; return false;
    }
    const previous = this.availability;
    if (previous && (previous.canWakeDisplay !== next.canWakeDisplay || previous.controlGranted !== next.controlGranted || previous.viewOnly !== next.viewOnly)) {
      this.request = null; this.message = '';
    }
    this.availability = next;
    return true;
  }

  asleep(value: unknown): boolean {
    if (!isDisplayAsleep(value)) return false;
    const data = value as { availability?: unknown };
    const next = readWakeAvailability(data.availability, this.sessionId);
    if (next && this.currentGeneration !== undefined && next.sessionGeneration < this.currentGeneration) return false;
    this.observe(data.availability); this.sleeping = true;
    return true;
  }

  /** Current image draw + awaited receipt, or current bound/main-validated video presentation. */
  presented(value: unknown, deliveredGeneration: unknown): boolean {
    if (!generation(deliveredGeneration) || (this.currentGeneration !== undefined && deliveredGeneration < this.currentGeneration)) return false;
    this.observe(value, deliveredGeneration);
    this.sleeping = false; this.request = null; this.message = '';
    return true;
  }

  pause() { this.scope = {}; this.availability = null; this.request = null; this.message = ''; }
  end() { this.pause(); this.sleeping = false; }
  unsupported() { this.unsupportedGeneration = this.currentGeneration; this.availability = null; this.request = null; }

  beginWake(now: number): WakeAttempt | null {
    const state = this.view(now);
    if (!Number.isFinite(now) || now < 0 || !state.asleep || !state.eligible || state.pending || state.remainingMs > 0 || this.currentGeneration === undefined) return null;
    const token = { scope: this.scope, generation: this.currentGeneration };
    this.request = token; this.nextWakeAt = now + WAKE_COOLDOWN_MS; this.message = '';
    return token;
  }

  finishWake(token: WakeAttempt, message: string, now: number, rateLimited = false): boolean {
    if (this.request !== token || token.scope !== this.scope || token.generation !== this.currentGeneration) return false;
    this.request = null; this.message = String(message).slice(0, 500);
    if (rateLimited && Number.isFinite(now)) this.nextWakeAt = Math.max(this.nextWakeAt, now + WAKE_COOLDOWN_MS);
    return true;
  }

  /** A newer presentation consumes feedback, but cannot cancel a current authority denial. */
  currentReply(token: WakeAttempt): boolean { return token.scope === this.scope && token.generation === this.currentGeneration; }

  view(now: number): DisplayAvailabilityView {
    const data = this.availability;
    return { asleep: this.sleeping, eligible: !!data && this.unsupportedGeneration !== this.currentGeneration && data.sessionGeneration === this.currentGeneration && data.canWakeDisplay && data.controlGranted && !data.viewOnly,
      pending: this.request !== null, remainingMs: Number.isFinite(now) ? Math.max(0, this.nextWakeAt - now) : WAKE_COOLDOWN_MS,
      message: this.message, sessionGeneration: this.currentGeneration };
  }
}
