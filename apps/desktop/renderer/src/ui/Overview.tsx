import type { CSSProperties, ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Command, Copy, Ellipsis, Eye,
  FileDown, FileUp, Fingerprint, FlaskConical, Globe2, Link2, Loader2, LockKeyhole,
  Monitor, MonitorUp, Plus, Power, Settings2, ShieldAlert, ShieldCheck, Terminal, Unplug,
} from 'lucide-react';
import { securityCode, type AuditEntry, type Device, type HostStatus, type Permissions } from '../api';
import './overview.css';

export type OverviewPage = 'devices' | 'connections' | 'activity' | 'settings';

export type OverviewProps = {
  status: HostStatus | null;
  devices: Device[];
  activity: AuditEntry[];
  sessionsCount: number;
  connecting: string | null;
  loading?: boolean;
  onAddDevice(): void;
  onJoin(): void;
  onConnect(device: Device, viewOnly: boolean): void;
  onManage(device: Device): void;
  onNavigate(page: OverviewPage): void;
  onCopyAddress?(): void;
};

type Tone = 'ok' | 'warn' | 'info' | 'off';
type SessionEntry = NonNullable<HostStatus['sessions']>[number] & { direction?: 'incoming' | 'outgoing' };

const MAX_CARDS = 5;
const PERMISSION_LABELS: [keyof Permissions, string][] = [['view', 'View'], ['control', 'Control'], ['clipboard', 'Clipboard'], ['files', 'Files'], ['power', 'Power']];

function platformName(value?: string) {
  if (/darwin|mac/i.test(value || '')) return 'macOS';
  if (/win/i.test(value || '')) return 'Windows';
  if (/linux/i.test(value || '')) return 'Linux';
  return value || 'Computer';
}

function PlatformIcon({ platform, size = 22 }: { platform?: string; size?: number }) {
  if (/darwin|mac/i.test(platform || '')) return <Command size={size} strokeWidth={1.7} />;
  if (/linux/i.test(platform || '')) return <Terminal size={size} strokeWidth={1.7} />;
  return <Monitor size={size} strokeWidth={1.7} />;
}

function timeAgo(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 172800) return 'yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function shortDate(value?: string) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

function plural(count: number, word: string) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

function permissionSummary(permissions?: Partial<Permissions>) {
  const granted = PERMISSION_LABELS.filter(([key]) => permissions?.[key]).map(([, label]) => label);
  if (!granted.length) return '';
  return granted.length === 1 && granted[0] === 'View' ? 'View only' : granted.join(' · ');
}

// Friendly wording for the host's audit actions (see HostState.AddAudit). Unknown actions fall back to a readable form.
function describeEntry(entry: AuditEntry, devices: Device[]) {
  const who = entry.deviceName || devices.find(d => d.id === entry.deviceId)?.name;
  const labels: Record<string, [string, typeof Activity]> = {
    'session.started': [who ? `${who} connected` : 'Remote session started', MonitorUp],
    'session.ended': [who ? `Session with ${who} ended` : 'Remote session ended', Unplug],
    'sessions.disconnected': ['All sessions disconnected', Unplug],
    'device.paired': [who ? `${who} paired` : 'Device paired', Link2],
    'device.revoked': [who ? `${who} revoked` : 'Device access revoked', ShieldAlert],
    'invite.created': ['Pairing invite created', Plus],
    'host.started': ['Orbit started on this computer', Power],
    'settings.changed': ['Host settings changed', Settings2],
    'power.lock': ['Screen locked remotely', LockKeyhole],
    'power.restart.requested': ['Restart requested remotely', Power],
    'file.download': ['File downloaded from this computer', FileDown],
    'file.upload': ['File uploaded to this computer', FileUp],
  };
  const [title, icon] = labels[entry.action] || [entry.action.replace(/[._-]/g, ' ').replace(/^\w/, c => c.toUpperCase()), Activity];
  const failed = /denied|fail|error|reject/i.test(entry.outcome || '');
  return { title, icon, failed, detail: entry.detail || (who && !title.includes(who) ? who : '') };
}

function State({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`ov-state ov-${tone}`}><i aria-hidden="true" />{children}</span>;
}

const rise = (index: number) => ({ '--i': Math.min(index, 6) } as CSSProperties);

function Tile({ label, icon: Icon, tone, state, index, children, busy }: { label: string; icon: typeof Activity; tone: Tone; state?: string; index: number; children: ReactNode; busy?: boolean }) {
  return <section className={`ov-tile ov-tile-${tone} ov-rise`} style={rise(index)} aria-label={label} aria-busy={busy || undefined}>
    <header className="ov-tile-head"><span className="ov-tile-icon" aria-hidden="true"><Icon size={17} strokeWidth={1.8} /></span><span className="ov-label">{label}</span>{state && !busy && <State tone={tone}>{state}</State>}</header>
    {busy ? <div className="ov-skeleton-stack" aria-hidden="true"><span /><span /><span /></div> : children}
  </section>;
}

function DeviceCard({ device, index, connecting, onConnect, onManage }: { device: Device; index: number; connecting: string | null; onConnect: OverviewProps['onConnect']; onManage: OverviewProps['onManage'] }) {
  const incoming = device.direction === 'incoming';
  const online = device.online === true ? 'ok' : device.online === false ? 'off' : 'info';
  const busy = connecting === device.id;
  const blocked = connecting !== null || !device.address;
  const perms = permissionSummary(device.permissions);
  const paired = shortDate(device.pairedAt);
  return <article className={`ov-device ov-rise ${device.online === true ? 'is-online' : ''}`} style={rise(index)} aria-label={device.name}>
    <div className="ov-device-top">
      <span className="ov-device-icon" aria-hidden="true"><PlatformIcon platform={device.platform} size={22} /></span>
      <div className="ov-device-name"><h3 title={device.name}>{device.name}</h3><span>{platformName(device.platform)}{paired && ` · paired ${paired}`}</span></div>
      <button type="button" className="ov-icon-btn" aria-label={`Manage ${device.name}`} title="Details, security code and access" onClick={() => onManage(device)}><Ellipsis size={19} /></button>
    </div>
    <div className="ov-device-facts">
      <State tone={online}>{device.online === true ? 'Online' : device.online === false ? 'Offline' : 'Not checked'}</State>
      <span className="ov-direction">{incoming ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{incoming ? 'Can access this host' : 'You connect to it'}</span>
    </div>
    {perms && <p className="ov-device-perms" title={incoming ? 'What this device may do on this computer' : 'What that computer allows you to do'}>Access: <b>{perms}</b></p>}
    <div className="ov-device-actions">
      {incoming ? <span className="ov-device-note">To open its desktop, join an invite created on it.</span> : <>
        <button type="button" className="ov-btn ov-primary ov-small" aria-label={`Connect to ${device.name}`} disabled={blocked} title={!device.address ? 'This device has no saved address yet.' : undefined} onClick={() => onConnect(device, false)}>
          {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <MonitorUp size={15} aria-hidden="true" />}{busy ? 'Connecting…' : 'Connect'}</button>
        <button type="button" className="ov-btn ov-secondary ov-small" aria-label={`View only, ${device.name}`} disabled={blocked} onClick={() => onConnect(device, true)}><Eye size={15} aria-hidden="true" />View only</button>
      </>}
    </div>
  </article>;
}

export function Overview(props: OverviewProps) {
  const { status, devices, activity, sessionsCount, connecting, loading = false, onAddDevice, onJoin, onConnect, onManage, onNavigate, onCopyAddress } = props;
  const host = status?.host;
  const tailscale = host?.tailscale;
  const testMode = host?.testMode === true;
  const connected = tailscale?.connected === true;
  const waiting = !status && loading;
  const code = securityCode(host?.fingerprint);
  const codeGroups = code ? code.split(' ') : [];
  const online = devices.filter(d => d.online === true).length;
  const knownOffline = devices.length > 0 && devices.every(d => d.online === false);
  const firstRun = !devices.length && !loading;

  const devicePhrase = !devices.length ? 'no devices paired yet'
    : `${plural(devices.length, 'device')} paired${online ? `, ${online} online` : knownOffline ? ', none online' : ''}`;
  const [lineTone, line]: [Tone, string] = waiting ? ['info', 'Checking this computer…']
    : !status ? ['warn', 'The Orbit desktop service is not connected']
    : testMode ? ['info', `Running in local test mode · ${devicePhrase}`]
    : !connected ? ['warn', `Tailscale is not connected on this computer · ${devicePhrase}`]
    : ['ok', `This computer is ready · ${devicePhrase}`];

  const network: { tone: Tone; state: string; title: string; body: ReactNode } = !status
    ? { tone: 'off', state: 'Unknown', title: 'Service unavailable', body: 'Network state appears once the Orbit service responds.' }
    : testMode ? { tone: 'info', state: 'Loopback only', title: 'Test mode', body: 'Remote devices cannot reach this computer while it runs in local test mode.' }
    : connected ? { tone: 'ok', state: 'Connected', title: 'Private and reachable', body: tailscale?.dnsName ? `Tailscale · ${tailscale.dnsName}` : 'Reachable on your Tailscale network' }
    : tailscale?.available ? { tone: 'warn', state: 'Not connected', title: 'Tailscale is off', body: tailscale.error || 'Sign in to Tailscale on this computer so your devices can reach it.' }
    : { tone: 'warn', state: 'Not installed', title: 'Tailscale needed', body: 'Install Tailscale to create the private network Orbit connects through.' };

  const sessions = (status?.sessions || []) as SessionEntry[];
  const incomingSessions = sessions.filter(s => s.direction === 'incoming').length;
  const outgoingSessions = sessions.filter(s => s.direction === 'outgoing').length;
  const lastSession = activity.find(e => /^session/.test(e.action));
  const sessionDetail = sessionsCount > 0
    ? (incomingSessions || outgoingSessions ? [incomingSessions && `${incomingSessions} viewing this computer`, outgoingSessions && `${outgoingSessions} you opened`].filter(Boolean).join(' · ')
      : sessions.map(s => s.deviceName).filter(Boolean).join(', ') || 'A remote desktop session is open')
    : lastSession ? `Last: ${describeEntry(lastSession, devices).title} · ${timeAgo(lastSession.timestamp)}` : 'No sessions yet';

  const shown = devices.slice(0, MAX_CARDS);
  const wireguard = connected && !testMode;

  return <div className="ov">
    <header className="ov-head ov-rise" style={rise(0)}>
      <div className="ov-heading">
        <h1>{greeting()}</h1>
        <p className={`ov-statusline ov-${lineTone}`} role="status">{waiting ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <i aria-hidden="true" />}<span>{line}</span></p>
      </div>
      <div className="ov-head-actions">
        <button type="button" className="ov-btn ov-secondary" onClick={onJoin}><ArrowDownLeft size={16} aria-hidden="true" />Join with an invite</button>
        <button type="button" className={`ov-btn ${firstRun ? 'ov-secondary' : 'ov-primary'}`} onClick={onAddDevice}><Plus size={16} aria-hidden="true" />Add a device</button>
      </div>
    </header>

    <div className="ov-tiles">
      <Tile label="Network" icon={testMode ? FlaskConical : Globe2} tone={network.tone} state={network.state} index={1} busy={waiting}>
        <h2 className="ov-tile-title">{network.title}</h2>
        <p className="ov-tile-body">{network.body}</p>
        {tailscale?.ip && !testMode && <div className="ov-address"><code>{tailscale.ip}</code>{onCopyAddress && <button type="button" className="ov-icon-btn ov-tiny" aria-label="Copy Tailscale address" title="Copy Tailscale address" onClick={onCopyAddress}><Copy size={14} /></button>}</div>}
        <button type="button" className="ov-link" onClick={() => onNavigate('settings')}>Network health<ArrowRight size={14} aria-hidden="true" /></button>
      </Tile>

      <Tile label="Protection" icon={ShieldCheck} tone={status ? 'ok' : 'off'} state={status ? (wireguard ? '2 layers' : '1 layer') : 'Unknown'} index={2} busy={waiting}>
        <h2 className="ov-tile-title">{!status ? 'Waiting for status' : wireguard ? 'Encrypted twice' : 'Encrypted'}</h2>
        <div className="ov-chips">
          <span className={`ov-chip ${wireguard ? '' : 'is-off'}`} title={wireguard ? 'Tailscale wraps all traffic in a WireGuard tunnel.' : 'The WireGuard layer is active only on your Tailscale network.'}>{wireguard ? 'WireGuard' : 'WireGuard · off'}</span>
          {status && <span className="ov-chip" title="Mutual TLS with each paired device's pinned certificate. Orbit refuses links without forward secrecy.">Mutual TLS · pinned</span>}
        </div>
        {codeGroups.length ? <div className="ov-code" title="Compare this code with the one your other computer shows for this computer, over a channel you trust. A match confirms you paired with this computer's certificate; it can't vouch for a computer that is itself compromised.">{codeGroups.map((g, i) => <span key={i}>{g}</span>)}</div>
          : <p className="ov-tile-body">The security code appears once the Orbit service responds.</p>}
        <p className="ov-caption"><Fingerprint size={13} aria-hidden="true" />Compare this code on your other computer</p>
      </Tile>

      <Tile label="Sessions" icon={MonitorUp} tone={sessionsCount > 0 ? 'ok' : 'off'} state={sessionsCount > 0 ? 'Live' : 'Idle'} index={3} busy={waiting}>
        <h2 className="ov-tile-title">{sessionsCount > 0 ? plural(sessionsCount, 'active session') : 'None active'}</h2>
        <p className="ov-tile-body">{sessionDetail}</p>
        <button type="button" className="ov-link" onClick={() => onNavigate('connections')}>{sessionsCount > 0 ? 'Open connections' : 'Connections'}<ArrowRight size={14} aria-hidden="true" /></button>
      </Tile>
    </div>

    <section className="ov-section" aria-labelledby="ov-devices-title">
      <div className="ov-section-head ov-rise" style={rise(3)}>
        <h2 id="ov-devices-title">Your devices{devices.length > 0 && <span className="ov-count">{devices.length} paired</span>}</h2>
        {devices.length > 0 && <button type="button" className="ov-link" onClick={() => onNavigate('devices')}>{devices.length > MAX_CARDS ? `View all ${devices.length}` : 'All devices'}<ArrowRight size={14} aria-hidden="true" /></button>}
      </div>
      {!devices.length && loading ? <div className="ov-devices" aria-busy="true" aria-label="Loading devices">{[0, 1, 2].map(i => <div key={i} className="ov-device ov-device-skeleton" aria-hidden="true"><span /><span /><span /></div>)}</div>
        : firstRun ? <div className="ov-firstrun ov-rise" style={rise(4)}>
          <div className="ov-firstrun-art" aria-hidden="true"><span className="ov-art-node"><Monitor size={30} strokeWidth={1.5} /></span><span className="ov-art-link"><LockKeyhole size={14} /></span><span className="ov-art-node is-faint"><Plus size={26} strokeWidth={1.5} /></span></div>
          <div className="ov-firstrun-copy">
            <h3>Meet your other computer.</h3>
            <p>Pairing takes about a minute. You choose exactly what the other computer can do here.</p>
            <ol className="ov-steps">
              <li><b>1</b><span>Install Orbit on the other computer and connect it to Tailscale.</span></li>
              <li><b>2</b><span>Create an invite here and choose what it may do.</span></li>
              <li><b>3</b><span>Paste it there under <em>Join with an invite</em>.</span></li>
            </ol>
            <button type="button" className="ov-btn ov-primary" onClick={onAddDevice}><Plus size={16} aria-hidden="true" />Create your first invite</button>
          </div>
        </div>
        : <div className="ov-devices">
          {shown.map((d, i) => <DeviceCard key={d.id} device={d} index={4 + i} connecting={connecting} onConnect={onConnect} onManage={onManage} />)}
          <button type="button" className={['ov-pair-card ov-rise', ...[2, 3, 4].filter(n => shown.length % n === 0).map(n => `fills-${n}`)].join(' ')} style={rise(4 + shown.length)} onClick={onAddDevice}>
            <span className="ov-pair-plus" aria-hidden="true"><Plus size={20} /></span><span className="ov-pair-text"><strong>Pair another computer</strong><span>Create an invite here, paste it there.</span></span>
          </button>
        </div>}
    </section>

    <div className="ov-bottom">
      <section className="ov-panel ov-host ov-rise" style={rise(5)} aria-labelledby="ov-host-title">
        <div className="ov-panel-head"><h2 id="ov-host-title">This computer</h2><span className="ov-label">Local host</span></div>
        <div className="ov-host-identity">
          <span className="ov-device-icon" aria-hidden="true"><PlatformIcon platform={host?.platform} size={22} /></span>
          <div><strong>{host?.name || 'This computer'}</strong><span>{host ? `${platformName(host.platform)}${host.version ? ` · Orbit ${host.version}` : ''}` : waiting ? 'Checking…' : 'Waiting for the desktop service'}</span></div>
        </div>
        <div className="host-details"><span>Tailscale address</span>
          <span className="ov-host-value">{tailscale?.ip ? <><code>{tailscale.ip}</code>{onCopyAddress && <button type="button" className="ov-icon-btn ov-tiny" aria-label="Copy this computer's Tailscale address" onClick={onCopyAddress}><Copy size={14} /></button>}</> : waiting ? '—' : testMode ? 'Loopback only (test mode)' : 'Not available'}</span></div>
        <div className="host-details"><span>Security code</span><span className="security-code" title="Compare this code with the one your other computer shows for this computer, over a channel you trust. A match confirms you paired with this computer's certificate; it can't vouch for a computer that is itself compromised.">{code || '—'}</span></div>
        <div className="host-details"><span>Who can connect</span><span className="ov-host-value"><ShieldCheck size={14} aria-hidden="true" />Paired devices only</span></div>
        <button type="button" className="ov-link ov-panel-link" onClick={() => onNavigate('settings')}>Host settings<ArrowRight size={14} aria-hidden="true" /></button>
      </section>

      <section className="ov-panel ov-recent ov-rise" style={rise(6)} aria-labelledby="ov-recent-title">
        <div className="ov-panel-head"><h2 id="ov-recent-title">Recent activity</h2><button type="button" className="ov-link" aria-label="View all activity" onClick={() => onNavigate('activity')}>View all<ArrowRight size={14} aria-hidden="true" /></button></div>
        {activity.length ? <ol className="ov-activity">{activity.slice(0, 4).map((entry, index) => {
          const { title, icon: Icon, failed, detail } = describeEntry(entry, devices);
          return <li key={entry.id || index} className={failed ? 'is-failed' : ''}>
            <span className="ov-activity-icon" aria-hidden="true"><Icon size={15} /></span>
            <div><strong>{title}{failed && <span className="ov-failed">{entry.outcome}</span>}</strong>{detail && <span>{detail}</span>}</div>
            <time dateTime={entry.timestamp} title={new Date(entry.timestamp).toLocaleString()}>{timeAgo(entry.timestamp)}</time>
          </li>;
        })}</ol> : <div className="ov-recent-empty"><Activity size={22} strokeWidth={1.5} aria-hidden="true" /><strong>{loading ? 'Loading activity…' : 'No activity yet'}</strong><span>Pairing and connection events on this computer appear here.</span></div>}
      </section>
    </div>
  </div>;
}

export default Overview;
