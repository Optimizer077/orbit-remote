import type { WakeAvailability } from './stream/display-availability';
export type { WakeAvailability } from './stream/display-availability';

export type Permissions = {
  view: boolean;
  control: boolean;
  clipboard: boolean;
  files: boolean;
  power: boolean;
};

export type ResolvedTheme = 'daylight' | 'graphite' | 'midnight' | 'paper';
export type ThemePreference = ResolvedTheme | 'system';
export const THEME_STORAGE_KEY = 'orbit.theme';
const THEME_KEYS = new Set<ThemePreference>(['daylight', 'graphite', 'midnight', 'paper', 'system']);
const DARK_THEMES = new Set<ResolvedTheme>(['graphite', 'midnight']);

// Missing, unknown and legacy values (the removed 'orbit' theme) follow the system.
export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value && THEME_KEYS.has(value as ThemePreference) ? value as ThemePreference : 'system';
  } catch { return 'system'; }
}

// 'system' (and anything unrecognised) resolves to Daylight in light mode and Graphite in dark mode.
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system' && THEME_KEYS.has(preference)) return preference;
  const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'graphite' : 'daylight';
}

export function applyTheme(preference: ThemePreference) {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = DARK_THEMES.has(resolved) ? 'dark' : 'light';
}

export type Device = {
  id: string;
  name: string;
  platform: string;
  address?: string;
  online?: boolean;
  revoked?: boolean;
  blockedByOwner?: boolean;
  status?: string;
  statusReason?: string;
  lastSeen?: string;
  pairedAt?: string;
  direction?: 'incoming' | 'outgoing';
  fingerprint?: string;
  serverFingerprint?: string;
  permissions?: Partial<Permissions>;
};

// The negotiated encryption of one remote request, measured on the actual TLS socket.
export type Link = { protocol: string; cipher: string; keyExchange: string; forwardSecrecy: boolean; suite: string };

// A device's identity is the SHA-256 of its certificate. The first 128 bits, grouped,
// read the same on both computers, so people can compare them to rule out interception.
export function securityCode(fingerprint?: string) {
  const hex = (fingerprint || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 64 ? hex.slice(0, 32).match(/.{4}/g)!.join(' ') : '';
}

export type HostSettings = {
  hostName: string;
  allowControl: boolean;
  allowClipboard: boolean;
  allowFiles: boolean;
  allowPower: boolean;
  startAtLogin?: boolean;
  startAtLoginSupported?: boolean;
  listenPort?: number;
};

export type HostRuntime = {
  supervisor?: { state: 'starting' | 'running' | 'offline' | 'reconnecting' | 'stopped'; reason?: string | null; restartsLeft: number; nextRetryAt?: string | null };
  identity?: { expiresAt: string; daysRemaining: number; warning: boolean; expired: boolean } | null;
};

export type HostStatus = HostRuntime & {
  host: {
    id: string;
    name: string;
    platform: string;
    version?: string;
    address?: string;
    online?: boolean;
    testMode?: boolean;
    fingerprint?: string;
    tailscale: {
      available: boolean;
      connected: boolean;
      ip?: string;
      dnsName?: string;
      version?: string;
      error?: string;
    };
  };
  capabilities: {
    capture: boolean;
    input: boolean;
    clipboard: boolean;
    files: boolean;
    power: boolean;
    [key: string]: unknown;
  };
  settings: HostSettings;
  limitations?: string[];
  sessionState?: string;
  sessions?: { id: string; deviceId: string; deviceName?: string; startedAt?: string; direction?: 'incoming' | 'outgoing'; sessionGeneration?: number; permissions?: Partial<Permissions> }[];
};

export type AuditEntry = {
  id?: string;
  timestamp: string;
  action: string;
  deviceName?: string;
  deviceId?: string;
  detail?: string;
  outcome?: string;
};

export type Monitor = { id: string; name: string; width: number; height: number; primary?: boolean };
export type Session = { sessionId: string; canReconnect?: boolean; sessionGeneration?: number; availability?: WakeAvailability; canWakeDisplay?: boolean; deviceId?: string; startedAt?: string; permissions?: Partial<Permissions>; link?: Link; canScaleFrames?: boolean; canConditionalFrames?: boolean; canJpegFrames?: boolean; canLocalCursor?: boolean };
export type ViewerContext = { independent?: boolean; session: Session & { device: Device; viewOnly: boolean; endedReason?: string }; monitorId: string };
export type Frame = { deliveryId?: string; sessionGeneration?: number; availability?: WakeAvailability; data?: Uint8Array<ArrayBuffer>; contentType: 'image/png' | 'image/jpeg'; width: number; height: number; left?: number; top?: number; encodedWidth?: number; encodedHeight?: number; scale?: number; unchanged?: boolean; bytes?: number; link?: Link };
export type Invite = { invite: string; expiresAt?: string; code?: string };

export type CleanupEntry = { id: string; deviceName: string; state: 'failed' | 'retrying'; retryScheduled: boolean };
export type CleanupSnapshot = { revision: number; entries: CleanupEntry[] };
export type CleanupRetryResult = { cleared: boolean; confirmed: boolean };

declare global {
  interface Window {
    orbit?: { invoke: (action: string, payload?: unknown) => Promise<unknown>; onCleanupChanged?: (callback: (change: { revision: number }) => void) => () => void; onIncomingChanged?: (callback: () => void) => () => void; onWindowState?: (callback: (state: unknown) => void) => () => void; onFullscreenState?: (callback: (state: unknown) => void) => () => void };
  }
}

export class OrbitRequestError extends Error {
  code?: string;
  status?: number;
  retryable?: boolean;
  canReconnect?: boolean;
  displayState?: 'off';
  availability?: unknown;
  retryAfterSeconds?: 5;
  constructor(detail: { message?: string; code?: string; status?: number; retryable?: boolean; canReconnect?: boolean; displayState?: unknown; availability?: unknown; retryAfterSeconds?: unknown }) {
    super(detail.message || 'The request could not be completed.');
    this.name = 'OrbitRequestError'; this.code = detail.code; this.status = detail.status; this.retryable = detail.retryable === true;
    this.canReconnect = detail.canReconnect === true;
    if (detail.code === 'display_asleep' && detail.status === 409 && detail.displayState === 'off') { this.displayState = 'off'; this.availability = detail.availability; }
    if (detail.code === 'wake_rate_limited' && detail.status === 429 && detail.retryAfterSeconds === 5) this.retryAfterSeconds = 5;
  }
}

export async function invoke<T>(action: string, payload?: unknown): Promise<T> {
  if (!window.orbit?.invoke) throw new Error('The Orbit desktop service is not connected. Open this app through the desktop launcher.');
  const value = await window.orbit.invoke(action, payload) as Record<string, unknown> | null;
  if (value && typeof value === 'object' && value.error) {
    const error = value.error;
    throw typeof error === 'string' ? new OrbitRequestError({ message: error }) : new OrbitRequestError(error as ConstructorParameters<typeof OrbitRequestError>[0]);
  }
  return value as T;
}

export const api = {
  fullscreen: () => invoke<import('./stream/fullscreen-state').FullscreenState>('window.fullscreen.get'),
  setFullscreen: (fullscreen: boolean) => invoke<import('./stream/fullscreen-state').FullscreenState>('window.fullscreen.set', { fullscreen }),
  wakeDisplay: (sessionId: string) => invoke<{ state: 'requested' }>('session.wake-display', { sessionId }),
  cleanupList: () => invoke<CleanupSnapshot>('session.cleanup.list'),
  cleanupRetry: (cleanupId: string) => invoke<CleanupRetryResult>('session.cleanup.retry', { cleanupId }),
  status: () => invoke<HostStatus>('status'),
  runtime: () => invoke<HostRuntime>('host.runtime'),
  retryHost: () => invoke<HostRuntime>('host.retry'),
  rotateIdentity: (expectedFingerprint: string) => invoke<{ state: string; requiresRePair?: boolean }>('identity.rotate', { confirmRePair: true, expectedFingerprint }),
  devices: async () => {
    const result = await invoke<Device[] | { devices: Device[] }>('devices');
    return Array.isArray(result) ? result : result.devices || [];
  },
  audit: async () => {
    const result = await invoke<AuditEntry[] | { entries: AuditEntry[] }>('audit');
    return Array.isArray(result) ? result : result.entries || [];
  },
  createInvite: (permissions: Permissions) => invoke<Invite>('invite.create', { permissions }),
  pair: (invite: string) => invoke<Device>('pair', { invite }),
  revoke: (deviceId: string) => invoke('device.revoke', { deviceId }),
  block: (deviceId: string) => invoke('device.block', { deviceId }),
  allow: (deviceId: string) => invoke<Device>('device.allow', { deviceId }),
  updatePermissions: (deviceId: string, permissions: Permissions) => invoke('device.permissions', { deviceId, permissions }),
  updateSettings: (settings: HostSettings) => invoke('settings.update', settings),
  start: (deviceId: string, viewOnly: boolean) => invoke<Session>('session.start', { deviceId, viewOnly }),
  frame: (sessionId: string, monitorId?: string, scale = 1, includeImage = false, allowJpeg = false) => invoke<Frame>('session.frame', { sessionId, monitorId, scale, includeImage, ...(allowJpeg ? { format: 'jpeg', quality: 75 } : {}) }),
  openStream: (sessionId: string, monitorId: string, scale: number, requestId: string, localCursor = false) => invoke<{ streamId: string; monitorId: string }>('session.stream.open', { sessionId, monitorId, scale, requestId, ...(localCursor ? { cursor: 'local' } : {}) }),
  closeStream: (sessionId: string, streamId: string) => invoke('session.stream.close', { sessionId, streamId }),
  input: (sessionId: string, event: Record<string, unknown>, monitorId: string | null = null) => invoke('session.input', { sessionId, event, monitorId }),
  end: (sessionId: string) => invoke('session.end', { sessionId }),
  disconnectIncoming: () => invoke('host.disconnect-all'),
  monitors: async (sessionId: string) => {
    const result = await invoke<Monitor[] | { monitors: Monitor[] }>('session.monitors', { sessionId });
    return Array.isArray(result) ? result : result.monitors || [];
  },
};

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && (error as { status?: unknown }).status === undefined &&
    ['pin_mismatch', 'identity_mismatch'].includes(String((error as { code?: unknown }).code))) return "This device's identity changed. Forget it, then pair again.";
  return error instanceof Error ? error.message : String(error);
}
