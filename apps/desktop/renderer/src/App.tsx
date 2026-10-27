import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleHelp, Clipboard, Command, Copy, Download,
  Ellipsis, ExternalLink, File, Folder, FolderOpen, Globe2, HardDrive,
  Keyboard, Laptop, LayoutDashboard, Link2, Loader2, LockKeyhole, Maximize2,
  Monitor, MonitorUp, MousePointer2, Network, Plus, Power, RefreshCw,
  Search, Settings2, Shield, ShieldCheck, SlidersHorizontal, Terminal, Palette,
  Unplug, Upload, Wifi, X, Zap, MonitorPlay, Eye, UserPlus, Ticket, SunMoon, Sun, Moon, Gauge,
} from 'lucide-react';
import { SessionHud, useFrameStats, type FrameStats } from './ui/SessionHud';
import { ConnectionDetails } from './ui/ConnectionDetails';
import { drawEncodedFrame, frameDelay } from './ui/frame-delivery';
import { FrameInputCoalescer } from './ui/input-moves';
import { keepsControl, streamGeometry } from './stream/config-geometry';
import { startVideoStream } from './stream/client';
import { HostReturnPolicy } from './stream/reconnect-policy';
import { FullscreenStateTracker, type FullscreenState } from './stream/fullscreen-state';
import { createViewerLayout, normalizedClientPoint } from './stream/viewer-layout';
import { VideoRetryPolicy, streamFallback, terminalStreamFailure, type StreamFallbackInfo } from './stream/recovery';
import { DisplayAvailabilityState, isDisplayAsleep } from './stream/display-availability';
import { PresentationWindow } from './stream/presentation-stats';
import { createCursorLayer, type CursorLayer } from './stream/cursor-layer';
import { observeWindowState, RememberedControl, WindowPlaybackState, type ControlContext, type WindowVisibility } from './stream/window-state';
import './ui/cursor.css';
import { DevicesPage } from './ui/DevicesPage';
import { ActivityPage } from './ui/ActivityPage';
import { SettingsPage as SettingsPageV2, HostRecoveryNotice } from './ui/SettingsPage';
import { Overview } from './ui/Overview';
import { ViewedBanner } from './ui/ViewedBanner';
import { CleanupNotices } from './ui/CleanupNotices';
import { CommandPalette, usePaletteShortcut, type Command as PaletteCommand } from './ui/CommandPalette';
import { api, applyTheme, errorMessage, invoke, readThemePreference, securityCode, THEME_STORAGE_KEY, type AuditEntry, type Device, type Frame, type HostRuntime, type HostSettings, type HostStatus, type Invite, type Link, type Monitor as RemoteMonitor, type Permissions, type Session, type ThemePreference, type ViewerContext } from './api';

const INITIAL_THEME = readThemePreference();
applyTheme(INITIAL_THEME);

type Page = 'overview' | 'devices' | 'connections' | 'activity' | 'settings';
type ViewerPreferences = { monitorId?: string; frameScale?: number; videoWanted?: boolean; fit?: boolean; control?: ControlContext };
type ActiveSession = Session & { device: Device; viewOnly: boolean; endedReason?: string; initialMonitorId?: string; viewer?: ViewerPreferences; reconnectState?: { pending: boolean; error?: string } };
type LocalViewerContext = Omit<ViewerContext, 'session'> & { session: ActiveSession };
const DEFAULT_PERMISSIONS: Permissions = { view: true, control: false, clipboard: false, files: false, power: false };
const NAV: { id: Page; label: string; icon: typeof Monitor }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'devices', label: 'Devices', icon: Monitor },
  { id: 'connections', label: 'Connections', icon: Link2 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

function BrandMark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg viewBox="160 224 704 576" focusable="false" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="25"><circle cx="512" cy="512" r="220" /><ellipse cx="512" cy="512" rx="330" ry="122" transform="rotate(-32 512 512)" /></g><circle cx="512" cy="512" r="65" fill="currentColor" /><circle cx="791.86" cy="337.13" r="34" fill="currentColor" /></svg></span>;
}

function BrandWordmark() {
  return <svg className="brand-wordmark" viewBox="0 0 550 160" aria-hidden="true" focusable="false">
    <g transform="translate(-6 -6) scale(.167)" className="brand-wordmark-accent"><g fill="none" stroke="currentColor" strokeWidth="23"><circle cx="512" cy="512" r="220" /><ellipse cx="512" cy="512" rx="330" ry="122" transform="rotate(-32 512 512)" /></g><circle cx="512" cy="512" r="65" fill="currentColor" /><circle cx="791.86" cy="337.13" r="34" fill="currentColor" /></g>
    <g className="brand-wordmark-text" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"><circle cx="220" cy="70" r="29" /><path d="M278 100V42M278 66C278 48 292 40 310 42M335 17V100M335 70C335 31 394 31 394 70C394 109 335 109 335 70ZM423 43V100M461 22V82Q461 101 480 101H491M445 43H492" /></g>
    <circle className="brand-wordmark-text" cx="423" cy="21" r="5" fill="currentColor" /><circle className="brand-wordmark-accent" cx="518" cy="96" r="6" fill="currentColor" />
    <path className="brand-wordmark-text" d="M190 141V124H197Q202 124 202 129Q202 133 197 133H190M197 133L203 141M218 141H208V124H218M208 132H216M224 141V124L232 135L240 124V141M255 124C245 124 245 141 255 141C265 141 265 124 255 124ZM268 124H282M275 124V141M298 141H288V124H298M288 132H296" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function PlatformIcon({ platform, size = 22 }: { platform?: string; size?: number }) {
  if (/darwin|mac/i.test(platform || '')) return <Command size={size} />;
  if (/linux/i.test(platform || '')) return <Terminal size={size} />;
  return <Monitor size={size} />;
}

function platformName(value?: string) {
  if (/darwin|mac/i.test(value || '')) return 'macOS';
  if (/win/i.test(value || '')) return 'Windows';
  if (/linux/i.test(value || '')) return 'Linux';
  return value || 'Computer';
}

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>;
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    ref.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && ref.current) {
        const els = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]'));
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => { document.removeEventListener('keydown', handler); old?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><X size={20} /></button>
    <div className="modal-icon"><Link2 size={22} /></div><h2 tabIndex={-1}>{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}{children}
  </div></div>;
}

function EmptyState({ icon: Icon = MonitorUp, title, description, action, compact = false }: { icon?: typeof Monitor; title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-icon"><Icon size={28} strokeWidth={1.4} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

/** The local window outlives a remote session, so its exit route must too. */
function WindowFullscreenExit({ available, onError }: { available: boolean; onError: (reason: string) => void }) {
  const tracker = useRef(new FullscreenStateTracker());
  const [state, setState] = useState<FullscreenState | null>(null);
  const [pending, setPending] = useState(false);
  const alive = useRef(false), inFlight = useRef(false);
  const report = useRef(onError); report.current = onError;
  useEffect(() => {
    alive.current = true;
    const receive = (value: unknown) => { if (alive.current && tracker.current.accept(value)) setState(tracker.current.snapshot()); };
    const unsubscribe = window.orbit?.onFullscreenState?.(receive);
    if (unsubscribe) void api.fullscreen().then(receive).catch(() => undefined);
    return () => { alive.current = false; unsubscribe?.(); };
  }, []);
  const exit = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    try { const next = await api.setFullscreen(false); if (alive.current && tracker.current.accept(next)) setState(tracker.current.snapshot()); }
    catch (error) { if (alive.current) report.current(errorMessage(error)); }
    finally { inFlight.current = false; if (alive.current) setPending(false); }
  }, []);
  useEffect(() => {
    if (!available || !state?.fullscreen) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !['Escape', 'F11'].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"], [aria-modal="true"]')) return;
      event.preventDefault(); if (!event.repeat) void exit();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [available, state?.fullscreen, exit]);
  return available && state?.fullscreen ? <button className="window-fullscreen-exit button secondary" disabled={pending} onClick={() => void exit()}><ArrowDownLeft size={15} />Exit fullscreen</button> : null;
}

function WorkspaceApp() {
  const [theme, setTheme] = useState<ThemePreference>(INITIAL_THEME);
  const [page, setPage] = useState<Page>('overview');
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [runtime, setRuntime] = useState<HostRuntime | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const foregroundRefreshes = useRef(0);
  const startRefresh = useCallback(() => { foregroundRefreshes.current++; setRefreshing(true); }, []);
  const finishRefresh = useCallback(() => { foregroundRefreshes.current = Math.max(0, foregroundRefreshes.current - 1); setRefreshing(foregroundRefreshes.current > 0); }, []);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [toastError, setToastError] = useState(false);
  const [pairMode, setPairMode] = useState<'invite' | 'join' | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [retiredViewerId, setRetiredViewerId] = useState<string | null>(null);
  const [fullscreenViewerExpanded, setFullscreenViewerExpanded] = useState(false);
  const activeSessionRef = useRef(activeSession); activeSessionRef.current = activeSession;
  const connectionsVisit = useRef({ page, revision: 0 });
  if (connectionsVisit.current.page !== page) connectionsVisit.current = { page, revision: connectionsVisit.current.revision + 1 };
  const ownerReconnect = useRef<{ sourceId: string; visit: number } | null>(null);
  const ownerMounted = useRef(true);
  useEffect(() => { ownerMounted.current = true; return () => { ownerMounted.current = false; ownerReconnect.current = null; }; }, []);
  const [reconnectReadySessionId, setReconnectReadySessionId] = useState<string | null>(null);
  useEffect(() => {
    setReconnectReadySessionId(current => current && (page !== 'connections' || activeSession?.sessionId !== current || activeSession?.endedReason) ? null : current);
  }, [page, activeSession?.sessionId, activeSession?.endedReason, reconnectReadySessionId]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [endingIncoming, setEndingIncoming] = useState(false);
  const [allowing, setAllowing] = useState<string | null>(null);
  const allowPending = useRef(false);
  const refreshSeq = useRef(0);
  const ownerDecisionSeq = useRef(0);
  const incoming = (status?.sessions || []).filter(session => session.direction === 'incoming');

  useEffect(() => {
    applyTheme(theme);
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Appearance remains usable when local storage is unavailable. */ }
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const update = () => { if (theme === 'system') applyTheme(theme); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);

  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++refreshSeq.current;
    if (!quiet) startRefresh();
    try {
    const results = await Promise.allSettled([api.status(), api.devices(), api.audit(), api.runtime()]);
    if (sequence !== refreshSeq.current) return;
    if (results[0].status === 'fulfilled') { setStatus(results[0].value); if (!quiet) setError(''); }
    else if (!quiet || !status) setError(errorMessage(results[0].reason));
    if (results[1].status === 'fulfilled') setDevices(results[1].value);
    if (results[2].status === 'fulfilled') setAudits(results[2].value);
    if (results[3].status === 'fulfilled') setRuntime(results[3].value);
    } finally { setLoading(false); if (!quiet) finishRefresh(); }
  }, [Boolean(status), startRefresh, finishRefresh]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(true), incoming.length ? 4000 : 15000); return () => window.clearInterval(timer); }, [refresh, incoming.length > 0]);
  useEffect(() => window.orbit?.onIncomingChanged?.(() => void refresh(true)), [refresh]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer); }, [toast]);

  const notify = (message: string) => { setToastError(false); setToast(message); };
  const endIncoming = async (id?: string) => {
    ++refreshSeq.current; ++ownerDecisionSeq.current;
    setEndingIncoming(true);
    try {
      if (id) {
        const deviceId = incoming.find(session => session.id === id)?.deviceId;
        if (!deviceId) throw new Error('This incoming device is no longer listed. Refresh and manage its access from Devices.');
        await api.block(deviceId);
      } else await api.disconnectIncoming();
      ++refreshSeq.current; ++ownerDecisionSeq.current;
      await refresh(true);
    }
    catch (reason) { ++refreshSeq.current; ++ownerDecisionSeq.current; setError(errorMessage(reason)); }
    finally { setEndingIncoming(false); }
  };
  const allowDevice = async (device: Device) => {
    if (allowPending.current || device.direction !== 'incoming' || !device.blockedByOwner || device.revoked || device.status === 'revoked') return;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = origin?.closest('[role="dialog"]');
    const focusTarget = dialog?.querySelector<HTMLElement>('h2') ?? origin?.closest('article')?.querySelector<HTMLButtonElement>('[data-device-manage]');
    const hadFocus = document.hasFocus();
    ++refreshSeq.current; ++ownerDecisionSeq.current;
    allowPending.current = true; setAllowing(device.id); setError('');
    try {
      const allowed = await api.allow(device.id);
      if (allowed.id !== device.id || allowed.direction !== 'incoming') throw new Error('The host returned an unexpected device. Refresh its access before trying again.');
      ++refreshSeq.current; ++ownerDecisionSeq.current;
      setDevices(current => current.map(item => item.id === device.id && item.direction === 'incoming' ? allowed : item));
      setSelectedDevice(current => current?.id === device.id && current.direction === 'incoming' ? allowed : current);
      notify(`${device.name} can connect again with its existing permissions.`);
      void refresh(true);
      requestAnimationFrame(() => {
        if (hadFocus && document.hasFocus() && focusTarget?.isConnected &&
          (document.activeElement === origin || document.activeElement === document.body)) focusTarget.focus({ preventScroll: true });
      });
    } catch (reason) {
      ++refreshSeq.current; ++ownerDecisionSeq.current;
      const message = `Could not allow ${device.name}: ${errorMessage(reason)}`;
      if (!dialog?.isConnected) setError(message);
      requestAnimationFrame(() => {
        if (hadFocus && document.hasFocus() && origin?.isConnected &&
          (document.activeElement === origin || document.activeElement === document.body)) origin.focus({ preventScroll: true });
      });
      throw new Error(message);
    }
    finally { allowPending.current = false; setAllowing(null); }
  };
  const checkNetwork = async () => {
    const sequence = ++refreshSeq.current;
    const ownerDecision = ownerDecisionSeq.current;
    startRefresh();
    try {
      const value = await invoke<Device[] | { devices: Device[] }>('network.refresh');
      if (sequence === refreshSeq.current) setDevices(Array.isArray(value) ? value : value.devices || []);
    } catch (e) { if (ownerDecision === ownerDecisionSeq.current) setError(errorMessage(e)); }
    finally { try { await refresh(true); } finally { finishRefresh(); } }
  };
  const reconnectSession = async (sourceId: string, monitorId: string) => {
    const source = activeSessionRef.current;
    if (!source || source.sessionId !== sourceId || !source.endedReason || !source.canReconnect || ownerReconnect.current) return;
    const request = { sourceId, visit: connectionsVisit.current.revision }; ownerReconnect.current = request;
    setActiveSession(current => current?.sessionId === sourceId ? { ...current, reconnectState: { pending: true } } : current);
    try {
      const next = await invoke<ViewerContext>('session.reconnect', { sessionId: sourceId, monitorId: monitorId || null });
      if (!ownerMounted.current || ownerReconnect.current !== request || activeSessionRef.current?.sessionId !== sourceId) {
        await api.end(next.session.sessionId).catch(() => undefined); return;
      }
      ownerReconnect.current = null;
      const latest = activeSessionRef.current || source;
      const replacement: ActiveSession = { ...next.session, device: devices.find(device => device.id === next.session.device.id) || source.device,
        initialMonitorId: next.monitorId, viewer: { ...latest.viewer, monitorId: next.monitorId || latest.viewer?.monitorId, control: undefined } };
      activeSessionRef.current = replacement; setActiveSession(replacement);
      setReconnectReadySessionId(connectionsVisit.current.page === 'connections' && connectionsVisit.current.revision === request.visit ? replacement.sessionId : null);
    } catch (reason) {
      if (ownerMounted.current && ownerReconnect.current === request && activeSessionRef.current?.sessionId === sourceId) {
        const canReconnect = !!(reason && typeof reason === 'object' && (reason as { canReconnect?: boolean }).canReconnect === true);
        setActiveSession(current => current?.sessionId === sourceId ? { ...current, canReconnect, reconnectState: { pending: false, error: errorMessage(reason) } } : current);
      }
      throw reason;
    } finally { if (ownerReconnect.current === request) ownerReconnect.current = null; }
  };
  const connect = async (device: Device, viewOnly = false) => {
    if (device.revoked || device.status === 'revoked') { setError(`${device.name}: ${device.statusReason || 'Access revoked by the host. Join a new invitation to pair again.'}`); return; }
    if (activeSession?.device.id === device.id && activeSession.viewOnly === viewOnly && !activeSession.endedReason) { setPage('connections'); return; }
    ownerReconnect.current = null; setConnecting(device.id); setError('');
    try {
      if (activeSession) { await api.end(activeSession.sessionId).catch(() => undefined); setActiveSession(null); }
      const session = await api.start(device.id, viewOnly);
      setActiveSession({ ...session, device, viewOnly }); setPage('connections');
      void refresh(true);
    } catch (e) { const reason = errorMessage(e); setError(`Could not connect to ${device.name}: ${reason}`); if (e && typeof e === 'object' && ['stream_capacity', 'session_capacity'].includes(String((e as { code?: unknown }).code))) { setToastError(true); setToast(`${device.name}: ${reason}`); } }
    finally { setConnecting(null); }
  };
  const connected = status?.host?.tailscale?.connected === true;
  const localName = status?.host?.name || 'This computer';
  const sessionsCount = status?.sessions?.length ?? (activeSession && !activeSession.endedReason ? 1 : 0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePaletteShortcut(setPaletteOpen, !pairMode && !selectedDevice);
  // Command ids stay stable across launches: they key the palette's recent list.
  const commands = useMemo<PaletteCommand[]>(() => [
    ...NAV.map(n => ({ id: `nav:${n.id}`, group: 'Navigate', label: `Go to ${n.label}`, icon: n.icon, keywords: ['page'], run: () => { setPage(n.id); } })),
    ...devices.flatMap(d => {
      const blocked = d.direction === 'incoming' || !d.address || d.revoked === true || d.status === 'revoked';
      const hint = blocked ? 'Can access this host' : `${d.online === true ? 'Online' : d.online === false ? 'Offline' : 'Not checked'} · ${platformName(d.platform)}`;
      return [
        { id: `device:${d.id}:connect`, group: 'Devices', label: `Connect to ${d.name}`, hint, icon: MonitorPlay, disabled: blocked || connecting !== null, keywords: ['control', 'remote'], run: () => void connect(d, false) },
        { id: `device:${d.id}:view`, group: 'Devices', label: `View ${d.name} (view only)`, hint, icon: Eye, disabled: blocked || connecting !== null, keywords: ['watch', 'screen'], run: () => void connect(d, true) },
        { id: `device:${d.id}:manage`, group: 'Devices', label: `Manage ${d.name}`, hint: 'Permissions', icon: SlidersHorizontal, keywords: ['permissions', 'revoke'], run: () => setSelectedDevice(d) },
      ];
    }),
    { id: 'action:add-device', group: 'Actions', label: 'Add a device', icon: UserPlus, keywords: ['pair', 'invite'], run: () => setPairMode('invite') },
    { id: 'action:join', group: 'Actions', label: 'Join with an invite', icon: Ticket, keywords: ['pair', 'code'], run: () => setPairMode('join') },
    { id: 'action:copy-code', group: 'Actions', label: 'Copy security code', hint: securityCode(status?.host.fingerprint) || undefined, icon: Copy, disabled: !status?.host.fingerprint, keywords: ['fingerprint', 'verify'], run: () => { void copyText(securityCode(status?.host.fingerprint)).then(() => notify('Security code copied.')).catch(e => setError(errorMessage(e))); } },
    { id: 'action:check-network', group: 'Actions', label: 'Check network', icon: Network, keywords: ['tailscale'], run: () => void checkNetwork() },
    { id: 'action:refresh', group: 'Actions', label: 'Refresh', icon: RefreshCw, run: () => void refresh() },
    ...([['system', 'Match system', SunMoon], ['daylight', 'Daylight', Sun], ['graphite', 'Graphite', Moon], ['midnight', 'Midnight', Moon], ['paper', 'Paper', Palette]] as const)
      .map(([id, label, icon]) => ({ id: `theme:${id}`, group: 'Appearance', label: `Theme: ${label}`, hint: theme === id ? 'Current' : undefined, icon, keywords: ['theme', 'dark', 'light'], run: () => setTheme(id) })),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the run() closures read current state at call time
  ], [devices, connecting, status, theme]);

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setPage('overview')} aria-label="Orbit home"><BrandWordmark /><BrandMark /></button>
      <div className="workspace"><span className="workspace-avatar">P</span><div><strong>Personal workspace</strong><span>Your private network</span></div><ChevronDown size={15} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'devices' && devices.length > 0 && <b>{devices.length}</b>}{id === 'connections' && activeSession && !activeSession.endedReason && <i className="nav-live" />}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="private-card"><div className="private-icon"><ShieldCheck size={18} /></div><strong>Private. By design.</strong><p>Your computers, connected<br />through your Tailscale network.</p><span>Built for your own orbit <ArrowUpRight size={12} /></span></div>
        <div className="local-user"><div className={`local-avatar ${connected ? 'connected' : ''}`}><Laptop size={18} /></div><div><strong>{localName}</strong><span>{status ? platformName(status.host.platform) : 'Connecting to service'}</span></div><span className="version">v{status?.host.version || '0.1'}</span></div>
      </div>
    </aside>

    <main className={`main ${activeSession && page === 'connections' ? 'session-page' : ''}`}>
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{NAV.find(n => n.id === page)?.label}</strong></div><div className="topbar-right"><span className={`network-pill ${connected ? 'connected' : ''}`}><i />{status?.host.testMode ? 'Local test mode' : connected ? 'Tailscale connected' : loading ? 'Checking network' : 'Tailscale disconnected'}</span><button className={`icon-button ${refreshing ? 'spin' : ''}`} title="Refresh host and check device availability" aria-label="Refresh host and check device availability" disabled={refreshing} onClick={() => void checkNetwork()}><RefreshCw size={16} /></button><div className="topbar-divider" /><span className="personal-avatar">P</span></div></header>
      <div className="main-content">
        <HostRecoveryNotice runtime={runtime} onNavigate={() => setPage('settings')} onRetry={async () => { try { setRuntime(await api.retryHost()); notify('Host retry requested.'); await refresh(); } catch (reason) { setError(errorMessage(reason)); } }} />
        <CleanupNotices />
        <ViewedBanner sessions={incoming.map(session => ({ ...session, controlling: session.permissions?.control === true }))} busy={endingIncoming} onEndOne={id => void endIncoming(id)} onEndAll={() => void endIncoming()} />
        {error && <div className="error-banner" role="alert"><Shield size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}

        {page === 'overview' && <Overview status={status} devices={devices} activity={audits} sessionsCount={sessionsCount} sessions={status?.sessions}
          connecting={connecting} loading={loading}
          onAddDevice={() => setPairMode('invite')} onJoin={() => setPairMode('join')}
          onConnect={(device, viewOnly) => void connect(device, viewOnly)} onManage={setSelectedDevice} onAllow={allowDevice} allowing={allowing} onNavigate={setPage}
          onCopyAddress={() => { void copyText(status?.host.tailscale.ip || '').then(() => notify('Tailscale address copied.')).catch(e => setError(errorMessage(e))); }} />}

        {page === 'devices' && <DevicesPage devices={devices} sessions={status?.sessions} connecting={connecting} onAddDevice={() => setPairMode('invite')} onJoin={() => setPairMode('join')}
          onConnect={(device, viewOnly) => void connect(device, viewOnly ?? false)} onManage={setSelectedDevice} onAllow={allowDevice} allowing={allowing} onRefresh={() => void refresh()} refreshing={refreshing} />}

        {page === 'connections' && (activeSession ? <RemoteSession key={activeSession.sessionId} session={activeSession} onLayoutChange={setFullscreenViewerExpanded} initialMonitorId={activeSession.initialMonitorId} onViewerState={update => setActiveSession(current => current?.sessionId === activeSession.sessionId ? { ...current, viewer: { ...current.viewer, ...update } } : current)} requestReconnect={monitor => reconnectSession(activeSession.sessionId, monitor)} onDisconnecting={() => { setRetiredViewerId(activeSession.sessionId); if (ownerReconnect.current?.sourceId === activeSession.sessionId) ownerReconnect.current = null; setActiveSession(current => current?.sessionId === activeSession.sessionId ? { ...current, canReconnect: false, reconnectState: current.reconnectState ? { pending: false } : undefined } : current); }} focusAfterReconnect={reconnectReadySessionId === activeSession.sessionId && !activeSession.endedReason} onReconnectReady={() => setReconnectReadySessionId(current => current === activeSession.sessionId ? null : current)} onTerminated={(reason, canReconnect) => setActiveSession(current => current?.sessionId === activeSession.sessionId ? { ...current, endedReason: reason, canReconnect: canReconnect === true, viewer: { ...current.viewer, control: undefined } } : current)} onEnded={() => { if (ownerReconnect.current?.sourceId === activeSession.sessionId) ownerReconnect.current = null; setActiveSession(current => current?.sessionId === activeSession.sessionId ? null : current); void refresh(true); }} onError={setError} notify={notify} /> : <>
          <PageHeading eyebrow="A DESKTOP, WITHOUT THE DISTANCE" title="Make yourself at home." description="Open a private session to one of your paired computers." />
          <div className="panel"><EmptyState icon={Link2} title="No active connection" description={devices.length ? 'Choose a computer below to open its desktop. View-only access is available from the device menu.' : 'Your remote desktop will appear here. Pair a computer to start your first session.'} action={!devices.length && <button className="button primary" onClick={() => setPairMode('invite')}><Plus size={16} /> Add a device</button>} /></div>
          {devices.length > 0 && <><div className="section-heading"><div><h2>Choose a computer</h2></div></div><DevicesPage embedded devices={devices} sessions={status?.sessions} connecting={connecting} onAddDevice={() => setPairMode('invite')} onJoin={() => setPairMode('join')} onConnect={(device, viewOnly) => void connect(device, viewOnly ?? false)} onManage={setSelectedDevice} onAllow={allowDevice} allowing={allowing} /></>}
        </>)}

        {page === 'activity' && <ActivityPage entries={audits} refreshing={refreshing} onRefresh={() => void refresh()} />}

        {page === 'settings' && <SettingsPageV2 status={status} runtime={runtime} theme={theme} onThemeChange={setTheme} onSaved={() => { void refresh(); notify('Host settings saved.'); }} onIdentityRotated={() => { ownerReconnect.current = null; setActiveSession(null); void refresh(); notify('Identity replaced. Pair every device again.'); }} onError={setError} aboutContent={<AboutOrbit status={status} onError={setError} />} />}
      </div>
    </main>
    <WindowFullscreenExit available={page !== 'connections' || !activeSession || !!activeSession.endedReason || retiredViewerId === activeSession.sessionId || !fullscreenViewerExpanded} onError={setError} />
    {toast && <div className={`toast ${toastError ? 'is-error' : ''}`} role={toastError ? 'alert' : 'status'}><span>{toastError ? <Shield size={16} /> : <Check size={16} />}</span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    {pairMode && <PairModal mode={pairMode} connected={connected} onClose={() => setPairMode(null)} onPaired={() => { setPairMode(null); setPage('devices'); void refresh(); notify('Device paired. Your orbit just got a little bigger.'); }} onError={setError} notify={notify} />}
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    {selectedDevice && <DeviceModal device={selectedDevice} onAllow={() => allowDevice(selectedDevice)} allowing={allowing === selectedDevice.id} onClose={() => setSelectedDevice(null)} onConnect={viewOnly => { setSelectedDevice(null); void connect(selectedDevice, viewOnly); }} onChanged={() => { setSelectedDevice(null); void refresh(); }} onError={setError} notify={notify} />}
  </div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>;
}

async function copyText(value: string) {
  if (!value) return;
  await invoke('clipboard.local.write', { text: value });
}

function PermissionRows({ permissions, onChange, disabled = false }: { permissions: Permissions; onChange: (p: Permissions) => void; disabled?: boolean }) {
  const items: { key: keyof Permissions; icon: typeof Monitor; title: string; detail: string }[] = [
    { key: 'view', icon: Monitor, title: 'View screen', detail: 'See this computer’s desktop' },
    { key: 'control', icon: MousePointer2, title: 'Mouse & keyboard', detail: 'Control apps and type remotely' },
    { key: 'clipboard', icon: Clipboard, title: 'Clipboard', detail: 'Read and write clipboard text' },
    { key: 'files', icon: FolderOpen, title: 'File transfer', detail: 'Access the configured shared folder' },
    { key: 'power', icon: Power, title: 'Lock & restart', detail: 'Lock the screen or restart this host' },
  ];
  return <div className="permission-list">{items.map(({ key, icon: Icon, title, detail }) => <div className="permission-row" key={key}><Icon size={18} /><div><strong>{title}</strong><span>{detail}</span></div><Toggle checked={permissions[key]} label={title} disabled={disabled || key === 'view'} onChange={value => onChange({ ...permissions, [key]: value })} /></div>)}</div>;
}

function PairModal({ mode, connected, onClose, onPaired, onError, notify }: { mode: 'invite' | 'join'; connected: boolean; onClose: () => void; onPaired: () => void; onError: (e: string) => void; notify: (message: string) => void }) {
  const [permissions, setPermissions] = useState<Permissions>({ ...DEFAULT_PERMISSIONS });
  const [invite, setInvite] = useState<Invite | null>(null);
  const [joinText, setJoinText] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');
  const create = async () => { setBusy(true); setLocalError(''); try { setInvite(await api.createInvite(permissions)); } catch (e) { setLocalError(errorMessage(e)); } finally { setBusy(false); } };
  const join = async () => { setBusy(true); setLocalError(''); try { await api.pair(joinText.trim()); onPaired(); } catch (e) { setLocalError(errorMessage(e)); } finally { setBusy(false); } };
  return <Modal title={mode === 'invite' ? invite ? 'Your invitation is ready.' : 'Bring a device into orbit.' : 'A connection starts with trust.'} subtitle={mode === 'invite' ? 'Invite another computer to access this host. Choose exactly what it can do.' : 'Paste the invitation created on the computer you want to access.'} onClose={onClose}>
    {!connected && <div className="inline-notice"><Network size={16} /><span>Connect this computer to Tailscale before pairing. Both computers need a route to each other.</span></div>}
    {localError && <div className="inline-error" role="alert">{localError}</div>}
    {mode === 'invite' ? invite ? <><div className="invite-success"><CheckCheck size={24} /><div><strong>Only share with a computer you trust.</strong><p>{invite.expiresAt ? `Expires ${new Date(invite.expiresAt).toLocaleString()}` : 'Use this invite on your other computer.'}</p></div></div><label className="field-label" htmlFor="invite-code">PAIRING INVITATION</label><textarea id="invite-code" className="invite-code" readOnly value={invite.invite || invite.code || ''} rows={4} onFocus={e => e.target.select()} /><button className="button primary full" onClick={() => { void copyText(invite.invite || invite.code || '').then(() => notify('Pairing invitation copied.')).catch(e => { setLocalError(errorMessage(e)); onError(errorMessage(e)); }); }}><Copy size={16} /> Copy invitation</button><p className="form-footnote"><LockKeyhole size={12} /> Paste into Orbit → Devices → Join with invite on your other computer.</p></> : <><div className="subsection-label">ACCESS TO THIS COMPUTER</div><PermissionRows permissions={permissions} onChange={setPermissions} /><div className="modal-footer"><span><ShieldCheck size={14} /> Individually revocable</span><button className="button primary" disabled={busy || !connected} onClick={() => void create()}>{busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />} Create invite</button></div></> : <form onSubmit={e => { e.preventDefault(); void join(); }}><label htmlFor="join-code" className="field-label">PAIRING INVITATION</label><textarea id="join-code" className="join-code" placeholder="Paste your Orbit invitation here…" rows={6} value={joinText} onChange={e => setJoinText(e.target.value)} autoFocus /><div className="inline-notice subtle-notice"><ShieldCheck size={17} /><span>The invitation identifies the host and its granted permissions. Check that you received it directly from the computer’s owner.</span></div><button className="button primary full" type="submit" disabled={busy || !connected || !joinText.trim()}>{busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />} Pair this computer</button></form>}
  </Modal>;
}

function DeviceModal({ device, onClose, onConnect, onChanged, onError, notify, onAllow, allowing }: { device: Device; onAllow: () => Promise<void>; allowing: boolean; onClose: () => void; onConnect: (viewOnly: boolean) => void; onChanged: () => void; onError: (e: string) => void; notify: (m: string) => void }) {
  const [permissions, setPermissions] = useState<Permissions>({ view: false, control: false, clipboard: false, files: false, power: false, ...device.permissions });
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const incoming = device.direction === 'incoming';
  const code = securityCode(device.fingerprint || device.serverFingerprint);
  const revoke = async () => { setBusy(true); try { if (incoming) await api.revoke(device.id); else await invoke('device.forget', { deviceId: device.id }); notify(incoming ? 'Device revoked. It can no longer connect to this host.' : 'Connection forgotten on this computer.'); onChanged(); } catch (e) { setError(errorMessage(e)); onError(errorMessage(e)); } finally { setBusy(false); } };
  return <Modal title={device.name} subtitle={`${platformName(device.platform)} · ${device.address || device.id}`} onClose={onClose}>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {device.direction === 'incoming' ? <div className="inline-notice subtle-notice"><ShieldCheck size={17} /><span>{device.blockedByOwner ? 'Access to this host is paused by you.' : 'This computer has permission to access your host.'} To connect in the other direction, create an invite on that computer and join it here.</span></div> : <div className="device-modal-actions"><button className="button primary" disabled={!device.address || device.revoked || device.status === 'revoked'} onClick={() => onConnect(false)}><MousePointer2 size={16} /> Connect</button><button className="button secondary" disabled={!device.address || device.revoked || device.status === 'revoked'} onClick={() => onConnect(true)}><Monitor size={16} /> View only</button></div>}
    {incoming && device.blockedByOwner && !device.revoked && device.status !== 'revoked' && <div className="inline-notice owner-block-notice"><ShieldCheck size={17} /><span>Disconnected by you. Existing permissions are kept; this device needs your approval before it can connect again.</span><button className="button secondary small" aria-label={`Allow ${device.name} again`} aria-busy={allowing || undefined} disabled={allowing || busy} onClick={async () => { setError(''); try { await onAllow(); } catch (reason) { setError(errorMessage(reason)); } }}>{allowing ? 'Allowing...' : 'Allow again'}</button></div>}
    {code && <div className="security-code-card"><div className="subsection-label">SECURITY CODE</div><code>{code}</code><p>On {device.name}, open Overview → This computer. Its security code must match this one exactly. {incoming ? 'If it differs, revoke this device: it is not the computer you meant to pair.' : 'If it differs, don’t connect: forget this device and pair again.'}</p></div>}
    <div className="subsection-label">GRANTED PERMISSIONS</div><PermissionRows permissions={permissions} onChange={setPermissions} disabled />
    <p className="form-footnote">{incoming ? 'Permissions belong to this pairing. To change access, revoke it and create a new invitation with the permissions you want.' : 'These permissions were granted by the remote host. Its owner manages access to that computer.'}</p>
    <div className="danger-zone">{revokeConfirm ? <><div><strong>{incoming ? 'Revoke' : 'Forget'} {device.name}?</strong><p>{incoming ? 'This removes access to this host. Pair again to restore it.' : 'This removes the saved connection here. It does not revoke any access you granted on another host.'}</p></div><div className="heading-actions"><button className="button secondary small" onClick={() => setRevokeConfirm(false)}>Cancel</button><button className="button danger small" disabled={busy || allowing} onClick={() => void revoke()}>{busy ? <Loader2 size={14} className="spin" /> : <Unplug size={14} />} {incoming ? 'Revoke device' : 'Forget connection'}</button></div></> : <><div><strong>Remove this connection</strong><p>{incoming ? 'Revoke this device’s access immediately.' : 'Remove this saved connection from this computer.'}</p></div><button className="button danger-text small" onClick={() => setRevokeConfirm(true)}><Unplug size={14} /> {incoming ? 'Revoke' : 'Forget'}</button></>}</div>
  </Modal>;
}

function AboutOrbit({ status, onError }: { status: HostStatus | null; onError: (error: string) => void }) {
  const [opening, setOpening] = useState(false);
  const [educationTab, setEducationTab] = useState<'connection' | 'permissions' | 'recovery'>('connection');
  const educationTabs = [
    { id: 'connection' as const, label: 'Connection', icon: Network, title: 'A private route. Explicit trust.', text: 'Tailscale provides the private route between your computers. Orbit separately verifies the paired host’s identity and authorizes the connecting device. The native worker shares the desktop only after those checks pass.' },
    { id: 'permissions' as const, label: 'Permissions', icon: ShieldCheck, title: 'Only the access you grant.', text: 'View, control, clipboard, files, and power are separate pairing permissions. Transfers stay inside the host’s shared folder. Revoke incoming access on the host to remove that device’s trust; forgetting a saved connection only removes it from this computer.' },
    { id: 'recovery' as const, label: 'Recovery', icon: RefreshCw, title: 'Know when you can get back in.', text: 'This preview needs a signed-in, unlocked desktop. Starting Orbit at sign-in helps it return after login, but locked-screen access and pre-login recovery are unavailable. If the screen stream fails, remote control turns off; enable it again after the desktop returns.' },
  ];
  const openProject = async () => {
    setOpening(true);
    try { await invoke('app.open-project'); }
    catch (error) { onError(errorMessage(error)); }
    finally { setOpening(false); }
  };
  return <section className="panel settings-panel about-panel" id="about-orbit" aria-labelledby="about-orbit-title">
    <div className="about-brand-row"><div className="about-logo"><BrandMark /></div><div><span className="eyebrow">A LITTLE CLOSER, WHEREVER YOU ARE</span><h2 id="about-orbit-title">Orbit Remote<span>.</span></h2><p>Your desktops, in your own orbit.</p></div></div>
    <div className="about-release"><span className="preview-badge"><span /> Development preview</span><span className="about-version">Version {status?.host.version || 'unavailable'}</span></div>
    <p className="about-intro">A private connection to the computers you trust. Built around a simple idea: your desktop should feel within reach, and access should always be yours to decide.</p>
    <div className="about-section"><h3>How your connection works</h3>
      <div className="flow-caption"><span>EXPLANATORY DIAGRAM</span><span>A route, with clear boundaries.</span></div>
      <div className="architecture-flow" role="img" aria-label="Explanatory diagram: Your computer connects through a private Tailscale network to the remote host. The host verifies trust and permits only approved screen, input, and shared-folder file access.">
        <div className="architecture-node"><span><Laptop size={20} /></span><strong>Your computer</strong><small>The control app</small></div>
        <span className="flow-arrow" aria-hidden="true"><ArrowRight size={14} /><i /></span>
        <div className="architecture-node"><span><Network size={20} /></span><strong>Private network</strong><small>Tailscale route</small></div>
        <span className="flow-arrow" aria-hidden="true"><ArrowRight size={14} /><i /></span>
        <div className="architecture-node boundary-node"><span><ShieldCheck size={20} /></span><strong>Remote host</strong><small>Verifies access</small></div>
        <span className="flow-arrow" aria-hidden="true"><ArrowRight size={14} /><i /></span>
        <div className="architecture-node"><span><Monitor size={20} /></span><strong>Allowed actions</strong><small>Screen · input · files</small></div>
      </div>
      <div className="education-tabs" role="tablist" aria-label="Learn how Orbit works">{educationTabs.map((tab, index) => <button key={tab.id} id={`education-tab-${tab.id}`} type="button" role="tab" aria-selected={educationTab === tab.id} aria-controls={`education-panel-${tab.id}`} tabIndex={educationTab === tab.id ? 0 : -1} className={educationTab === tab.id ? 'selected' : ''} onClick={() => setEducationTab(tab.id)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? educationTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + educationTabs.length) % educationTabs.length; const next = educationTabs[nextIndex]; setEducationTab(next.id); document.getElementById(`education-tab-${next.id}`)?.focus(); }}><tab.icon size={13} />{tab.label}</button>)}</div>
      {educationTabs.map(tab => <div key={tab.id} className="education-panel" role="tabpanel" id={`education-panel-${tab.id}`} aria-labelledby={`education-tab-${tab.id}`} tabIndex={0} hidden={educationTab !== tab.id}><strong>{tab.title}</strong><p>{tab.text}</p></div>)}
    </div>
    <div className="about-section"><h3>Where this preview stands</h3><div className="about-status-grid"><div><span className="about-status-label"><Check size={12} /> AVAILABLE NOW</span><p>Device pairing, permission-based screen access, desktop controls, clipboard text, shared-folder transfers, and host activity records.</p></div><div><span className="about-status-label in-progress"><CircleHelp size={12} /> STILL IN PROGRESS</span><p>Access to locked screens and sign-in before the desktop opens is unavailable. Audio, smooth video streaming, and signed updates are still being built.</p></div></div><div className="about-availability"><LockKeyhole size={16} /><p>Keep the remote desktop signed in and unlocked. After a restart, someone must sign in locally before this preview can share that desktop again. Mac and Linux support still need testing on their own hardware.</p></div></div>
    <div className="about-section about-getting-started"><div><h3>Picking up on your Mac?</h3><p>Connect both computers to your Tailscale network. On the Mac, approve the requested Screen Recording and Accessibility permissions in System Settings, then sign in locally and pair the computers.</p><span>The project repository has the setup instructions, current feature checklist, and Mac setup guide.</span></div><Command size={30} strokeWidth={1.25} /></div>
    <div className="about-footer"><div><span>PROJECT LICENSE</span><strong>Not yet declared</strong></div><button className="button secondary small" disabled={opening} onClick={() => void openProject()}>{opening ? <Loader2 size={14} className="spin" /> : <ExternalLink size={14} />} Project on GitHub</button></div>
  </section>;
}

type FileEntry = { name: string; path: string; size?: number; isDirectory?: boolean; directory?: boolean };

// Shows the encryption measured on the latest request, never a fixed claim.
function LinkStatus({ link, code, ended = false }: { link?: Link; code: string; ended?: boolean }) {
  if (ended) return <span className="link-status" title="This connection has ended. Choose Connect to start a new session."><Unplug size={12} />Connection ended</span>;
  const detail = `Mutual TLS with this device’s pinned certificate${code ? ` (security code ${code})` : ''}, inside your Tailscale WireGuard tunnel. Orbit blocks any connection without forward secrecy and authenticated encryption.`;
  return <span className="link-status" title={detail}><LockKeyhole size={12} />{link ? <>Encrypted end to end<span className="status-separator">·</span>{link.protocol}<span className="status-separator">·</span>{link.cipher}<span className="status-separator">·</span>{link.keyExchange}</> : 'Encrypted, paired connection'}</span>;
}

type RemoteSessionProps = { onLayoutChange?: (expanded: boolean) => void; session: ActiveSession; onEnded: () => void; onDisconnecting?: () => void; onTerminated?: (reason: string, canReconnect?: boolean) => void; onReconnected?: (next: ViewerContext) => void; requestReconnect?: (monitorId: string) => Promise<void>; onViewerState?: (update: Partial<ViewerPreferences>) => void; onReconnectReady?: () => void; focusAfterReconnect?: boolean; independent?: boolean; onError: (e: string) => void; notify: (m: string) => void; initialMonitorId?: string; popout?: boolean };
function RemoteSession({ onLayoutChange, session, onEnded, onDisconnecting, onTerminated, onReconnected, requestReconnect, onViewerState, onReconnectReady, focusAfterReconnect = false, onError, notify, independent = false, initialMonitorId = '', popout = false }: RemoteSessionProps) {
  const reconnectRequest = useRef<object | null>(null);
  useEffect(() => () => { reconnectRequest.current = null; }, [session.sessionId]);
  const [localManualReconnect, setManualReconnect] = useState(session.canReconnect === true);
  const manualReconnect = session.reconnectState ? session.canReconnect === true : localManualReconnect;
  const [localReconnecting, setReconnecting] = useState(false);
  const reconnecting = session.reconnectState?.pending === true || localReconnecting;
  const [localReconnectError, setReconnectError] = useState('');
  const reconnectError = session.reconnectState?.error || localReconnectError;
  const [reconnectAnnouncement, setReconnectAnnouncement] = useState('');
  const reconnectButton = useRef<HTMLButtonElement>(null);
  const restoreRetryFocus = useRef(false);
  const reconnectReported = useRef(false);
  const [endedSessionId, setEndedSessionId] = useState<string | null>(null);
  const sessionEnded = Boolean(session.endedReason) || endedSessionId === session.sessionId;
  const onTerminatedRef = useRef(onTerminated);
  onTerminatedRef.current = onTerminated;
  const [frame, setFrame] = useState<Omit<Frame, 'data' | 'contentType'> | null>(null);
  const [frameError, setFrameError] = useState(session.endedReason || '');
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [frameDelivery, setFrameDelivery] = useState<{ bytes?: number; unchanged: boolean }>({ unchanged: false });
  const imageTelemetry = useRef<() => void>(() => undefined);
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([]);
  const [monitorId, setMonitorId] = useState(session.viewer?.monitorId ?? initialMonitorId);
  const displayState = useRef(new DisplayAvailabilityState(session.sessionId, monitorId));
  displayState.current.reset(session.sessionId, monitorId);
  const [displayRevision, setDisplayRevision] = useState(0);
  const publishDisplay = useCallback(() => setDisplayRevision(value => value + 1), []);
  const displayAlive = useRef(true);
  const wakeFeedbackId = useId();
  const wakeButton = useRef<HTMLButtonElement>(null);
  const wakeOwnsFocus = useRef(false);
  const recheckDisplay = useRef<() => void>(() => undefined);
  const [frameScale, setFrameScale] = useState(session.viewer?.frameScale ?? 1);
  const [videoEnabled, setVideoEnabled] = useState(session.viewer?.videoWanted ?? true);
  const [videoWanted, setVideoWanted] = useState(session.viewer?.videoWanted ?? true);
  const [videoRetryDelay, setVideoRetryDelay] = useState<number | null>(null);
  const [videoFallback, setVideoFallback] = useState<StreamFallbackInfo | null>(null);
  const [windowState, setWindowState] = useState<WindowVisibility>({ paused: !!window.orbit?.onWindowState, reason: window.orbit?.onWindowState ? 'hidden' : null, revision: -1 });
  const [deliveryGeneration, setDeliveryGeneration] = useState(0);
  const nativeWindowState = useRef(windowState);
  const playback = useRef(new WindowPlaybackState(!!window.orbit?.onWindowState));
  const playbackSession = useRef(session.sessionId);
  const closeDelivery = useRef<() => void>(() => undefined);
  const receiveWindowState = useRef<(state: unknown) => void>(() => undefined);
  const hostReturn = useRef(new HostReturnPolicy());
  if (playbackSession.current !== session.sessionId) { playback.current.end(); playback.current = new WindowPlaybackState(nativeWindowState.current.paused); playbackSession.current = session.sessionId; hostReturn.current.reset(); }
  if (sessionEnded) { playback.current.end(); hostReturn.current.deny(); }
  const resumeVideo = useRef(true);
  const retryPolicy = useRef(new VideoRetryPolicy());
  const videoControl = useRef<ReturnType<typeof startVideoStream> | null>(null);
  const videoOn = videoWanted && (videoEnabled || videoRetryDelay !== null || hostReturn.current.awaitingHost());
  const deliveryScale = videoEnabled ? 'video' : frameScale;
  const heldVideoRetry = useRef<number | null>(null);
  const [videoStats, setVideoStats] = useState<FrameStats>({ samples: 0 });
  const [control, setControl] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fit, setFit] = useState(session.viewer?.fit ?? true);
  const [expanded, setExpanded] = useState(popout);
  const layoutIntent = useRef<'viewer' | 'workspace'>('workspace');
  const layoutChanged = useRef(onLayoutChange); layoutChanged.current = onLayoutChange;
  useEffect(() => { layoutChanged.current?.(expanded); }, [expanded]);
  const [nativeFullscreen, setNativeFullscreen] = useState<FullscreenState | null>(null);
  const nativeFullscreenTracker = useRef(new FullscreenStateTracker());
  const nativeFullscreenCurrent = useRef<FullscreenState | null>(null);
  const fullscreenRequestToken = useRef<object | null>(null);
  const fullscreenRequestTarget = useRef<boolean | null>(null);
  const unobservedFullscreenEntry = useRef(false);
  const [fullscreenPending, setFullscreenPending] = useState(false);
  const [hudReveal, setHudReveal] = useState(0);
  const reservedLocalKeys = useRef(new Set<string>());
  const localControlsButton = useRef<HTMLButtonElement>(null);
  const [ending, setEnding] = useState(false);
  // Remains retired after a failed remote DELETE: Retry performs cleanup only.
  const disconnectStarted = useRef(false);
  const [disconnectError, setDisconnectError] = useState('');
  const [openingScreen, setOpeningScreen] = useState(false);
  const [tool, setTool] = useState<'clipboard' | 'files' | 'power' | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [clipboardText, setClipboardText] = useState('');
  const [toolError, setToolError] = useState('');
  const [toolBusy, setToolBusy] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filePath, setFilePath] = useState('');
  const viewer = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLCanvasElement>(null);
  const cursorInvert = useRef<HTMLCanvasElement>(null);
  const cursorReplace = useRef<HTMLCanvasElement>(null);
  const cursorLayer = useRef<CursorLayer | null>(null);
  const heldKeys = useRef(new Map<string, {key: string; code: string}>());
  const keyRepeatTimes = useRef(new Map<string, number>());
  const inputPaused = useRef(false);
  const inputDelivery = useRef<{ isCurrent: () => boolean } | null>(null);
  const permissions: Permissions = { view: false, control: false, clipboard: false, files: false, power: false, ...(session.permissions || session.device.permissions) };
  const displayView = displayState.current.view(performance.now());
  const canOfferWake = displayView.asleep && displayView.eligible && !session.viewOnly && !sessionEnded && !windowState.paused && !disconnectStarted.current;
  useEffect(() => {
    if (canOfferWake || !wakeOwnsFocus.current) return;
    wakeOwnsFocus.current = false;
    // Return only this control's focus; do not activate a background window or displace another local control.
    if (document.hasFocus() && (!document.activeElement || document.activeElement === document.body)) viewer.current?.focus({ preventScroll: true });
  }, [canOfferWake]);
  useEffect(() => { displayState.current.observe(session.availability, session.sessionGeneration); publishDisplay(); }, [session.sessionId, session.availability, session.sessionGeneration, monitorId, publishDisplay]);
  useEffect(() => { displayAlive.current = true; return () => { displayAlive.current = false; displayState.current.end(); }; }, []);
  useEffect(() => { if (sessionEnded) { displayState.current.end(); publishDisplay(); } }, [sessionEnded, publishDisplay]);
  useEffect(() => {
    if (!displayView.asleep || displayView.pending || displayView.remainingMs <= 0 || windowState.paused) return;
    const timer = window.setTimeout(publishDisplay, displayView.remainingMs);
    return () => window.clearTimeout(timer);
  }, [displayRevision, displayView.asleep, displayView.pending, windowState.paused, session.sessionId, monitorId, publishDisplay]);
  const currentControl = useRef<ControlContext>({ sessionId: session.sessionId, sessionGeneration: frame?.sessionGeneration, monitorId, frame, enabled: control, allowed: permissions.control, viewOnly: session.viewOnly, ended: sessionEnded });
  currentControl.current = { sessionId: session.sessionId, sessionGeneration: frame?.sessionGeneration, monitorId, frame, enabled: control, allowed: permissions.control, viewOnly: session.viewOnly, ended: sessionEnded };
  const currentVideo = useRef({ enabled: videoEnabled, wanted: videoWanted, retry: videoRetryDelay !== null });
  currentVideo.current = { enabled: videoEnabled, wanted: videoWanted, retry: videoRetryDelay !== null };
  const viewerState = useRef(onViewerState); viewerState.current = onViewerState;
  const navigationControl = useRef<RememberedControl | null>(null);
  const restoringNavigationControl = useRef(Boolean(session.viewer?.control));
  if (!navigationControl.current) { navigationControl.current = new RememberedControl(); if (session.viewer?.control) navigationControl.current.pause(session.viewer.control); }
  const clearNavigationControl = () => { navigationControl.current?.invalidate(); restoringNavigationControl.current = false; viewerState.current?.({ control: undefined }); };
  // Deliberately observe physical identity fields, not the per-frame object or
  // callback: telemetry publication must not re-arm a navigation checkpoint.
  useEffect(() => {
    if (restoringNavigationControl.current) return;
    viewerState.current?.({ control: control && frame && !frameError && !sessionEnded && !windowState.paused ? { ...currentControl.current, enabled: true } : undefined });
  }, [control, frame?.sessionGeneration, frame?.width, frame?.height, frame?.left, frame?.top, monitorId, permissions.control, session.viewOnly, sessionEnded, frameError, windowState.paused]);

  useEffect(() => {
    if (!focusAfterReconnect || reconnectReported.current || !frame || frameError || sessionEnded || windowState.paused) return;
    reconnectReported.current = true;
    setControl(false);
    // Reconnect replaces the focused button with a new session. Hand focus to
    // its first drawn surface only if the user has not chosen somewhere else.
    if (document.hasFocus() && document.activeElement === document.body) viewer.current?.focus({ preventScroll: true });
    setReconnectAnnouncement('Reconnected. The remote desktop is ready. Control is off.');
    onReconnectReady?.();
  }, [focusAfterReconnect, frame, frameError, sessionEnded, windowState.paused, onReconnectReady]);

  useEffect(() => {
    if (reconnecting || !reconnectError || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    const button = reconnectButton.current;
    if (button && !button.disabled && document.hasFocus() && (document.activeElement === document.body || document.activeElement === button))
      button.focus({ preventScroll: true });
  }, [reconnecting, reconnectError]);

  useEffect(() => { playback.current.clearControl(); }, [session.sessionId, monitorId, deliveryScale, permissions.control, session.viewOnly, sessionEnded]);
  const { record, reset, stats } = useFrameStats(() => imageTelemetry.current());
  useEffect(() => { reset(); }, [reset, monitorId, deliveryScale, session.sessionId, videoEnabled, deliveryGeneration]);
  useEffect(() => { retryPolicy.current.reset(); hostReturn.current.reset(); setVideoRetryDelay(null); setVideoFallback(null); setVideoEnabled(videoWanted); }, [session.sessionId, monitorId]);
  useEffect(() => {
    if (disconnectStarted.current || videoEnabled || !videoWanted || sessionEnded || windowState.paused || videoRetryDelay === null) return;
    const timer = window.setTimeout(() => { if (!disconnectStarted.current) { setVideoRetryDelay(null); setVideoEnabled(true); } }, videoRetryDelay);
    return () => window.clearTimeout(timer);
  }, [videoRetryDelay, videoEnabled, videoWanted, sessionEnded, windowState.paused, session.sessionId, monitorId]);

  useEffect(() => {
    if (disconnectStarted.current || sessionEnded || windowState.paused) return;
    let stopped = false;
    let timer: number;
    let hasImage = false, idleCount = 0;
    const machine = playback.current, lease = machine.delivery.begin();
    const isCurrent = () => !disconnectStarted.current && !stopped && machine === playback.current && lease() && !nativeWindowState.current.paused;
    inputDelivery.current = { isCurrent };
    imageTelemetry.current = () => undefined;
    const frameDrawn = (geometry: Frame) => {
      if (!isCurrent() || displayState.current.view(performance.now()).asleep) return false;
      const context = { ...currentControl.current, frame: geometry, sessionGeneration: geometry.sessionGeneration };
      const restoredWindow = machine.freshFrame(context, isCurrent);
      const restoredNavigation = restoringNavigationControl.current && navigationControl.current!.freshFrame(context);
      if (restoringNavigationControl.current) { restoringNavigationControl.current = false; viewerState.current?.({ control: restoredNavigation ? { ...context, enabled: true } : undefined }); }
      if (restoredWindow || restoredNavigation) setControl(true);
      const hostBack = hostReturn.current.hostBack();
      // The one-shot authorized return spends the existing eligible retry now;
      // failed opens still advance through the unchanged bounded retry policy.
      if (hostBack && currentVideo.current.wanted && heldVideoRetry.current !== null) setVideoRetryDelay(0);
      return hostBack;
    };
    inputPaused.current = true;
    setControl(false); setFrame(null); setLastFrameAt(null);
    const canvas = image.current;
    if (videoEnabled && canvas) {
      const localCursor = session.canLocalCursor === true ? createCursorLayer(viewer.current, canvas, cursorInvert.current, cursorReplace.current, () => {
        clearNavigationControl();
        inputPaused.current = true; setControl(false); setVideoRetryDelay(null); setVideoEnabled(false);
        notify('The remote pointer could not be displayed safely. Using image updates.');
      }) : null;
      cursorLayer.current = localCursor;
      const measured = new PresentationWindow(performance.now());
      let lastTelemetry = -Infinity, hasVideo = false, configGeometry: string | null = null;
      let configGeneration: number | undefined;
      setVideoStats({ samples: 0, mode: 'video' }); setFrameError('');
      const telemetry = window.setInterval(() => { if (isCurrent()) setVideoStats(measured.snapshot(performance.now())); }, 250);
      const closeVideo = startVideoStream(canvas, session.sessionId, monitorId, frameScale, {
        onWindowState: state => receiveWindowState.current(state),
        onConfig: (config, generation) => {
          if (!isCurrent()) return;
          if (generation !== undefined && generation !== displayState.current.view(performance.now()).sessionGeneration) { displayState.current.observe(undefined, generation); publishDisplay(); }
          localCursor?.configure(config); hasVideo = false; inputPaused.current = true;
          // Held keys and buttons are always released (input is paused until the next drawn frame, so a mouse-up could be
          // lost). Control itself stays on when the monitor and physical rectangle are unchanged; otherwise it turns off.
          const geometry = streamGeometry(config);
          releaseInputs.current();
          const unchanged = keepsControl(configGeometry, geometry) && currentControl.current.allowed && !currentControl.current.viewOnly
            && !currentControl.current.ended && generation !== undefined && generation === configGeneration;
          if (!unchanged) { setControl(false); setFrame(null); }
          configGeometry = geometry; configGeneration = generation;
        },
        onCursor: (_config, pointer) => { if (isCurrent()) localCursor?.receive(pointer); },
        onReceived: (bytes, hostMicros) => { if (isCurrent()) measured.received(performance.now(), bytes, hostMicros); },
        onPresented: (config, sample, link, sessionGeneration) => {
          if (!isCurrent()) return;
          if (displayState.current.view(performance.now()).asleep && displayState.current.presented(undefined, sessionGeneration)) publishDisplay();
          const now = performance.now(); measured.presented(now, sample.decodeMs, sample.drawMs); retryPolicy.current.presented(now);
          if (!hasVideo || now - lastTelemetry >= 250) {
            setFrame({ width: config.physicalWidth, height: config.physicalHeight, left: config.physicalLeft, top: config.physicalTop,
              encodedWidth: config.width, encodedHeight: config.height, scale: config.scale, link, sessionGeneration });
            setVideoStats(measured.snapshot(now));
            setFrameDelivery({ bytes: sample.bytes, unchanged: false }); setLastFrameAt(Date.now()); lastTelemetry = now;
          }
          hasVideo = true; localCursor?.setReady(true); setFrameError(''); inputPaused.current = displayState.current.view(performance.now()).asleep;
          frameDrawn({ width: config.physicalWidth, height: config.physicalHeight, left: config.physicalLeft, top: config.physicalTop, sessionGeneration, contentType: 'image/png' });
        },
        onRecovering: () => { if (!isCurrent()) return; clearNavigationControl(); playback.current.clearControl(); localCursor?.setReady(false); inputPaused.current = true; setControl(false); setFrameError('Recovering the video stream. Input is paused.'); },
        onEnded: (reason, canReconnect) => {
          if (!isCurrent()) return;
          displayState.current.end(); publishDisplay();
          clearNavigationControl();
          playback.current.end(); hostReturn.current.deny(); setManualReconnect(canReconnect === true);
          inputPaused.current = true; setControl(false); setFrame(null); setLastFrameAt(null); setTool(null); setFrameError(reason);
          setEndedSessionId(session.sessionId); onTerminatedRef.current?.(reason, canReconnect);
        },
        onFallback: info => {
          if (!isCurrent()) return;
          if (isDisplayAsleep(info)) displayState.current.asleep(info);
          else if (info.code === 'host_stopping' || terminalStreamFailure(info)) displayState.current.end();
          else displayState.current.pause();
          publishDisplay();
          clearNavigationControl();
          hostReturn.current.failed(info);
          playback.current.clearControl();
          inputPaused.current = true; setControl(false); setFrame(null); setLastFrameAt(null);
          heldVideoRetry.current = retryPolicy.current.failed(info);
          setVideoFallback(info); setVideoRetryDelay(hostReturn.current.ownsRetry() ? null : heldVideoRetry.current); setVideoEnabled(false); if (!isDisplayAsleep(info)) notify(info.reason);
        },
      }, { localCursor: localCursor !== null });
      videoControl.current = closeVideo;
      const dispose = () => { stopped = true; window.clearInterval(telemetry); closeVideo(); if (videoControl.current === closeVideo) videoControl.current = null; localCursor?.close(); if (cursorLayer.current === localCursor) cursorLayer.current = null; };
      closeDelivery.current = dispose;
      return () => { dispose(); if (closeDelivery.current === dispose) closeDelivery.current = () => undefined; };
    }
    canvas?.getContext('2d', { alpha: false })?.clearRect(0, 0, canvas.width, canvas.height);
    let pendingImage: { metadata: Omit<Frame, 'data' | 'contentType'>; bytes: number; unchanged: boolean; at: number } | null = null;
    let imageSignature: string | null = null, imageError = false;
    const publishImage = () => {
      if (!isCurrent() || !pendingImage) return;
      const next = pendingImage; pendingImage = null;
      setFrame(next.metadata); setFrameDelivery({ bytes: next.bytes, unchanged: next.unchanged });
      setLastFrameAt(next.at); setFrameError('');
    };
    imageTelemetry.current = publishImage;
    let polling = false, immediateRecheck = false;
    const poll = async () => {
      if (!isCurrent() || polling) return;
      polling = true;
      let delay = 260; // Preserve the current error retry until W4 is wired.
      try {
        const started = performance.now();
        const next = await api.frame(session.sessionId, monitorId || undefined, frameScale, !hasImage || hostReturn.current.awaitingHost() || displayState.current.view(performance.now()).asleep, session.canJpegFrames === true);
        if (!isCurrent()) return;
        displayState.current.observe(next.availability, next.sessionGeneration);
        const firstImage = !hasImage;
        let drawn = false;
        if (!next.unchanged || !hasImage) {
          if (!canvas || !await drawEncodedFrame(canvas, next, isCurrent)) return;
          let received = false;
          if (next.deliveryId) { await invoke('session.frame.presented', { sessionId: session.sessionId, monitorId: monitorId || null, deliveryId: next.deliveryId }); received = true; }
          if (!isCurrent()) return;
          hasImage = true;
          drawn = true;
          if (!next.unchanged && received) displayState.current.presented(next.availability, next.sessionGeneration);
        }
        if (!isCurrent()) return;
        publishDisplay();
        const bytes = next.bytes ?? next.data?.byteLength ?? 0;
        const { data: _data, ...metadata } = next;
        const signature = [next.width, next.height, next.left || 0, next.top || 0, next.encodedWidth, next.encodedHeight, next.scale, next.sessionGeneration].join(':');
        const awaitingDraw = !drawn && hostReturn.current.awaitingHost();
        pendingImage = awaitingDraw ? null : { metadata, bytes, unchanged: next.unchanged === true, at: Date.now() };
        const hostReturned = drawn && !displayState.current.view(performance.now()).asleep && frameDrawn(next);
        record(performance.now() - started, bytes, next.unchanged === true);
        if (!awaitingDraw) {
          if (firstImage || imageError || signature !== imageSignature || hostReturned) publishImage();
          imageSignature = signature; imageError = false; if (!disconnectStarted.current && !displayState.current.view(performance.now()).asleep) inputPaused.current = false;
        }
        idleCount = next.unchanged ? idleCount + 1 : 0;
        delay = frameDelay(next.unchanged === true, idleCount);
      } catch (e) {
        if (isCurrent()) {
          pendingImage = null; imageError = true;
          clearNavigationControl();
          const reason = errorMessage(e);
          const failure = streamFallback(e); hostReturn.current.failed(failure, 'image');
          if (isDisplayAsleep(failure)) {
            const enteringAsleep = !displayState.current.view(performance.now()).asleep;
            displayState.current.asleep(failure); hasImage = false; imageSignature = null;
            setFrame(null); setLastFrameAt(null); if (enteringAsleep) releaseInputs.current();
            setVideoRetryDelay(value => value === null ? value : Math.max(15000, value));
          } else if (failure.code === 'host_stopping' || terminalStreamFailure(failure)) displayState.current.end();
          else displayState.current.pause();
          publishDisplay();
          playback.current.clearControl();
          inputPaused.current = true;
          setControl(false); setFrameError(reason);
          if (terminalStreamFailure(failure)) {
            canvas?.getContext('2d', { alpha: false })?.clearRect(0, 0, canvas.width, canvas.height);
            playback.current.end(); hostReturn.current.deny(); stopped = true; setEndedSessionId(session.sessionId); setFrame(null); setLastFrameAt(null); setTool(null);
            const explicitReconnect = !!(e && typeof e === 'object' && (e as { canReconnect?: boolean }).canReconnect === true);
            setManualReconnect(explicitReconnect); onTerminatedRef.current?.(reason, explicitReconnect);
          }
        }
      } finally { polling = false; }
      if (isCurrent()) {
        // Sleep needs a low-cost availability check, rather than repeated input cleanup.
        if (displayState.current.view(performance.now()).asleep) delay = Math.max(3000, delay);
        if (immediateRecheck) { immediateRecheck = false; delay = 0; }
        timer = window.setTimeout(() => void poll(), delay);
      }
    };
    const recheck = () => {
      if (!isCurrent()) return;
      if (polling) { immediateRecheck = true; return; }
      window.clearTimeout(timer); void poll();
    };
    recheckDisplay.current = recheck;
    const dispose = () => { stopped = true; pendingImage = null; immediateRecheck = false; window.clearTimeout(timer); if (imageTelemetry.current === publishImage) imageTelemetry.current = () => undefined; if (recheckDisplay.current === recheck) recheckDisplay.current = () => undefined; }; closeDelivery.current = dispose;
    void poll();
    return () => { dispose(); if (closeDelivery.current === dispose) closeDelivery.current = () => undefined; };
  }, [session.sessionId, monitorId, deliveryScale, sessionEnded, videoEnabled, windowState.paused, deliveryGeneration]);

  useEffect(() => { videoControl.current?.setScale(frameScale); }, [frameScale, videoEnabled]);

  useEffect(() => { void api.monitors(session.sessionId).then(setMonitors).catch(() => undefined); }, [session.sessionId]);
  // Input stays paused while the stream is failing or ended, even if something re-enables control locally.
  const releaseInputs = useRef<() => void>(() => undefined);
  const notifyInput = useRef(notify); notifyInput.current = notify;
  const inputAttempt = useRef({ failed: false });
  const inputCleanup = useRef(false);
  const inputScope = [session.sessionId, monitorId, frame?.sessionGeneration, frame?.width, frame?.height, frame?.left, frame?.top, deliveryGeneration, control, permissions.control, session.viewOnly, sessionEnded, windowState.paused];
  const previousInputScope = useRef(inputScope);
  if (previousInputScope.current.some((value, index) => !Object.is(value, inputScope[index]))) { previousInputScope.current = inputScope; inputAttempt.current = { failed: false }; }
  useEffect(() => { inputPaused.current = disconnectStarted.current || !!frameError || !!disconnectError || ending || sessionEnded || windowState.paused; if (inputPaused.current) setControl(false); }, [frameError, disconnectError, ending, sessionEnded, windowState.paused]);
  const send = useCallback((event: Record<string, unknown>) => {
    if (disconnectStarted.current || inputPaused.current || inputAttempt.current.failed) return;
    const attempt = inputAttempt.current, cleanup = inputCleanup.current, delivery = inputDelivery.current;
    void api.input(session.sessionId, event, monitorId || null).catch(e => {
      if (cleanup || attempt !== inputAttempt.current || attempt.failed || inputPaused.current || delivery !== inputDelivery.current || !delivery?.isCurrent()) return;
      attempt.failed = true; playback.current.clearControl(); setControl(false);
      releaseInputs.current();
      inputAttempt.current.failed = true;
      notifyInput.current(`Remote input stopped: ${errorMessage(e)}`);
    });
  }, [session.sessionId, monitorId]);
  const moves = useMemo(() => new FrameInputCoalescer(send, callback => window.requestAnimationFrame(callback), frame => window.cancelAnimationFrame(frame)), [send]);
  useEffect(() => () => moves.cancel(), [moves]);
  const sendImmediate = useCallback((event: Record<string, unknown>) => moves.immediate(event), [moves]);
  const layoutReleaseFrame = useRef<number | null>(null);
  const layoutReleaseTicket = useRef<object | null>(null);
  const releaseKeys = useCallback(() => {
    layoutReleaseTicket.current = null;
    if (layoutReleaseFrame.current !== null) { window.cancelAnimationFrame(layoutReleaseFrame.current); layoutReleaseFrame.current = null; }
    inputAttempt.current = { failed: false }; moves.cancel(); cursorLayer.current?.stopPrediction(); inputCleanup.current = true;
    heldKeys.current.forEach(event => send({ type: 'key', ...event, down: false })); inputCleanup.current = false;
    heldKeys.current.clear(); keyRepeatTimes.current.clear(); void invoke('session.release-inputs', { sessionId: session.sessionId }).catch(() => undefined);
  }, [send, moves, session.sessionId]);
  const releaseLayoutInputs = useCallback(() => {
    moves.cancel(); cursorLayer.current?.stopPrediction();
    if ((!currentControl.current.enabled && heldKeys.current.size === 0) || layoutReleaseFrame.current !== null) return;
    const scope = currentControl.current;
    const ticket = {}; layoutReleaseTicket.current = ticket;
    layoutReleaseFrame.current = window.requestAnimationFrame(() => {
      if (layoutReleaseTicket.current !== ticket) return;
      layoutReleaseTicket.current = null;
      layoutReleaseFrame.current = null;
      const current = currentControl.current;
      if (current.sessionId !== scope.sessionId || current.monitorId !== scope.monitorId || current.sessionGeneration !== scope.sessionGeneration) return;
      if (currentControl.current.enabled || heldKeys.current.size > 0) releaseKeys();
    });
  }, [moves, releaseKeys]);
  useEffect(() => {
    let active = true;
    const receive = (value: unknown) => {
      if (!active || !nativeFullscreenTracker.current.accept(value)) return;
      const next = nativeFullscreenTracker.current.snapshot()!;
      if (nativeFullscreenCurrent.current && next.fullscreen !== nativeFullscreenCurrent.current.fullscreen) releaseInputs.current();
      nativeFullscreenCurrent.current = next; setNativeFullscreen(next);
      if (next.fullscreen) unobservedFullscreenEntry.current = false;
      if (next.fullscreen && !disconnectStarted.current && layoutIntent.current === 'viewer') setExpanded(true);
    };
    const unsubscribe = window.orbit?.onFullscreenState?.(receive);
    if (unsubscribe) void api.fullscreen().then(receive).catch(() => undefined);
    return () => { active = false; fullscreenRequestToken.current = null; fullscreenRequestTarget.current = null; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    const shell = viewer.current?.closest('.app-shell');
    if (expanded) shell?.classList.add('viewer-full-window');
    return () => { shell?.classList.remove('viewer-full-window'); };
  }, [expanded]);
  useEffect(() => {
    const resize = () => releaseLayoutInputs();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      layoutReleaseTicket.current = null;
      if (layoutReleaseFrame.current !== null) { window.cancelAnimationFrame(layoutReleaseFrame.current); layoutReleaseFrame.current = null; }
    };
  }, [releaseLayoutInputs]);
  const changeExpanded = (value: boolean) => {
    layoutIntent.current = value ? 'viewer' : 'workspace';
    releaseKeys(); setExpanded(value); setHudReveal(value => value + 1);
    if (!value && (nativeFullscreenCurrent.current?.fullscreen || unobservedFullscreenEntry.current || fullscreenRequestTarget.current === true)) void changeNativeFullscreen(false);
  };
  const changeNativeFullscreen = async (value: boolean) => {
    if (!nativeFullscreenCurrent.current || (value && disconnectStarted.current) ||
      (fullscreenRequestToken.current && (value || fullscreenRequestTarget.current === false))) return;
    const request = {}; fullscreenRequestToken.current = request; fullscreenRequestTarget.current = value; setFullscreenPending(true); releaseKeys(); setHudReveal(value => value + 1);
    unobservedFullscreenEntry.current = value;
    if (value) { layoutIntent.current = 'viewer'; setExpanded(true); }
    try {
      const next = await api.setFullscreen(value);
      if (fullscreenRequestToken.current !== request) return;
      if (nativeFullscreenTracker.current.accept(next)) {
        nativeFullscreenCurrent.current = nativeFullscreenTracker.current.snapshot(); setNativeFullscreen(nativeFullscreenCurrent.current);
      }
    } catch (error) { if (fullscreenRequestToken.current === request) { unobservedFullscreenEntry.current = false; notifyInput.current(errorMessage(error)); } }
    finally { if (fullscreenRequestToken.current === request) { fullscreenRequestToken.current = null; fullscreenRequestTarget.current = null; setFullscreenPending(false); } }
  };
  const localKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (tool || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
    if (reservedLocalKeys.current.has(event.code)) {
      if (event.repeat) { event.preventDefault(); event.stopPropagation(); return; }
      reservedLocalKeys.current.delete(event.code);
    }
    if (event.code === 'Enter' && event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault(); event.stopPropagation();
      for (const code of heldKeys.current.keys()) if (/^(Control|Alt)/.test(code)) reservedLocalKeys.current.add(code);
      reservedLocalKeys.current.add(event.code); releaseKeys(); setHudReveal(value => value + 1);
      if (!event.repeat) void changeNativeFullscreen(!nativeFullscreenCurrent.current?.fullscreen);
      window.requestAnimationFrame(() => { if (!disconnectStarted.current && document.hasFocus() && !nativeWindowState.current.paused) localControlsButton.current?.focus(); });
      return;
    }
    if (!control && !tool && event.target === viewer.current && (event.key === 'F11' || event.key === 'Escape')) {
      event.preventDefault(); event.stopPropagation(); if (event.repeat) return;
      releaseKeys(); setHudReveal(value => value + 1);
      if (event.key === 'F11') void changeNativeFullscreen(!nativeFullscreenCurrent.current?.fullscreen);
      else if (nativeFullscreenCurrent.current?.fullscreen) void changeNativeFullscreen(false);
      else if (expanded) changeExpanded(false);
    }
  };
  const localKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (tool || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
    if (reservedLocalKeys.current.delete(event.code)) { event.preventDefault(); event.stopPropagation(); }
  };
  receiveWindowState.current = value => {
    if (disconnectStarted.current) return;
    const change = playback.current.receive(value, currentControl.current);
    if (!change) return;
    const next = change.state; nativeWindowState.current = next;
    if (currentControl.current.ended) { inputPaused.current = true; setWindowState(next); return; }
    if (change.transition === 'paused') {
      displayState.current.pause(); publishDisplay();
      clearNavigationControl();
      const mode = currentVideo.current; resumeVideo.current = mode.wanted && (mode.enabled || mode.retry);
      closeDelivery.current(); releaseKeys(); inputPaused.current = true; setControl(false); setFrame(null); setLastFrameAt(null); setFrameError('');
    } else if (change.transition === 'resumed') {
      closeDelivery.current(); inputPaused.current = true; setFrame(null); setFrameError(''); setVideoRetryDelay(null);
      setVideoEnabled(resumeVideo.current && currentVideo.current.wanted); setDeliveryGeneration(value => value + 1);
      setFocused(document.activeElement === viewer.current && document.hasFocus());
    }
    setWindowState(next);
  };
  useEffect(() => {
    const bridge = window.orbit;
    if (!bridge?.onWindowState) return;
    return observeWindowState({ invoke: bridge.invoke, onWindowState: bridge.onWindowState }, value => receiveWindowState.current(value),
      () => { playback.current.delivery.invalidate(); closeDelivery.current(); inputPaused.current = true; setControl(false); notify('Window state is unavailable. Screen delivery remains paused.'); });
  }, [session.sessionId]);
  useEffect(() => { if (!control) releaseKeys(); }, [control, releaseKeys]);
  releaseInputs.current = releaseKeys;
  useEffect(() => { const blur = () => { releaseKeys(); reservedLocalKeys.current.clear(); setFocused(false); }; window.addEventListener('blur', blur); return () => { window.removeEventListener('blur', blur); releaseKeys(); }; }, [releaseKeys]);
  useEffect(() => {
    const releaseOutside = (event: MouseEvent) => { if (!viewer.current?.contains(event.target as Node)) releaseKeys(); };
    window.addEventListener('mouseup', releaseOutside);
    return () => window.removeEventListener('mouseup', releaseOutside);
  }, [releaseKeys]);
  useEffect(() => {
    const element = viewer.current;
    const preventScroll = (event: WheelEvent) => { if (control) event.preventDefault(); };
    element?.addEventListener('wheel', preventScroll, { passive: false });
    return () => element?.removeEventListener('wheel', preventScroll);
  }, [control]);
  const point = (e: { clientX: number; clientY: number }) => {
    const element = viewer.current;
    if (!element || !image.current || !frame) return null;
    const rect = element.getBoundingClientRect();
    const layout = createViewerLayout({ physical: { width: frame.width, height: frame.height, left: frame.left, top: frame.top },
      viewport: { left: rect.left + element.clientLeft, top: rect.top + element.clientTop, width: element.clientWidth, height: element.clientHeight },
      mode: fit ? 'fit' : 'one-to-one', scroll: { left: element.scrollLeft, top: element.scrollTop } });
    return normalizedClientPoint(layout, e.clientX, e.clientY);
  };
  const disconnect = async () => { displayState.current.end(); publishDisplay(); layoutIntent.current = 'workspace'; disconnectStarted.current = true; fullscreenRequestToken.current = null; setFullscreenPending(false); inputPaused.current = true; closeDelivery.current(); playback.current.delivery.invalidate(); hostReturn.current.deny(); heldVideoRetry.current = null; setVideoRetryDelay(null); reconnectRequest.current = null; setReconnecting(false); setManualReconnect(false); onDisconnecting?.(); clearNavigationControl(); playback.current.clearControl(); setDisconnectError(''); setEnding(true); setControl(false); releaseKeys(); try { if (popout) { await invoke('session.release-inputs', { sessionId: session.sessionId }).catch(() => undefined); await invoke('viewer.close'); } else { await api.end(session.sessionId); onEnded(); } } catch (e) { setDisconnectError(errorMessage(e)); } finally { setEnding(false); } };
  const reconnect = async () => {
    if (reconnecting || windowState.paused || !sessionEnded || !manualReconnect) return;
    const request = {}; reconnectRequest.current = request;
    const hadFocus = document.activeElement === reconnectButton.current;
    restoreRetryFocus.current = false; setReconnectError('');
    setReconnecting(true); releaseKeys(); setControl(false);
    try { if (requestReconnect) { await requestReconnect(monitorId); return; } const next = await invoke<ViewerContext>('session.reconnect', { sessionId: session.sessionId, monitorId: monitorId || null }); if (reconnectRequest.current !== request) { await invoke(popout ? 'viewer.close' : 'session.end', popout ? {} : { sessionId: next.session.sessionId }).catch(() => {}); return; } playback.current.end(); closeDelivery.current(); inputPaused.current = true; onReconnected?.(next); }
    catch (error) {
      if (reconnectRequest.current !== request) return;
      restoreRetryFocus.current = hadFocus && (document.activeElement === document.body || document.activeElement === reconnectButton.current);
      setManualReconnect(!!(error && typeof error === 'object' && (error as { canReconnect?: boolean }).canReconnect));
      setFrameError(errorMessage(error)); setReconnectError(errorMessage(error));
    }
    finally { if (reconnectRequest.current === request) { reconnectRequest.current = null; setReconnecting(false); } }
  };
  const wakeDisplay = async () => {
    if (!canOfferWake || !displayAlive.current || disconnectStarted.current || nativeWindowState.current.paused || currentControl.current.ended) return;
    const request = displayState.current.beginWake(performance.now());
    if (!request) return;
    if (wakeOwnsFocus.current) { wakeOwnsFocus.current = false; if (document.hasFocus()) viewer.current?.focus({ preventScroll: true }); }
    clearNavigationControl(); playback.current.clearControl(); setControl(false); releaseKeys(); publishDisplay();
    try {
      const result = await api.wakeDisplay(session.sessionId);
      if (!displayAlive.current || disconnectStarted.current || nativeWindowState.current.paused || currentControl.current.ended) return;
      if (result?.state !== 'requested') throw new Error('The remote computer did not accept the wake request.');
      if (displayState.current.finishWake(request, 'Wake requested.', performance.now())) { publishDisplay(); recheckDisplay.current(); }
    } catch (error) {
      if (!displayAlive.current || disconnectStarted.current || nativeWindowState.current.paused || currentControl.current.ended) return;
      const failure = streamFallback(error), reason = errorMessage(error);
      if (!displayState.current.currentReply(request)) return;
      if (terminalStreamFailure(failure)) {
        displayState.current.end(); closeDelivery.current(); clearNavigationControl(); playback.current.end(); hostReturn.current.deny();
        inputPaused.current = true; setControl(false); releaseKeys(); heldVideoRetry.current = null; setVideoRetryDelay(null);
        setFrame(null); setLastFrameAt(null); setTool(null); setManualReconnect(false); setFrameError(reason);
        setEndedSessionId(session.sessionId); onTerminatedRef.current?.(reason, false);
      } else {
        if (!displayState.current.finishWake(request, reason, performance.now(), failure.code === 'wake_rate_limited' && failure.status === 429)) return;
        if (failure.code === 'host_stopping') { displayState.current.end(); setFrameError(reason); }
        else if (failure.code === 'wake_unsupported' && failure.status === 409) displayState.current.unsupported();
      }
      publishDisplay();
    }
  };
  const openScreen = async () => { setOpeningScreen(true); releaseKeys(); setControl(false); try { await invoke('viewer.open', { sessionId: session.sessionId, monitorId: monitorId || '' }); } catch (e) { notify(errorMessage(e)); } finally { setOpeningScreen(false); } };
  const listFiles = async (path = '') => { setToolBusy(true); setToolError(''); try { const value = await invoke<{ entries?: FileEntry[]; files?: FileEntry[]; path?: string } | FileEntry[]>('files.list', { sessionId: session.sessionId, path }); setFiles(Array.isArray(value) ? value : value.entries || value.files || []); setFilePath(Array.isArray(value) ? path : value.path || path); } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const openTool = (next: 'clipboard' | 'files' | 'power') => { setTool(next); setToolError(''); if (next === 'files') void listFiles(); };
  const clipboard = async (action: 'read' | 'write') => { setToolBusy(true); setToolError(''); try { const value = await invoke<{ text?: string }>(`clipboard.${action}`, { sessionId: session.sessionId, text: clipboardText }); if (action === 'read') setClipboardText(value.text || ''); else notify('Text sent to the remote clipboard.'); } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const upload = async () => { setToolBusy(true); setToolError(''); try { const result = await invoke<{ cancelled?: boolean }>('files.upload', { sessionId: session.sessionId, path: filePath }); if (!result.cancelled) { notify('File uploaded to the remote shared folder.'); await listFiles(filePath); } } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const download = async (file: FileEntry) => { setToolBusy(true); setToolError(''); try { const result = await invoke<{ savedPath?: string; cancelled?: boolean }>('files.download', { sessionId: session.sessionId, name: file.name }); if (!result.cancelled) notify(result.savedPath ? `Saved to ${result.savedPath}` : 'Download complete.'); } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const power = async (action: 'lock' | 'restart') => { setToolBusy(true); setToolError(''); setControl(false); releaseKeys(); try { await invoke(`session.${action}`, { sessionId: session.sessionId }); notify(action === 'lock' ? 'Remote screen lock requested.' : 'Restart scheduled; reconnecting automatically.'); setTool(null); if (action === 'restart') { setFrame(null); setFrameError('Restart scheduled; reconnecting automatically.'); } } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };

  return <div className={`remote-session ${expanded ? 'viewer-expanded' : ''}`} onKeyDownCapture={localKeyDown} onKeyUpCapture={localKeyUp} data-stream-mode={sessionEnded ? 'ended' : windowState.paused ? 'paused' : videoEnabled ? 'video' : 'image'} data-display-asleep={displayView.asleep && !sessionEnded} data-display-generation={displayView.sessionGeneration} data-stream-last-fallback={videoFallback?.code} data-stream-retry-delay={videoRetryDelay ?? undefined}><div className="session-heading" aria-hidden={expanded} inert={expanded}><div className="session-identity"><span className="session-platform"><PlatformIcon platform={session.device.platform} /></span><div><h1>{session.device.name}</h1><span><i className={`small-dot ${sessionEnded || windowState.paused ? '' : 'green'}`} /> {sessionEnded ? 'Session ended' : windowState.paused ? 'Screen updates paused' : displayView.asleep ? 'Display asleep' : frameError ? 'Reconnecting to desktop' : frame ? 'Desktop connected' : 'Opening desktop'}<span className="session-heading-sep">·</span>{platformName(session.device.platform)}</span></div></div><button className="button danger-outline small" disabled={ending} onClick={() => void disconnect()}>{ending ? <Loader2 size={15} className="spin" /> : <Unplug size={15} />} {popout ? 'Close screen' : 'Disconnect'}</button></div>
    {disconnectError && <div className="error-banner" role="alert"><Shield size={17} /><span>{popout ? "Couldn't close this screen." : "Couldn't end the session on the remote computer."} <span>{disconnectError}</span></span><button className="button secondary small" disabled={ending} onClick={() => void disconnect()}>Retry</button></div>}
    <div className="screen-window-note"><Monitor size={12} /><span>{popout ? independent ? 'This screen has its own new connection. Closing it ends this connection.' : 'This screen shares the existing connection. Closing it keeps your other windows connected.' : 'Open existing host displays in separate windows. Creating additional virtual displays is planned.'}</span></div>
    <SessionHud title={session.device.name} titleHeading={expanded} revealRequest={hudReveal} onTitleDoubleClick={() => void changeNativeFullscreen(!nativeFullscreenCurrent.current?.fullscreen)} link={frame?.link || session.link} ended={sessionEnded} state={sessionEnded ? 'ended' : windowState.paused ? 'paused' : displayView.asleep ? 'asleep' : hostReturn.current.awaitingHost() ? 'reconnecting' : frameError && frame ? 'reconnecting' : 'live'} stats={videoEnabled ? videoStats : stats} controlling={control} viewOnly={session.viewOnly} overlayAction={displayView.asleep && !sessionEnded && !windowState.paused ? <div className="display-wake-actions">{canOfferWake && <button type="button" className="button primary small" ref={wakeButton} aria-label="Wake display" aria-describedby={wakeFeedbackId} onFocus={() => { wakeOwnsFocus.current = true; }} onBlur={event => { if (event.relatedTarget) wakeOwnsFocus.current = false; }} aria-busy={displayView.pending} disabled={displayView.pending || displayView.remainingMs > 0} onClick={() => void wakeDisplay()}>{displayView.pending && <Loader2 size={15} className="spin" />}{displayView.pending ? 'Requesting wake...' : 'Wake display'}</button>}<span className="display-wake-feedback" aria-hidden="true">{displayView.pending ? 'Requesting display wake.' : displayView.message}</span></div> : !windowState.paused && sessionEnded && manualReconnect ? <button ref={reconnectButton} className="button primary small" disabled={reconnecting || ending || !!disconnectError} onClick={() => void reconnect()}>{reconnecting ? 'Reconnecting...' : 'Reconnect'}</button> : undefined} detail={!sessionEnded && windowState.paused ? `Screen updates and input are paused while this window is ${windowState.reason === 'minimized' ? 'minimized' : 'hidden'}. They resume when you return to it.` : displayView.asleep ? canOfferWake ? 'You can request a wake. Keyboard and mouse input stay off.' : 'Someone at that computer, or a controller, can wake it.' : hostReturn.current.awaitingHost() ? 'Waiting for the same paired host to return. Video will retry after a fresh authorized screen update.' : frameError || undefined} toolbar={<><button className="toolbar-button" aria-label={expanded ? popout ? 'Show window details' : 'Return to workspace' : 'Expand viewer'} title={expanded ? popout ? 'Show window details' : 'Return to workspace' : 'Use the whole application window'} disabled={fullscreenPending && !expanded} onClick={() => changeExpanded(!expanded)}>{expanded ? <ArrowDownLeft size={15} /> : <Maximize2 size={15} />}<span>{expanded ? popout ? 'Window details' : 'Workspace' : 'Expand'}</span></button>{!disconnectStarted.current && !sessionEnded && !(nativeFullscreen?.fullscreen && !expanded) && <button className="toolbar-button" aria-label={nativeFullscreen?.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title="Toggle local fullscreen (Ctrl+Alt+Enter). While controlling, Escape and F11 go to the remote computer." disabled={!nativeFullscreen || fullscreenPending || disconnectStarted.current} onClick={() => void changeNativeFullscreen(!nativeFullscreenCurrent.current?.fullscreen)}><Maximize2 size={15} /><span>{nativeFullscreen?.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}</span></button>}{expanded && <button className="button danger-outline small" disabled={ending} onClick={() => void disconnect()}><Unplug size={15} />{popout ? 'Close screen' : 'Disconnect'}</button>}<button type="button" role="switch" aria-checked={videoOn} aria-label="Video stream (beta)" className={`toolbar-button ${videoOn ? 'selected' : ''}`} disabled={sessionEnded || typeof VideoDecoder !== 'function'} title="Prefer hardware-decoded H.264 video. Transient failures use images while video retries automatically. Switch off to use images." onClick={() => { releaseKeys(); setControl(false); retryPolicy.current.reset(); hostReturn.current.reset(); setVideoRetryDelay(null); setVideoFallback(null); clearNavigationControl(); viewerState.current?.({ videoWanted: !videoOn }); setVideoWanted(!videoOn); setVideoEnabled(!videoOn); }}><MonitorPlay size={15} /><span>Video stream (beta)</span></button><div className="toolbar-group"><Monitor size={16} /><select aria-label="Remote monitor" disabled={popout || sessionEnded} value={monitorId} onChange={e => { releaseKeys(); setControl(false); clearNavigationControl(); viewerState.current?.({ monitorId: e.target.value }); setMonitorId(e.target.value); setFrame(null); }}>{monitors.length === 0 && <option value="">Primary display</option>}{monitors.length > 0 && <option value="">Primary display</option>}{monitors.map(m => <option key={m.id} value={m.id}>{m.name} · {m.width} × {m.height}</option>)}</select></div>{session.canScaleFrames && <div className="toolbar-group"><select aria-label="Screen image quality" title="Smaller screen images reduce image transfer. Pointer coordinates always use the full desktop." disabled={sessionEnded} value={frameScale} onChange={event => { releaseKeys(); if (!videoEnabled) { setControl(false); setFrame(null); } viewerState.current?.({ frameScale: Number(event.target.value) }); setFrameScale(Number(event.target.value)); }}><option value={1}>Full detail</option><option value={0.75}>Balanced · 75%</option><option value={0.5}>Lighter · 50%</option></select></div>}{!popout && <button className="toolbar-button screen-popout-button" aria-label="Open screen in window" title="Open an existing host display in its own window. Creating virtual displays is planned." disabled={openingScreen || ending || sessionEnded} onClick={() => void openScreen()}>{openingScreen ? <Loader2 size={15} className="spin" /> : <ExternalLink size={15} />}<span>Open screen in window</span></button>}<div className="toolbar-group"><button className={`toolbar-button ${fit ? 'selected' : ''}`} onClick={() => { releaseKeys(); viewerState.current?.({ fit: true }); viewer.current?.scrollTo(0, 0); setFit(true); }} title="Fit to window"><Maximize2 size={15} /><span>Fit</span></button><button className={`toolbar-button ${!fit ? 'selected' : ''}`} onClick={() => { releaseKeys(); viewerState.current?.({ fit: false }); setFit(false); }}>1:1</button></div><button ref={localControlsButton} type="button" className={`toolbar-button ${detailsOpen ? 'selected' : ''}`} aria-pressed={detailsOpen} title="Connection details: smoothness, late frames, decode time and encryption" onClick={() => setDetailsOpen(o => !o)}><Gauge size={15} /><span>Details</span></button><div className="toolbar-spacer" /><button className="toolbar-button" disabled={sessionEnded || !permissions.clipboard} title={!permissions.clipboard ? 'Clipboard permission not granted' : 'Clipboard'} onClick={() => openTool('clipboard')}><Clipboard size={16} /><span>Clipboard</span></button><button className="toolbar-button" disabled={sessionEnded || !permissions.files} title={!permissions.files ? 'File permission not granted' : 'Shared files'} onClick={() => openTool('files')}><FolderOpen size={16} /><span>Files</span></button><button className="toolbar-button" disabled={sessionEnded || !permissions.power} title={!permissions.power ? 'Power permission not granted' : 'Lock and restart'} onClick={() => openTool('power')}><Power size={16} /></button><span className="toolbar-divider" /><button className={`button small ${control ? 'primary' : 'secondary'}`} disabled={ending || !!disconnectError || sessionEnded || windowState.paused || displayView.asleep || session.viewOnly || !permissions.control || !frame || !!frameError} onClick={() => { clearNavigationControl(); playback.current.clearControl(); if (control) releaseKeys(); setControl(c => !c); if (!control) viewer.current?.focus(); }}><MousePointer2 size={15} />{session.viewOnly ? 'View only' : control ? 'Control enabled' : 'Take control'}</button></>}>
    <div ref={viewer} tabIndex={0} aria-label="Remote desktop. Enable Take control to send keyboard and mouse input. Ctrl+Alt+Enter shows local controls and toggles fullscreen. While controlling, Escape and F11 go to the remote computer." className={`remote-viewer ${fit ? 'fit' : 'actual'} ${control ? 'controlling' : ''} ${focused ? 'focused' : ''}`} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); releaseKeys(); }} onMouseLeave={() => { if (control) releaseKeys(); }} onScroll={() => releaseLayoutInputs()} onContextMenu={e => { if (control) e.preventDefault(); }} onMouseMove={e => { if (!control) return; const p = point(e); if (p) { if (focused && !inputPaused.current) cursorLayer.current?.predict(p.x, p.y); moves.move({ type: 'pointer.move', ...p }); } }} onMouseDown={e => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); e.currentTarget.focus(); sendImmediate({ type: 'pointer.button', button: e.button, down: true, ...p }); } }} onMouseUp={e => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); sendImmediate({ type: 'pointer.button', button: e.button, down: false, ...p }); } else { releaseKeys(); } }} onWheel={e => { if (!control) return; const p = point(e); if (p) sendImmediate({ type: 'pointer.wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...p }); }} onKeyDown={e => { if (!control || !focused) return; e.preventDefault(); e.stopPropagation(); const now = Date.now(); if (e.repeat && now - (keyRepeatTimes.current.get(e.code) || 0) < 35) return; keyRepeatTimes.current.set(e.code, now); heldKeys.current.set(e.code, { key: e.key, code: e.code }); sendImmediate({ type: 'key', key: e.key, code: e.code, down: true, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }); }} onKeyUp={e => { if (!control || !focused || !heldKeys.current.has(e.code)) return; e.preventDefault(); e.stopPropagation(); heldKeys.current.delete(e.code); keyRepeatTimes.current.delete(e.code); sendImmediate({ type: 'key', key: e.key, code: e.code, down: false, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }); }}>
      <canvas key={`${session.sessionId}:${monitorId}:${deliveryScale}:${videoEnabled && !sessionEnded ? 'video' : 'image'}:${sessionEnded ? 'ended' : 'live'}:${deliveryGeneration}:${windowState.paused ? 'paused' : 'active'}`} ref={image} role="img" aria-label={`Remote desktop of ${session.device.name}`} style={{ display: frame ? undefined : 'none', ...(!fit && frame ? { width: frame.width, height: frame.height } : {}) }} /><canvas ref={cursorInvert} className="remote-cursor-layer remote-cursor-invert" aria-hidden="true" /><canvas ref={cursorReplace} className="remote-cursor-layer remote-cursor-replace" aria-hidden="true" />{!frame && (!displayView.asleep || sessionEnded) && (!windowState.paused || sessionEnded) && <div className="stream-loading"><div className="stream-orbit"><BrandMark /></div><h3>{sessionEnded ? 'This session has ended.' : frameError ? 'Waiting for the remote desktop' : 'Bringing your desktop into view'}</h3><p>{frameError || 'Establishing a screen stream over your private connection…'}</p><>{sessionEnded ? <p className="session-ended-help">{popout ? 'Close this screen, then choose Connect in the main window to start a new session.' : 'Choose Disconnect, then Connect to start a new session. Orbit will not reconnect to this ended session.'}</p> : <Loader2 className="spin" size={20} />}</></div>}
    </div></SessionHud><span id={wakeFeedbackId} data-display-wake-feedback="" className="hud-sr" role="status" aria-live="polite">{displayView.pending ? 'Requesting display wake.' : displayView.message}</span><span className="hud-sr" role="status" aria-live="polite">{reconnectAnnouncement}</span><span className="hud-sr" role="alert">{reconnectError}</span><ConnectionDetails open={detailsOpen} onClose={() => setDetailsOpen(false)} deviceName={session.device.name} link={frame?.link || session.link} stats={videoEnabled ? videoStats : stats} monitor={monitors.find(m => m.id === monitorId) ?? monitors.find(m => m.primary)} scale={frame?.scale ?? frameScale} canScaleFrames={session.canScaleFrames} lastFrameBytes={frameDelivery.bytes} /><div className="session-statusbar"><LinkStatus ended={sessionEnded} link={frame?.link || session.link} code={securityCode(session.device.fingerprint || session.device.serverFingerprint)} /><span>{frame ? `${frame.width} × ${frame.height}` : 'Waiting for display'}<span className="status-separator">·</span>{sessionEnded ? 'Explicit Connect required' : windowState.paused ? 'Paused' : displayView.asleep ? 'Display asleep' : frameDelivery.unchanged ? 'Idle screen · 0 KB' : lastFrameAt ? videoEnabled ? 'Video stream' : 'Image stream' : 'Connecting'}<span className="status-separator">·</span>{control && focused ? 'Keyboard captured' : 'Local keyboard'}</span></div>
    {tool && <Modal title={tool === 'clipboard' ? 'A little copy. A little paste.' : tool === 'files' ? 'Files, within reach.' : 'Host power controls'} subtitle={tool === 'clipboard' ? 'Explicitly read or write the remote computer’s text clipboard.' : tool === 'files' ? 'Transfers are confined to the remote host’s shared folder.' : 'These actions affect the remote computer. Save any work first.'} onClose={() => setTool(null)} wide={tool === 'files'}>
      {toolError && <div className="inline-error" role="alert">{toolError}</div>}
      {tool === 'clipboard' && <><label className="field-label" htmlFor="clipboard-content">CLIPBOARD TEXT</label><textarea id="clipboard-content" className="join-code" value={clipboardText} onChange={e => setClipboardText(e.target.value)} placeholder="Read the remote clipboard, or type text to send…" rows={7} /><div className="modal-footer"><button className="button secondary" disabled={toolBusy} onClick={() => void clipboard('read')}><Download size={15} /> Read remote</button><button className="button primary" disabled={toolBusy} onClick={() => void clipboard('write')}><Upload size={15} /> Send to remote</button></div></>}
      {tool === 'files' && <><div className="files-toolbar"><button className="button text small" disabled={toolBusy || !filePath} onClick={() => { const parent = filePath.replace(/[/\\][^/\\]+[/\\]?$/, ''); void listFiles(parent === filePath ? '' : parent); }}><ArrowUpRight size={14} /> Parent folder</button><span>{filePath || 'Shared folder'}</span><button className="button secondary small" disabled={toolBusy} onClick={() => void upload()}><Upload size={14} /> Upload</button></div><div className="file-list">{toolBusy && <div className="file-busy"><Loader2 size={18} className="spin" /> Working…</div>}{files.length ? files.map((file, i) => <button className="file-row" key={`${file.path}-${i}`} disabled={toolBusy} onClick={() => file.isDirectory || file.directory ? void listFiles(file.path) : void download(file)}>{file.isDirectory || file.directory ? <Folder size={19} /> : <File size={19} />}<strong>{file.name}</strong><span>{file.isDirectory || file.directory ? 'Folder' : file.size !== undefined ? formatSize(file.size) : 'File'}</span>{file.isDirectory || file.directory ? <ChevronRight size={15} /> : <Download size={15} />}</button>) : !toolBusy && <div className="file-empty"><FolderOpen size={30} /><p>This folder is empty.</p></div>}</div></>}
      {tool === 'power' && <div className="power-actions"><button className="power-action" disabled={toolBusy} onClick={() => void power('lock')}><LockKeyhole size={21} /><div><strong>Lock remote screen</strong><span>Require the computer’s credentials to unlock.</span></div><ArrowRight size={17} /></button><div className="restart-warning"><Power size={22} /><div><strong>Restart remote computer</strong><p>This can close unsaved work. Orbit will keep this viewer open and try to reconnect after the remote host returns. Take control again when the desktop is ready.</p><button className="button danger" disabled={toolBusy} onClick={() => void power('restart')}>{toolBusy ? <Loader2 size={15} className="spin" /> : <Power size={15} />} Restart now</button></div></div></div>}
    </Modal>}
  </div>;
}

function formatSize(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

function StandaloneViewer() {
  const [fullscreenViewerExpanded, setFullscreenViewerExpanded] = useState(true);
  const [context, setContext] = useState<LocalViewerContext | null>(null);
  const [retiredViewerId, setRetiredViewerId] = useState<string | null>(null);
  const [reconnectReadySessionId, setReconnectReadySessionId] = useState<string | null>(null);
  useEffect(() => {
    setReconnectReadySessionId(current => current && (context?.session.sessionId !== current || context?.session.endedReason) ? null : current);
  }, [context?.session.sessionId, context?.session.endedReason, reconnectReadySessionId]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  useEffect(() => {
    let disposed = false;
    void invoke<ViewerContext>('viewer.context').then(value => {
      if (!value?.session?.sessionId || !value.session.device) throw new Error('This screen window is not attached to a connection. Open it from an active remote desktop.');
      if (!disposed) setContext(value);
    }).catch(reason => { if (!disposed) setError(errorMessage(reason)); });
    const syncTheme = () => applyTheme(readThemePreference());
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', syncTheme);
    const storageChanged = (event: StorageEvent) => { if (event.key === THEME_STORAGE_KEY || event.key === null) syncTheme(); };
    window.addEventListener('storage', storageChanged);
    return () => { disposed = true; media.removeEventListener('change', syncTheme); window.removeEventListener('storage', storageChanged); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer); }, [toast]);
  return <main className="standalone-viewer">
    {error && <div className="error-banner" role="alert"><Shield size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
    {context ? <RemoteSession key={context.session.sessionId} session={context.session} onLayoutChange={setFullscreenViewerExpanded} onDisconnecting={() => setRetiredViewerId(context.session.sessionId)} onViewerState={update => setContext(current => current ? { ...current, session: { ...current.session, viewer: { ...current.session.viewer, ...update } } } : current)} independent={context.independent} focusAfterReconnect={reconnectReadySessionId === context.session.sessionId && !context.session.endedReason} onReconnectReady={() => setReconnectReadySessionId(current => current === context.session.sessionId ? null : current)} onReconnected={next => { setReconnectReadySessionId(next.session.sessionId); setContext(current => ({ ...next, session: { ...next.session, viewer: { ...current?.session.viewer, monitorId: next.monitorId, control: undefined } } })); }} initialMonitorId={context.monitorId || ''} popout onTerminated={(reason, canReconnect) => setContext(current => current ? { ...current, session: { ...current.session, endedReason: reason, canReconnect: canReconnect === true } } : current)} onEnded={() => undefined} onError={setError} notify={setToast} /> : <div className="standalone-loading"><BrandMark />{error ? <><h1>This screen is not connected.</h1><p>Open a screen window from an active Orbit connection.</p><button className="button secondary" onClick={() => { void invoke('viewer.close').catch(reason => setError(errorMessage(reason))); }}><X size={15} /> Close screen</button></> : <><h1>Opening your screen.</h1><p>Using your existing private connection.</p><Loader2 size={18} className="spin" /></>}</div>}
    <WindowFullscreenExit available={!context || !!context.session.endedReason || retiredViewerId === context.session.sessionId || !fullscreenViewerExpanded} onError={setError} />
    {toast && <div className="toast" role="status"><span><Check size={16} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </main>;
}

function App() {
  return new URLSearchParams(window.location.search).get('viewer') === '1' ? <StandaloneViewer /> : <WorkspaceApp />;
}

export default App;
