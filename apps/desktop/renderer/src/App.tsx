import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, CheckCheck,
  ChevronDown, ChevronRight, CircleHelp, Clipboard, Command, Copy, Download,
  Ellipsis, ExternalLink, File, Folder, FolderOpen, Globe2, HardDrive,
  Keyboard, Laptop, LayoutDashboard, Link2, Loader2, LockKeyhole, Maximize2,
  Monitor, MonitorUp, MousePointer2, Network, Plus, Power, RefreshCw,
  Search, Settings2, Shield, ShieldCheck, SlidersHorizontal, Terminal, Palette,
  Unplug, Upload, Wifi, X, Zap,
} from 'lucide-react';
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

function timeAgo(value?: string) {
  if (!value) return 'No activity yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function niceAction(action: string) { return action.replace(/[._-]/g, ' ').replace(/^\w/, c => c.toUpperCase()); }

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
  const [pairMode, setPairMode] = useState<'invite' | 'join' | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'online'>('all');

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

  useEffect(() => { void refresh(); const timer = window.setInterval(() => void refresh(true), 15000); return () => window.clearInterval(timer); }, [refresh]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer); }, [toast]);

  const notify = (message: string) => setToast(message);
  const checkNetwork = async () => {
    setRefreshing(true);
    try {
      const value = await invoke<Device[] | { devices: Device[] }>('network.refresh');
      setDevices(Array.isArray(value) ? value : value.devices || []);
    } catch (e) { setError(errorMessage(e)); }
    await refresh();
  };
  const connect = async (device: Device, viewOnly = false) => {
    if (activeSession?.device.id === device.id && activeSession.viewOnly === viewOnly) { setPage('connections'); return; }
    setConnecting(device.id); setError('');
    try {
      if (activeSession) { await api.end(activeSession.sessionId).catch(() => undefined); setActiveSession(null); }
      const session = await api.start(device.id, viewOnly);
      setActiveSession({ ...session, device, viewOnly }); setPage('connections');
      void refresh(true);
    } catch (e) { setError(errorMessage(e)); }
    finally { setConnecting(null); }
  };
  const connected = status?.host?.tailscale?.connected === true;
  const knownOnline = devices.filter(d => d.online === true).length;
  const localName = status?.host?.name || 'This computer';
  const sessionsCount = status?.sessions?.length ?? (activeSession ? 1 : 0);
  const filtered = devices.filter(d => (filter === 'all' || d.online === true) && `${d.name} ${d.platform} ${d.address || ''}`.toLowerCase().includes(search.toLowerCase()));

  const deviceCards = (list: Device[]) => <div className="device-grid">{list.map(d => <article className="device-card" key={d.id}>
    <div className="device-card-top"><div className="device-platform"><PlatformIcon platform={d.platform} size={25} /></div><button className="icon-button" aria-label={`Manage ${d.name}`} onClick={() => setSelectedDevice(d)}><Ellipsis size={22} /></button></div>
    <h3>{d.name}</h3><div className="device-subtitle">{platformName(d.platform)}<span>·</span><span className={`device-online ${d.online === true ? 'yes' : ''}`}><i />{d.online === true ? 'Online' : d.online === false ? 'Offline' : 'Not checked'}</span></div>
    <div className="device-address"><Network size={13} /><span>{d.address || 'Paired computer'}</span><LockKeyhole size={12} /></div>
    <div className="device-card-bottom"><span>{d.direction === 'incoming' ? 'Can access this host' : d.lastSeen ? `Seen ${timeAgo(d.lastSeen).toLowerCase()}` : 'Trusted device'}</span><button className="button small primary" disabled={connecting !== null || d.direction === 'incoming' || !d.address} title={d.direction === 'incoming' ? 'This pairing authorizes access to your host. Create a reverse invitation to access that computer.' : undefined} onClick={() => void connect(d)}>{connecting === d.id ? <Loader2 size={14} className="spin" /> : <ArrowUpRight size={15} />} Connect</button></div>
  </article>)}</div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setPage('overview')} aria-label="Orbit home"><BrandMark /><span>orbit<span className="brand-dot">.</span></span></button>
      <div className="workspace"><span className="workspace-avatar">P</span><div><strong>Personal workspace</strong><span>Your private network</span></div><ChevronDown size={15} /></div>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="Main navigation">{NAV.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => { setPage(id); setSearch(''); }}><Icon size={19} strokeWidth={1.7} /><span>{label}</span>{id === 'devices' && devices.length > 0 && <b>{devices.length}</b>}{id === 'connections' && activeSession && <i className="nav-live" />}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="private-card"><div className="private-icon"><ShieldCheck size={18} /></div><strong>Private. By design.</strong><p>Your computers, connected<br />through your Tailscale network.</p><span>Built for your own orbit <ArrowUpRight size={12} /></span></div>
        <div className="local-user"><div className={`local-avatar ${connected ? 'connected' : ''}`}><Laptop size={18} /></div><div><strong>{localName}</strong><span>{status ? platformName(status.host.platform) : 'Connecting to service'}</span></div><span className="version">v{status?.host.version || '0.1'}</span></div>
      </div>
    </aside>

    <main className={`main ${activeSession && page === 'connections' ? 'session-page' : ''}`}>
      <header className="topbar"><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{NAV.find(n => n.id === page)?.label}</strong></div><div className="topbar-right"><span className={`network-pill ${connected ? 'connected' : ''}`}><i />{status?.host.testMode ? 'Local test mode' : connected ? 'Tailscale connected' : loading ? 'Checking network' : 'Tailscale disconnected'}</span><button className={`icon-button ${refreshing ? 'spin' : ''}`} title="Refresh host and check device availability" aria-label="Refresh host and check device availability" disabled={refreshing} onClick={() => void checkNetwork()}><RefreshCw size={16} /></button><div className="topbar-divider" /><span className="personal-avatar">P</span></div></header>
      <div className="main-content">
        {error && <div className="error-banner" role="alert"><Shield size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}

        {page === 'overview' && <>
          <section className="hero"><div className="hero-copy"><span className="eyebrow"><span /> YOUR PRIVATE COMMAND CENTER</span><h1>Your world.<br /><span>Within reach.</span></h1><p>A familiar desktop, wherever you are.<br />Bring your computers into one secure orbit.</p><div className="hero-actions"><button className="button primary" onClick={() => setPairMode('invite')}><Plus size={17} /> Add a device</button><button className="button text" onClick={() => setPairMode('join')}>Join with an invite <ArrowRight size={16} /></button></div></div><div className="orbit-illustration" aria-hidden="true"><div className="orbit-ring ring-one" /><div className="orbit-ring ring-two" /><div className="orbit-ring ring-three" /><div className="orbit-cross cross-one" /><div className="orbit-cross cross-two" /><div className="orbit-center"><BrandMark /><span>YOUR ORBIT</span></div><div className="orbit-satellite satellite-one"><Monitor size={23} /></div><div className="orbit-satellite satellite-two"><Laptop size={22} /></div><div className="orbit-satellite satellite-three"><Command size={21} /></div><div className="orbit-small-dot" /><div className="orbit-caption"><LockKeyhole size={11} /> A PRIVATE CONNECTION, EVERY TIME</div></div></section>

          <div className="stats-grid"><div className="stat"><div><span>Paired devices</span><Monitor size={17} /></div><strong>{devices.length.toString().padStart(2, '0')}</strong><p>{knownOnline > 0 ? `${knownOnline} confirmed online` : 'Ready when you are'}<span className="stat-dots">···</span></p></div><div className="stat"><div><span>Active connections</span><Link2 size={17} /></div><strong>{sessionsCount.toString().padStart(2, '0')}</strong><p>{sessionsCount ? 'A desktop is within reach' : 'Your space is all yours'}<span className="stat-dots">···</span></p></div><div className={`stat network-stat ${connected ? 'is-connected' : ''}`}><div><span>Private network</span><ShieldCheck size={18} /></div><strong><span className="status-dot" />{status?.host.testMode ? 'Local test' : connected ? 'Connected' : loading ? 'Checking' : 'Not connected'}</strong><p>{status?.host.testMode ? 'Loopback integration environment' : connected ? 'Tailscale encrypted transport' : 'Connect Tailscale to get started'}<ArrowUpRight size={14} /></p></div></div>

          <div className="section-heading"><div><h2>Your devices <span>{devices.length}</span></h2><p>A little closer, no matter the distance.</p></div><button className="button text subtle" onClick={() => setPage('devices')}>View all devices <ArrowRight size={15} /></button></div>
          {devices.length ? deviceCards(devices.slice(0, 3)) : <div className="first-device-card"><div className="first-device-art"><div className="mini-monitor"><Monitor size={38} strokeWidth={1.2} /><span /></div><span className="tiny-orbit">+</span><Laptop size={30} strokeWidth={1.2} /></div><div><span className="eyebrow">EVERY ORBIT STARTS WITH A CONNECTION</span><h3>Meet your other computer.</h3><p>Create an invite here, then paste it into Orbit on your other device.<br />You decide exactly what it can access.</p></div><button className="button secondary" onClick={() => setPairMode('invite')}>Pair your first device <ArrowUpRight size={16} /></button></div>}

          <div className="overview-bottom"><section className="panel local-host-panel"><div className="panel-heading"><h2>This computer</h2><span className="label">LOCAL HOST</span></div><div className="local-host-identity"><div className="host-device-icon"><PlatformIcon platform={status?.host.platform} size={28} /></div><div><h3>{localName}</h3><p>{status ? platformName(status.host.platform) : 'Waiting for desktop service'}<span>·</span>{connected ? 'Network ready' : 'Network setup needed'}</p></div><span className={`small-dot ${connected ? 'green' : ''}`} /></div><div className="host-details"><span>Tailscale address</span><button className="copy-inline" disabled={!status?.host.tailscale.ip} onClick={() => { void copyText(status?.host.tailscale.ip || '').then(() => notify('Tailscale address copied.')).catch(e => setError(errorMessage(e))); }}>{status?.host.tailscale.ip || 'Not available'}<Copy size={12} /></button></div><div className="host-details"><span>Security code</span><span className="security-code" title="Your other computers show this code for this computer. If the codes match, nobody is intercepting the connection.">{securityCode(status?.host.fingerprint) || '—'}</span></div><div className="host-details"><span>Access policy</span><span className="mint-text"><ShieldCheck size={13} /> Paired devices only</span></div><button className="local-settings-link" onClick={() => setPage('settings')}>Manage host settings <ArrowRight size={14} /></button></section>
            <section className="panel recent-panel"><div className="panel-heading"><h2>Recent activity</h2><button className="icon-button" aria-label="View all activity" onClick={() => setPage('activity')}><ArrowUpRight size={17} /></button></div>{audits.length ? <div className="recent-list">{audits.slice(0, 3).map((entry, index) => <div className="recent-entry" key={entry.id || index}><span className="activity-icon"><Activity size={15} /></span><div><strong>{niceAction(entry.action)}</strong><span>{entry.deviceName || entry.detail || 'This computer'}</span></div><time>{timeAgo(entry.timestamp)}</time></div>)}</div> : <div className="recent-empty"><div><Activity size={22} strokeWidth={1.4} /></div><p>A quiet orbit is a good orbit.</p><span>Connection and access events will appear here.</span></div>}</section></div>
          <footer className="page-footer"><span><LockKeyhole size={12} /> Designed around explicit trust</span><span>Windows · macOS · Linux</span></footer>
        </>}

        {page === 'devices' && <>
          <PageHeading eyebrow="YOUR PRIVATE NETWORK" title="Every device. One orbit." description="Connect to the computers you trust, with the access you choose." action={<div className="heading-actions"><button className="button secondary" onClick={() => setPairMode('join')}><ArrowDownLeft size={16} /> Join with invite</button><button className="button primary" onClick={() => setPairMode('invite')}><Plus size={17} /> Add a device</button></div>} />
          <div className="device-toolbar"><div className="tab-group"><button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>All devices <span>{devices.length}</span></button><button className={filter === 'online' ? 'selected' : ''} onClick={() => setFilter('online')}>Online <span>{knownOnline}</span></button></div><label className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a device…" aria-label="Find a device" /><span>⌕</span></label></div>
          {filtered.length ? deviceCards(filtered) : <div className="panel"><EmptyState title={devices.length ? 'No matching devices' : 'Make your first connection'} description={devices.length ? 'Try another device name or show all devices.' : 'Install Orbit on another computer, then exchange a pairing invite. Each connection is yours to approve.'} action={!devices.length && <button className="button primary" onClick={() => setPairMode('invite')}><Plus size={16} /> Pair a device</button>} /></div>}
          <div className="security-note"><ShieldCheck size={20} /><div><strong>Trust is explicit.</strong><p>Pairing grants only the permissions you select. Revoke a device at any time from its device menu.</p></div></div>
        </>}

        {page === 'connections' && (activeSession ? <RemoteSession session={activeSession} onEnded={() => { setActiveSession(null); void refresh(true); }} onError={setError} notify={notify} /> : <>
          <PageHeading eyebrow="A DESKTOP, WITHOUT THE DISTANCE" title="Make yourself at home." description="Open a private session to one of your paired computers." />
          <div className="panel"><EmptyState icon={Link2} title="No active connection" description={devices.length ? 'Choose a computer below to open its desktop. View-only access is available from the device menu.' : 'Your remote desktop will appear here. Pair a computer to start your first session.'} action={!devices.length && <button className="button primary" onClick={() => setPairMode('invite')}><Plus size={16} /> Add a device</button>} /></div>
          {devices.length > 0 && <><div className="section-heading"><div><h2>Choose a computer</h2></div></div>{deviceCards(devices)}</>}
        </>)}

        {page === 'activity' && <>
          <PageHeading eyebrow="A CLEAR VIEW OF YOUR NETWORK" title="Nothing behind the scenes." description="Review pairing, connection, and access events recorded by this host." action={<button className="button secondary" onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : ''} /> Refresh activity</button>} />
          <div className="panel audit-panel"><div className="panel-heading"><h2>Host activity</h2><span className="label">{audits.length} EVENTS</span></div>{audits.length ? <div className="table-scroll"><table className="audit-table"><thead><tr><th>EVENT</th><th>DEVICE / DETAILS</th><th>RESULT</th><th>TIME</th></tr></thead><tbody>{audits.map((entry, index) => <tr key={entry.id || index}><td><span className="table-event-icon"><Activity size={14} /></span>{niceAction(entry.action)}</td><td><strong>{entry.deviceName || entry.deviceId?.slice(0, 12) || 'Local host'}</strong><span>{entry.detail || '—'}</span></td><td><span className={`result-pill ${/denied|fail|error/i.test(entry.outcome || '') ? 'failed' : ''}`}>{entry.outcome || 'Recorded'}</span></td><td><time title={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time></td></tr>)}</tbody></table></div> : <EmptyState compact icon={Activity} title="Your activity starts here" description="Events are recorded on this computer as you pair devices and open remote sessions." />}</div>
        </>}

        {page === 'settings' && <SettingsPage status={status} theme={theme} onThemeChange={setTheme} onSaved={() => { void refresh(); notify('Host settings saved.'); }} onError={setError} />}
      </div>
    </main>
    {toast && <div className="toast" role="status"><span><Check size={16} /></span>{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={14} /></button></div>}
    {pairMode && <PairModal mode={pairMode} connected={connected} onClose={() => setPairMode(null)} onPaired={() => { setPairMode(null); setPage('devices'); void refresh(); notify('Device paired. Your orbit just got a little bigger.'); }} onError={setError} notify={notify} />}
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
    {device.direction === 'incoming' ? <div className="inline-notice subtle-notice"><ShieldCheck size={17} /><span>This computer has permission to access your host. To connect in the other direction, create an invite on that computer and join it here.</span></div> : <div className="device-modal-actions"><button className="button primary" disabled={!device.address} onClick={() => onConnect(false)}><MousePointer2 size={16} /> Connect</button><button className="button secondary" disabled={!device.address} onClick={() => onConnect(true)}><Monitor size={16} /> View only</button></div>}
    {code && <div className="security-code-card"><div className="subsection-label">SECURITY CODE</div><code>{code}</code><p>On {device.name}, open Overview → This computer. Its security code must match this one exactly. {incoming ? 'If it differs, revoke this device: it is not the computer you meant to pair.' : 'If it differs, don’t connect: forget this device and pair again.'}</p></div>}
    <div className="subsection-label">GRANTED PERMISSIONS</div><PermissionRows permissions={permissions} onChange={setPermissions} disabled />
    <p className="form-footnote">{incoming ? 'Permissions belong to this pairing. To change access, revoke it and create a new invitation with the permissions you want.' : 'These permissions were granted by the remote host. Its owner manages access to that computer.'}</p>
    <div className="danger-zone">{revokeConfirm ? <><div><strong>{incoming ? 'Revoke' : 'Forget'} {device.name}?</strong><p>{incoming ? 'This removes access to this host. Pair again to restore it.' : 'This removes the saved connection here. It does not revoke any access you granted on another host.'}</p></div><div className="heading-actions"><button className="button secondary small" onClick={() => setRevokeConfirm(false)}>Cancel</button><button className="button danger small" disabled={busy} onClick={() => void revoke()}>{busy ? <Loader2 size={14} className="spin" /> : <Unplug size={14} />} {incoming ? 'Revoke device' : 'Forget connection'}</button></div></> : <><div><strong>Remove this connection</strong><p>{incoming ? 'Revoke this device’s access immediately.' : 'Remove this saved connection from this computer.'}</p></div><button className="button danger-text small" onClick={() => setRevokeConfirm(true)}><Unplug size={14} /> {incoming ? 'Revoke' : 'Forget'}</button></>}</div>
  </Modal>;
}

function SettingsPage({ status, theme, onThemeChange, onSaved, onError }: { status: HostStatus | null; theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void; onSaved: () => void; onError: (e: string) => void }) {
  const [settings, setSettings] = useState<HostSettings>({ hostName: '', allowControl: false, allowClipboard: false, allowFiles: false, allowPower: false, startAtLogin: false });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (status?.settings) setSettings(status.settings); }, [status?.host.id]);
  const save = async () => { setBusy(true); try { const { startAtLogin, ...policy } = settings; await api.updateSettings(status?.settings.startAtLoginSupported ? settings : policy); onSaved(); } catch (e) { onError(errorMessage(e)); } finally { setBusy(false); } };
  const capabilities = [
    { key: 'allowControl' as const, capability: 'input', icon: MousePointer2, title: 'Remote mouse & keyboard', detail: 'Choose mouse and keyboard access when you create a pairing invitation.' },
    { key: 'allowClipboard' as const, capability: 'clipboard', icon: Clipboard, title: 'Clipboard sharing', detail: 'Clipboard access is off by default. Enable it only for pairings you trust.' },
    { key: 'allowFiles' as const, capability: 'files', icon: FolderOpen, title: 'File transfer', detail: 'Allow transfers within Orbit’s designated shared folder.' },
    { key: 'allowPower' as const, capability: 'power', icon: Power, title: 'Lock & restart', detail: 'Allow paired devices with power permission to request host power actions.' },
  ];
  return <><PageHeading eyebrow="MAKE ORBIT YOUR OWN" title="Your computer. Your rules." description="Control how this host appears and what remote devices can do." action={<button className="button primary" disabled={busy || !status || !settings.hostName.trim()} onClick={() => void save()}>{busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />} Save changes</button>} />
    <div className="settings-layout"><div className="settings-main"><AppearanceSettings theme={theme} onChange={onThemeChange} /><section className="panel settings-panel"><div className="settings-section-title"><Laptop size={20} /><div><h2>This host</h2><p>The identity of this computer in your private network.</p></div></div><label className="field-label" htmlFor="host-name">COMPUTER NAME</label><input className="text-input" id="host-name" value={settings.hostName} maxLength={80} disabled={!status} placeholder="Name your computer" onChange={e => setSettings(s => ({ ...s, hostName: e.target.value }))} /><div className="settings-detail"><span>Operating system</span><strong>{platformName(status?.host.platform)}</strong></div><div className="settings-detail"><span>Host identity</span><code title={status?.host.id}>{status?.host.id?.slice(0, 20) || 'Waiting for service'}{status?.host.id && status.host.id.length > 20 ? '…' : ''}</code></div><div className="settings-detail"><span>Service version</span><strong>{status?.host.version || '—'}</strong></div></section>
    <section className="panel settings-panel"><div className="settings-section-title"><SlidersHorizontal size={20} /><div><h2>Remote access</h2><p>Host policy applies in addition to each pairing’s permissions.</p></div></div>{capabilities.map(({ key, capability, icon: Icon, title, detail }) => <div className="settings-capability" key={key}><span className="setting-icon"><Icon size={18} /></span><div><strong>{title}</strong><p>{detail}</p>{status && !status.capabilities?.[capability] && <span className="capability-unavailable">Unavailable on this host</span>}</div>{key === 'allowControl' || key === 'allowClipboard' ? <span className="label">PER PAIRING</span> : <Toggle label={title} checked={Boolean(settings[key])} disabled={!status || !status.capabilities?.[capability]} onChange={value => setSettings(s => ({ ...s, [key]: value }))} />}</div>)}</section>
    <section className="panel settings-panel"><div className="settings-section-title"><Zap size={20} /><div><h2>Stay within reach</h2><p>Startup and availability.</p></div></div><div className="settings-capability"><span className="setting-icon"><Power size={18} /></span><div><strong>Start Orbit at sign-in</strong><p>Launch Orbit automatically when you sign in to this computer.</p><span className="capability-unavailable">Available in the packaged desktop app. Pre-login access requires a separate system service installation.</span></div><Toggle label="Start Orbit at sign-in" checked={Boolean(settings.startAtLogin)} disabled={!status?.settings.startAtLoginSupported} onChange={value => setSettings(s => ({ ...s, startAtLogin: value }))} /></div></section><AboutOrbit status={status} onError={onError} /></div>
    <aside className="settings-aside"><div className="panel network-diagnostics"><div className="settings-section-title"><Network size={20} /><div><h2>Network health</h2><p>Live host diagnostics</p></div></div><div className={`network-state ${status?.host.tailscale.connected ? 'ready' : ''}`}><span /><strong>{status?.host.testMode ? 'Local test mode' : status?.host.tailscale.connected ? 'Tailscale connected' : 'Connection needed'}</strong></div><dl><div><dt>Tailscale installed</dt><dd>{status ? status.host.tailscale.available ? 'Detected' : 'Not detected' : 'Checking'}</dd></div><div><dt>Private IP</dt><dd>{status?.host.tailscale.ip || '—'}</dd></div><div><dt>DNS name</dt><dd>{status?.host.tailscale.dnsName || '—'}</dd></div><div><dt>Host port</dt><dd>{settings.listenPort || '—'}</dd></div></dl>{status?.host.tailscale.error && <div className="inline-error">{status.host.tailscale.error}</div>}</div><UnattendedAvailability status={status} /><div className="settings-help"><ShieldCheck size={24} /><h3>Two layers of trust.</h3><p>Tailscale provides your private network. Orbit pairing decides who can connect and what they can do.</p><p>Keep your tailnet access policy limited to the people and devices you trust.</p></div></aside></div></>;
}

function AppearanceSettings({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const themes = [
    { id: 'orbit' as const, name: 'Orbit', description: 'Earthy, calm, familiar' },
    { id: 'midnight' as const, name: 'Midnight', description: 'A little after hours' },
    { id: 'paper' as const, name: 'Paper', description: 'Room to breathe' },
  ];
  return <section className="panel settings-panel appearance-panel"><div className="settings-section-title"><Palette size={20} /><div><h2>Make yourself comfortable</h2><p>A different atmosphere. The same private orbit.</p></div><span className="appearance-saved"><Check size={11} /> Saved here</span></div><div className="theme-choices" role="group" aria-label="Appearance theme">{themes.map(option => <button key={option.id} className={`theme-choice ${theme === option.id ? 'selected' : ''}`} aria-label={`Use ${option.name} theme`} aria-pressed={theme === option.id} onClick={() => onChange(option.id)}><div className={`theme-preview preview-${option.id}`} aria-hidden="true"><div className="preview-sidebar"><i /><span /><span /><span /></div><div className="preview-main"><i /><strong /><span /><div><b /><b /><b /></div><em /></div><span className="preview-check"><Check size={12} /></span></div><div className="theme-choice-label"><strong>{option.name}</strong><span className="theme-radio"><i /></span></div><p>{option.description}</p></button>)}</div><div className="system-theme-row"><Monitor size={16} /><div><strong>Follow your system</strong><span>Paper by day. Midnight when your system goes dark.</span></div><Toggle label="Follow system appearance" checked={theme === 'system'} onChange={enabled => onChange(enabled ? 'system' : 'orbit')} /></div><p className="appearance-local-note">Appearance changes instantly and stays on this computer.</p></section>;
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

function UnattendedAvailability({ status }: { status: HostStatus | null }) {
  const notes = (status?.limitations || []).flatMap(note => {
    if (/locked screens|lock screens|logged-in interactive/i.test(note)) return /remote locking/i.test(note) ? ['Remote screen locking is not available on this computer.'] : [];
    if (/integrity isolation/i.test(note)) return ['Some administrator apps cannot be controlled from this desktop. Protected permission prompts are unavailable.'];
    if (/PNG snapshot/i.test(note)) return ['Screen sharing uses still-image updates. Audio and smooth video streaming are not available yet.'];
    if (/Screen Recording permission/i.test(note)) return ['On this Mac, allow Screen Recording to share the screen and Accessibility to use the mouse and keyboard.'];
    if (/macOS backend.*validation/i.test(note)) return ['macOS support still needs testing on a physical Mac.'];
    if (/Only local X11/i.test(note)) return ['Linux access requires an unlocked X11 desktop. Wayland desktops are not supported yet.'];
    if (/Linux backend.*validation/i.test(note)) return ['Linux support still needs testing on a physical desktop with screen-capture support installed.'];
    if (/Capture requires ffmpeg/i.test(note)) return ['Install ffmpeg on this computer to enable screen sharing.'];
    if (/control require xdotool/i.test(note)) return ['Install xdotool on this computer to enable mouse and keyboard control.'];
    if (/enumeration requires xrandr/i.test(note)) return ['Install xrandr on this computer to detect its displays.'];
    if (/Clipboard requires xclip/i.test(note)) return ['Install xclip on this computer to enable clipboard sharing.'];
    return [note.replace(/backend/gi, 'support')];
  });
  const state = status?.sessionState;
  const stateText = state === 'interactive' ? 'Desktop is signed in and unlocked' : state && /locked|secure/.test(state) ? 'Desktop is locked or protected' : state ? 'An unlocked desktop is not available' : 'Desktop availability is not confirmed';
  return <section className="panel unattended-notice"><div className="settings-section-title"><LockKeyhole size={20} /><div><h2>Unattended availability</h2><p>Know when this host is within reach.</p></div></div><div className="availability-state"><span className={`small-dot ${state === 'interactive' ? 'green' : ''}`} />{stateText}</div><p>{status ? 'This build needs an unlocked, signed-in desktop. Access while locked and recovery before sign-in are not available yet.' : 'Connect to the host service to check desktop availability.'}</p>{notes.length > 0 && <ul>{[...new Set(notes)].map(note => <li key={note}>{note}</li>)}</ul>}</section>;
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
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([]);
  const [monitorId, setMonitorId] = useState(initialMonitorId);
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
  const permissions: Permissions = { view: false, control: false, clipboard: false, files: false, power: false, ...(session.permissions || session.device.permissions) };

  useEffect(() => {
    if (sessionEnded) return;
    let stopped = false;
    let timer: number;
    const poll = async () => {
      try {
        const next = await api.frame(session.sessionId, monitorId || undefined);
        if (!stopped) { if (next.dataUrl) { setFrame(next); setFrameError(''); setLastFrameAt(Date.now()); } }
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
  }, [session.sessionId, monitorId, sessionEnded]);

  useEffect(() => { void api.monitors(session.sessionId).then(setMonitors).catch(() => undefined); }, [session.sessionId]);
  const send = useCallback((event: Record<string, unknown>) => { void api.input(session.sessionId, event, monitorId || null).catch(e => { setControl(false); setFrameError(errorMessage(e)); }); }, [session.sessionId, monitorId]);
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
    <div className="session-toolbar"><div className="toolbar-group"><Monitor size={16} /><select aria-label="Remote monitor" disabled={popout || sessionEnded} value={monitorId} onChange={e => { releaseKeys(); setControl(false); setMonitorId(e.target.value); setFrame(null); }}>{monitors.length === 0 && <option value="">Primary display</option>}{monitors.length > 0 && <option value="">Primary display</option>}{monitors.map(m => <option key={m.id} value={m.id}>{m.name} · {m.width} × {m.height}</option>)}</select></div>{!popout && <button className="toolbar-button screen-popout-button" aria-label="Open screen in window" title="Open an existing host display in its own window. Creating virtual displays is planned." disabled={openingScreen || ending || sessionEnded} onClick={() => void openScreen()}>{openingScreen ? <Loader2 size={15} className="spin" /> : <ExternalLink size={15} />}<span>Open screen in window</span></button>}<div className="toolbar-group"><button className={`toolbar-button ${fit ? 'selected' : ''}`} onClick={() => setFit(true)} title="Fit to window"><Maximize2 size={15} /><span>Fit</span></button><button className={`toolbar-button ${!fit ? 'selected' : ''}`} onClick={() => setFit(false)}>1:1</button></div><div className="toolbar-spacer" /><button className="toolbar-button" disabled={sessionEnded || !permissions.clipboard} title={!permissions.clipboard ? 'Clipboard permission not granted' : 'Clipboard'} onClick={() => openTool('clipboard')}><Clipboard size={16} /><span>Clipboard</span></button><button className="toolbar-button" disabled={sessionEnded || !permissions.files} title={!permissions.files ? 'File permission not granted' : 'Shared files'} onClick={() => openTool('files')}><FolderOpen size={16} /><span>Files</span></button><button className="toolbar-button" disabled={sessionEnded || !permissions.power} title={!permissions.power ? 'Power permission not granted' : 'Lock and restart'} onClick={() => openTool('power')}><Power size={16} /></button><span className="toolbar-divider" /><button className={`button small ${control ? 'primary' : 'secondary'}`} disabled={sessionEnded || session.viewOnly || !permissions.control || !frame} onClick={() => { setControl(c => !c); if (!control) viewer.current?.focus(); }}><MousePointer2 size={15} />{session.viewOnly ? 'View only' : control ? 'Control enabled' : 'Take control'}</button></div>
    <div className="screen-window-note"><Monitor size={12} /><span>{popout ? 'This screen shares the existing connection. Closing it keeps your other windows connected.' : 'Open existing host displays in separate windows. Creating additional virtual displays is planned.'}</span></div>
    <div ref={viewer} tabIndex={0} aria-label="Remote desktop. Enable Take control to send keyboard and mouse input. Escape releases control." className={`remote-viewer ${fit ? 'fit' : 'actual'} ${control ? 'controlling' : ''} ${focused ? 'focused' : ''}`} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); releaseKeys(); }} onMouseLeave={() => { if (control) releaseKeys(); }} onContextMenu={e => { if (control) e.preventDefault(); }} onMouseMove={e => { if (!control || Date.now() - lastMove.current < 40) return; const p = point(e); if (p) { lastMove.current = Date.now(); send({ type: 'pointer.move', ...p }); } }} onMouseDown={e => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); e.currentTarget.focus(); send({ type: 'pointer.button', button: e.button, down: true, ...p }); } }} onMouseUp={e => { if (!control) return; const p = point(e); if (p) { e.preventDefault(); send({ type: 'pointer.button', button: e.button, down: false, ...p }); } else { releaseKeys(); } }} onWheel={e => { if (!control) return; const p = point(e); if (p) send({ type: 'pointer.wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...p }); }} onKeyDown={e => { if (e.key === 'Escape') { setControl(false); e.preventDefault(); return; } if (!control || !focused) return; e.preventDefault(); const now = Date.now(); if (e.repeat && now - (keyRepeatTimes.current.get(e.code) || 0) < 35) return; keyRepeatTimes.current.set(e.code, now); heldKeys.current.set(e.code, { key: e.key, code: e.code }); send({ type: 'key', key: e.key, code: e.code, down: true, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }); }} onKeyUp={e => { if (!control || !focused) return; e.preventDefault(); heldKeys.current.delete(e.code); keyRepeatTimes.current.delete(e.code); send({ type: 'key', key: e.key, code: e.code, down: false, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey }); }}>
      {frame ? <img ref={image} src={frame.dataUrl} alt={`Remote desktop of ${session.device.name}`} draggable={false} /> : <div className="stream-loading"><div className="stream-orbit"><BrandMark /></div><h3>{sessionEnded ? 'This session has ended.' : frameError ? 'Waiting for the remote desktop' : 'Bringing your desktop into view'}</h3><p>{frameError || 'Establishing a screen stream over your private connection…'}</p><>{sessionEnded ? <p className="session-ended-help">{popout ? 'Close this screen, then choose Connect in the main window to start a new session.' : 'Choose Disconnect, then Connect to start a new session. Orbit will not reconnect to this ended session.'}</p> : <Loader2 className="spin" size={20} />}</></div>}
      {frame && frameError && <div className="stream-error"><RefreshCw size={15} className="spin" /><span>{frameError}</span></div>}
      {control && <div className="control-hint"><MousePointer2 size={12} />{focused ? 'You’re controlling this computer' : 'Click the desktop to focus'}<kbd>esc</kbd> to release</div>}
    </div><div className="session-statusbar"><LinkStatus ended={sessionEnded} link={frame?.link || session.link} code={securityCode(session.device.fingerprint || session.device.serverFingerprint)} /><span>{frame ? `${frame.width} × ${frame.height}` : 'Waiting for display'}<span className="status-separator">·</span>{sessionEnded ? 'Explicit Connect required' : lastFrameAt ? 'Image stream' : 'Connecting'}<span className="status-separator">·</span>{control && focused ? 'Keyboard captured' : 'Local keyboard'}</span></div>
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
