import { useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Clipboard, Command, Ellipsis, Eye, FolderOpen, Laptop, Loader2, LockKeyhole, Monitor, MonitorUp, MousePointer2, Network, Plus, Power, RefreshCw, Search, ShieldCheck, Terminal, X } from 'lucide-react';
import type { Device } from '../api';
import './pages.css';

export type DevicesPageProps = {
  devices: Device[];
  sessions?: readonly { id?: string; deviceId?: string; direction?: 'incoming' | 'outgoing'; startedAt?: string }[];
  connecting: string | null;
  onAddDevice: () => void;
  onJoin: () => void;
  onConnect: (device: Device, viewOnly?: boolean) => void;
  onManage: (device: Device) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Reuse the real device cards beneath an existing page heading. */
  embedded?: boolean;
};

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

export function DevicesPage({ devices, sessions = [], connecting, onAddDevice, onJoin, onConnect, onManage, onRefresh, refreshing = false, embedded = false }: DevicesPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'incoming'>('all');
  const online = devices.filter(device => device.online === true).length;
  const incoming = devices.filter(device => device.direction === 'incoming').length;
  const shown = useMemo(() => devices.filter(device =>
    (filter !== 'online' || device.online === true) &&
    (filter !== 'incoming' || device.direction === 'incoming') &&
    `${device.name} ${platformLabel(device.platform)} ${device.address || ''}`.toLowerCase().includes(query.trim().toLowerCase())), [devices, query, filter]);

  return <section className={`op-page op-devices-page ${embedded ? 'op-devices-embedded' : ''}`} aria-label={embedded ? 'Available computers' : undefined} aria-labelledby={embedded ? undefined : 'devices-page-title'}>
    {!embedded && <><header className="op-page-heading"><div><span className="op-eyebrow">YOUR PRIVATE NETWORK</span><h1 id="devices-page-title">Every device. One orbit.</h1><p>Familiar computers. Clear permissions. A connection on your terms.</p></div><div className="op-heading-actions"><button className="button secondary" onClick={onJoin}><ArrowDownLeft size={17} />Join with an invite</button><button className="button primary" onClick={onAddDevice}><Plus size={18} />Add a device</button></div></header>
    <div className="op-device-summary" aria-label="Device summary"><span><Monitor size={17} /><strong>{devices.length}</strong> paired {devices.length === 1 ? 'device' : 'devices'}</span><span><i className="op-status-dot online" /><strong>{online}</strong> confirmed online</span><span><ShieldCheck size={17} /><strong>{incoming}</strong> can access this host</span>{onRefresh && <button className="op-text-button" onClick={onRefresh} disabled={refreshing}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />Check availability</button>}</div>
    <div className="op-page-toolbar"><div className="op-segmented" role="group" aria-label="Filter devices"><button aria-pressed={filter === 'all'} className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All devices <span>{devices.length}</span></button><button aria-pressed={filter === 'online'} className={filter === 'online' ? 'active' : ''} onClick={() => setFilter('online')}>Online <span>{online}</span></button><button aria-pressed={filter === 'incoming'} className={filter === 'incoming' ? 'active' : ''} onClick={() => setFilter('incoming')}>Access to this host</button></div><label className="op-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a device…" aria-label="Find a device" />{query && <button aria-label="Clear device search" onClick={() => setQuery('')}><X size={15} /></button>}</label></div></>}
    {shown.length ? <div className="op-device-grid">{shown.map(device => {
      const receivesAccess = device.direction === 'incoming';
      const revoked = device.revoked === true || device.status === 'revoked';
      const inSession = sessions.some(session => session.deviceId === device.id && session.direction === (device.direction || 'outgoing'));
      const canConnect = !receivesAccess && !revoked && Boolean(device.address) && connecting === null;
      const grants = ([['view', 'View', Eye], ['control', 'Control', MousePointer2], ['clipboard', 'Clipboard', Clipboard], ['files', 'Files', FolderOpen], ['power', 'Power', Power]] as const);
      return <article className={`op-device-card ${inSession ? 'is-in-session' : ''}`} key={`${device.direction || 'outgoing'}-${device.id}`} aria-label={device.name} data-session-state={inSession ? 'active' : 'idle'} data-direction={device.direction || 'outgoing'}>
        <div className="op-device-card-head"><div className="op-platform-tile"><DevicePlatform platform={device.platform} /></div><span className={`op-device-state ${inSession || device.online === true ? 'online' : ''}`}><i />{revoked ? 'Access revoked' : inSession ? 'In session' : receivesAccess ? 'Authorized' : device.online === true ? 'Online' : device.online === false ? 'Offline' : 'Not checked'}</span><button className="op-icon-button" aria-label={`Manage ${device.name}`} onClick={() => onManage(device)}><Ellipsis size={21} /></button></div>
        <h2>{device.name}</h2><p className="op-device-platform">{platformLabel(device.platform)}<span>·</span>{receivesAccess ? 'Incoming access' : 'Remote computer'}</p>
        <div className="op-device-route">{receivesAccess ? <ShieldCheck size={15} /> : <Network size={15} />}<span>{receivesAccess ? 'May connect to this computer' : device.address || 'Address unavailable'}</span></div>
        {revoked && <p className="op-device-revoked">{device.statusReason || 'Access revoked by the host.'} Join a new invitation to pair again.</p>}
        <div className="op-grants" role="group" aria-label={`Permissions for ${device.name}`}>{grants.map(([key, label, Icon]) => { const granted = device.permissions?.[key] === true; return <span key={key} className={granted ? 'is-granted' : ''} data-permission={key} data-granted={granted} aria-label={`${label}: ${granted ? 'Granted' : 'Not granted'}`}><Icon size={14} aria-hidden="true" /><b>{label}</b><small>{granted ? 'Granted' : 'Not granted'}</small></span>; })}</div>
        <footer><span className="op-device-seen">{receivesAccess ? 'Managed on this host' : seenLabel(device.lastSeen)}</span>{revoked ? <div className="op-device-actions"><button className="button secondary" onClick={() => onManage(device)}>Forget connection</button><button className="button primary" onClick={onJoin}>Pair again</button></div> : receivesAccess ? <button className="button secondary" onClick={() => onManage(device)}><ShieldCheck size={15} />Manage access</button> : <div className="op-device-actions"><button className="op-view-button" aria-label={`View ${device.name} only`} title="Connect without mouse or keyboard control" disabled={!canConnect} onClick={() => onConnect(device, true)}><Eye size={16} />View only</button><button className="button primary" disabled={!canConnect} onClick={() => onConnect(device, false)}>{connecting === device.id ? <Loader2 size={15} className="spin" /> : <ArrowUpRight size={16} />}Connect</button></div>}</footer>
      </article>;
    })}</div> : <div className="op-empty-card"><div className="op-empty-symbol"><MonitorUp size={36} strokeWidth={1.5} /></div><span className="op-eyebrow">{devices.length ? 'KEEP LOOKING' : 'START WITH A COMPUTER YOU TRUST'}</span><h2>{devices.length ? 'No matching devices' : 'Make your first connection'}</h2><p>{devices.length ? 'Try a different name or switch back to all devices.' : 'Install Orbit on your other computer. Create an invitation, choose its permissions, and bring it into your private network.'}</p>{devices.length ? <button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>Show all devices <ArrowRight size={16} /></button> : <button className="button primary" onClick={onAddDevice}><Plus size={17} />Pair a device</button>}<div className="op-empty-platforms"><Laptop size={16} />Windows<span>·</span>macOS<span>·</span>Linux</div></div>}
    {!embedded && <div className="op-trust-note"><LockKeyhole size={20} /><div><strong>Pairing is a choice. Access is a permission.</strong><p>Each direction is paired separately. Manage a device to compare its security code, review its grants, or revoke access to this host.</p></div></div>}
  </section>;
}

export default DevicesPage;
