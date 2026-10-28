import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Clipboard, CloudMoon, Copy, FileText, Flame, FolderOpen, Laptop, Loader2, LockKeyhole, Monitor, Moon, MousePointer2, Network, Palette, Power, ShieldCheck, SlidersHorizontal, Sun, Zap } from 'lucide-react';
import { api, copyText, errorMessage, securityCode, type HostRuntime, type HostSettings, type HostStatus, type ThemePreference } from '../api';
import { platformLabel } from './DevicesPage';
import './pages.css';

export type SettingsPageProps = {
  status: HostStatus | null;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSaved: () => void;
  onError: (message: string) => void;
  /** Shows a confirmation toast, for example after a copy. */
  notify: (message: string) => void;
  /** Shows an error toast, for example when a copy fails. */
  notifyError: (message: string) => void;
  aboutContent?: ReactNode;
  runtime?: HostRuntime | null;
  onIdentityRotated?: () => void;
};

function displayDate(value?: string | null, timeOnly = false) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? timeOnly ? date.toLocaleTimeString() : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not available';
}

export function HostRecoveryNotice({ runtime, onRetry, onNavigate, checkingTailscale = false }: { runtime: HostRuntime | null; onRetry: () => Promise<void>; onNavigate: () => void; checkingTailscale?: boolean }) {
  const [retrying, setRetrying] = useState(false);
  const supervisor = runtime?.supervisor;
  const identity = runtime?.identity;
  const interrupted = supervisor?.state === 'stopped' || supervisor?.state === 'reconnecting';
  // A restart the owner asked for to look for Tailscale is expected, not a failure.
  const checking = checkingTailscale && supervisor?.state !== 'stopped';
  if (!interrupted && !checking && !identity?.warning) return null;
  return <div className="op-recovery-notices">
    {checking && <section className="op-recovery-notice" aria-label="Checking for Tailscale" role="status"><Network size={20} aria-hidden="true" /><div><strong>Checking for Tailscale…</strong><p>Orbit is restarting its background service on this computer to look for Tailscale. This takes a few seconds.</p></div></section>}
    {interrupted && !checking && <section className="op-recovery-notice" aria-label="Background service recovery" role="status"><Power size={20} aria-hidden="true" /><div><strong>{supervisor.state === 'stopped' ? 'Orbit’s background service has stopped.' : 'Orbit’s background service is restarting.'}</strong><p>{supervisor.reason || 'Remote access is unavailable until the background service returns.'}</p><p>{supervisor.state === 'stopped' ? 'Automatic recovery has paused. Retry when you are ready.' : supervisor.nextRetryAt ? `Automatic retry at ${displayDate(supervisor.nextRetryAt, true)}. ${supervisor.restartsLeft} automatic retries remain.` : 'Waiting for the background service to return.'}</p></div>{supervisor.state === 'stopped' && <button className="button secondary small" disabled={retrying} onClick={async () => { setRetrying(true); try { await onRetry(); } finally { setRetrying(false); } }}>{retrying && <Loader2 size={14} className="spin" />}Retry</button>}</section>}
    {identity?.warning && <section className="op-recovery-notice" aria-label="Identity expiry warning" role="status"><ShieldCheck size={20} aria-hidden="true" /><div><strong>{identity.expired ? 'This computer’s identity has expired.' : `This computer’s identity expires in ${identity.daysRemaining} ${identity.daysRemaining === 1 ? 'day' : 'days'}.`}</strong><p>{identity.expired ? 'Remote access is disabled. Replace the identity locally, then pair your computers again.' : 'Plan to replace the identity before expiry. Every computer will need to pair again.'}</p></div><button className="button secondary small" onClick={onNavigate}>Review identity</button></section>}
  </div>;
}

function HostIdentitySettings({ status, runtime, onRotated, onError }: { status: HostStatus | null; runtime?: HostRuntime | null; onRotated?: () => void; onError: (message: string) => void }) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [rotating, setRotating] = useState(false);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const identity = runtime?.identity || status?.identity;
  const fingerprint = status?.host.fingerprint;
  useEffect(() => { setConfirmation(null); setAcknowledged(false); }, [fingerprint]);
  // The confirmation replaces the Replace button: start on its safe choice, and return when it closes.
  useEffect(() => {
    const open = confirmation !== null;
    if (open && !wasConfirming.current) cancelButton.current?.focus();
    else if (!open && wasConfirming.current && (!document.activeElement || document.activeElement === document.body)) replaceButton.current?.focus();
    wasConfirming.current = open;
  }, [confirmation]);
  const rotate = async () => {
    if (!confirmation || !acknowledged) return;
    setRotating(true);
    try {
      const result = await api.rotateIdentity(confirmation);
      setConfirmation(null); setAcknowledged(false);
      if (result.requiresRePair) onRotated?.();
    } catch (error) { onError(errorMessage(error)); }
    finally { setRotating(false); }
  };
  return <section className="op-settings-card op-identity-settings" aria-labelledby="identity-settings-heading"><div className="op-settings-card-title"><span className="op-title-symbol"><ShieldCheck size={20} /></span><div><h2 id="identity-settings-heading">This computer’s identity</h2><p>Your paired computers use it to recognise this one.</p></div></div><dl className="op-settings-details"><div><dt>Valid until</dt><dd>{displayDate(identity?.expiresAt)}</dd></div><div><dt>Status</dt><dd>{identity ? identity.expired ? 'Expired — replace it on this computer' : identity.warning ? 'Needs replacing soon' : 'Up to date' : 'Not available'}</dd></div></dl><p className="op-setting-note">Replacing it disconnects everyone, cancels open invites and removes every pairing, in both directions. You will need to pair each computer again. Orbit never does this on its own.</p><details className="op-settings-disclosure"><summary>Technical details</summary><p>The identity is the TLS certificate this computer presents. Each paired computer pins it and checks it on every connection; the security code is made from its fingerprint.</p></details>{confirmation ? <div className="op-identity-confirmation" role="group" aria-label="Confirm identity replacement"><strong>You will need to pair each computer again.</strong><p>Continue only when you can set up each trusted computer again. The system confirmation lets you cancel before anything changes.</p><label><input type="checkbox" checked={acknowledged} disabled={rotating} onChange={event => setAcknowledged(event.target.checked)} />I understand that I will need to pair each computer again.</label><div className="op-identity-actions"><button ref={cancelButton} className="button secondary small" disabled={rotating} onClick={() => { setConfirmation(null); setAcknowledged(false); }}>Cancel replacement</button><button className="button danger small" disabled={!acknowledged || rotating} onClick={() => void rotate()}>{rotating && <Loader2 size={14} className="spin" />}Continue to system confirmation</button></div></div> : <button ref={replaceButton} className="button secondary small" disabled={!fingerprint} onClick={() => { setConfirmation(fingerprint || null); setAcknowledged(false); }}>Replace identity…</button>}</section>;
}

function SettingSwitch({ checked, label, disabled, describedBy, onChange }: { checked: boolean; label: string; disabled?: boolean; describedBy?: string; onChange: (value: boolean) => void }) {
  return <button type="button" className={`op-switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedBy} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function AppearanceSettings({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const options = [
    { id: 'daylight' as const, label: 'Daylight', description: 'Bright and crisp', icon: Sun },
    { id: 'graphite' as const, label: 'Graphite', description: 'Deep navy, vivid teal', icon: Moon },
    { id: 'midnight' as const, label: 'Midnight', description: 'Room for blue', icon: CloudMoon },
    { id: 'paper' as const, label: 'Paper', description: 'Warm and focused', icon: FileText },
    { id: 'ember' as const, label: 'Ember', description: 'Dark, with a warm glow', icon: Flame },
  ];
  return <section className="op-settings-card op-appearance" aria-labelledby="op-appearance-heading"><div className="op-settings-card-title"><span className="op-title-symbol"><Palette size={20} /></span><div><h2 id="op-appearance-heading">Make yourself comfortable</h2><p>A different atmosphere. The same private orbit.</p></div></div><div className="op-theme-options" role="group" aria-label="Appearance theme">{options.map(({ id, label, description, icon: Icon }) => <button key={id} className={`op-theme-option ${theme === id ? 'selected' : ''}`} aria-label={`Use ${label} theme`} aria-pressed={theme === id} onClick={() => onChange(id)}><div className={`op-theme-art op-theme-${id}`} aria-hidden="true"><span className="op-theme-art-sidebar"><i /><i /><i /></span><span className="op-theme-art-main"><Icon size={22} /><b /><span><i /><i /></span></span>{theme === id && <span className="op-theme-check"><Check size={13} /></span>}</div><strong>{label}<span className="op-radio">{theme === id && <i />}</span></strong><p>{description}</p></button>)}</div><div className="op-setting-row op-system-setting"><span className="op-setting-icon"><Monitor size={19} /></span><div><strong>Follow your system</strong><p id="follow-system-detail">Daylight in light mode. Graphite in dark mode.</p></div><SettingSwitch label="Follow system appearance" describedBy="follow-system-detail" checked={theme === 'system'} onChange={value => onChange(value ? 'system' : 'daylight')} /></div><p className="op-setting-note">Appearance applies immediately on this computer.</p></section>;
}

function availabilityNotes(status: HostStatus | null) {
  return [...new Set((status?.limitations || []).flatMap(note => {
    if (/locked screens|lock screens|logged-in interactive/i.test(note)) return /remote locking/i.test(note) ? ['Remote screen locking is not available on this computer.'] : [];
    if (/integrity isolation/i.test(note)) return ['Some administrator apps and protected permission prompts cannot be controlled remotely.'];
    if (/PNG snapshot/i.test(note)) return ['This preview shares screen images. Audio and smooth video streaming are still in development.'];
    if (/Screen Recording permission/i.test(note)) return ['On macOS, allow Screen Recording and Accessibility in System Settings.'];
    if (/macOS backend.*validation/i.test(note)) return ['macOS support still needs testing on a physical Mac.'];
    if (/Only local X11/i.test(note)) return ['Linux access currently requires X11. Wayland is not supported yet.'];
    if (/Linux backend.*validation/i.test(note)) return ['Linux support still needs testing on a physical desktop.'];
    return [note.replace(/backend/gi, 'support')];
  }))];
}

export function UnattendedAvailability({ status }: { status: HostStatus | null }) {
  const notes = availabilityNotes(status);
  const unlocked = status?.sessionState === 'interactive';
  return <section className="op-settings-card op-availability"><div className="op-settings-card-title"><span className="op-title-symbol"><LockKeyhole size={20} /></span><div><h2>Reachable while you’re away</h2><p>Whether someone can connect when nobody is at this computer.</p></div></div><span className="op-availability-label"><i className={`op-status-dot ${unlocked ? 'online' : ''}`} />{unlocked ? 'Signed in and unlocked' : status?.sessionState && /locked|secure/.test(status.sessionState) ? 'Desktop is locked or protected' : 'Desktop availability not confirmed'}</span><p className="op-availability-summary">This preview needs an unlocked, signed-in desktop. Locked-screen access and recovery before sign-in are not available yet.</p>{notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>}</section>;
}

type SavedKey = 'hostName' | 'allowFiles' | 'allowPower' | 'startAtLogin';
type SettingsRecord = Record<string, unknown>;

const DEFAULT_SETTINGS: HostSettings = { hostName: '', allowControl: false, allowClipboard: false, allowFiles: false, allowPower: false, startAtLogin: false };

/** Settings edited on this page that differ from the last values the host confirmed. */
function unsavedKeys(settings: HostSettings, saved: HostSettings): SavedKey[] {
  const keys: SavedKey[] = ['hostName', 'allowFiles', 'allowPower', ...(saved.startAtLoginSupported ? ['startAtLogin' as const] : [])];
  return keys.filter(key => key === 'hostName' ? settings.hostName !== saved.hostName : Boolean(settings[key]) !== Boolean(saved[key]));
}

function sameSettings(a: HostSettings, b: HostSettings) {
  const left = a as SettingsRecord, right = b as SettingsRecord;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => Object.is(left[key], right[key]));
}

/** Takes the host's new values, except for fields edited here since `previous` (the values they were edited from). */
function adoptHostSettings(local: HostSettings, previous: HostSettings, next: HostSettings): HostSettings {
  const current = local as SettingsRecord, before = previous as SettingsRecord, merged: SettingsRecord = { ...current };
  for (const [key, value] of Object.entries(next as SettingsRecord)) if (Object.is(current[key], before[key])) merged[key] = value;
  return merged as HostSettings;
}

export function SettingsPage({ status, runtime, theme, onThemeChange, onSaved, onIdentityRotated, onError, notify, notifyError, aboutContent }: SettingsPageProps) {
  // `baseline` is the last settings the host confirmed (status or the save reply); `settings` holds local edits on top.
  const [baseline, setBaseline] = useState<HostSettings>(() => status?.settings ?? DEFAULT_SETTINGS);
  const [settings, setSettings] = useState<HostSettings>(() => status?.settings ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');
  const baselineRef = useRef(baseline);
  const hostId = useRef(status?.host.id);
  const savingRef = useRef(false);
  const saveBar = useRef<HTMLDivElement>(null);
  const confirm = useCallback((next: HostSettings, editedFrom: HostSettings) => {
    baselineRef.current = next; setBaseline(next);
    setSettings(local => adoptHostSettings(local, editedFrom, next));
  }, []);
  useEffect(() => {
    if (!status?.settings) return;
    if (hostId.current !== status.host.id) { hostId.current = status.host.id; baselineRef.current = status.settings; setBaseline(status.settings); setSettings(status.settings); return; }
    // A status refresh never overwrites a field the owner is editing.
    if (!sameSettings(baselineRef.current, status.settings)) confirm(status.settings, baselineRef.current);
  }, [status?.host.id, status?.settings, confirm]);
  const dirty = Boolean(status) && unsavedKeys(settings, baseline).length > 0;
  const nameMissing = !settings.hostName.trim();
  // Save is disabled while saving and once saved, and Discard disappears: keep keyboard focus on the bar.
  const keepFocusOnBar = () => { if (saveBar.current?.contains(document.activeElement)) saveBar.current.focus({ preventScroll: true }); };
  const save = async () => {
    if (savingRef.current) return;
    keepFocusOnBar();
    savingRef.current = true; setSaving(true); setLocalError('');
    const sent = settings;
    try {
      const { startAtLogin, ...policy } = sent;
      const reply = await api.updateSettings(status?.settings.startAtLoginSupported ? sent : policy) as Partial<HostStatus> | undefined;
      // The controller answers with the new status; an older reply without settings means the host took what was sent.
      confirm(reply?.settings ?? { ...baselineRef.current, ...sent }, sent);
      onSaved();
    }
    catch (error) { const message = errorMessage(error); setLocalError(message); onError(message); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const discard = () => { keepFocusOnBar(); setSettings(baselineRef.current); setLocalError(''); };
  // While edits are unsaved the bar is sticky: keep focused controls clear of it, and keep toasts above it on this page.
  useEffect(() => {
    const element = saveBar.current, root = document.documentElement;
    if (!element) return;
    const apply = () => {
      const height = Math.ceil(element.getBoundingClientRect().height);
      // Toasts sit 25px from the bottom; the bar is 16px from it when sticky and about 52px at the end of the page.
      root.style.setProperty('--op-save-bar-space', `${height + 40}px`);
      root.style.scrollPaddingBottom = dirty ? `${height + 24}px` : '';
    };
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    return () => { observer?.disconnect(); root.style.removeProperty('--op-save-bar-space'); root.style.scrollPaddingBottom = ''; };
  }, [dirty]);
  const code = securityCode(status?.host.fingerprint);
  const copyCode = async () => { try { await copyText(code); notify('Security code copied.'); } catch (error) { notifyError(errorMessage(error)); } };
  const capabilities = [
    { key: 'allowControl' as const, capability: 'input', icon: MousePointer2, title: 'Remote mouse & keyboard', detail: 'Allowed only for computers you invite with See and control. The other person must also choose Take control.', perPairing: true, on: '', off: '' },
    { key: 'allowClipboard' as const, capability: 'clipboard', icon: Clipboard, title: 'Clipboard sharing', detail: 'Off by default. Turn it on in an invite only for computers you trust.', perPairing: true, on: '', off: '' },
    { key: 'allowFiles' as const, capability: 'files', icon: FolderOpen, title: 'File transfer', detail: 'Files are sent and received only through the shared folder.', perPairing: false,
      on: 'On: computers whose invite allows File transfer can send and receive files.', off: 'Off: no computer can send or receive files.' },
    { key: 'allowPower' as const, capability: 'power', icon: Power, title: 'Lock & restart', detail: 'Only for computers invited with See and control and Lock & restart.', perPairing: false,
      on: 'On: those computers can lock or restart this one.', off: 'Off: no computer can lock or restart this one.' },
  ];
  return <section className="op-page op-settings-page" aria-labelledby="settings-page-title"><header className="op-page-heading"><div><span className="op-eyebrow">MAKE ORBIT YOUR OWN</span><h1 id="settings-page-title">Your computer. Your rules.</h1><p>Set the atmosphere. Keep access deliberate.</p></div></header>
    {localError && <div className="op-inline-error" role="alert">{localError}</div>}
    <div className="op-settings-layout"><div className="op-settings-main"><AppearanceSettings theme={theme} onChange={onThemeChange} />
      <section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><Laptop size={20} /></span><div><h2>This computer</h2><p>How this computer appears to the computers you pair with.</p></div></div><label className="op-field-label" htmlFor="host-name">COMPUTER NAME</label><input className="op-text-input" id="host-name" maxLength={80} disabled={!status} value={settings.hostName} placeholder="Name your computer" aria-invalid={nameMissing && status ? true : undefined} aria-describedby={nameMissing && status ? 'host-name-required' : undefined} onChange={event => setSettings(current => ({ ...current, hostName: event.target.value }))} />{nameMissing && status && <p className="op-field-error" id="host-name-required">Give this computer a name to save your changes.</p>}<dl className="op-settings-details"><div><dt>Operating system</dt><dd>{status ? platformLabel(status.host.platform) : 'Waiting for Orbit'}</dd></div><div><dt>Orbit version</dt><dd>{status?.host.version || 'Not available'}</dd></div></dl>{code && <div className="op-host-code"><span><ShieldCheck size={16} />This computer’s security code</span><code>{code}</code><button className="op-text-button" onClick={() => void copyCode()}><Copy size={14} />Copy security code</button><p>Compare this with the code shown for this computer on your other computer.</p></div>}</section>
      <section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><SlidersHorizontal size={20} /></span><div><h2>Remote access</h2><p>An action works only when it is on here and also allowed in that computer’s invite.</p></div></div>{capabilities.map(({ key, capability, icon: Icon, title, detail, perPairing, on, off }) => { const unavailable = Boolean(status && !status.capabilities[capability]); const stateId = `setting-state-${key}`; return <div className="op-setting-row" key={key}><span className="op-setting-icon"><Icon size={19} /></span><div><strong>{title}</strong><p>{detail}</p>{unavailable ? <span className="op-capability-note" id={perPairing ? undefined : stateId}>Not available on this computer</span> : !perPairing && <span className="op-setting-state" id={stateId}>{settings[key] ? on : off}</span>}</div>{perPairing ? <span className="op-pairing-tag">Set in each invite</span> : <SettingSwitch label={title} describedBy={stateId} checked={Boolean(settings[key])} disabled={!status || unavailable} onChange={value => setSettings(current => ({ ...current, [key]: value }))} />}</div>; })}</section>
      <section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><Zap size={20} /></span><div><h2>Stay within reach</h2><p>Ready after you sign in.</p></div></div><div className="op-setting-row"><span className="op-setting-icon"><Power size={19} /></span><div><strong>Start Orbit at sign-in</strong><p>Opens Orbit automatically when you sign in to this computer. Someone still has to sign in first.</p>{status?.settings.startAtLoginSupported ? <span className="op-setting-state" id="setting-state-startAtLogin">{settings.startAtLogin ? 'On: Orbit opens when you sign in.' : 'Off: open Orbit yourself after you sign in.'}</span> : <span className="op-capability-note" id="setting-state-startAtLogin">Available in the installed Windows and macOS app.</span>}</div><SettingSwitch label="Start Orbit at sign-in" describedBy="setting-state-startAtLogin" checked={Boolean(settings.startAtLogin)} disabled={!status?.settings.startAtLoginSupported} onChange={value => setSettings(current => ({ ...current, startAtLogin: value }))} /></div></section>
      <HostIdentitySettings status={status} runtime={runtime} onRotated={onIdentityRotated} onError={onError} />
      {aboutContent && <div className="op-about-content">{aboutContent}</div>}
    </div><aside className="op-settings-aside"><section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><Network size={20} /></span><div><h2>Network health</h2><p>Checked by this computer</p></div></div><span className={`op-network-label ${status?.host.tailscale.connected ? 'ready' : ''}`}><i className={`op-status-dot ${status?.host.tailscale.connected ? 'online' : ''}`} />{status?.host.testMode ? 'Local test mode' : status?.host.tailscale.connected ? 'Tailscale connected' : 'Connection needed'}</span><dl className="op-network-details"><div><dt>Tailscale</dt><dd>{status ? status.host.tailscale.available ? 'Detected' : 'Not detected' : 'Checking'}</dd></div></dl><details className="op-settings-disclosure"><summary>Network details</summary><dl className="op-network-details"><div><dt>Tailscale address</dt><dd>{status?.host.tailscale.ip || 'Not available'}</dd></div><div><dt>Tailscale name</dt><dd>{status?.host.tailscale.dnsName || 'Not available'}</dd></div><div><dt>Orbit port</dt><dd>{settings.listenPort || 'Not available'}</dd></div></dl></details>{status?.host.tailscale.error && <p className="op-inline-error">{status.host.tailscale.error}</p>}</section><UnattendedAvailability status={status} /><div className="op-trust-explainer"><ShieldCheck size={25} /><h2>Two layers of trust.</h2><p>Tailscale provides your private route. Orbit pairing decides which computers can connect and what each may do.</p><p>In Tailscale, share your network only with people and devices you trust.</p></div></aside></div>
    <div ref={saveBar} className={`op-save-bar ${dirty ? 'is-dirty' : ''}`} role="region" aria-label="Save settings" tabIndex={-1}><p role="status">{dirty ? nameMissing ? 'Give this computer a name to save your changes.' : 'You have unsaved changes.' : 'All changes are saved.'}</p>{dirty && <button className="button secondary" disabled={saving} onClick={discard}>Discard changes</button>}<button className="button primary" disabled={saving || !status || nameMissing || !dirty} aria-busy={saving || undefined} onClick={() => void save()}>{saving ? <Loader2 size={16} className="spin" /> : <Check size={17} />}Save changes</button></div>
  </section>;
}

export default SettingsPage;
