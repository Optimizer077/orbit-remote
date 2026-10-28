import type { CSSProperties, ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, Check, Clipboard, Command, Copy, Ellipsis, Eye, FolderOpen, MousePointer2,
  FileDown, FileUp, Fingerprint, FlaskConical, Globe2, Link2, Loader2, LockKeyhole,
  Monitor, MonitorUp, Plus, Power, RefreshCw, Settings2, ShieldAlert, ShieldCheck, Terminal, Unplug,
} from 'lucide-react';
import { securityCode, type AuditEntry, type Device, type HostStatus, type Permissions } from '../api';
import { eventName } from './event-names';
import { revokedReason } from './revoked-reason';
import { TAILSCALE_FIX, tailscaleProblem } from './tailscale-state';
import './overview.css';

export type OverviewPage = 'devices' | 'connections' | 'activity' | 'settings';

export type OverviewProps = {
  status: HostStatus | null;
  devices: Device[];
  activity: AuditEntry[];
  sessionsCount: number;
  sessions?: readonly SessionEntry[];
  connecting: string | null;
  loading?: boolean;
  onAddDevice(): void;
  onJoin(): void;
  onConnect(device: Device, viewOnly: boolean): void;
  onManage(device: Device): void;
  onAllow?(device: Device): void | Promise<void>;
  allowing?: string | null;
  onNavigate(page: OverviewPage): void;
  onCopyAddress?(): void;
  /** Restarts the local background host so it looks for Tailscale again. */
  onRecheckTailscale?(): void;
  recheckingTailscale?: boolean;
  /** Opens the existing native Mac permission setup (the same one as the app menu). */
  onOpenMacPermissions?(): void;
  openingMacPermissions?: boolean;
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

function PermissionChips({ device }: { device: Device }) {
  const icons = { view: Eye, control: MousePointer2, clipboard: Clipboard, files: FolderOpen, power: Power };
  return <div className="ov-permission-chips" role="group" aria-label={`Permissions for ${device.name}`}>{PERMISSION_LABELS.map(([key, label]) => {
    const granted = device.permissions?.[key] === true;
    const Icon = icons[key];
    return <span key={key} className={`ov-permission-chip ${granted ? 'is-granted' : ''}`} data-permission={key} data-granted={granted} aria-label={`${label}: ${granted ? 'Allowed' : 'Not allowed'}`}><Icon size={14} aria-hidden="true" /><b>{label}</b><small>{granted ? 'Allowed' : 'Not allowed'}</small></span>;
  })}</div>;
}

// Icons for the host's audit actions; their plain names come from event-names.ts, shared with Activity.
const EVENT_ICONS: Record<string, typeof Activity> = {
  'session.started': MonitorUp, 'session.ended': Unplug, 'sessions.disconnected': Unplug, 'device.paired': Link2, 'device.revoked': ShieldAlert,
  'device.blocked_by_owner': ShieldAlert, 'device.allowed_by_owner': ShieldCheck, 'invite.created': Plus, 'identity.rotated': Fingerprint,
  'host.started': Power, 'settings.changed': Settings2, 'power.lock': LockKeyhole, 'power.restart.requested': Power,
  'file.download': FileDown, 'file.upload': FileUp, 'display.wake.requested': Monitor, 'display.wake.outcome': Monitor,
};

function describeEntry(entry: AuditEntry, devices: Device[]) {
  const who = entry.deviceName || devices.find(d => d.id === entry.deviceId)?.name;
  const failed = /denied|fail|error|reject/i.test(entry.outcome || '');
  return { title: eventName(entry.action), icon: EVENT_ICONS[entry.action] || Activity, failed, who, detail: who || entry.detail || '' };
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

function DeviceCard({ device, index, connecting, inSession, onConnect, onManage, onJoin, onAllow, allowing }: { device: Device; index: number; connecting: string | null; inSession: boolean; onConnect: OverviewProps['onConnect']; onManage: OverviewProps['onManage']; onJoin: OverviewProps['onJoin']; onAllow?: OverviewProps['onAllow']; allowing?: string | null }) {
  const incoming = device.direction === 'incoming';
  const ownerBlocked = incoming && device.blockedByOwner === true;
  inSession = inSession && !ownerBlocked;
  const online = device.online === true ? 'ok' : device.online === false ? 'off' : 'info';
  const busy = connecting === device.id;
  const revoked = device.revoked === true || device.status === 'revoked';
  const blocked = connecting !== null || !device.address || revoked;
  const paired = shortDate(device.pairedAt);
  return <article className={`ov-device ov-rise ${device.online === true ? 'is-online' : ''} ${inSession ? 'is-in-session' : ''}`} style={rise(index)} aria-label={device.name} data-session-state={inSession ? 'active' : 'idle'} data-direction={device.direction || 'outgoing'}>
    <div className="ov-device-top">
      <span className="ov-device-icon" aria-hidden="true"><PlatformIcon platform={device.platform} size={22} /></span>
      <div className="ov-device-name"><h3 title={device.name}>{device.name}</h3><span>{platformName(device.platform)}{paired && ` · paired ${paired}`}</span></div>
      <button type="button" className="ov-icon-btn" data-device-manage aria-label={`Manage ${device.name}`} title="Details, security code and access" onClick={() => onManage(device)}><Ellipsis size={19} /></button>
    </div>
    <div className="ov-device-facts">
      <State tone={inSession ? 'ok' : online}>{revoked ? 'Access removed' : ownerBlocked ? 'Disconnected by you' : inSession ? 'In session' : device.online === true ? 'Online' : device.online === false ? 'Offline' : 'Not checked'}</State>
      <span className="ov-direction">{incoming ? <ArrowDownLeft size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{incoming ? ownerBlocked ? 'Access paused by you' : 'Can see this computer' : 'You can see it'}</span>
    </div>
    {revoked && <p className="ov-device-revoked">{revokedReason(device.statusReason)} To see it again, join a new invite from it.</p>}
    <PermissionChips device={device} />
    <div className="ov-device-actions">
      {revoked ? <><button className="ov-btn ov-secondary ov-small" onClick={() => onManage(device)}>Forget connection</button><button className="ov-btn ov-primary ov-small" onClick={onJoin}>Pair again</button></> : ownerBlocked && onAllow ? <button type="button" className="ov-btn ov-secondary ov-small" disabled={allowing != null} aria-label={`Allow ${device.name} again`} aria-busy={allowing === device.id || undefined} onClick={async () => { try { await onAllow(device); } catch { /* The owner reports approval errors in the relevant surface. */ } }}>{allowing === device.id ? 'Allowing...' : 'Allow again'}</button> : incoming ? <span className="ov-device-note">To open its desktop, join an invite created on it.</span> : <>
        <button type="button" className="ov-btn ov-primary ov-connect" aria-label={`Connect to ${device.name}`} disabled={blocked} title={!device.address ? 'This computer has no saved address yet.' : undefined} onClick={() => onConnect(device, false)}>
          {busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <MonitorUp size={17} aria-hidden="true" />}{busy ? 'Connecting…' : 'Connect'}</button>
        <button type="button" className="ov-btn ov-secondary ov-small" aria-label={`View only, ${device.name}`} disabled={blocked} onClick={() => onConnect(device, true)}><Eye size={15} aria-hidden="true" />View only</button>
      </>}
    </div>
  </article>;
}

export function Overview(props: OverviewProps) {
  const { status, devices, activity, sessionsCount, connecting, sessions: providedSessions, loading = false, onAddDevice, onJoin, onConnect, onManage, onNavigate, onCopyAddress, onAllow, allowing, onRecheckTailscale, recheckingTailscale = false, onOpenMacPermissions, openingMacPermissions = false } = props;
  const host = status?.host;
  const tailscale = host?.tailscale;
  const testMode = host?.testMode === true;
  const connected = tailscale?.connected === true;
  const problem = status && !testMode ? tailscaleProblem(tailscale) : null;
  const fix = problem ? TAILSCALE_FIX[problem] : null;
  const waiting = !status && loading;
  const code = securityCode(host?.fingerprint);
  const codeGroups = code ? code.split(' ') : [];
  const online = devices.filter(d => d.online === true).length;
  const knownOffline = devices.length > 0 && devices.every(d => d.online === false);
  const firstRun = !devices.length && !loading;

  const devicePhrase = !devices.length ? 'no computers paired yet'
    : `${plural(devices.length, 'computer')} paired${online ? `, ${online} online` : knownOffline ? ', none online' : ''}`;
  const [lineTone, line]: [Tone, string] = waiting ? ['info', 'Checking this computer…']
    : !status ? ['warn', 'The Orbit desktop service is not connected']
    : testMode ? ['info', `Running in local test mode · ${devicePhrase}`]
    : fix ? ['warn', `${fix.line} · ${devicePhrase}`]
    : ['ok', `This computer is ready · ${devicePhrase}`];

  const network: { tone: Tone; state: string; title: string; body: ReactNode } = !status
    ? { tone: 'off', state: 'Unknown', title: 'Service unavailable', body: 'Network state appears once the Orbit service responds.' }
    : testMode ? { tone: 'info', state: 'Loopback only', title: 'Test mode', body: 'Your other computers cannot reach this one while it runs in local test mode.' }
    : connected ? { tone: 'ok', state: 'Connected', title: 'Private and reachable', body: tailscale?.dnsName ? `Tailscale · ${tailscale.dnsName}` : 'Reachable on your Tailscale network' }
    : { tone: 'warn', state: fix?.state || 'Not connected', title: fix?.title || 'Tailscale is off', body: fix?.fix || TAILSCALE_FIX.off.fix };
  const tailscaleOff = !!status && !testMode && !connected;

  const sessions: readonly SessionEntry[] = providedSessions || status?.sessions || [];
  const incomingSessions = sessions.filter(s => s.direction === 'incoming').length;
  const outgoingSessions = sessions.filter(s => s.direction === 'outgoing').length;
  const lastSession = activity.find(e => /^session/.test(e.action));
  const sessionDetail = sessionsCount > 0
    ? (incomingSessions || outgoingSessions ? [incomingSessions && `${incomingSessions} viewing this computer`, outgoingSessions && `${outgoingSessions} you opened`].filter(Boolean).join(' · ')
      : sessions.map(s => s.deviceName).filter(Boolean).join(', ') || 'A remote desktop session is open')
    : lastSession ? `Last: ${[describeEntry(lastSession, devices).who, describeEntry(lastSession, devices).title].filter(Boolean).join(' · ')} · ${timeAgo(lastSession.timestamp)}` : 'No sessions yet';

  // A Mac host cannot share its screen or accept input until macOS allows it. Only the host's own report decides.
  const onMac = !!status && /darwin|mac/i.test(host?.platform || '');
  const needsScreen = onMac && status?.capabilities?.capture !== true, needsInput = onMac && status?.capabilities?.input !== true;
  const macPermissionsNeeded = needsScreen || needsInput;
  const macMissing = [needsScreen && 'Screen Recording', needsInput && 'Accessibility'].filter(Boolean).join(' and ');
  const macEffect = needsScreen && needsInput ? 'Without them, your other computers can’t see this screen or use its mouse and keyboard.'
    : needsScreen ? 'Without it, your other computers can’t see this screen.' : 'Without it, your other computers can’t use this Mac’s mouse and keyboard, even when you allow control.';

  const shown = devices.slice(0, MAX_CARDS);
  const wireguard = connected && !testMode;

  // One re-check button: in the Network tile, or beside step 1 of the first-run card while nothing is paired.
  const recheck = tailscaleOff && onRecheckTailscale && <button type="button" className="ov-btn ov-secondary ov-small ov-wrap" disabled={recheckingTailscale} aria-busy={recheckingTailscale || undefined} onClick={onRecheckTailscale}>{recheckingTailscale ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{recheckingTailscale ? 'Checking for Tailscale…' : 'Tailscale is on now — check again'}</button>;
  // Step 1 of the first-run card follows this computer's real Tailscale state.
  const tailscaleStep: 'done' | 'needed' | 'unknown' = connected && !testMode ? 'done' : fix ? 'needed' : 'unknown';
  const tiles = <div className="ov-tiles">
      <Tile label="Network" icon={testMode ? FlaskConical : Globe2} tone={network.tone} state={network.state} index={1} busy={waiting}>
        <h2 className="ov-tile-title">{network.title}</h2>
        <p className="ov-tile-body">{network.body}</p>
        {!firstRun && recheck}
        {tailscale?.ip && !testMode && <div className="ov-address"><code>{tailscale.ip}</code>{onCopyAddress && <button type="button" className="ov-icon-btn ov-tiny" aria-label="Copy Tailscale address" title="Copy Tailscale address" onClick={onCopyAddress}><Copy size={14} /></button>}</div>}
        <button type="button" className="ov-link" onClick={() => onNavigate('settings')}>Network health<ArrowRight size={14} aria-hidden="true" /></button>
      </Tile>

      <Tile label="Protection" icon={ShieldCheck} tone={status ? 'ok' : 'off'} state={status ? (wireguard ? '2 layers' : '1 layer') : 'Unknown'} index={2} busy={waiting}>
        <h2 className="ov-tile-title">{!status ? 'Waiting for status' : 'Private, encrypted connection'}</h2>
        {status && <details className="ov-details">
          <summary>Details</summary>
          <div className="ov-chips">
            <span className={`ov-chip ${wireguard ? '' : 'is-off'}`} title={wireguard ? 'Tailscale wraps all traffic in a WireGuard tunnel.' : 'The WireGuard layer is active only on your Tailscale network.'}>{wireguard ? 'WireGuard' : 'WireGuard · off'}</span>
            <span className="ov-chip" title="Mutual TLS with each paired computer's pinned certificate. Orbit refuses links without forward secrecy.">Mutual TLS · pinned</span>
          </div>
          <p className="ov-details-text">{wireguard ? 'Tailscale wraps all traffic in a WireGuard tunnel. ' : 'The WireGuard layer is active only on your Tailscale network. '}Inside it, Orbit uses mutual TLS with each paired computer’s pinned certificate and refuses links without forward secrecy.</p>
        </details>}
        {codeGroups.length ? <div className="ov-code" title="Compare this code with the one your other computer shows for this computer, over a channel you trust. A match confirms you paired with this computer's certificate; it can't vouch for a computer that is itself compromised.">{codeGroups.map((g, i) => <span key={i}>{g}</span>)}</div>
          : <p className="ov-tile-body">The security code appears once the Orbit service responds.</p>}
        <p className="ov-caption"><Fingerprint size={13} aria-hidden="true" />Compare this code on your other computer</p>
      </Tile>

      <Tile label="Sessions" icon={MonitorUp} tone={sessionsCount > 0 ? 'ok' : 'off'} state={sessionsCount > 0 ? 'Live' : 'Idle'} index={3} busy={waiting}>
        <h2 className="ov-tile-title">{sessionsCount > 0 ? plural(sessionsCount, 'active session') : 'None active'}</h2>
        <p className="ov-tile-body">{sessionDetail}</p>
        <button type="button" className="ov-link" onClick={() => onNavigate('connections')}>{sessionsCount > 0 ? 'Open connections' : 'Connections'}<ArrowRight size={14} aria-hidden="true" /></button>
      </Tile>
  </div>;

  return <div className="ov">
    <header className="ov-head ov-rise" style={rise(0)}>
      <div className="ov-heading">
        <h1>{greeting()}</h1>
        <p className={`ov-statusline ov-${lineTone}`} role="status">{waiting ? <Loader2 size={15} className="spin" aria-hidden="true" /> : <i aria-hidden="true" />}<span>{line}</span></p>
      </div>
      <div className="ov-head-actions">
        <button type="button" className="ov-btn ov-secondary" onClick={onJoin}><ArrowDownLeft size={16} aria-hidden="true" />Join with an invite</button>
        <button type="button" className={`ov-btn ${firstRun ? 'ov-secondary' : 'ov-primary'}`} onClick={onAddDevice}><Plus size={16} aria-hidden="true" />Invite a computer</button>
      </div>
    </header>

    {macPermissionsNeeded && <section className="ov-mac-permissions ov-rise" style={rise(1)} aria-labelledby="ov-mac-permissions-title">
      <span className="ov-tile-icon" aria-hidden="true"><ShieldAlert size={18} /></span>
      <div>
        <h2 id="ov-mac-permissions-title">Orbit needs {macMissing} permission on this Mac</h2>
        <p>{macEffect} After allowing {needsScreen && needsInput ? 'them' : 'it'}, quit and reopen Orbit.</p>
        <ul className="ov-mac-permission-state" aria-label="Permission status on this Mac">
          <li data-permission="screen">Screen Recording: {needsScreen ? 'needs approval' : 'allowed'}</li>
          <li data-permission="accessibility">Accessibility: {needsInput ? 'needs approval' : 'allowed'}</li>
        </ul>
      </div>
      {onOpenMacPermissions && <button type="button" className="ov-btn ov-secondary ov-small ov-wrap" aria-disabled={openingMacPermissions || undefined} aria-busy={openingMacPermissions || undefined} onClick={() => { if (!openingMacPermissions) onOpenMacPermissions(); }}>{openingMacPermissions ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Settings2 size={14} aria-hidden="true" />}Open permission setup</button>}
    </section>}

    {!firstRun && tiles}

    <section className="ov-section" aria-labelledby="ov-devices-title">
      <div className="ov-section-head ov-rise" style={rise(3)}>
        <h2 id="ov-devices-title">{firstRun ? 'Get started' : 'Your devices'}{devices.length > 0 && <span className="ov-count">{devices.length} paired</span>}</h2>
        {devices.length > 0 && <button type="button" className="ov-link" onClick={() => onNavigate('devices')}>{devices.length > MAX_CARDS ? `View all ${devices.length}` : 'All devices'}<ArrowRight size={14} aria-hidden="true" /></button>}
      </div>
      {!devices.length && loading ? <div className="ov-devices" aria-busy="true" aria-label="Loading devices">{[0, 1, 2].map(i => <div key={i} className="ov-device ov-device-skeleton" aria-hidden="true"><span /><span /><span /></div>)}</div>
        : firstRun ? <div className="ov-firstrun ov-rise" style={rise(4)}>
          <div className="ov-firstrun-art" aria-hidden="true"><span className="ov-art-node"><Monitor size={30} strokeWidth={1.5} /></span><span className="ov-art-link"><LockKeyhole size={14} /></span><span className="ov-art-node is-faint"><Plus size={26} strokeWidth={1.5} /></span></div>
          <div className="ov-firstrun-copy">
            <h3>Meet your other computer.</h3>
            <p>Pairing takes about a minute. Start on the computer you want to see: it creates the invite and decides what the other computer may do.</p>
            <ol className="ov-steps">
              <li className="ov-step-tailscale" data-step="tailscale" data-state={tailscaleStep}>
                <b>{tailscaleStep === 'done' ? <Check size={13} strokeWidth={2.6} aria-hidden="true" /> : 1}</b>
                <div className="ov-step-body">
                  <span>Install Orbit on both computers and turn on Tailscale.</span>
                  {tailscaleStep === 'done' ? <State tone="ok">On here</State> : fix && <>
                    <State tone="warn">{fix.step}</State>
                    <p className="ov-step-fix">{fix.fix}</p>
                    {recheck}
                  </>}
                </div>
              </li>
              <li><b>2</b><span>On the computer you want to see, choose <em>Let another computer see this one</em>.</span></li>
              <li><b>3</b><span>On the other computer, choose <em>See another computer from here</em> and paste the invite.</span></li>
            </ol>
            <div className="ov-direction-choice" role="group" aria-label="Which computer is this?">
              <button type="button" className="ov-btn ov-primary ov-wrap" onClick={onAddDevice}><ArrowUpRight size={16} aria-hidden="true" />Let another computer see this one</button>
              <button type="button" className="ov-btn ov-primary ov-wrap" onClick={onJoin}><ArrowDownLeft size={16} aria-hidden="true" />See another computer from here</button>
            </div>
          </div>
        </div>
        : <div className="ov-devices">
          {shown.map((d, i) => <DeviceCard key={`${d.direction || 'outgoing'}-${d.id}`} device={d} index={4 + i} connecting={connecting} inSession={sessions.some(session => session.deviceId === d.id && session.direction === (d.direction || 'outgoing'))} onConnect={onConnect} onManage={onManage} onJoin={onJoin} onAllow={onAllow} allowing={allowing} />)}
          <button type="button" className={['ov-pair-card ov-rise', ...[2, 3, 4].filter(n => shown.length % n === 0).map(n => `fills-${n}`)].join(' ')} style={rise(4 + shown.length)} onClick={onAddDevice}>
            <span className="ov-pair-plus" aria-hidden="true"><Plus size={20} /></span><span className="ov-pair-text"><strong>Let another computer see this one</strong><span>Create an invite here, paste it there.</span></span>
          </button>
        </div>}
    </section>

    {firstRun && tiles}

    <div className="ov-bottom">
      <section className="ov-panel ov-host ov-rise" style={rise(5)} aria-labelledby="ov-host-title">
        <div className="ov-panel-head"><h2 id="ov-host-title">This computer</h2></div>
        <div className="ov-host-identity">
          <span className="ov-device-icon" aria-hidden="true"><PlatformIcon platform={host?.platform} size={22} /></span>
          <div><strong>{host?.name || 'This computer'}</strong><span>{host ? `${platformName(host.platform)}${host.version ? ` · Orbit ${host.version}` : ''}` : waiting ? 'Checking…' : 'Waiting for the desktop service'}</span></div>
        </div>
        <div className="host-details"><span>Tailscale address</span>
          <span className="ov-host-value">{tailscale?.ip ? <><code>{tailscale.ip}</code>{onCopyAddress && <button type="button" className="ov-icon-btn ov-tiny" aria-label="Copy this computer's Tailscale address" onClick={onCopyAddress}><Copy size={14} /></button>}</> : waiting ? '—' : testMode ? 'Loopback only (test mode)' : 'Not available'}</span></div>
        <div className="host-details"><span>Security code</span><span className="security-code" title="Compare this code with the one your other computer shows for this computer, over a channel you trust. A match confirms you paired with this computer's certificate; it can't vouch for a computer that is itself compromised.">{code || '—'}</span></div>
        <div className="host-details"><span>Who can connect</span><span className="ov-host-value"><ShieldCheck size={14} aria-hidden="true" />Paired computers only</span></div>
        <button type="button" className="ov-link ov-panel-link" onClick={() => onNavigate('settings')}>Open settings<ArrowRight size={14} aria-hidden="true" /></button>
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
