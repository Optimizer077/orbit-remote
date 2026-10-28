import { useEffect, useId, useRef, useState } from 'react';
import { Check, CheckCheck, Clipboard, Clock, Copy, Eye, FolderOpen, Link2, Loader2, LockKeyhole, Monitor, MonitorUp, MousePointer2, Network, Power, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, copyText, errorMessage, securityCode, type Device, type HostStatus, type Invite, type Permissions } from '../api';
import { Modal } from './Modal';
import { FriendlyErrorNotice } from './FriendlyErrorNotice';
import { friendlyError, type FriendlyError } from './friendly-errors';
import { countdownLabel, inviteRemaining, newlyJoined } from './invite-progress';
import { pairingTailscaleNotice, tailscaleProblem } from './tailscale-state';
import './pairing.css';

export const DEFAULT_PERMISSIONS: Permissions = { view: true, control: false, clipboard: false, files: false, power: false };
// The host refuses an invite that grants power without control (Permissions.IsValid in Models.cs).
const POWER_NEEDS_CONTROL = { power: 'Needs See and control' } as const;

function Toggle({ checked, onChange, disabled, label, describedBy }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string; describedBy?: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} disabled={disabled} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><span /></button>;
}

/** `locked` turns a row off and disables it, showing the short reason in place of its description. */
export function PermissionRows({ permissions, onChange, disabled = false, only, locked }: { permissions: Permissions; onChange: (p: Permissions) => void; disabled?: boolean; only?: readonly (keyof Permissions)[]; locked?: Partial<Record<keyof Permissions, string>> }) {
  const id = useId();
  const all: { key: keyof Permissions; icon: typeof Monitor; title: string; detail: string }[] = [
    { key: 'view', icon: Monitor, title: 'View screen', detail: 'See this computer’s desktop' },
    { key: 'control', icon: MousePointer2, title: 'Mouse & keyboard', detail: 'Control apps and type remotely' },
    { key: 'clipboard', icon: Clipboard, title: 'Clipboard', detail: 'Read and write clipboard text' },
    { key: 'files', icon: FolderOpen, title: 'File transfer', detail: 'Access the configured shared folder' },
    { key: 'power', icon: Power, title: 'Lock & restart', detail: 'Lock the screen or restart this computer' },
  ];
  const items = only ? all.filter(item => only.includes(item.key)) : all;
  return <div className="permission-list">{items.map(({ key, icon: Icon, title, detail }) => {
    const reason = locked?.[key];
    return <div className={`permission-row ${reason ? 'is-locked' : ''}`} key={key}><Icon size={18} /><div><strong>{title}</strong><span id={reason ? `${id}-${key}-reason` : undefined}>{reason || detail}</span></div><Toggle checked={reason ? false : permissions[key]} label={title} describedBy={reason ? `${id}-${key}-reason` : undefined} disabled={disabled || key === 'view' || !!reason} onChange={value => onChange({ ...permissions, [key]: value })} /></div>;
  })}</div>;
}

const ACCESS_CHOICES = [
  { control: false, icon: Eye, title: 'See only', detail: 'It can watch this screen. It can’t use your mouse or keyboard.' },
  { control: true, icon: MousePointer2, title: 'See and control', detail: 'It can watch this screen and use your mouse and keyboard.' },
] as const;

/** The main decision when inviting: maps to the existing control grant. See only is the default. */
export function AccessChoice({ permissions, onChange }: { permissions: Permissions; onChange: (p: Permissions) => void }) {
  const id = useId();
  return <div className="access-choice" role="radiogroup" aria-label="What can the other computer do?">{ACCESS_CHOICES.map(({ control, icon: Icon, title, detail }) => {
    const key = `${id}-${control ? 'control' : 'see'}`;
    return <label key={title} className={`access-choice-option ${permissions.control === control ? 'selected' : ''}`}>
      <input type="radio" name={`${id}-access`} checked={permissions.control === control} onChange={() => onChange({ ...permissions, control, power: control ? permissions.power : false })} aria-labelledby={`${key}-title`} aria-describedby={`${key}-detail`} />
      <Icon size={18} aria-hidden="true" /><span><strong id={`${key}-title`}>{title}</strong><span id={`${key}-detail`}>{detail}</span></span>
    </label>;
  })}</div>;
}

/** The grants a host gave, in the invite's own words: "See only, plus clipboard and file transfer". */
export function grantSummary(permissions: Partial<Permissions> = {}) {
  const extras = ([['clipboard', 'clipboard'], ['files', 'file transfer'], ['power', 'lock & restart']] as const)
    .filter(([key]) => permissions[key] === true).map(([, label]) => label);
  const base = permissions.control === true ? 'See and control' : 'See only';
  return extras.length ? `${base}, plus ${extras.length > 1 ? `${extras.slice(0, -1).join(', ')} and ${extras.at(-1)}` : extras[0]}` : base;
}

const INVITE_STEPS = ['Choose access', 'Send the invite', 'Check the code'] as const;
const JOIN_STEPS = ['Paste the invite', 'Check the code', 'Connect'] as const;

/** Where this side of the pairing is: finished steps show a check, the current one is marked for assistive tech. */
export function PairSteps({ steps, current }: { steps: readonly string[]; current: number }) {
  return <ol className="pair-steps" aria-label="Pairing steps">{steps.map((label, index) => {
    const state = index < current ? 'done' : index === current ? 'current' : 'todo';
    return <li key={label} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
      <b aria-hidden="true">{state === 'done' ? <Check size={12} strokeWidth={2.8} /> : index + 1}</b>
      <span>{state === 'done' && <span className="pair-steps-sr">Done: </span>}{label}</span>
    </li>;
  })}</ol>;
}

export type PairModalProps = {
  mode: 'invite' | 'join';
  connected: boolean;
  onClose: () => void;
  /** A join succeeded. The dialog stays open on its success step until the person chooses. */
  onPaired: (device: Device) => void;
  /** "Connect now" on the join success step: the same explicit connect as the Devices Connect button. */
  onConnect?: (device: Device) => void;
  onError: (e: string) => void;
  notify: (message: string) => void;
  /** Restarts the local background host so it looks for Tailscale again. */
  onRecheckTailscale?: () => Promise<void>;
  rechecking?: boolean;
  /** The workspace's paired devices, refreshed by its existing refresh and change signal. */
  devices?: readonly Device[];
  /** From the workspace's runtime status; picks the right cause when remote listening is unavailable. */
  identityExpired?: boolean;
  /** This computer's Tailscale report; only picks the wording of the "Tailscale is off" notice. */
  tailscale?: HostStatus['host']['tailscale'];
  /** This computer's certificate fingerprint; its security code is shown once the other computer joins. */
  hostFingerprint?: string;
};

/** Re-renders once a second only while `active`. A local clock, not a host request. */
function useTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick(tick => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

export function PairModal({ mode, connected, onClose, onPaired, onConnect, onError, notify, onRecheckTailscale, rechecking = false, devices = [], identityExpired, tailscale, hostFingerprint }: PairModalProps) {
  const [permissions, setPermissions] = useState<Permissions>({ ...DEFAULT_PERMISSIONS });
  const [invite, setInvite] = useState<Invite | null>(null);
  const [joinText, setJoinText] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<FriendlyError | null>(null);
  const [joined, setJoined] = useState<Device | null>(null);
  const [paired, setPaired] = useState<Device | null>(null);
  const doneButton = useRef<HTMLButtonElement>(null);
  const newInviteButton = useRef<HTMLButtonElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const pairedStep = useRef<HTMLDivElement>(null);
  const context = { tailscaleConnected: connected, identityExpired };
  // Measured against Date.now() at every render, so a fresh invite never reads above 5:00.
  const remaining = invite && !joined ? inviteRemaining(invite.expiresAt, Date.now()) : null;
  const expired = remaining === 0;
  useTick(remaining !== null && remaining > 0);
  const create = async () => {
    setBusy(true); setLocalError(null);
    try { const created = await api.createInvite(permissions.control ? permissions : { ...permissions, power: false }); setJoined(null); setInvite(created); }
    catch (e) { setLocalError(friendlyError(e, context)); } finally { setBusy(false); }
  };
  // An incoming pairing made after this invite was created means the other computer used it,
  // including a re-pair that keeps an existing id. Checked even after expiry: a refresh may
  // arrive later than the join it reports.
  useEffect(() => {
    if (!invite || joined) return;
    const device = newlyJoined(invite, devices);
    if (device) setJoined(device);
  }, [devices, invite, joined]);
  // The focused Copy button disappears when the invite is used or expires; keep focus in the dialog.
  // The join form (and its focused button) is replaced by the success step; keep focus in the dialog.
  // Create invite (or Create a new invite) disappears once the invite exists; move to its next action.
  useEffect(() => { if (invite) copyButton.current?.focus(); }, [invite]);
  useEffect(() => {
    if (paired) pairedStep.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('h2')?.focus();
  }, [paired]);
  useEffect(() => {
    const target = joined ? doneButton.current : expired ? newInviteButton.current : null;
    if (!target) return;
    if (target.disabled) target.closest('[role="dialog"]')?.querySelector<HTMLElement>('h2')?.focus();
    else target.focus();
  }, [joined, expired]);
  const announcement = paired ? `${paired.name} is paired.` : joined ? `${joined.name} joined.` : expired ? 'This invite expired. Create a new invite to pair.' : '';
  const join = async () => { setBusy(true); setLocalError(null); try { const device = await api.pair(joinText.trim()); setPaired(device); onPaired(device); } catch (e) { setLocalError(friendlyError(e, context)); } finally { setBusy(false); } };
  const pairedCode = paired ? securityCode(paired.serverFingerprint || paired.fingerprint) : '';
  const hostCode = securityCode(hostFingerprint);
  const step = mode === 'invite' ? joined ? 2 : invite ? 1 : 0 : paired ? 1 : 0;
  return <Modal title={mode === 'invite' ? 'Invite another computer' : 'Join another computer'} subtitle={mode === 'invite' ? joined ? 'It joined. Check that both computers show the same security code.' : invite ? 'Your invite is ready. Send it to the computer that should see this one.' : 'The other computer will be able to see this one. Choose exactly what it may do.' : paired ? 'Check the security code, then connect when you are ready.' : 'Paste the invite you copied on the computer you want to see.'} onClose={onClose}>
    <p className="pairing-live" role="status" aria-live="polite">{announcement}</p>
    <PairSteps steps={mode === 'invite' ? INVITE_STEPS : JOIN_STEPS} current={step} />
    {!connected && <div className="inline-notice tailscale-off-notice"><Network size={16} aria-hidden="true" /><div><span>{pairingTailscaleNotice(tailscaleProblem(tailscale))}</span>{onRecheckTailscale && <button type="button" className="button secondary small" disabled={rechecking} aria-busy={rechecking || undefined} onClick={() => { void onRecheckTailscale(); }}>{rechecking ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{rechecking ? 'Checking for Tailscale…' : 'Tailscale is on now — check again'}</button>}</div></div>}
    {localError && <div className="inline-error" role="alert"><FriendlyErrorNotice error={localError} /></div>}
    {mode === 'invite' ? invite ? joined ? <>
      <div className="invite-success invite-joined"><CheckCheck size={24} aria-hidden="true" /><div><strong>{joined.name} joined</strong><p>{joined.blockedByOwner ? 'Its access is still paused by you. Allow it under Devices when you are ready.' : 'It can now see this computer with the access you chose. You can close this window.'}</p></div></div>
      {hostCode && <div className="security-code-card host-code-card"><div className="subsection-label">THIS COMPUTER’S SECURITY CODE</div><code>{hostCode}</code><p>{joined.name} now shows a security code for this computer. Check that it is the same. If it is different, choose Remove access for {joined.name} under Devices.</p></div>}
      <button ref={doneButton} type="button" className="button primary full" onClick={onClose}>Done</button>
    </> : expired ? <>
      <div className="invite-success invite-expired"><Clock size={24} aria-hidden="true" /><div><strong>This invite expired.</strong><p>Invites work for a few minutes only. Create a new one, then paste it on your other computer.</p></div></div>
      <button ref={newInviteButton} type="button" className="button primary full" disabled={busy || !connected} onClick={() => void create()}>{busy ? <Loader2 size={16} className="spin" aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />} Create a new invite</button>
    </> : <><div className="invite-success"><CheckCheck size={24} /><div><strong>Only share with a computer you trust.</strong><p>{remaining !== null ? <span className="invite-countdown">Expires in {countdownLabel(remaining)}</span> : 'Use this invite on your other computer.'}</p></div></div><p className="invite-instruction">On your other computer: open Orbit → Join with an invite → paste this</p><label className="field-label" htmlFor="invite-code">PAIRING INVITATION</label><textarea id="invite-code" className="invite-code" readOnly value={invite.invite || invite.code || ''} rows={4} onFocus={e => e.target.select()} /><button ref={copyButton} className="button primary full" onClick={() => { void copyText(invite.invite || invite.code || '').then(() => notify('Pairing invitation copied.')).catch(e => { setLocalError(friendlyError(e, context)); onError(errorMessage(e)); }); }}><Copy size={16} /> Copy invitation</button><p className="form-footnote"><LockKeyhole size={12} /> This window shows when the other computer joins.</p></> : <><div className="subsection-label">WHAT CAN THE OTHER COMPUTER DO?</div><AccessChoice permissions={permissions} onChange={setPermissions} /><div className="subsection-label">MORE ACCESS (OPTIONAL)</div><PermissionRows permissions={permissions} onChange={setPermissions} only={['clipboard', 'files', 'power']} locked={permissions.control ? undefined : POWER_NEEDS_CONTROL} /><div className="modal-footer"><span><ShieldCheck size={14} /> Individually revocable</span><button className="button primary" disabled={busy || !connected} onClick={() => void create()}>{busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />} Create invite</button></div></> : paired ? <div ref={pairedStep} className="pair-success">
      <div className="invite-success invite-joined"><CheckCheck size={24} aria-hidden="true" /><div><strong>{paired.name} is paired</strong><p>Its owner allowed {grantSummary(paired.permissions)}. Nothing connects until you choose Connect now.</p></div></div>
      {pairedCode && <div className="security-code-card"><div className="subsection-label">SECURITY CODE</div><code>{pairedCode}</code><p>Check that {paired.name} shows the same code under Overview → This computer, or in its invite window. If it is different, don’t connect: forget this computer and pair again.</p></div>}
      <div className="device-modal-actions pair-success-actions"><button type="button" className="button primary" disabled={!paired.address || !onConnect} onClick={() => onConnect?.(paired)}><MonitorUp size={16} aria-hidden="true" /> Connect now</button><button type="button" className="button secondary" onClick={onClose}>Later</button></div>
    </div> : <form onSubmit={e => { e.preventDefault(); void join(); }}><label htmlFor="join-code" className="field-label">PAIRING INVITATION</label><textarea id="join-code" className="join-code" placeholder="Paste your Orbit invitation here…" rows={6} value={joinText} onChange={e => setJoinText(e.target.value)} data-autofocus /><div className="inline-notice subtle-notice"><ShieldCheck size={17} /><span>The invite names the computer it came from and the access its owner chose. Check that you received it directly from that computer’s owner.</span></div><button className="button primary full" type="submit" disabled={busy || !connected || !joinText.trim()}>{busy ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />} Pair this computer</button></form>}
  </Modal>;
}
