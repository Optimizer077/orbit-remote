import { useEffect, useRef, useState } from 'react';
import { Clipboard, FolderOpen, Loader2, Monitor, MousePointer2, Power, ShieldCheck, Unplug } from 'lucide-react';
import { api, errorMessage, invoke, securityCode, type Device, type Permissions } from '../api';
import { Modal } from './Modal';
import { platformLabel } from './DevicesPage';
import './pages.css';

export type DeviceDetailsDialogProps = {
  device: Device;
  onAllow: () => Promise<void>;
  allowing: boolean;
  onClose: () => void;
  onConnect: (viewOnly: boolean) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  notify: (message: string) => void;
};

const ACCESS: { key: keyof Permissions; icon: typeof Monitor; title: string }[] = [
  { key: 'view', icon: Monitor, title: 'View screen' },
  { key: 'control', icon: MousePointer2, title: 'Mouse & keyboard' },
  { key: 'clipboard', icon: Clipboard, title: 'Clipboard' },
  { key: 'files', icon: FolderOpen, title: 'File transfer' },
  { key: 'power', icon: Power, title: 'Lock & restart' },
];

function pairedDate(value?: string) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not available';
}

/** Details, security code and access for one paired direction ("Manage <device>"). */
export function DeviceDetailsDialog({ device, onClose, onConnect, onChanged, onError, notify, onAllow, allowing }: DeviceDetailsDialogProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancelButton = useRef<HTMLButtonElement>(null);
  const removing = useRef(false);
  const startButton = useRef<HTMLButtonElement>(null);
  const incoming = device.direction === 'incoming';
  const revoked = device.revoked === true || device.status === 'revoked';
  const ownerBlocked = incoming && device.blockedByOwner === true && !revoked;
  const code = securityCode(device.fingerprint || device.serverFingerprint);
  const direction = revoked ? 'Access removed' : incoming ? ownerBlocked ? 'Access paused by you' : 'Can see this computer' : 'You can see it';
  // An unknown platform adds nothing, so the subtitle is the direction alone.
  const subtitle = !device.platform || device.platform === 'unknown' ? direction : `${platformLabel(device.platform)} · ${direction}`;
  // A destructive confirmation starts on its safe choice; cancelling returns focus to the button that opened it.
  const [returnFocus, setReturnFocus] = useState(false);
  useEffect(() => { if (confirming) cancelButton.current?.focus(); else if (returnFocus) { startButton.current?.focus(); setReturnFocus(false); } }, [confirming, returnFocus]);
  const remove = async () => {
    // One request per confirmation, even for a double click.
    if (removing.current) return;
    removing.current = true; setBusy(true); setError('');
    try {
      if (incoming) await api.revoke(device.id); else await invoke('device.forget', { deviceId: device.id });
      notify(incoming ? `Access removed. ${device.name} can no longer connect to this computer.` : `${device.name} was removed from this computer.`);
      onChanged();
    } catch (reason) { setError(errorMessage(reason)); onError(errorMessage(reason)); }
    finally { removing.current = false; setBusy(false); }
  };
  return <Modal title={device.name} subtitle={subtitle} onClose={onClose}>
    {error && <div className="inline-error" role="alert">{error}</div>}
    {incoming ? <div className="inline-notice subtle-notice"><ShieldCheck size={17} aria-hidden="true" /><span>{ownerBlocked ? '' : `${device.name} can see this computer. `}To see {device.name} from here, create an invite on it and join it here.</span></div>
      : <div className="device-modal-actions"><button className="button primary" disabled={!device.address || revoked} onClick={() => onConnect(false)}><MousePointer2 size={16} /> Connect</button><button className="button secondary" disabled={!device.address || revoked} onClick={() => onConnect(true)}><Monitor size={16} /> View only</button></div>}
    {ownerBlocked && <div className="inline-notice owner-block-notice"><ShieldCheck size={17} aria-hidden="true" /><span>Disconnected by you. Existing permissions are kept; this device needs your approval before it can connect again.</span><button className="button secondary small" aria-label={`Allow ${device.name} again`} aria-busy={allowing || undefined} disabled={allowing || busy} onClick={async () => { setError(''); try { await onAllow(); } catch (reason) { setError(errorMessage(reason)); } }}>{allowing ? 'Allowing...' : 'Allow again'}</button></div>}
    {code && <div className="security-code-card"><div className="subsection-label">SECURITY CODE</div><code>{code}</code><p>On {device.name}, open Overview → This computer. Its security code must match this one exactly. {incoming ? 'If it differs, remove its access: it is not the computer you meant to pair.' : 'If it differs, don’t connect: forget this computer and pair again.'}</p></div>}
    <div className="subsection-label op-caps" id="device-access-heading">{incoming ? 'What it can do on this computer' : 'What you can do on it'}</div>
    <ul className="op-access-list" aria-labelledby="device-access-heading">{ACCESS.map(({ key, icon: Icon, title }) => { const allowed = device.permissions?.[key] === true; return <li key={key} className={allowed ? 'is-allowed' : ''} data-permission={key}><Icon size={18} aria-hidden="true" /><strong>{title}</strong><span>{allowed ? 'Allowed' : 'Not allowed'}</span></li>; })}</ul>
    <p className="form-footnote">{incoming ? 'To change what it can do, remove its access, then send it a new invite with the access you want.' : `${device.name}’s owner chose this access. Only they can change it.`}</p>
    <details className="op-dialog-details"><summary>Connection details</summary><dl>
      {!incoming && <div><dt>Address</dt><dd>{device.address || 'Not available'}</dd></div>}
      <div><dt>Paired on</dt><dd>{pairedDate(device.pairedAt)}</dd></div>
      <div><dt>Device ID</dt><dd>{device.id}</dd></div>
    </dl></details>
    <div className="danger-zone">{confirming ? <><div><strong>{incoming ? `Remove access for ${device.name}?` : `Forget ${device.name}?`}</strong><p>{incoming ? 'It is disconnected now and cannot connect again. To let it back in, you will need to send it a new invite.' : `It disappears from this computer. If you are connected to it, that connection ends. Access on ${device.name} does not change. To see it again, you will need a new invite from it.`}</p></div><div className="heading-actions"><button ref={cancelButton} className="button secondary small" disabled={busy} onClick={() => { setConfirming(false); setReturnFocus(true); }}>Cancel</button><button className="button danger small" disabled={busy || allowing} onClick={() => void remove()}>{busy ? <Loader2 size={14} className="spin" /> : <Unplug size={14} />} {incoming ? 'Remove access' : 'Forget connection'}</button></div></>
      : <><div><strong>{incoming ? 'Remove access' : 'Forget this computer'}</strong><p>{incoming ? `${device.name} will no longer be able to see or control this computer.` : `Removes ${device.name} from this computer. You will need a new invite to see it again.`}</p></div><button ref={startButton} className="button danger-text small" onClick={() => setConfirming(true)}><Unplug size={14} /> {incoming ? 'Remove access…' : 'Forget…'}</button></>}</div>
  </Modal>;
}
