import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Clipboard, Command, Ellipsis, Eye, FolderOpen, Laptop, Loader2, LockKeyhole, Monitor, MonitorUp, MousePointer2, Network, Plus, Power, RefreshCw, Search, ShieldCheck, Terminal, X } from 'lucide-react';
import type { Device } from '../api';
import { revokedReason } from './revoked-reason';
import './pages.css';

export type DevicesPageProps = {
  devices: Device[];
  sessions?: readonly { id?: string; deviceId?: string; direction?: 'incoming' | 'outgoing'; startedAt?: string }[];
  connecting: string | null;
  onAddDevice: () => void;
  onJoin: () => void;
  onConnect: (device: Device, viewOnly?: boolean) => void;
  onManage: (device: Device) => void;
  onAllow?: (device: Device) => void | Promise<void>;
  allowing?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** A network check that contacts the paired devices is running. */
  checking?: boolean;
  /** Reuse the real device cards beneath an existing page heading. */
  embedded?: boolean;
  /** Accessible name of the embedded card list. */
  label?: string;
};

/** A paired address without the scheme and port, e.g. "100.100.1.1"; the full address stays available as a tooltip. */
export function addressLabel(value?: string) {
  if (!value) return '';
  try { return new URL(value).hostname || value; } catch { return value; }
}

export function platformLabel(value?: string) {
  if (/darwin|mac/i.test(value || '')) return 'macOS';
  if (/win/i.test(value || '')) return 'Windows';
  if (/linux/i.test(value || '')) return 'Linux';
  return !value || value === 'unknown' ? 'Computer' : value;
}

export function DevicePlatform({ platform, size = 24 }: { platform?: string; size?: number }) {
  if (/darwin|mac/i.test(platform || '')) return <Command size={size} />;
  if (/linux/i.test(platform || '')) return <Terminal size={size} />;
  return <Monitor size={size} />;
}

function seenLabel(value?: string) {
  if (!value) return 'Availability not checked';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Last seen time unavailable';
  return `Last seen ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

export function DevicesPage({ devices, sessions = [], connecting, onAddDevice, onJoin, onConnect, onManage, onAllow, allowing = null, onRefresh, refreshing = false, checking = false, embedded = false, label = 'Available computers' }: DevicesPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'incoming'>('all');
  const online = devices.filter(device => device.online === true).length;
  const incoming = devices.filter(device => device.direction === 'incoming' && !device.blockedByOwner && !device.revoked && device.status !== 'revoked').length;
  const shown = useMemo(() => devices.filter(device =>
    (filter !== 'online' || device.online === true) &&
    (filter !== 'incoming' || device.direction === 'incoming') &&
    `${device.name} ${platformLabel(device.platform)} ${device.address || ''}`.toLowerCase().includes(query.trim().toLowerCase())), [devices, query, filter]);

  return <section className={`op-page op-devices-page ${embedded ? 'op-devices-embedded' : ''}`} aria-label={embedded ? label : undefined} aria-labelledby={embedded ? undefined : 'devices-page-title'}>
    {!embedded && <><header className="op-page-heading"><div><span className="op-eyebrow">YOUR PRIVATE NETWORK</span><h1 id="devices-page-title">Every device. One orbit.</h1><p>Familiar computers. Clear permissions. A connection on your terms.</p></div><div className="op-heading-actions"><button className="button secondary" onClick={onJoin}><ArrowDownLeft size={17} />Join with an invite</button><button className="button primary" onClick={onAddDevice}><Plus size={18} />Invite a computer</button></div></header>
    <div className="op-device-summary" aria-label="Device summary"><span><Monitor size={17} /><strong>{devices.length}</strong> paired {devices.length === 1 ? 'device' : 'devices'}</span><span><i className="op-status-dot online" /><strong>{online}</strong> confirmed online</span><span><ShieldCheck size={17} /><strong>{incoming}</strong> can see this computer</span>{onRefresh && <button className="op-text-button" onClick={onRefresh} disabled={refreshing || checking} aria-busy={checking}><RefreshCw size={15} className={refreshing || checking ? 'spin' : ''} />{checking ? 'Checking…' : 'Check availability'}</button>}</div>
    <div className="op-page-toolbar"><div className="op-segmented" role="group" aria-label="Filter devices"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All devices <span>{devices.length}</span></button><button aria-pressed={filter === 'online'} className={filter === 'online' ? 'active' : ''} onClick={() => setFilter('online')}>Online <span>{online}</span></button><button aria-pressed={filter === 'incoming'} className={filter === 'incoming' ? 'active' : ''} onClick={() => setFilter('incoming')}>Can see this computer</button></div><label className="op-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a device…" aria-label="Find a device" />{query && <button aria-label="Clear device search" onClick={() => setQuery('')}><X size={15} /></button>}</label></div></>}
    {shown.length ? <div className="op-device-grid">{shown.map(device => {
      const receivesAccess = device.direction === 'incoming';
      const revoked = device.revoked === true || device.status === 'revoked';
      const ownerBlocked = receivesAccess && device.blockedByOwner === true;
      const inSession = !ownerBlocked && sessions.some(session => session.deviceId === device.id && session.direction === (device.direction || 'outgoing'));
      const canConnect = !receivesAccess && !revoked && Boolean(device.address) && connecting === null;
      const grants = ([['view', 'View', Eye], ['control', 'Control', MousePointer2], ['clipboard', 'Clipboard', Clipboard], ['files', 'Files', FolderOpen], ['power', 'Power', Power]] as const);
      return <article className={`op-device-card ${inSession ? 'is-in-session' : ''}`} key={`${device.direction || 'outgoing'}-${device.id}`} aria-label={device.name} data-session-state={inSession ? 'active' : 'idle'} data-direction={device.direction || 'outgoing'}>
        <div className="op-device-card-head"><div className="op-platform-tile"><DevicePlatform platform={device.platform} /></div><span className={`op-device-state ${inSession || device.online === true ? 'online' : ''}`}><i />{revoked ? 'Access removed' : ownerBlocked ? 'Disconnected by you' : inSession ? 'In session' : receivesAccess ? 'Access allowed' : device.online === true ? 'Online' : device.online === false ? 'Offline' : 'Not checked'}</span><button className="op-icon-button" data-device-manage aria-label={`Manage ${device.name}`} onClick={() => onManage(device)}><Ellipsis size={21} /></button></div>
        <h2>{device.name}</h2><p className="op-device-platform">{platformLabel(device.platform)}<span>·</span>{receivesAccess ? ownerBlocked ? 'Access paused by you' : 'Can see this computer' : 'You can see it'}</p>
        <div className="op-device-route">{receivesAccess ? <ShieldCheck size={15} /> : <Network size={15} />}<span title={receivesAccess ? undefined : device.address}>{receivesAccess ? ownerBlocked ? 'Your approval is required to connect again' : 'May connect to this computer' : addressLabel(device.address) || 'Address unavailable'}</span></div>
        {ownerBlocked && !revoked && <p className="op-device-owner-blocked">Disconnected by you. Permissions are kept.</p>}
        {revoked && <p className="op-device-revoked">{revokedReason(device.statusReason)} To see it again, join a new invite from it.</p>}
        <div className="op-grants" role="group" aria-label={`Permissions for ${device.name}`}>{grants.map(([key, label, Icon]) => { const granted = device.permissions?.[key] === true; return <span key={key} className={granted ? 'is-granted' : ''} data-permission={key} data-granted={granted} aria-label={`${label}: ${granted ? 'Allowed' : 'Not allowed'}`}><Icon size={14} aria-hidden="true" /><b>{label}</b><small>{granted ? 'Allowed' : 'Not allowed'}</small></span>; })}</div>
        <footer><span className="op-device-seen">{receivesAccess ? 'You manage its access here' : seenLabel(device.lastSeen)}</span>{revoked ? <div className="op-device-actions"><button className="button secondary" onClick={() => onManage(device)}>Forget connection</button><button className="button primary" onClick={onJoin}>Pair again</button></div> : ownerBlocked && onAllow ? <button className="button secondary" disabled={allowing != null} aria-label={`Allow ${device.name} again`} aria-busy={allowing === device.id || undefined} onClick={async () => { try { await onAllow(device); } catch { /* The owner reports approval errors in the relevant surface. */ } }}>{allowing === device.id ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}{allowing === device.id ? 'Allowing...' : 'Allow again'}</button> : receivesAccess ? <button className="button secondary" onClick={() => onManage(device)}><ShieldCheck size={15} />Manage access</button> : <div className="op-device-actions"><button className="op-view-button" aria-label={`View ${device.name} only`} title="Connect without mouse or keyboard control" disabled={!canConnect} onClick={() => onConnect(device, true)}><Eye size={16} />View only</button><button className="button primary" disabled={!canConnect} onClick={() => onConnect(device, false)}>{connecting === device.id ? <Loader2 size={15} className="spin" /> : <ArrowUpRight size={16} />}Connect</button></div>}</footer>
      </article>;
    })}</div> : <div className="op-empty-card"><div className="op-empty-symbol"><MonitorUp size={36} strokeWidth={1.5} /></div><span className="op-eyebrow">{devices.length ? 'KEEP LOOKING' : 'NOTHING PAIRED YET'}</span><h2>{devices.length ? 'No matching devices' : 'Pair your first computer'}</h2><p>{devices.length ? 'Try a different name or switch back to all devices.' : 'Install Orbit on both computers. Start on the computer you want to see: it creates the invite. Then join with that invite on the other computer.'}</p>{devices.length ? <button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>Show all devices <ArrowRight size={16} /></button>
      // Nothing paired: both directions, with equal weight, as on the Overview first-run card.
      : <div className="op-empty-choice" role="group" aria-label="Which computer is this?"><button className="button primary" onClick={onAddDevice}><ArrowUpRight size={17} />Let another computer see this one</button><button className="button primary" onClick={onJoin}><ArrowDownLeft size={17} />See another computer from here</button></div>}<div className="op-empty-platforms"><Laptop size={16} />Windows<span>·</span>macOS<span>·</span>Linux</div></div>}
    {!embedded && <div className="op-trust-note"><LockKeyhole size={20} /><div><strong>Pairing is a choice. Access is a permission.</strong><p>Each direction is paired separately. Open a computer’s menu (…) to check its security code, see what it can do, or remove its access.</p></div></div>}
  </section>;
}

export default DevicesPage;
