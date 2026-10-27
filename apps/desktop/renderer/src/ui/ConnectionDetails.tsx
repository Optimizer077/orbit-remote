import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ClipboardCopy, Gauge, LockKeyhole, Monitor as MonitorIcon, MonitorPlay, X } from 'lucide-react';
import { invoke, type Link, type Monitor } from '../api';
import { QUALITY_THRESHOLDS, qualityFrom, videoQuality, type FrameStats, type QualityLevel } from './SessionHud';
import './details.css';

/** Shown for every value that has not been measured or reported. Never replaced by a guess. */
export const NOT_MEASURED = 'Not measured yet';
export const THROUGHPUT_CAVEAT = 'Image bytes divided by the whole request time, including latency. Not a measure of link bandwidth.';

export type ConnectionDetailsProps = {
  open: boolean;
  onClose(): void;
  deviceName: string;
  /** TLS details from the latest frame response (frame?.link || session.link). */
  link?: Link;
  /** From useFrameStats() in SessionHud. */
  stats: FrameStats;
  /** The monitor being shown, when the host reported it. */
  monitor?: Monitor;
  /** Requested image scale (1, 0.75, 0.5). Shown only when canScaleFrames. */
  scale?: number;
  canScaleFrames?: boolean;
  canConditionalFrames?: boolean;
  /** Bytes of the latest frame response (0 for an unchanged 304). */
  lastFrameBytes?: number;
  /** Frame responses that were "unchanged" (304) since the counters were last reset. */
  unchangedCount?: number;
  /** All frame responses since the counters were last reset. */
  totalFrames?: number;
};

type Row = { key: string; label: string; value: string; measured: boolean; note?: string };
type Section = { key: string; title: string; rows: Row[]; note?: string };

const row = (key: string, label: string, value: string | undefined, note?: string): Row =>
  ({ key, label, value: value ?? NOT_MEASURED, measured: value !== undefined, note });

const fmtMs = (v?: number) => v === undefined || !Number.isFinite(v) ? undefined : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
const fmtRate = (v?: number) => v === undefined || !Number.isFinite(v) ? undefined : `${v.toFixed(1)} updates/s`;
const fmtKbps = (v?: number) => v === undefined || !Number.isFinite(v) ? undefined : v >= 1000 ? `${(v / 1000).toFixed(1)} Mbit/s` : `${Math.round(v)} kbit/s`;
export function fmtBytes(bytes?: number) {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** Same names as the "Screen image quality" select in App.tsx. */
export function scaleLabel(scale?: number) {
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return undefined;
  const pct = `${Math.round(scale * 100)}%`;
  return scale >= 1 ? `Full detail · ${pct}` : scale === 0.75 ? `Balanced · ${pct}` : scale === 0.5 ? `Lighter · ${pct}` : pct;
}

export function qualityText(stats: FrameStats): { level: QualityLevel; value?: string; detail?: string } {
  if (stats.mode === 'video') {
    const v = videoQuality(stats);
    if (v.level === 'unknown') return { level: 'unknown', value: stats.fps === undefined ? undefined : 'Measuring…', detail: 'Rated on late frames over the last two seconds' };
    const words = { good: 'Smooth', fair: 'A few late frames', slow: 'Stuttering' }[v.level];
    const late = stats.lateFrames ?? 0;
    return { level: v.level, value: words, detail: `${late} late ${late === 1 ? 'frame' : 'frames'} in the last two seconds · ${v.label}` };
  }
  const q = qualityFrom(stats);
  const { minSamples } = QUALITY_THRESHOLDS;
  if (stats.samples <= 0) return { level: 'unknown' };
  if (q.level === 'unknown') return { level: 'unknown', value: 'Measuring…', detail: `${stats.samples} of ${minSamples} screen updates so far` };
  return { level: q.level, value: q.label, detail: `Average ${Math.round(stats.avgMs!)} ms over ${stats.samples} screen updates` };
}

/** Every value the panel shows, in order. Pure: the panel and the copied summary both use it. */
export function connectionSections(p: Omit<ConnectionDetailsProps, 'open' | 'onClose'>): Section[] {
  const { link, stats } = p;
  const quality = qualityText(stats);
  const video = stats.mode === 'video';
  const sections: Section[] = [
    { key: 'encryption', title: 'Encryption', note: link ? (video ? 'Reported by the paired connection.' : 'Reported by the latest screen request.') : 'Shown after the first screen update arrives.', rows: [
      row('protocol', 'Protocol', link?.protocol),
      row('cipher', 'Cipher', link?.cipher),
      row('key-exchange', 'Key exchange', link?.keyExchange),
      row('forward-secrecy', 'Forward secrecy', link ? (link.forwardSecrecy ? 'Yes' : 'No') : undefined),
    ] },
  ];
  if (video) {
    const fps = stats.fps === undefined ? undefined : `${stats.fps.toFixed(1)} fps`;
    sections.push({ key: 'video', title: 'Video stream', note: 'Only changed frames are sent, so a still screen draws few frames. Timings are measured on this computer.', rows: [
      row('quality', 'Smoothness', quality.value, quality.detail),
      row('fps', 'Frames drawn', fps, 'Actual canvas draws over the last two seconds.'),
      row('late', 'Late frames', stats.lateFrames === undefined ? undefined : String(stats.lateFrames), 'Captured on time by the host but delivered more than 50 ms late.'),
      row('gap', 'Longest gap', fmtMs(stats.longestGapMs)),
      row('decode', 'Average decode', fmtMs(stats.decodeMs)),
      row('draw', 'Average draw', fmtMs(stats.drawMs)),
      row('bitrate', 'Video data', fmtKbps(stats.kbps), 'Validated video payload; transport overhead is excluded.'),
    ] });
  }
  const lastImage = stats.samples > 0 && stats.unchanged ? 'Unchanged · 0 B' : fmtBytes(p.lastFrameBytes ?? stats.lastBytes);
  const updates: Row[] = [
    row('quality', 'Link quality', quality.value, quality.detail),
    row('last', 'Last update', fmtMs(stats.lastMs)),
    row('average', 'Average update', fmtMs(stats.avgMs)),
    row('rate', 'Update rate', fmtRate(stats.fps)),
    row('last-image', 'Last image size', lastImage),
    row('throughput', 'Image throughput', fmtKbps(stats.kbps), THROUGHPUT_CAVEAT),
  ];
  if (p.canConditionalFrames) {
    const total = p.totalFrames ?? 0, same = p.unchangedCount ?? 0;
    const value = total > 0 && same >= 0 && same <= total ? `${Math.round((same / total) * 100)}% · ${same} of ${total}` : undefined;
    updates.push(row('unchanged', 'Unchanged updates', value, 'The screen had not changed, so no image was sent. Lossless.'));
  }
  if (!video) sections.push({ key: 'updates', title: 'Screen updates', rows: updates, note: 'Timed on this computer, from request sent to image received.' });
  const display: Row[] = [
    row('monitor', 'Monitor', p.monitor ? `${p.monitor.name}${p.monitor.primary ? ' (primary)' : ''}` : undefined),
    row('size', 'Desktop size', p.monitor ? `${p.monitor.width} × ${p.monitor.height}` : undefined),
  ];
  if (p.canScaleFrames) display.push(row('scale', 'Image scale', scaleLabel(p.scale), 'Pointer positions always use the full desktop.'));
  sections.push({ key: 'display', title: 'Display', rows: display });
  return sections;
}

/** Plain-text summary for the clipboard. Contains no addresses and no security code. */
export function connectionSummary(p: Omit<ConnectionDetailsProps, 'open' | 'onClose'>): string {
  const lines = [`Orbit connection details: ${p.deviceName}`];
  for (const section of connectionSections(p)) {
    lines.push('', `${section.title}`);
    for (const r of section.rows) lines.push(`  ${r.label}: ${r.value}${r.key === 'throughput' && r.measured ? ' (image bytes / request time; not link bandwidth)' : r.key === 'quality' && r.note ? ` (${r.note})` : ''}`);
  }
  return lines.join('\n');
}

export function ConnectionDetails(props: ConnectionDetailsProps) {
  return props.open ? <DetailsPanel {...props} /> : null;
}

function QualityBars({ level }: { level: QualityLevel }) {
  const on = { good: 3, fair: 2, slow: 1, unknown: 0 }[level];
  return <span className="cd-bars" aria-hidden="true">{[1, 2, 3].map(i => <i key={i} data-on={i <= on} />)}</span>;
}

function DetailsPanel({ onClose, open: _open, ...data }: ConnectionDetailsProps) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<number | undefined>(undefined);

  // Move focus in on open; on close, restore it only if it was still inside the panel (non-modal:
  // the rest of the window stays usable). Layout cleanup runs before the panel leaves the DOM.
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(copyTimer.current);
      if (previous?.isConnected && panelRef.current?.contains(document.activeElement)) previous.focus({ preventScroll: true });
    };
  }, []);

  // Esc closes only while focus is inside the panel, so Esc on the remote screen still releases control.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    e.preventDefault(); e.stopPropagation();
    onCloseRef.current();
  };

  const doCopy = async () => {
    window.clearTimeout(copyTimer.current);
    try {
      await invoke('clipboard.local.write', { text: connectionSummary(data) });
      setCopy('copied');
    } catch { setCopy('failed'); }
    copyTimer.current = window.setTimeout(() => setCopy('idle'), 2400);
  };

  const sections = connectionSections(data);
  const quality = qualityText(data.stats), video = data.stats.mode === 'video';
  const icons = { encryption: LockKeyhole, updates: Gauge, video: MonitorPlay, display: MonitorIcon } as const;

  return <aside ref={panelRef} className="cd-panel" role="dialog" aria-modal="false" aria-labelledby={titleId} onKeyDown={onKeyDown}>
    <header className="cd-head">
      <div className="cd-head-text">
        <h2 id={titleId}>Connection details</h2>
        <p className="cd-device" title={data.deviceName}>{data.deviceName}</p>
      </div>
      <button ref={closeRef} type="button" className="cd-close" aria-label="Close connection details" onClick={() => onCloseRef.current()}><X size={17} strokeWidth={2} aria-hidden="true" /></button>
    </header>

    <div className="cd-scroll">
      <div className={`cd-hero q-${quality.level}`}>
        <QualityBars level={quality.level} />
        <div className="cd-hero-text">
          <span className="cd-hero-label">{video ? 'Smoothness' : 'Link quality'}</span>
          <strong data-measured={quality.value !== undefined}>{quality.value ?? NOT_MEASURED}</strong>
          <span className="cd-hero-detail">{quality.detail ?? (video ? 'Rated after two seconds of video' : `Rated after ${QUALITY_THRESHOLDS.minSamples} screen updates`)}</span>
          <span className="cd-hero-scale">{video ? 'Smooth: no late frames · A few: 1–2 · Stuttering: 3 or more, in two seconds' : <>Good &lt; {QUALITY_THRESHOLDS.goodMs} ms · Fair &lt; {QUALITY_THRESHOLDS.fairMs} ms · Slow ≥ {QUALITY_THRESHOLDS.fairMs} ms</>}</span>
        </div>
      </div>

      {sections.map(section => {
        const Icon = icons[section.key as keyof typeof icons];
        return <section key={section.key} className="cd-section" aria-labelledby={`${titleId}-${section.key}`} data-section={section.key}>
          <h3 id={`${titleId}-${section.key}`}><Icon size={14} strokeWidth={2} aria-hidden="true" />{section.title}</h3>
          <dl className="cd-rows">
            {section.rows.filter(r => r.key !== 'quality').map(r => <div key={r.key} className="cd-row" data-row={r.key}>
              <dt>{r.label}</dt>
              <dd data-measured={r.measured}>{r.value}</dd>
              {r.note && <dd className="cd-note">{r.note}</dd>}
            </div>)}
          </dl>
          {section.note && <p className="cd-section-note">{section.note}</p>}
        </section>;
      })}
    </div>

    <footer className="cd-foot">
      <button type="button" className="cd-copy" onClick={() => void doCopy()} data-state={copy}>
        {copy === 'copied' ? <Check size={15} strokeWidth={2.2} aria-hidden="true" /> : <ClipboardCopy size={15} strokeWidth={1.9} aria-hidden="true" />}
        {copy === 'copied' ? 'Copied' : 'Copy summary'}
      </button>
      <span className="cd-foot-hint">{copy === 'failed' ? 'Could not copy. Clipboard access was refused.' : 'Plain text. No addresses or security code.'}</span>
      <span className="cd-sr" role="status" aria-live="polite">{copy === 'copied' ? 'Connection summary copied to the clipboard.' : copy === 'failed' ? 'Could not copy the connection summary.' : ''}</span>
    </footer>
  </aside>;
}
