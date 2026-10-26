import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { Eye, Loader2, LockKeyhole, MousePointer2, Unplug } from 'lucide-react';
import type { Link } from '../api';
import './hud.css';

/* ---------- Measured frame statistics ---------- */

/** Weight of the newest sample in every exponentially weighted moving average (EWMA). */
export const EWMA_ALPHA = 0.3;
/** Gaps between updates longer than this (a reconnect, a paused poll) are not counted as update rate. */
export const STALE_GAP_MS = 10_000;

/**
 * Link-quality thresholds, applied to the EWMA of the time one screen update takes
 * (request sent → image received). Fewer than `minSamples` measurements is "unknown".
 *   Good: avg < 300 ms · Fair: 300–899 ms · Slow: ≥ 900 ms
 */
export const QUALITY_THRESHOLDS = { goodMs: 300, fairMs: 900, minSamples: 3 } as const;

export type FrameStats = {
  /** Duration of the latest update, ms. */
  lastMs?: number;
  /** EWMA of update duration, ms. */
  avgMs?: number;
  /** Updates per second, from the EWMA of wall-clock time between record() calls. Needs 2 samples. */
  fps?: number;
  /** Transfer throughput while fetching (bytes × 8 / ms = kbit/s), EWMA. Only when bytes were recorded. */
  kbps?: number;
  samples: number;
};

export type FrameAccumulator = { avgMs?: number; avgGapMs?: number; kbps?: number; lastAt?: number; lastMs?: number; samples: number };

const ewma = (prev: number | undefined, value: number) => prev === undefined ? value : prev + EWMA_ALPHA * (value - prev);

/** Pure fold of one real measurement into the accumulator. `now` is a monotonic clock in ms. */
export function foldFrameSample(acc: FrameAccumulator, ms: number, bytes: number | undefined, now: number): FrameAccumulator {
  if (!Number.isFinite(ms) || ms < 0) return acc;
  const gap = acc.lastAt === undefined ? undefined : now - acc.lastAt;
  return {
    avgMs: ewma(acc.avgMs, ms),
    avgGapMs: gap !== undefined && gap > 0 && gap < STALE_GAP_MS ? ewma(acc.avgGapMs, gap) : acc.avgGapMs,
    kbps: bytes !== undefined && Number.isFinite(bytes) && bytes >= 0 && ms > 0 ? ewma(acc.kbps, (bytes * 8) / ms) : acc.kbps,
    lastAt: now,
    lastMs: ms,
    samples: acc.samples + 1,
  };
}

export function statsFrom(acc: FrameAccumulator): FrameStats {
  return { lastMs: acc.lastMs, avgMs: acc.avgMs, fps: acc.avgGapMs ? 1000 / acc.avgGapMs : undefined, kbps: acc.kbps, samples: acc.samples };
}

/** Collects real frame timings. Call record(durationMs, bytes?) after each successful frame fetch; reset() on monitor switch or new session. */
export function useFrameStats() {
  const acc = useRef<FrameAccumulator>({ samples: 0 });
  const [stats, setStats] = useState<FrameStats>({ samples: 0 });
  const record = useCallback((ms: number, bytes?: number) => {
    const next = foldFrameSample(acc.current, ms, bytes, performance.now());
    if (next === acc.current) return;
    acc.current = next;
    setStats(statsFrom(next));
  }, []);
  const reset = useCallback(() => { acc.current = { samples: 0 }; setStats({ samples: 0 }); }, []);
  return { record, reset, stats };
}

export type QualityLevel = 'good' | 'fair' | 'slow' | 'unknown';

export function qualityFrom(stats: FrameStats): { level: QualityLevel; label: string } {
  const { goodMs, fairMs, minSamples } = QUALITY_THRESHOLDS;
  if (stats.samples < minSamples || stats.avgMs === undefined) return { level: 'unknown', label: 'Measuring…' };
  if (stats.avgMs < goodMs) return { level: 'good', label: 'Good' };
  if (stats.avgMs < fairMs) return { level: 'fair', label: 'Fair' };
  return { level: 'slow', label: 'Slow' };
}

const fmtMs = (v?: number) => v === undefined ? 'Not measured yet' : `${Math.round(v)} ms`;
const fmtRate = (v?: number) => v === undefined ? 'Not measured yet' : `${v.toFixed(1)} updates/s`;
const fmtKbps = (v?: number) => v === undefined ? 'Not measured' : v >= 1000 ? `${(v / 1000).toFixed(1)} Mbit/s` : `${Math.round(v)} kbit/s`;

/* ---------- HUD ---------- */

export type HudState = 'live' | 'reconnecting' | 'ended';
export const HUD_IDLE_MS = 2500;
/** While controlling, only pointer movement this close to the top edge reveals the toolbar. */
const REVEAL_ZONE_PX = 110;

export type SessionHudProps = {
  title: string;
  link?: Link;
  ended?: boolean;
  state: HudState;
  reconnectAttempt?: number;
  stats: FrameStats;
  controlling: boolean;
  viewOnly: boolean;
  /** Toolbar controls (the existing `.session-toolbar` children). */
  toolbar: ReactNode;
  /** The remote viewer. */
  children: ReactNode;
  /** Keep the toolbar shown (lab, screenshots, tests). */
  forceVisible?: boolean;
  /** Overrides the overlay card's explanation text. */
  detail?: ReactNode;
  /** Optional button(s) inside the reconnecting / ended card. */
  overlayAction?: ReactNode;
  /** Start with the link-quality details expanded. */
  initialDetailsOpen?: boolean;
};

export function SessionHud({ title, link, ended: endedProp, state: stateProp, reconnectAttempt, stats, controlling, viewOnly, toolbar, children, forceVisible = false, detail, overlayAction, initialDetailsOpen = false }: SessionHudProps) {
  const state: HudState = endedProp || stateProp === 'ended' ? 'ended' : stateProp;
  const live = state === 'live';
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [awake, setAwake] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);

  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAwake(false), HUD_IDLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { if (live) wake(); }, [live, wake]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (controlling && root.current && e.clientY - root.current.getBoundingClientRect().top > REVEAL_ZONE_PX) return;
    wake();
  };
  // Only keyboard focus (or an open <select>) pins the toolbar; a mouse click on a button must not keep it up forever.
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'SELECT' || target.matches(':focus-visible')) setFocusWithin(true);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false); };

  const visible = forceVisible || !live || awake || hovered || focusWithin;
  const announcement = state === 'reconnecting' ? `Connection lost. Reconnecting${reconnectAttempt ? `, attempt ${reconnectAttempt}` : ''}. The last image stays visible.` : state === 'ended' ? 'Connection ended.' : '';

  return <div ref={root} className={`hud hud-${state}`} onPointerMove={onPointerMove} onPointerDown={wake}>
    <div className="hud-stage">{children}</div>
    {!live && <div className="hud-veil">
      <div className="hud-card">
        <span className="hud-card-icon" aria-hidden="true">{state === 'reconnecting' ? <Loader2 size={22} className="hud-spin" /> : <Unplug size={22} />}</span>
        <h2>{state === 'reconnecting' ? <>Reconnecting…{reconnectAttempt ? <span className="hud-attempt"> (attempt {reconnectAttempt})</span> : null}</> : 'Connection ended'}</h2>
        <p>{detail ?? (state === 'reconnecting'
          ? 'Showing the last image received. Keyboard and mouse input are paused until the connection returns.'
          : 'This session is over and Orbit will not reconnect to it. Choose Connect to start a new session.')}</p>
        {overlayAction && <div className="hud-card-actions">{overlayAction}</div>}
      </div>
    </div>}
    <div className="hud-handle" data-shown={!visible} aria-hidden="true" />
    <div className="hud-bar" data-visible={visible} role="region" aria-label={`Session controls for ${title}`}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => { setHovered(false); if (live) wake(); }} onFocus={onFocus} onBlur={onBlur}>
      <div className="hud-status">
        {state !== 'ended' && <span className={`hud-state is-${state}`}>
          {state === 'live' ? <i className="hud-live-dot" aria-hidden="true" /> : <Loader2 size={13} className="hud-spin" aria-hidden="true" />}
          {state === 'live' ? 'Live' : 'Reconnecting'}
        </span>}
        <strong className="hud-title" title={title}>{title}</strong>
        <span className="hud-status-fill" />
        {state !== 'ended' && <QualityMeter stats={stats} paused={state !== 'live'} initialOpen={initialDetailsOpen} />}
        <EncryptionChip link={link} ended={state === 'ended'} />
        {state !== 'ended' && <ControlChip controlling={controlling && live} viewOnly={viewOnly} />}
      </div>
      <div className="hud-toolbar">{toolbar}</div>
    </div>
    <span className="hud-sr" aria-live="polite">{announcement}</span>
  </div>;
}

function QualityMeter({ stats, paused, initialOpen }: { stats: FrameStats; paused: boolean; initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  // Esc must hide the tip even while it is hovered or focused; reset when the pointer or focus leaves.
  const [dismissed, setDismissed] = useState(false);
  const tipId = useId();
  const q = paused ? { level: 'unknown' as const, label: 'No updates' } : qualityFrom(stats);
  const bars = { good: 3, fair: 2, slow: 1, unknown: 0 }[q.level];
  const { goodMs, fairMs, minSamples } = QUALITY_THRESHOLDS;
  return <span className="hud-meter-wrap" onPointerLeave={() => setDismissed(false)}>
    <button type="button" className={`hud-meter q-${q.level}`} aria-expanded={open} aria-describedby={tipId} onClick={() => { setDismissed(false); setOpen(o => !o); }} onBlur={() => setDismissed(false)} onKeyDown={e => { if (e.key === 'Escape' && (open || !dismissed)) { e.stopPropagation(); setOpen(false); setDismissed(true); } }}>
      <span className="hud-bars" aria-hidden="true">{[1, 2, 3].map(i => <i key={i} data-on={i <= bars} />)}</span>
      <span className="hud-sr">Link quality: </span>
      <span>{q.label}</span>
    </button>
    <span className="hud-tip" role="tooltip" id={tipId} data-open={open} data-dismissed={dismissed}>
      <span className="hud-tip-title">{paused ? 'No screen updates while reconnecting' : stats.samples < minSamples ? `Measuring: ${stats.samples} of ${minSamples} updates so far` : `Measured from ${stats.samples} screen updates`}</span>
      <span className="hud-tip-row"><span>Last update</span><b>{fmtMs(stats.lastMs)}</b></span>
      <span className="hud-tip-row"><span>Average</span><b>{fmtMs(stats.avgMs)}</b></span>
      <span className="hud-tip-row"><span>Update rate</span><b>{fmtRate(stats.fps)}</b></span>
      <span className="hud-tip-row"><span title="Image bytes divided by the whole request time, including latency. Not a measure of link bandwidth.">Image throughput</span><b>{fmtKbps(stats.kbps)}</b></span>
      <span className="hud-tip-foot">Rated on the average update time<span className="hud-tip-scale">Good &lt; {goodMs} ms · Fair &lt; {fairMs} ms · Slow ≥ {fairMs} ms</span></span>
    </span>
  </span>;
}

function EncryptionChip({ link, ended }: { link?: Link; ended: boolean }) {
  if (ended) return <span className="hud-chip is-ended" title="This connection has ended. Choose Connect to start a new session."><Unplug size={14} aria-hidden="true" />Connection ended</span>;
  const detail = link
    ? `Encrypted end to end: ${link.protocol}, ${link.cipher}, key exchange ${link.keyExchange}${link.forwardSecrecy ? ', forward secrecy' : ''}. Measured on the latest request.`
    : 'Encrypted, paired connection (mutual TLS with the pinned certificate). Details appear after the first screen update.';
  return <span className="hud-chip" title={detail}><LockKeyhole size={14} aria-hidden="true" /><span className="hud-sr">Encryption: </span>{link ? <>{link.protocol}<span className="hud-dot-sep" aria-hidden="true">·</span>{link.cipher}</> : 'Encrypted'}</span>;
}

function ControlChip({ controlling, viewOnly }: { controlling: boolean; viewOnly: boolean }) {
  if (controlling) return <span className="hud-chip is-control"><MousePointer2 size={14} aria-hidden="true" />You have control<span className="hud-dot-sep" aria-hidden="true">·</span><kbd>Esc</kbd>to release</span>;
  return <span className="hud-chip" title={viewOnly ? 'This session can only view the remote screen.' : 'Take control to send keyboard and mouse input.'}><Eye size={14} aria-hidden="true" />{viewOnly ? 'View only' : 'Viewing'}</span>;
}
