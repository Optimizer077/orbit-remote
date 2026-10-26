import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleHelp, Clipboard, Command, Copy, Download,
  Ellipsis, ExternalLink, File, Folder, FolderOpen, Globe2, HardDrive,
  Keyboard, Laptop, LayoutDashboard, Link2, Loader2, LockKeyhole, Maximize2,
  Monitor, MonitorUp, MousePointer2, Network, Plus, Power, RefreshCw,
  Search, Settings2, Shield, ShieldCheck, SlidersHorizontal, Terminal, Palette,
  Unplug, Upload, Wifi, X, Zap, MonitorPlay, Eye, UserPlus, Ticket, SunMoon, Sun, Moon,
} from 'lucide-react';
import { SessionHud, useFrameStats } from './ui/SessionHud';
import { DevicesPage } from './ui/DevicesPage';
import { ActivityPage } from './ui/ActivityPage';
import { SettingsPage as SettingsPageV2 } from './ui/SettingsPage';
import { Overview } from './ui/Overview';
import { ViewedBanner } from './ui/ViewedBanner';
import { CommandPalette, usePaletteShortcut, type Command as PaletteCommand } from './ui/CommandPalette';
import { api, applyTheme, errorMessage, invoke, readThemePreference, securityCode, THEME_STORAGE_KEY, type AuditEntry, type Device, type Frame, type HostSettings, type HostStatus, type Invite, type Link, type Monitor as RemoteMonitor, type Permissions, type Session, type ThemePreference, type ViewerContext } from './api';

const INITIAL_THEME = readThemePreference();
applyTheme(INITIAL_THEME);

type Page = 'overview' | 'devices' | 'connections' | 'activity' | 'settings';
type ActiveSession = Session & { device: Device; viewOnly: boolean };
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
    <div className="modal-icon"><Link2 size={22} /></div><h2>{title}</h2>{subtitle && <p className="modal-subtitle">{subtitle}</p>}{children}
  </div></div>;
}

function EmptyState({ icon: Icon = MonitorUp, title, description, action, compact = false }: { icon?: typeof Monitor; title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={`empty-state ${compact ? 'compact' : ''}`}><div className="empty-icon"><Icon size={28} strokeWidth={1.4} /></div><h3>{title}</h3><p>{description}</p>{action}</div>;
}

function WorkspaceApp() {
  const [theme, setTheme] = useState<ThemePreference>(INITIAL_THEME);
  const [page, setPage] = useState<Page>('overview');
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [toastError, setToastError] = useState(false);
  const [pairMode, setPairMode] = useState<'invite' | 'join' | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [endingIncoming, setEndingIncoming] = useState(false);
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
    if (!quiet) setRefreshing(true);
    const results = await Promise.allSettled([api.status(), api.devices(), api.audit()]);
    if (results[0].status === 'fulfilled') { setStatus(results[0].value); if (!quiet) setError(''); }
    else if (!quiet || !status) setError(errorMessage(results[0].reason));
    if (results[1].status === 'fulfilled') setDevices(results[1].value);
    if (results[2].status === 'fulfilled') setAudits(results[2].value);
    setLoading(false); setRefreshing(false);
  }, [Boolean(status)]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(true), incoming.length ? 4000 : 15000); return () => window.clearInterval(timer); }, [refresh, incoming.length > 0]);
  useEffect(() => window.orbit?.onIncomingChanged?.(() => void refresh(true)), [refresh]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer); }, [toast]);

  const notify = (message: string) => { setToastError(false); setToast(message); };
  const endIncoming = async (id?: string) => {
    setEndingIncoming(true);
    try { if (id) await api.end(id); else await api.disconnectIncoming(); await refresh(true); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setEndingIncoming(false); }
  };
  const checkNetwork = async () => {
    setRefreshing(true);
    try {
      const value = await invoke<Device[] | { devices: Device[] }>('network.refresh');
      setDevices(Array.isArray(value) ? value : value.devices || []);
    } catch (e) { setError(errorMessage(e)); }
    await refresh();
  };
  const connect = async (device: Device, viewOnly = false) => {
    if (device.revoked || device.status === 'revoked') { setError(`${device.name}: ${device.statusReason || 'Access revoked by the host. Join a new invitation to pair again.'}`); return; }
    if (activeSession?.device.id === device.id && activeSession.viewOnly === viewOnly) { setPage('connections'); return; }
    setConnecting(device.id); setError('');
    try {
      if (activeSession) { await api.end(activeSession.sessionId).catch(() => undefined); setActiveSession(null); }
      const session = await api.start(device.id, viewOnly);
      setActiveSession({ ...session, device, viewOnly }); setPage('connections');
      void refresh(true);
    } catch (e) { const reason = errorMessage(e); setError(`Could not connect to ${device.name}: ${reason}`); if (/device.*sessions|session.*limit|maximum.*sessions/i.test(reason)) { setToastError(true); setToast(`${device.name}: ${reason}`); } }
    finally { setConnecting(null); }
  };
  const connected = status?.host?.tailscale?.connected === true;
  const localName = status?.host?.name || 'This computer';
  const sessionsCount = status?.sessions?.length ?? (activeSession ? 1 : 0);
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
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'devices' && devices.length > 0 && <b>{devices.length}</b>}{id === 'connections' && activeSession && <i className="nav-live" />}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="private-card"><div className="private-icon"><ShieldCheck size={18} /></div><strong>Private. By design.</strong><p>Your computers, connected<br />through your Tailscale network.</p><span>Built for your own orbit <ArrowUpRight size={12} /></span></div>
        <div className="local-user"><div className={`local-avatar ${connected ? 'connected' : ''}`}><Laptop size={18} /></div><div><strong>{localName}</strong><span>{status ? platformName(status.host.platform) : 'Connecting to service'}</span></div><span className="version">v{status?.host.version || '0.1'}</span></div>
      </div>
    </aside>

    <main className={`main ${activeSession && page === 'connections' ? 'session-page' : ''}`}>
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{NAV.find(n => n.id === page)?.label}</strong></div><div className="topbar-right"><span className={`network-pill ${connected ? 'connected' : ''}`}><i />{status?.host.testMode ? 'Local test mode' : connected ? 'Tailscale connected' : loading ? 'Checking network' : 'Tailscale disconnected'}</span><button className={`icon-button ${refreshing ? 'spin' : ''}`} title="Refresh host and check device availability" aria-label="Refresh host and check device availability" disabled={refreshing} onClick={() => void checkNetwork()}><RefreshCw size={16} /></button><div className="topbar-divider" /><span className="personal-avatar">P</span></div></header>
      <div className="main-content">
        <ViewedBanner sessions={incoming.map(session => ({ ...session, controlling: session.permissions?.control === true }))} busy={endingIncoming} onEndOne={id => void endIncoming(id)} onEndAll={() => void endIncoming()} />
        {error && <div className="error-banner" role="alert"><Shield size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}

        {page === 'overview' && <Overview status={status} devices={devices} activity={audits} sessionsCount={sessionsCount} sessions={status?.sessions}
          connecting={connecting} loading={loading}
          onAddDevice={() => setPairMode('invite')} onJoin={() => setPairMode('join')}
          onConnect={(device, viewOnly) => void connect(device, viewOnly)} onManage={setSelectedDevice} onNavigate={setPage}
          onCopyAddress={() => { void copyText(status?.host.tailscale.ip || '').then(() => notify('Tailscale address copied.')).catch(e => setError(errorMessage(e))); }} />}

        {page === 'devices' && <DevicesPage devices={devices} sessions={status?.sessions} connecting={connecting} onAddDevice={() => setPairMode('invite')} onJoin={() => setPairMode('join')}
          onConnect={(device, viewOnly) => void connect(device, viewOnly ?? false)} onManage={setSelectedDevice} onRefresh={() => void refresh()} refreshing={refreshing} />}

        {page === 'connections' && (activeSession ? <RemoteSession session={activeSession} onEnded={() => { setActiveSession(null); void refresh(true); }} onError={setError} notify={notify} /> : <>
          <PageHeading eyebrow="A DESKTOP, WITHOUT THE DISTANCE" title="Make yourself at home." description="Open a private session to one of your paired computers." />
          <div className="panel"><EmptyState icon={Link2} title="No active connection" description={devices.length ? 'Choose a computer below to open its desktop. View-only access is available from the device menu.' : 'Your remote desktop will appear here. Pair a computer to start your first session.'} action={!devices.length && <button className="button primary" onClick={() => setPairMode('invite')}><Plus size={16} /> Add a device</button>} /></div>
          {devices.length > 0 && <><div className="section-heading"><div><h2>Choose a computer</h2></div></div><DevicesPage embedded devices={devices} sessions={status?.sessions} connecting={connecting} onAddDevice={() => setPairMode('invite')} onJoin={() => setPairMode('join')} onConnect={(device, viewOnly) => void connect(device, viewOnly ?? false)} onManage={setSelectedDevice} /></>}
        </>)}

        {page === 'activity' && <ActivityPage entries={audits} refreshing={refreshing} onRefresh={() => void refresh()} />}

        {page === 'settings' && <SettingsPageV2 status={status} theme={theme} onThemeChange={setTheme} onSaved={() => { void refresh(); notify('Host settings saved.'); }} onError={setError} aboutContent={<AboutOrbit status={status} onError={setError} />} />}
      </div>
    </main>
    {toast && <div className={`toast ${toastError ? 'is-error' : ''}`} role={toastError ? 'alert' : 'status'}><span>{toastError ? <Shield size={16} /> : <Check size={16} />}</span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    {pairMode && <PairModal mode={pairMode} connected={connected} onClose={() => setPairMode(null)} onPaired={() => { setPairMode(null); setPage('devices'); void refresh(); notify('Device paired. Your orbit just got a little bigger.'); }} onError={setError} notify={notify} />}
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    {selectedDevice && <DeviceModal device={selectedDevice} onClose={() => setSelectedDevice(null)} onConnect={viewOnly => { setSelectedDevice(null); void connect(selectedDevice, viewOnly); }} onChanged={() => { setSelectedDevice(null); void refresh(); }} onError={setError} notify={notify} />}
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

function DeviceModal({ device, onClose, onConnect, onChanged, onError, notify }: { device: Device; onClose: () => void; onConnect: (viewOnly: boolean) => void; onChanged: () => void; onError: (e: string) => void; notify: (m: string) => void }) {
  const [permissions, setPermissions] = useState<Permissions>({ view: false, control: false, clipboard: false, files: false, power: false, ...device.permissions });
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const incoming = device.direction === 'incoming';
  const code = securityCode(device.fingerprint || device.serverFingerprint);
  const revoke = async () => { setBusy(true); try { if (incoming) await api.revoke(device.id); else await invoke('device.forget', { deviceId: device.id }); notify(incoming ? 'Device revoked. It can no longer connect to this host.' : 'Connection forgotten on this computer.'); onChanged(); } catch (e) { setError(errorMessage(e)); onError(errorMessage(e)); } finally { setBusy(false); } };
  return <Modal title={device.name} subtitle={`${platformName(device.platform)} · ${device.address || device.id}`} onClose={onClose}>
    {error && <div className="inline-error">{error}</div>}
    {device.direction === 'incoming' ? <div className="inline-notice subtle-notice"><ShieldCheck size={17} /><span>This computer has permission to access your host. To connect in the other direction, create an invite on that computer and join it here.</span></div> : <div className="device-modal-actions"><button className="button primary" disabled={!device.address || device.revoked || device.status === 'revoked'} onClick={() => onConnect(false)}><MousePointer2 size={16} /> Connect</button><button className="button secondary" disabled={!device.address || device.revoked || device.status === 'revoked'} onClick={() => onConnect(true)}><Monitor size={16} /> View only</button></div>}
    {code && <div className="security-code-card"><div className="subsection-label">SECURITY CODE</div><code>{code}</code><p>On {device.name}, open Overview → This computer. Its security code must match this one exactly. {incoming ? 'If it differs, revoke this device: it is not the computer you meant to pair.' : 'If it differs, don’t connect: forget this device and pair again.'}</p></div>}
    <div className="subsection-label">GRANTED PERMISSIONS</div><PermissionRows permissions={permissions} onChange={setPermissions} disabled />
    <p className="form-footnote">{incoming ? 'Permissions belong to this pairing. To change access, revoke it and create a new invitation with the permissions you want.' : 'These permissions were granted by the remote host. Its owner manages access to that computer.'}</p>
    <div className="danger-zone">{revokeConfirm ? <><div><strong>{incoming ? 'Revoke' : 'Forget'} {device.name}?</strong><p>{incoming ? 'This removes access to this host. Pair again to restore it.' : 'This removes the saved connection here. It does not revoke any access you granted on another host.'}</p></div><div className="heading-actions"><button className="button secondary small" onClick={() => setRevokeConfirm(false)}>Cancel</button><button className="button danger small" disabled={busy} onClick={() => void revoke()}>{busy ? <Loader2 size={14} className="spin" /> : <Unplug size={14} />} {incoming ? 'Revoke device' : 'Forget connection'}</button></div></> : <><div><strong>Remove this connection</strong><p>{incoming ? 'Revoke this device’s access immediately.' : 'Remove this saved connection from this computer.'}</p></div><button className="button danger-text small" onClick={() => setRevokeConfirm(true)}><Unplug size={14} /> {incoming ? 'Revoke' : 'Forget'}</button></>}</div>
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

function RemoteSession({ session, onEnded, onError, notify, initialMonitorId = '', popout = false }: { session: ActiveSession; onEnded: () => void; onError: (e: string) => void; notify: (m: string) => void; initialMonitorId?: string; popout?: boolean }) {
  const [endedSessionId, setEndedSessionId] = useState<string | null>(null);
  const sessionEnded = endedSessionId === session.sessionId;
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState('');
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [frameDelivery, setFrameDelivery] = useState<{ bytes?: number; unchanged: boolean }>({ unchanged: false });
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([]);
  const [monitorId, setMonitorId] = useState(initialMonitorId);
  const [frameScale, setFrameScale] = useState(1);
  const [control, setControl] = useState(false);
  const [focused, setFocused] = useState(false);
  const [fit, setFit] = useState(true);
  const [ending, setEnding] = useState(false);
  const [openingScreen, setOpeningScreen] = useState(false);
  const [tool, setTool] = useState<'clipboard' | 'files' | 'power' | null>(null);
  const [clipboardText, setClipboardText] = useState('');
  const [toolError, setToolError] = useState('');
  const [toolBusy, setToolBusy] = useState(false);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filePath, setFilePath] = useState('');
  const viewer = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  const heldKeys = useRef(new Map<string, {key: string; code: string}>());
  const keyRepeatTimes = useRef(new Map<string, number>());
  const { record, reset, stats } = useFrameStats();
  useEffect(() => { reset(); }, [reset, monitorId, frameScale, session.sessionId]);
  const permissions: Permissions = { view: false, control: false, clipboard: false, files: false, power: false, ...(session.permissions || session.device.permissions) };

  useEffect(() => {
    if (sessionEnded) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        const started = performance.now();
        const next = await api.frame(session.sessionId, monitorId || undefined, frameScale);
        if (!stopped) { if (next.dataUrl) { const payload = next.dataUrl.slice(next.dataUrl.indexOf(',') + 1); const bytes = next.bytes ?? (payload.length * 3 / 4 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)); record(performance.now() - started, bytes, next.unchanged === true); setFrameDelivery({ bytes, unchanged: next.unchanged === true }); setFrame(next); setFrameError(''); setLastFrameAt(Date.now()); } }
      } catch (e) {
        if (!stopped) {
          const reason = errorMessage(e);
          setControl(false); setFrameError(reason);
          if (/ended by host|cannot safely resume|This session has ended/i.test(reason)) {
            stopped = true; setEndedSessionId(session.sessionId); setFrame(null); setLastFrameAt(null); setTool(null);
          }
        }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), 260);
    };
    void poll();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [session.sessionId, monitorId, frameScale, sessionEnded]);

  useEffect(() => { void api.monitors(session.sessionId).then(setMonitors).catch(() => undefined); }, [session.sessionId]);
  // Input stays paused while the stream is failing or ended, even if something re-enables control locally.
  const inputPaused = useRef(false);
  useEffect(() => { inputPaused.current = !!frameError || sessionEnded; if (inputPaused.current) setControl(false); }, [frameError, sessionEnded]);
  const send = useCallback((event: Record<string, unknown>) => { if (inputPaused.current) return; void api.input(session.sessionId, event, monitorId || null).catch(e => { setControl(false); setFrameError(errorMessage(e)); }); }, [session.sessionId, monitorId]);
  const releaseKeys = useCallback(() => { heldKeys.current.forEach(event => send({ type: 'key', ...event, down: false })); heldKeys.current.clear(); keyRepeatTimes.current.clear(); void invoke('session.release-inputs', { sessionId: session.sessionId }).catch(() => undefined); }, [send, session.sessionId]);
  useEffect(() => { if (!control) releaseKeys(); }, [control, releaseKeys]);
  useEffect(() => { const blur = () => { releaseKeys(); setFocused(false); }; window.addEventListener('blur', blur); return () => { window.removeEventListener('blur', blur); releaseKeys(); }; }, [releaseKeys]);
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
    if (!image.current || !frame) return null;
    const rect = image.current.getBoundingClientRect();
    const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
    const width = frame.width * scale, height = frame.height * scale;
    const x = (e.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (e.clientY - rect.top - (rect.height - height) / 2) / height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  };
  const disconnect = async () => { setEnding(true); setControl(false); releaseKeys(); try { if (popout) { await invoke('session.release-inputs', { sessionId: session.sessionId }).catch(() => undefined); await invoke('viewer.close'); } else { await api.end(session.sessionId); } } catch (e) { onError(errorMessage(e)); } finally { setEnding(false); if (!popout) onEnded(); } };
  const openScreen = async () => { setOpeningScreen(true); releaseKeys(); setControl(false); try { await invoke('viewer.open', { sessionId: session.sessionId, monitorId: monitorId || '' }); } catch (e) { onError(errorMessage(e)); } finally { setOpeningScreen(false); } };
  const listFiles = async (path = '') => { setToolBusy(true); setToolError(''); try { const value = await invoke<{ entries?: FileEntry[]; files?: FileEntry[]; path?: string } | FileEntry[]>('files.list', { sessionId: session.sessionId, path }); setFiles(Array.isArray(value) ? value : value.entries || value.files || []); setFilePath(Array.isArray(value) ? path : value.path || path); } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const openTool = (next: 'clipboard' | 'files' | 'power') => { setTool(next); setToolError(''); if (next === 'files') void listFiles(); };
  const clipboard = async (action: 'read' | 'write') => { setToolBusy(true); setToolError(''); try { const value = await invoke<{ text?: string }>(`clipboard.${action}`, { sessionId: session.sessionId, text: clipboardText }); if (action === 'read') setClipboardText(value.text || ''); else notify('Text sent to the remote clipboard.'); } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const upload = async () => { setToolBusy(true); setToolError(''); try { const result = await invoke<{ cancelled?: boolean }>('files.upload', { sessionId: session.sessionId, path: filePath }); if (!result.cancelled) { notify('File uploaded to the remote shared folder.'); await listFiles(filePath); } } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const download = async (file: FileEntry) => { setToolBusy(true); setToolError(''); try { const result = await invoke<{ savedPath?: string; cancelled?: boolean }>('files.download', { sessionId: session.sessionId, name: file.name }); if (!result.cancelled) notify(result.savedPath ? `Saved to ${result.savedPath}` : 'Download complete.'); } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };
  const power = async (action: 'lock' | 'restart') => { setToolBusy(true); setToolError(''); setControl(false); releaseKeys(); try { await invoke(`session.${action}`, { sessionId: session.sessionId }); notify(action === 'lock' ? 'Remote screen lock requested.' : 'Restart scheduled; reconnecting automatically.'); setTool(null); if (action === 'restart') { setFrame(null); setFrameError('Restart scheduled; reconnecting automatically.'); } } catch (e) { setToolError(errorMessage(e)); } finally { setToolBusy(false); } };

  return <div className="remote-session"><div className="session-heading"><div className="session-identity"><span className="session-platform"><PlatformIcon platform={session.device.platform} /></span><div><h1>{session.device.name}</h1><span><i className={`small-dot ${sessionEnded ? '' : 'green'}`} /> {sessionEnded ? 'Session ended' : frameError ? 'Reconnecting to desktop' : frame ? 'Desktop connected' : 'Opening desktop'}<span className="session-heading-sep">·</span>{platformName(session.device.platform)}</span></div></div><button className="button danger-outline small" disabled={ending} onClick={() => void disconnect()}>{ending ? <Loader2 size={15} className="spin" /> : <Unplug size={15} />} {popout ? 'Close screen' : 'Disconnect'}</button></div>
    <div className="screen-window-note"><Monitor size={12} /><span>{popout ? 'This screen shares the existing connection. Closing it keeps your other windows connected.' : 'Open existing host displays in separate windows. Creating additional virtual displays is planned.'}</span></div>
    <SessionHud title={session.device.name} link={frame?.link || session.link} ended={sessionEnded} state={sessionEnded ? 'ended' : frameError && frame ? 'reconnecting' : 'live'} stats={stats} controlling={control} viewOnly={session.viewOnly} detail={frameError || undefined} toolbar={<><div className="toolbar-group"><Monitor size={16} /><select aria-label="Remote monitor" disabled={popout || sessionEnded} value={monitorId} onChange={e => { releaseKeys(); setControl(false); setMonitorId(e.target.value); setFrame(null); }}>{monitors.length === 0 && <option value="">Primary display</option>}{monitors.length > 0 && <option value="">Primary display</option>}{monitors.map(m => <option key={m.id} value={m.id}>{m.name} · {m.width} × {m.height}</option>)}</select></div>{session.canScaleFrames && <div className="toolbar-group"><select aria-label="Screen image quality" title="Smaller screen images reduce image transfer. Pointer coordinates always use the full desktop." disabled={sessionEnded} value={frameScale} onChange={event => { releaseKeys(); setControl(false); setFrameScale(Number(event.target.value)); setFrame(null); }}><option value={1}>Full detail</option><option value={0.75}>Balanced · 75%</option><option value={0.5}>Lighter · 50%</option></select></div>}{!popout && <button className="toolbar-button screen-popout-button" aria-label="Open screen in window" title="Open an existing host display in its own window. Creating virtual displays is planned." disabled={openingScreen || ending || sessionEnded} onClick={() => void openScreen()}>{openingScreen ? <Loader2 size={15} className="spin" /> : <ExternalLink size={15} />}<span>Open screen in window</span></button>}<div className="toolbar-group"><button className={`toolbar-button ${fit ? 'selected' : ''}`} onClick={() => setFit(true)} title="Fit to window"><Maximize2 size={15} /><span>Fit</span></button><button className={`toolbar-button ${!fit ? 'selected' : ''}`} onClick={() => setFit(false)}>1:1</button></div><div className="toolbar-spacer" /><button className="toolbar-button" disabled={sessionEnded || !permissions.clipboard} title={!permissions.clipboard ? 'Clipboard permission not granted' : 'Clipboard'} onClick={() => openTool('clipboard')}><Clipboard size={16} /><span>Clipboard</span></button><button className="toolbar-button" disabled={sessionEnded || !permissions.files} title={!permissions.files ? 'File permission not granted' : 'Shared files'} onClick={() => openTool('files')}><FolderOpen size={16} /><span>Files</span></button><button className="toolbar-button" disabled={sessionEnded || !permissions.power} title={!permissions.power ? 'Power permission not granted' : 'Lock and restart'} onClick={() => openTool('power')}><Power size={16} /></button><span className="toolbar-divider" /><button className={`button small ${control ? 'primary' : 'secondary'}`} disabled={sessionEnded || session.viewOnly || !permissions.control || !frame || !!frameError} onClick={() => { setControl(c => !c); if (!control) viewer.current?.focus(); }}><MousePointer2 size={15} />{session.viewOnly ? 'View only' : control ? 'Control enabled' : 'Take control'}</button></>}>
    <div ref={viewer} tabIndex={0} aria-label="Remote desktop. Enable Take control to send keyboard and mouse input. Escape releases control." className={`remote-viewer ${fit ? 'fit' : 'actual'} ${control ? 'controlling' : ''} ${focused ? 'focused' : ''}`} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); releaseKeys(); }} onMouseLeave={() => { if (control) releaseKeys(); }} onContextMenu={e => { if (control) e.preventDefault(); }} onMouseMove={e => { if (!control || Date.now() - lastMove.current < 40) return; const p = point(e); if (p) { lastMove.current = Date.now(); send({ type: 'pointer.move', ...p }); } }} onMouseDown={e => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); e.currentTarget.focus(); send({ type: 'pointer.button', button: e.button, down: true, ...p }); } }} onMouseUp={e => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); send({ type: 'pointer.button', button: e.button, down: false, ...p }); } else { releaseKeys(); } }} onWheel={e => { if (!control) return; const p = point(e); if (p) send({ type: 'pointer.wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...p }); }} onKeyDown={e => { if (e.key === 'Escape') { setControl(false); e.preventDefault(); return; } if (!control || !focused) return; e.preventDefault(); const now = Date.now(); if (e.repeat && now - (keyRepeatTimes.current.get(e.code) || 0) < 35) return; keyRepeatTimes.current.set(e.code, now); heldKeys.current.set(e.code, { key: e.key, code: e.code }); send({ type: 'key', key: e.key, code: e.code, down: true, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }); }} onKeyUp={e => { if (!control || !focused) return; e.preventDefault(); heldKeys.current.delete(e.code); keyRepeatTimes.current.delete(e.code); send({ type: 'key', key: e.key, code: e.code, down: false, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }); }}>
      {frame ? <img ref={image} src={frame.dataUrl} alt={`Remote desktop of ${session.device.name}`} draggable={false} /> : <div className="stream-loading"><div className="stream-orbit"><BrandMark /></div><h3>{sessionEnded ? 'This session has ended.' : frameError ? 'Waiting for the remote desktop' : 'Bringing your desktop into view'}</h3><p>{frameError || 'Establishing a screen stream over your private connection…'}</p><>{sessionEnded ? <p className="session-ended-help">{popout ? 'Close this screen, then choose Connect in the main window to start a new session.' : 'Choose Disconnect, then Connect to start a new session. Orbit will not reconnect to this ended session.'}</p> : <Loader2 className="spin" size={20} />}</></div>}
    </div></SessionHud><div className="session-statusbar"><LinkStatus ended={sessionEnded} link={frame?.link || session.link} code={securityCode(session.device.fingerprint || session.device.serverFingerprint)} /><span>{frame ? `${frame.width} × ${frame.height}` : 'Waiting for display'}<span className="status-separator">·</span>{sessionEnded ? 'Explicit Connect required' : frameDelivery.unchanged ? 'Idle screen · 0 KB' : lastFrameAt ? 'Image stream' : 'Connecting'}<span className="status-separator">·</span>{control && focused ? 'Keyboard captured' : 'Local keyboard'}</span></div>
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
  const [context, setContext] = useState<ViewerContext | null>(null);
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
    {context ? <RemoteSession session={context.session} initialMonitorId={context.monitorId || ''} popout onEnded={() => undefined} onError={setError} notify={setToast} /> : <div className="standalone-loading"><BrandMark />{error ? <><h1>This screen is not connected.</h1><p>Open a screen window from an active Orbit connection.</p><button className="button secondary" onClick={() => { void invoke('viewer.close').catch(reason => setError(errorMessage(reason))); }}><X size={15} /> Close screen</button></> : <><h1>Opening your screen.</h1><p>Using your existing private connection.</p><Loader2 size={18} className="spin" /></>}</div>}
    {toast && <div className="toast" role="status"><span><Check size={16} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
  </main>;
}

function App() {
  return new URLSearchParams(window.location.search).get('viewer') === '1' ? <StandaloneViewer /> : <WorkspaceApp />;
}

export default App;
