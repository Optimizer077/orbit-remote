import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Eye, LoaderCircle, MousePointer2, X } from 'lucide-react';
import './viewed.css';

/** One incoming session: another device is viewing (or controlling) THIS computer. */
export type ViewedSession = { id: string; deviceName?: string; startedAt?: string; controlling?: boolean };

export type ViewedBannerProps = {
  sessions: ViewedSession[];
  onEndOne: (sessionId: string) => void;
  onEndAll: () => void;
  /** True while an end/disconnect request is in flight: disables the buttons. */
  busy?: boolean;
  /** Lab/demo only: start with the device list open (only used when there are 2+ sessions). */
  initialMenuOpen?: boolean;
};

const FALLBACK_NAME = 'A paired device';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function elapsedSeconds(startedAt: string | undefined, now: number): number | null {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  return Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : null;
}

/** Clock style, e.g. 0:42, 4:12, 1:04:12. */
function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Minute resolution for screen readers and tooltips, e.g. "4 minutes". */
function spoken(seconds: number): string {
  if (seconds < 60) return 'less than a minute';
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  return h > 0 ? `${part(h, 'hour')}${m ? ' ' + part(m, 'minute') : ''}` : part(m, 'minute');
}

function nameList(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function Elapsed({ seconds }: { seconds: number | null }) {
  if (seconds === null) return null;
  return <span className="viewed-timer" title={`Connected for ${spoken(seconds)}`}>
    <span className="viewed-live-dot" aria-hidden="true" />
    <span aria-hidden="true">{clock(seconds)}</span>
    <span className="viewed-sr">connected for {spoken(seconds)}</span>
  </span>;
}

export function ViewedBanner({ sessions, onEndOne, onEndAll, busy = false, initialMenuOpen = false }: ViewedBannerProps) {
  const active = sessions.length > 0;
  const now = useNow(active);
  const [menuOpen, setMenuOpen] = useState(initialMenuOpen);
  const menuId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const multiple = sessions.length > 1;

  // The menu only exists with 2+ sessions; close it when that stops being true.
  useEffect(() => { if (!multiple) setMenuOpen(false); }, [multiple]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); toggleRef.current?.focus(); }
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer); };
  }, [menuOpen]);

  if (!active) return null;

  const controller = sessions.find(s => s.controlling);
  const controlling = !!controller;
  const names = sessions.map(s => s.deviceName?.trim() || FALLBACK_NAME);
  const earliest = sessions.reduce<number | null>((max, s) => {
    const e = elapsedSeconds(s.startedAt, now);
    return e === null ? max : Math.max(max ?? 0, e);
  }, null);

  let title: string;
  let detail: string;
  if (!multiple) {
    title = `${names[0]} is ${controlling ? 'controlling this computer' : 'viewing this screen'}`;
    detail = controlling ? 'It can see your screen and use your mouse and keyboard.' : 'It can see your screen. It cannot use your mouse or keyboard.';
  } else {
    title = `${sessions.length} sessions are ${controlling ? 'connected to' : 'viewing'} this ${controlling ? 'computer' : 'screen'}`;
    detail = controlling
      ? `${controller.deviceName?.trim() || FALLBACK_NAME} has control of your mouse and keyboard. Also viewing: ${nameList(sessions.filter(s => s !== controller).map(s => s.deviceName?.trim() || FALLBACK_NAME))}.`
      : `${nameList([...new Set(names)])} can see your screen.`;
  }

  const Icon = controlling ? MousePointer2 : Eye;
  const endIcon = busy ? <LoaderCircle size={15} className="viewed-spin" aria-hidden="true" /> : <X size={15} aria-hidden="true" />;

  return <section ref={rootRef} className={`viewed-banner ${controlling ? 'is-controlling' : 'is-viewing'}`} aria-label="Remote access to this computer" aria-busy={busy || undefined}>
    <span className="viewed-icon" aria-hidden="true"><Icon size={17} strokeWidth={2.2} /></span>
    <div className="viewed-copy">
      <div className="viewed-title-row">
        <span className="viewed-badge">{controlling ? 'Controlling' : 'Viewing'}</span>
        {/* Only the summary sentence is live: it changes when sessions change, not every second. */}
        <strong className="viewed-title" role="status" aria-live="polite" aria-atomic="true">{title}</strong>
        <Elapsed seconds={earliest} />
      </div>
      <p className="viewed-detail">{detail}</p>
    </div>
    <div className="viewed-actions">
      {multiple ? <>
        <button ref={toggleRef} type="button" className="viewed-btn viewed-btn-quiet" aria-expanded={menuOpen} aria-controls={menuId}
          onClick={() => setMenuOpen(open => !open)}>
          Devices <span className="viewed-count">{sessions.length}</span><ChevronDown size={15} className="viewed-chevron" aria-hidden="true" />
        </button>
        <button type="button" className="viewed-btn viewed-btn-end" disabled={busy} title="Disconnect and block the currently connected devices until you allow them again." onClick={onEndAll}>
          {endIcon}{busy ? 'Disconnecting…' : 'Disconnect all'}
        </button>
      </> : <button type="button" className="viewed-btn viewed-btn-end" disabled={busy} title="End and block this device until you allow it again." onClick={() => onEndOne(sessions[0].id)}
        aria-label={`End session with ${names[0]}`}>
        {endIcon}{busy ? 'Ending…' : 'End session'}
      </button>}
    </div>
    {multiple && menuOpen && <div id={menuId} className="viewed-menu" role="group" aria-label="Connected devices">
      <ul>
        {sessions.map((s, index) => {
          const seconds = elapsedSeconds(s.startedAt, now);
          const RowIcon = s.controlling ? MousePointer2 : Eye;
          return <li key={s.id} className={s.controlling ? 'is-controlling' : undefined}>
            <span className="viewed-row-icon" aria-hidden="true"><RowIcon size={15} /></span>
            <span className="viewed-row-copy">
              <span className="viewed-row-name">{names.filter(name => name === names[index]).length > 1 ? names.indexOf(names[index]) === index ? `${names[index]} · ${names.filter(name => name === names[index]).length} sessions` : `Session ${names.slice(0, index + 1).filter(name => name === names[index]).length}` : names[index]}</span>
              <span className="viewed-row-meta">{s.controlling ? 'Controlling' : 'Viewing'}{seconds !== null && <> · <span aria-hidden="true" className="viewed-row-time">{clock(seconds)}</span><span className="viewed-sr">for {spoken(seconds)}</span></>}</span>
            </span>
            <button type="button" className="viewed-btn viewed-btn-end small" disabled={busy} title="End and block this device until you allow it again." onClick={() => onEndOne(s.id)}
              aria-label={`End session with ${names[index]}`}>End</button>
          </li>;
        })}
      </ul>
    </div>}
  </section>;
}
