import { useEffect, useState, type ReactNode } from 'react';
import { Check, Clipboard, CloudMoon, Copy, FileText, FolderOpen, Laptop, Loader2, LockKeyhole, Monitor, Moon, MousePointer2, Network, Palette, Power, ShieldCheck, SlidersHorizontal, Sun, Zap } from 'lucide-react';
import { api, errorMessage, invoke, securityCode, type HostSettings, type HostStatus, type ThemePreference } from '../api';
import { platformLabel } from './DevicesPage';
import './pages.css';

export type SettingsPageProps = {
  status: HostStatus | null;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onSaved: () => void;
  onError: (message: string) => void;
  aboutContent?: ReactNode;
};

function SettingSwitch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" className={`op-switch ${checked ? 'on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function AppearanceSettings({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const options = [
    { id: 'daylight' as const, label: 'Daylight', description: 'Bright and crisp', icon: Sun },
    { id: 'graphite' as const, label: 'Graphite', description: 'A quieter dark', icon: Moon },
    { id: 'midnight' as const, label: 'Midnight', description: 'Room for blue', icon: CloudMoon },
    { id: 'paper' as const, label: 'Paper', description: 'Warm and focused', icon: FileText },
  ];
  return <section className="op-settings-card op-appearance" aria-labelledby="op-appearance-heading"><div className="op-settings-card-title"><span className="op-title-symbol"><Palette size={20} /></span><div><h2 id="op-appearance-heading">Make yourself comfortable</h2><p>A different atmosphere. The same private orbit.</p></div></div><div className="op-theme-options" role="group" aria-label="Appearance theme">{options.map(({ id, label, description, icon: Icon }) => <button key={id} className={`op-theme-option ${theme === id ? 'selected' : ''}`} aria-label={`Use ${label} theme`} aria-pressed={theme === id} onClick={() => onChange(id)}><div className={`op-theme-art op-theme-${id}`} aria-hidden="true"><span className="op-theme-art-sidebar"><i /><i /><i /></span><span className="op-theme-art-main"><Icon size={22} /><b /><span><i /><i /></span></span>{theme === id && <span className="op-theme-check"><Check size={13} /></span>}</div><strong>{label}<span className="op-radio">{theme === id && <i />}</span></strong><p>{description}</p></button>)}</div><div className="op-setting-row op-system-setting"><Monitor size={19} /><div><strong>Follow your system</strong><p>Daylight in light mode. Graphite in dark mode.</p></div><SettingSwitch label="Follow system appearance" checked={theme === 'system'} onChange={value => onChange(value ? 'system' : 'daylight')} /></div><p className="op-setting-note">Appearance applies immediately on this computer.</p></section>;
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
  return <section className="op-settings-card op-availability"><div className="op-settings-card-title"><span className="op-title-symbol"><LockKeyhole size={20} /></span><div><h2>Unattended availability</h2><p>Know when this host is within reach.</p></div></div><span className="op-availability-label"><i className={`op-status-dot ${unlocked ? 'online' : ''}`} />{unlocked ? 'Signed in and unlocked' : status?.sessionState && /locked|secure/.test(status.sessionState) ? 'Desktop is locked or protected' : 'Desktop availability not confirmed'}</span><p className="op-availability-summary">This preview needs an unlocked, signed-in desktop. Locked-screen access and recovery before sign-in are not available yet.</p>{notes.length > 0 && <ul>{notes.map(note => <li key={note}>{note}</li>)}</ul>}</section>;
}

export function SettingsPage({ status, theme, onThemeChange, onSaved, onError, aboutContent }: SettingsPageProps) {
  const [settings, setSettings] = useState<HostSettings>({ hostName: '', allowControl: false, allowClipboard: false, allowFiles: false, allowPower: false, startAtLogin: false });
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');
  useEffect(() => { if (status?.settings) setSettings(status.settings); }, [status?.host.id]);
  const save = async () => {
    setSaving(true); setLocalError('');
    try { const { startAtLogin, ...policy } = settings; await api.updateSettings(status?.settings.startAtLoginSupported ? settings : policy); onSaved(); }
    catch (error) { const message = errorMessage(error); setLocalError(message); onError(message); }
    finally { setSaving(false); }
  };
  const code = securityCode(status?.host.fingerprint);
  const copyCode = async () => { try { await invoke('clipboard.local.write', { text: code }); } catch (error) { onError(errorMessage(error)); } };
  const capabilities = [
    { key: 'allowControl' as const, capability: 'input', icon: MousePointer2, title: 'Remote mouse & keyboard', detail: 'Choose input access for each pairing. The viewer must also choose Take control.', perPairing: true },
    { key: 'allowClipboard' as const, capability: 'clipboard', icon: Clipboard, title: 'Clipboard sharing', detail: 'Off by default. Grant clipboard access only to pairings you trust.', perPairing: true },
    { key: 'allowFiles' as const, capability: 'files', icon: FolderOpen, title: 'File transfer', detail: 'Confine transfers to the dedicated shared folder you select on this computer.', perPairing: false },
    { key: 'allowPower' as const, capability: 'power', icon: Power, title: 'Lock & restart', detail: 'Allow host power requests only when the pairing also grants power and control.', perPairing: false },
  ];
  return <section className="op-page op-settings-page" aria-labelledby="settings-page-title"><header className="op-page-heading"><div><span className="op-eyebrow">MAKE ORBIT YOUR OWN</span><h1 id="settings-page-title">Your computer. Your rules.</h1><p>Set the atmosphere. Keep access deliberate.</p></div><button className="button primary" disabled={saving || !status || !settings.hostName.trim()} onClick={() => void save()}>{saving ? <Loader2 size={16} className="spin" /> : <Check size={17} />}Save changes</button></header>
    {localError && <div className="op-inline-error" role="alert">{localError}</div>}
    <div className="op-settings-layout"><div className="op-settings-main"><AppearanceSettings theme={theme} onChange={onThemeChange} />
      <section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><Laptop size={20} /></span><div><h2>This host</h2><p>How this computer appears in your private network.</p></div></div><label className="op-field-label" htmlFor="host-name">COMPUTER NAME</label><input className="op-text-input" id="host-name" maxLength={80} disabled={!status} value={settings.hostName} placeholder="Name your computer" onChange={event => setSettings(current => ({ ...current, hostName: event.target.value }))} /><dl className="op-settings-details"><div><dt>Operating system</dt><dd>{status ? platformLabel(status.host.platform) : 'Waiting for host'}</dd></div><div><dt>Service version</dt><dd>{status?.host.version || 'Not available'}</dd></div></dl>{code && <div className="op-host-code"><span><ShieldCheck size={16} />This computer’s security code</span><code>{code}</code><button className="op-text-button" onClick={() => void copyCode()}><Copy size={14} />Copy security code</button><p>Compare this with the code shown for this computer on your other device.</p></div>}</section>
      <section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><SlidersHorizontal size={20} /></span><div><h2>Remote access</h2><p>Host policy and pairing permissions must both allow an action.</p></div></div>{capabilities.map(({ key, capability, icon: Icon, title, detail, perPairing }) => <div className="op-setting-row" key={key}><span className="op-setting-icon"><Icon size={19} /></span><div><strong>{title}</strong><p>{detail}</p>{status && !status.capabilities[capability] && <span className="op-capability-note">Unavailable on this host</span>}</div>{perPairing ? <span className="op-pairing-tag">Per pairing</span> : <SettingSwitch label={title} checked={Boolean(settings[key])} disabled={!status || !status.capabilities[capability]} onChange={value => setSettings(current => ({ ...current, [key]: value }))} />}</div>)}</section>
      <section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><Zap size={20} /></span><div><h2>Stay within reach</h2><p>Ready after you sign in.</p></div></div><div className="op-setting-row"><span className="op-setting-icon"><Power size={19} /></span><div><strong>Start Orbit at sign-in</strong><p>Launch automatically when you sign in to this computer.</p><span className="op-capability-note">Available in supported installed desktop builds. This does not provide pre-login access.</span></div><SettingSwitch label="Start Orbit at sign-in" checked={Boolean(settings.startAtLogin)} disabled={!status?.settings.startAtLoginSupported} onChange={value => setSettings(current => ({ ...current, startAtLogin: value }))} /></div></section>
      {aboutContent && <div className="op-about-content">{aboutContent}</div>}
    </div><aside className="op-settings-aside"><section className="op-settings-card"><div className="op-settings-card-title"><span className="op-title-symbol"><Network size={20} /></span><div><h2>Network health</h2><p>Reported by this host</p></div></div><span className={`op-network-label ${status?.host.tailscale.connected ? 'ready' : ''}`}><i className={`op-status-dot ${status?.host.tailscale.connected ? 'online' : ''}`} />{status?.host.testMode ? 'Local test mode' : status?.host.tailscale.connected ? 'Tailscale connected' : 'Connection needed'}</span><dl className="op-network-details"><div><dt>Tailscale</dt><dd>{status ? status.host.tailscale.available ? 'Detected' : 'Not detected' : 'Checking'}</dd></div><div><dt>Private address</dt><dd>{status?.host.tailscale.ip || 'Not available'}</dd></div><div><dt>DNS name</dt><dd>{status?.host.tailscale.dnsName || 'Not available'}</dd></div><div><dt>Host port</dt><dd>{settings.listenPort || 'Not available'}</dd></div></dl>{status?.host.tailscale.error && <p className="op-inline-error">{status.host.tailscale.error}</p>}</section><UnattendedAvailability status={status} /><div className="op-trust-explainer"><ShieldCheck size={25} /><h2>Two layers of trust.</h2><p>Tailscale provides your private route. Orbit pairing decides which devices can connect and what each may do.</p><p>Keep your tailnet policy limited to the people and devices you trust.</p></div></aside></div>
  </section>;
}

export default SettingsPage;
