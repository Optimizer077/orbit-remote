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

export type HostStatus = {
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
  sessions?: { id: string; deviceId: string; deviceName?: string; startedAt?: string }[];
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
export type Session = { sessionId: string; deviceId?: string; startedAt?: string; permissions?: Partial<Permissions>; link?: Link };
export type ViewerContext = { session: Session & { device: Device; viewOnly: boolean }; monitorId: string };
export type Frame = { dataUrl: string; width: number; height: number; link?: Link };
export type Invite = { invite: string; expiresAt?: string; code?: string };

declare global {
  interface Window {
    orbit?: { invoke: (action: string, payload?: unknown) => Promise<unknown> };
  }
}

export async function invoke<T>(action: string, payload?: unknown): Promise<T> {
  if (!window.orbit?.invoke) throw new Error('The Orbit desktop service is not connected. Open this app through the desktop launcher.');
  const value = await window.orbit.invoke(action, payload) as Record<string, unknown> | null;
  if (value && typeof value === 'object' && value.error) {
    const error = value.error;
    throw new Error(typeof error === 'string' ? error : String((error as { message?: string }).message || 'The request could not be completed.'));
  }
  return value as T;
}

export const api = {
  status: () => invoke<HostStatus>('status'),
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
  updatePermissions: (deviceId: string, permissions: Permissions) => invoke('device.permissions', { deviceId, permissions }),
  updateSettings: (settings: HostSettings) => invoke('settings.update', settings),
  start: (deviceId: string, viewOnly: boolean) => invoke<Session>('session.start', { deviceId, viewOnly }),
  frame: (sessionId: string, monitorId?: string) => invoke<Frame>('session.frame', { sessionId, monitorId }),
  input: (sessionId: string, event: Record<string, unknown>, monitorId: string | null = null) => invoke('session.input', { sessionId, event, monitorId }),
  end: (sessionId: string) => invoke('session.end', { sessionId }),
  monitors: async (sessionId: string) => {
    const result = await invoke<Monitor[] | { monitors: Monitor[] }>('session.monitors', { sessionId });
    return Array.isArray(result) ? result : result.monitors || [];
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
