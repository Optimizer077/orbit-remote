import { useCallback, useEffect, useId, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from 'react';
import { Eye, Loader2, LockKeyhole, MonitorOff, MousePointer2, Pause, Unplug } from 'lucide-react';
import type { Link } from '../api';
import { PresentationWindow, videoQuality, type ViewerLatency } from '../stream/presentation-stats';
import type { DecodeMode } from '../stream/types';
import './hud.css';

export { videoQuality };

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
  mode?: 'video' | 'image';
  decodeMs?: number;
  drawMs?: number;
  /** Duration of the latest update, ms. */
  lastMs?: number;
  /** EWMA of update duration, ms. */
  avgMs?: number;
  /** Video: actual canvas presentations per second over a bounded two-second window. */
  fps?: number;
  /** Video: frames that reached this computer more than 50 ms later than the host captured them (last two seconds). */
  lateFrames?: number;
  /** Video: longest interval between two drawn frames in the last two seconds, ms. */
  longestGapMs?: number;
  /** Video: active decode path. 'hardware' only once a hardware-only decoder produced a frame; otherwise never assumed. */
  decodeMode?: DecodeMode;
  /** Video: decoded frames replaced by a newer one within the same display refresh (last two seconds). Not drops. */
  superseded?: number;
  /** Video: frames the decoder discarded and never displayed (last two seconds). */
  dropped?: number;
  /** Video: viewer-side percentiles over the last two seconds; never glass-to-glass latency. */
  latency?: ViewerLatency;
  /** Transfer throughput while fetching (bytes × 8 / ms = kbit/s), EWMA. Only when bytes were recorded. */
  kbps?: number;
  lastBytes?: number;
  unchanged?: boolean;
  samples: number;
};

export type FrameAccumulator = { avgMs?: number; avgGapMs?: number; kbps?: number; lastAt?: number; lastMs?: number; lastBytes?: number; unchanged?: boolean; samples: number };

const ewma = (prev: number | undefined, value: number) => prev === undefined ? value : prev + EWMA_ALPHA * (value - prev);

/** Pure fold of one real measurement into the accumulator. `now` is a monotonic clock in ms. */
export function foldFrameSample(acc: FrameAccumulator, ms: number, bytes: number | undefined, now: number, unchanged = false): FrameAccumulator {
  if (!Number.isFinite(ms) || ms < 0) return acc;
  const gap = acc.lastAt === undefined ? undefined : now - acc.lastAt;
  return {
    avgMs: ewma(acc.avgMs, ms),
    avgGapMs: gap !== undefined && gap > 0 && gap < STALE_GAP_MS ? ewma(acc.avgGapMs, gap) : acc.avgGapMs,
    kbps: bytes !== undefined && Number.isFinite(bytes) && bytes >= 0 && ms > 0 ? ewma(acc.kbps, (bytes * 8) / ms) : acc.kbps,
    lastAt: now,
    lastMs: ms,
    lastBytes: bytes,
    unchanged,
    samples: acc.samples + 1,
  };
}

export function statsFrom(acc: FrameAccumulator): FrameStats {
  return { lastMs: acc.lastMs, avgMs: acc.avgMs, fps: acc.avgGapMs ? 1000 / acc.avgGapMs : undefined, kbps: acc.kbps, lastBytes: acc.lastBytes, unchanged: acc.unchanged, samples: acc.samples };
}

/** Collects real frame timings. Call record(durationMs, bytes?) after each successful frame fetch; reset() on monitor switch or new session. */
export function useFrameStats(onPublish?: () => void) {
  const acc = useRef<FrameAccumulator>({ samples: 0 });
  const presentations = useRef(new PresentationWindow(performance.now()));
  const [stats, setStats] = useState<FrameStats>({ samples: 0 });
  const published = useRef(onPublish); published.current = onPublish;
  const record = useCallback((ms: number, bytes?: number, unchanged = false) => {
    const next = foldFrameSample(acc.current, ms, bytes, performance.now(), unchanged);
    if (next === acc.current) return;
    acc.current = next;
    const now = performance.now();
    if (bytes !== undefined) presentations.current.received(now, bytes);
    if (!unchanged) presentations.current.presented(now, 0, 0);
    if (next.samples === 1) { setStats({ ...statsFrom(next), mode: 'image', fps: presentations.current.snapshot(now).fps }); published.current?.(); }
  }, []);
  useEffect(() => { const timer = window.setInterval(() => { if (acc.current.samples) { setStats({ ...statsFrom(acc.current), mode: 'image', fps: presentations.current.snapshot(performance.now()).fps }); published.current?.(); } }, 250); return () => window.clearInterval(timer); }, []);
  const reset = useCallback(() => { acc.current = { samples: 0 }; presentations.current = new PresentationWindow(performance.now()); setStats({ samples: 0 }); }, []);
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

export type HudState = 'live' | 'reconnecting' | 'paused' | 'asleep' | 'ended';
export const HUD_IDLE_MS = 2000;
/** While controlling, an unpressed pointer must rest near the top before the toolbar appears. */
const REVEAL_ZONE_PX = 16;
const KEEP_VISIBLE_ZONE_PX = 110;
const REVEAL_REST_MS = 400;
const REVEAL_REST_SLOP_PX = 4;

/**
 * Tracks one return to live video, for the single "Back to live video." announcement.
 * none: no live image yet (first connect), or after paused, asleep or ended; shown: live with an image;
 * lost: reconnecting after an image was live; returned: live with an image again after lost.
 */
export type LiveRecovery = 'none' | 'shown' | 'lost' | 'returned';
/** Pure: the recovery phase after the HUD shows `state`. Only reconnecting, then live with an image, gives `returned`. */
export function nextLiveRecovery(phase: LiveRecovery, state: HudState, hasImage: boolean): LiveRecovery {
  if (state === 'reconnecting') return phase === 'none' ? 'none' : 'lost';
  if (state !== 'live') return 'none';
  if (!hasImage) return phase;
  return phase === 'lost' ? 'returned' : phase === 'none' ? 'shown' : phase;
}

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
  revealRequest?: number;
  /**
   * The viewer shows a remote image. "Back to live video." is announced only when a screen that was live with an
   * image comes back from reconnecting, never on the first connect. Reconnect starts a new session (a new HUD) and
   * announces itself, so it never adds this message.
   */
  hasImage?: boolean;
  titleHeading?: boolean;
  onTitleDoubleClick?: () => void;
};

export function SessionHud({ title, link, ended: endedProp, state: stateProp, reconnectAttempt, stats, controlling, viewOnly, toolbar, children, forceVisible = false, detail, overlayAction, initialDetailsOpen = false, revealRequest = 0, hasImage = false, titleHeading = false, onTitleDoubleClick }: SessionHudProps) {
  const state: HudState = endedProp || stateProp === 'ended' ? 'ended' : stateProp;
  const live = state === 'live';
  const root = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const dwell = useRef<{ timer: number; x: number; y: number } | undefined>(undefined);
  const [awake, setAwake] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [recovery, setRecovery] = useState<LiveRecovery>('none');
  const liveRecovery = nextLiveRecovery(recovery, state, hasImage);
  if (liveRecovery !== recovery) setRecovery(liveRecovery);

  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAwake(false), HUD_IDLE_MS);
  }, []);
  const cancelDwell = useCallback(() => { window.clearTimeout(dwell.current?.timer); dwell.current = undefined; }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => { cancelDwell(); return cancelDwell; }, [controlling, live, cancelDwell]);
  useEffect(() => {
    window.addEventListener('blur', cancelDwell); window.addEventListener('resize', cancelDwell); window.addEventListener('scroll', cancelDwell, true);
    return () => { window.removeEventListener('blur', cancelDwell); window.removeEventListener('resize', cancelDwell); window.removeEventListener('scroll', cancelDwell, true); };
  }, [cancelDwell]);
  useEffect(() => { if (live) wake(); }, [live, wake]);
  useEffect(() => { if (revealRequest) wake(); }, [revealRequest, wake]);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const local = (e.target as Element).closest('.hud-bar');
    if (!controlling || local) { cancelDwell(); wake(); return; }
    const rect = root.current?.getBoundingClientRect();
    if (live && rect && (awake || hovered || focusWithin || forceVisible) && e.buttons === 0 && e.clientY >= rect.top && e.clientY <= rect.top + KEEP_VISIBLE_ZONE_PX) { cancelDwell(); wake(); return; }
    if (!live || !rect || e.buttons !== 0 || e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.top + REVEAL_ZONE_PX) { cancelDwell(); return; }
    const previous = dwell.current;
    if (previous && Math.hypot(e.clientX - previous.x, e.clientY - previous.y) <= REVEAL_REST_SLOP_PX) return;
    cancelDwell();
    dwell.current = { x: e.clientX, y: e.clientY, timer: window.setTimeout(() => { dwell.current = undefined; wake(); }, REVEAL_REST_MS) };
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    cancelDwell();
    if (!controlling || (e.target as Element).closest('.hud-bar')) wake();
  };
  // Only keyboard focus (or an open <select>) pins the toolbar; a mouse click on a button must not keep it up forever.
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'SELECT' || target.matches(':focus-visible')) setFocusWithin(true);
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false); };

  const visible = forceVisible || !live || awake || hovered || focusWithin;
  const announcement = state === 'reconnecting' ? `Connection lost. Reconnecting${reconnectAttempt ? `, attempt ${reconnectAttempt}` : ''}. The last image stays visible.` : state === 'paused' ? 'Screen updates and input are paused while this window is minimized or hidden.' : state === 'asleep' ? 'The remote display is asleep. Remote input is off.' : state === 'ended' ? 'Connection ended.' : liveRecovery === 'returned' ? 'Back to live video.' : '';

  return <div ref={root} className={`hud hud-${state}`} onPointerMove={onPointerMove} onPointerDown={onPointerDown} onPointerLeave={cancelDwell} onPointerCancel={cancelDwell}>
    <div className="hud-stage">{children}</div>
    {!live && <div className="hud-veil">
      <div className="hud-card">
        <span className="hud-card-icon" aria-hidden="true">{state === 'reconnecting' ? <Loader2 size={22} className="hud-spin" /> : state === 'paused' ? <Pause size={22} /> : state === 'asleep' ? <MonitorOff size={22} /> : <Unplug size={22} />}</span>
        <h2>{state === 'reconnecting' ? <>Reconnecting…{reconnectAttempt ? <span className="hud-attempt"> (attempt {reconnectAttempt})</span> : null}</> : state === 'paused' ? 'Screen updates paused' : state === 'asleep' ? 'The remote display is asleep.' : 'Connection ended'}</h2>
        <p>{detail ?? (state === 'reconnecting'
          ? 'Showing the last image received. Keyboard and mouse input are paused until the connection returns.'
          : state === 'paused' ? 'Return to this window to resume screen updates. Held keys and buttons have been released.'
          : state === 'asleep' ? 'Someone at that computer, or a controller, can wake it.'
          : 'This session is over and Orbit will not reconnect to it. Choose Connect to start a new session.')}</p>
        {overlayAction && <div className="hud-card-actions">{overlayAction}</div>}
      </div>
    </div>}
    {/* While controlling, the hidden toolbar leaves a small reminder that input goes to the remote computer and how to get local controls back. */}
    <div className="hud-handle" data-shown={!visible} data-control={controlling && live ? 'true' : undefined} aria-hidden="true">
      {controlling && live && <><MousePointer2 size={13} />Controlling<kbd>Ctrl+Alt+Enter</kbd></>}
    </div>
    <div className="hud-bar" data-visible={visible} role="region" aria-label={`Session controls for ${title}`}
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => { setHovered(false); if (live) wake(); }} onFocus={onFocus} onBlur={onBlur}>
      <div className="hud-status">
        {state !== 'ended' && <span className={`hud-state is-${state}`}>
          {state === 'live' ? <i className="hud-live-dot" aria-hidden="true" /> : state === 'paused' ? <Pause size={13} aria-hidden="true" /> : state === 'asleep' ? <MonitorOff size={13} aria-hidden="true" /> : <Loader2 size={13} className="hud-spin" aria-hidden="true" />}
          {state === 'live' ? 'Live' : state === 'paused' ? 'Paused' : state === 'asleep' ? 'Display asleep' : 'Reconnecting'}
        </span>}
        {titleHeading ? <h1 className="hud-title" title={`${title}. Double-click the title to toggle local fullscreen.`} onDoubleClick={onTitleDoubleClick}>{title}</h1>
          : <strong className="hud-title" title={title} onDoubleClick={onTitleDoubleClick}>{title}</strong>}
        <span className="hud-status-fill" />
        {state !== 'ended' && <QualityMeter stats={stats} paused={state !== 'live'} windowPaused={state === 'paused'} displayAsleep={state === 'asleep'} initialOpen={initialDetailsOpen} />}
        <EncryptionChip link={link} ended={state === 'ended'} />
        {state !== 'ended' && <ControlChip controlling={controlling && live} viewOnly={viewOnly} />}
      </div>
      <div className="hud-toolbar">{toolbar}</div>
    </div>
    <span className="hud-sr" aria-live="polite">{announcement}</span>
  </div>;
}

function QualityMeter({ stats, paused, windowPaused, displayAsleep, initialOpen }: { stats: FrameStats; paused: boolean; windowPaused: boolean; displayAsleep: boolean; initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  // Esc must hide the tip even while it is hovered or focused; reset when the pointer or focus leaves.
  const [dismissed, setDismissed] = useState(false);
  const tipId = useId();
  const video = stats.mode === 'video';
  const q = paused ? { level: 'unknown' as const, label: 'No updates' } : video ? videoQuality(stats) : qualityFrom(stats);
  const bars = { good: 3, fair: 2, slow: 1, unknown: 0 }[q.level];
  const smoothness = paused ? displayAsleep ? 'Display asleep' : windowPaused ? 'Paused' : 'Reconnecting' : { good: 'Smooth', fair: 'A few late frames', slow: 'Stuttering', unknown: 'Not measured yet' }[q.level];
  const meterName = video ? `Smoothness: ${smoothness}. Presentation rate: ${q.label}.` : undefined;
  const { goodMs, fairMs, minSamples } = QUALITY_THRESHOLDS;
  return <span className="hud-meter-wrap" onPointerLeave={() => setDismissed(false)}>
    <button type="button" className={`hud-meter q-${q.level}`} aria-label={meterName} aria-expanded={open} aria-describedby={tipId} onClick={() => { setDismissed(false); setOpen(o => !o); }} onBlur={() => setDismissed(false)} onKeyDown={e => { if (e.key === 'Escape' && (open || !dismissed)) { e.stopPropagation(); setOpen(false); setDismissed(true); } }}>
      <span className="hud-bars" aria-hidden="true">{[1, 2, 3].map(i => <i key={i} data-on={i <= bars} />)}</span>
      <span className="hud-sr">{video ? 'Presentation rate: ' : 'Link quality: '}</span>
      <span>{q.label}</span>
    </button>
    <span className="hud-tip" role="tooltip" id={tipId} data-open={open} data-dismissed={dismissed}>
      <span className="hud-tip-title">{paused ? displayAsleep ? 'No screen updates while the remote display is asleep' : windowPaused ? 'Screen updates paused while minimized or hidden' : 'No screen updates while reconnecting' : video ? 'Actual presentations · last 2 seconds' : stats.samples < minSamples ? `Measuring: ${stats.samples} of ${minSamples} updates so far` : `Measured from ${stats.samples} screen updates`}</span>
      <span className="hud-tip-row"><span>{video ? 'Average decode' : 'Last update'}</span><b>{fmtMs(video ? stats.decodeMs : stats.lastMs)}</b></span>
      <span className="hud-tip-row"><span>{video ? 'Average draw' : 'Average'}</span><b>{fmtMs(video ? stats.drawMs : stats.avgMs)}</b></span>
      {video && <span className="hud-tip-row"><span>Late frames</span><b>{stats.lateFrames === undefined ? 'Not measured yet' : String(stats.lateFrames)}</b></span>}
      {video && <span className="hud-tip-row"><span>Longest gap</span><b>{fmtMs(stats.longestGapMs)}</b></span>}
      <span className="hud-tip-row"><span>{video ? 'Presentations' : 'Update rate'}</span><b>{video ? stats.fps === undefined ? 'Not measured yet' : `${stats.fps.toFixed(1)} fps` : fmtRate(stats.fps)}</b></span>
      <span className="hud-tip-row"><span>Last image transfer</span><b>{stats.lastBytes === undefined ? 'Not measured' : stats.unchanged ? 'Unchanged · 0 B' : `${(stats.lastBytes / 1024).toFixed(1)} KB`}</b></span>
      <span className="hud-tip-row"><span title={video ? 'Validated video payload received in the last two seconds. Transport overhead is excluded.' : 'Image bytes divided by the whole request time, including latency. Not a measure of link bandwidth.'}>{video ? 'Video payload' : 'Image throughput'}</span><b>{fmtKbps(stats.kbps)}</b></span>
      <span className="hud-tip-foot">{video ? 'Counts canvas draws, excluding dropped access units. Decode and draw timings are local; they are not end-to-end latency.' : <>Rated on the average update time<span className="hud-tip-scale">Good &lt; {goodMs} ms · Fair &lt; {fairMs} ms · Slow ≥ {fairMs} ms</span></>}</span>
      {video && <span className="hud-tip-foot">Late frames were captured on time by the other computer but arrived here more than 50 ms late, measured over the last two seconds. A still screen sends no frames and is never late.</span>}
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
  if (controlling) return <span className="hud-chip is-control" title="Ctrl+Alt+Enter shows local controls and toggles fullscreen. Use the toolbar to stop control. Escape and F11 go to the remote computer."><MousePointer2 size={14} aria-hidden="true" />You have control<span className="hud-dot-sep" aria-hidden="true">·</span><kbd>Ctrl+Alt+Enter</kbd>local controls</span>;
  return <span className="hud-chip" title={viewOnly ? 'This session can only view the remote screen.' : 'Take control to send keyboard and mouse input.'}><Eye size={14} aria-hidden="true" />{viewOnly ? 'View only' : 'Viewing'}</span>;
}
