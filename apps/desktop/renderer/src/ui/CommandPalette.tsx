import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type KeyboardEvent as ReactKeyboardEvent, type SetStateAction } from 'react';
import { Command as CommandGlyph, CornerDownLeft, Search, SearchX, type LucideIcon } from 'lucide-react';
import './palette.css';

/** One runnable entry in the palette. `id` must be stable across launches (it keys the recent list). */
export type Command = {
  id: string;
  label: string;
  group: string;
  hint?: string;
  keywords?: string[];
  icon?: LucideIcon;
  disabled?: boolean;
  run(): void;
};

export type CommandPaletteProps = {
  open: boolean;
  onClose(): void;
  commands: Command[];
  placeholder?: string;
  /** Query shown when the palette opens. Used by the UI lab; the app normally leaves it empty. */
  initialQuery?: string;
};

export type FuzzyMatch = { score: number; indices: number[] };

export const PALETTE_RECENTS_KEY = 'orbit.palette.recent';
const MAX_RECENTS = 5;
const RECENT_GROUP = 'Recent';
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
/** Human label for the toggle shortcut on this platform, e.g. for a sidebar hint. */
export const PALETTE_SHORTCUT_LABEL = IS_MAC ? '⌘K' : 'Ctrl K';

// ---------- Fuzzy scoring (pure, exported for the lab self-check) ----------

const BOUNDARY = /[\s\-_./:·'’()]/;

function positionBonus(text: string, j: number): number {
  if (j === 0) return 10;
  const prev = text[j - 1];
  if (BOUNDARY.test(prev)) return 7;
  const ch = text[j];
  if (prev === prev.toLowerCase() && ch !== ch.toLowerCase()) return 5; // camelCase hump
  return 0;
}

/**
 * Case-insensitive subsequence match with the best-scoring alignment (small DP).
 * Rewards word starts and consecutive runs, lightly penalises gaps and long labels.
 * Returns null when `query` is not a subsequence of `text`.
 */
export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase();
  const t = text.slice(0, 160).toLowerCase();
  const n = q.length, m = t.length;
  if (n === 0) return { score: 0, indices: [] };
  if (n > m) return null;
  const NEG = Number.NEGATIVE_INFINITY;
  const dp: number[][] = [];
  const from: number[][] = [];
  for (let i = 0; i < n; i++) {
    dp.push(new Array<number>(m).fill(NEG));
    from.push(new Array<number>(m).fill(-1));
    for (let j = i; j < m; j++) {
      if (t[j] !== q[i]) continue;
      const base = 1 + positionBonus(text, j);
      if (i === 0) { dp[0][j] = base - Math.min(j, 10) * 0.2; continue; }
      let best = NEG, arg = -1;
      for (let k = i - 1; k < j; k++) {
        if (dp[i - 1][k] === NEG) continue;
        const gap = j - k - 1;
        const s = dp[i - 1][k] + (gap === 0 ? 8 : -Math.min(gap, 12) * 0.3);
        if (s > best) { best = s; arg = k; }
      }
      if (arg < 0) continue;
      dp[i][j] = best + base;
      from[i][j] = arg;
    }
  }
  let end = -1, score = NEG;
  for (let j = 0; j < m; j++) if (dp[n - 1][j] > score) { score = dp[n - 1][j]; end = j; }
  if (end < 0) return null;
  const indices: number[] = [];
  for (let i = n - 1, j = end; i >= 0; j = from[i][j], i--) indices.unshift(j);
  return { score: score - (m - n) * 0.02, indices };
}

/**
 * A label match must reach half the ideal score (a contiguous run starting a word: 11 + 9 per extra
 * character). Scattered letters fall below it; word starts and mid-word substrings stay above.
 */
const minLabelScore = (length: number) => 0.5 * (9 * length + 2);

/**
 * Scores a command against a query. Every whitespace-separated token must fuzzy-match the label,
 * or be a prefix of a keyword or the group name, in any order. Keyword/group hits score lower and
 * are not highlighted (they are not visible in the row).
 */
export function matchCommand(query: string, command: Pick<Command, 'label' | 'group' | 'keywords'>): FuzzyMatch | null {
  const trimmed = query.trim();
  if (!trimmed) return { score: 0, indices: [] };
  const extra = [...(command.keywords || []), command.group].map(word => word.toLowerCase());
  const indices = new Set<number>();
  let total = 0;
  for (const token of trimmed.split(/\s+/)) {
    const raw = fuzzyScore(token, command.label);
    const onLabel = raw && raw.score >= minLabelScore(token.length) ? raw : null;
    const lower = token.toLowerCase();
    const keywordScore = extra.some(word => word.startsWith(lower)) ? 5 * token.length : Number.NEGATIVE_INFINITY;
    const best = Math.max(onLabel ? onLabel.score : Number.NEGATIVE_INFINITY, keywordScore);
    if (best === Number.NEGATIVE_INFINITY) return null;
    if (onLabel && onLabel.score >= keywordScore) onLabel.indices.forEach(i => indices.add(i));
    total += best;
  }
  return { score: total, indices: [...indices].sort((a, b) => a - b) };
}

// ---------- Recent commands (memory first, localStorage best-effort) ----------

let recentMemory: string[] | null = null;

function loadRecents(): string[] {
  if (recentMemory) return recentMemory;
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PALETTE_RECENTS_KEY) || '[]');
    recentMemory = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX_RECENTS) : [];
  } catch { recentMemory = []; }
  return recentMemory;
}

function rememberCommand(id: string) {
  recentMemory = [id, ...loadRecents().filter(v => v !== id)].slice(0, MAX_RECENTS);
  try { localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(recentMemory)); } catch { /* Recents still work in memory. */ }
}

// ---------- Global shortcut ----------

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (target.getAttribute('role') === 'textbox') return true;
  return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(target.type);
}

/**
 * Toggles the palette on Ctrl+K (Cmd+K on macOS). Ignored while typing in another text field,
 * for keys a focused remote viewer already consumed (it calls preventDefault while capturing),
 * and entirely while `enabled` is false.
 */
export function usePaletteShortcut(setOpen: Dispatch<SetStateAction<boolean>>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.altKey || e.shiftKey) return;
      const isK = e.key.toLowerCase() === 'k' || (!/^[a-z]$/i.test(e.key) && e.code === 'KeyK');
      if (!isK || !(IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('.remote-viewer.controlling')) return;
      if (isTextField(target) && !target?.hasAttribute('data-command-palette-input')) return;
      e.preventDefault();
      setOpen(open => !open);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setOpen, enabled]);
}

// ---------- Component ----------

type Item = { command: Command; indices: number[] };
type Section = { label: string; items: Item[] };

function buildSections(commands: Command[], query: string, recents: string[]): Section[] {
  const groupOrder = [...new Set(commands.map(c => c.group))];
  if (!query.trim()) {
    const byId = new Map(commands.map(c => [c.id, c]));
    const recent = recents.map(id => byId.get(id)).filter((c): c is Command => Boolean(c));
    const recentIds = new Set(recent.map(c => c.id));
    const sections: Section[] = recent.length ? [{ label: RECENT_GROUP, items: recent.map(command => ({ command, indices: [] })) }] : [];
    for (const group of groupOrder) {
      const items = commands.filter(c => c.group === group && !recentIds.has(c.id)).map(command => ({ command, indices: [] }));
      if (items.length) sections.push({ label: group, items });
    }
    return sections;
  }
  const scored = commands.map((command, order) => ({ command, order, match: matchCommand(query, command) }))
    .filter((r): r is { command: Command; order: number; match: FuzzyMatch } => r.match !== null);
  const groups = new Map<string, typeof scored>();
  for (const r of scored) groups.set(r.command.group, [...(groups.get(r.command.group) || []), r]);
  return [...groups.entries()]
    .map(([label, rows]) => ({ label, rows: rows.sort((a, b) => Number(Boolean(a.command.disabled)) - Number(Boolean(b.command.disabled)) || b.match.score - a.match.score || a.order - b.order) }))
    .sort((a, b) => b.rows[0].match.score - a.rows[0].match.score || groupOrder.indexOf(a.label) - groupOrder.indexOf(b.label))
    .map(({ label, rows }) => ({ label, items: rows.map(r => ({ command: r.command, indices: r.match.indices })) }));
}

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const hits = new Set(indices);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i]; else parts.push({ text: text[i], hit });
  }
  return <>{parts.map((p, i) => p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}</>;
}

export function CommandPalette(props: CommandPaletteProps) {
  return props.open ? <PaletteDialog {...props} /> : null;
}

function PaletteDialog({ onClose, commands, placeholder = 'Search pages, devices, and actions…', initialQuery = '' }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [recents] = useState(loadRecents);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  const sections = useMemo(() => buildSections(commands, query, recents), [commands, query, recents]);
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections]);
  const firstEnabled = Math.max(0, flat.findIndex(item => !item.command.disabled));
  const found = flat.findIndex(item => item.command.id === activeId);
  const active = flat.length ? (found >= 0 ? found : firstEnabled) : -1;

  // Focus the input on open; restore the previously focused element on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    const trap = (e: KeyboardEvent) => {
      const focus = document.activeElement;
      if (focus && focus !== document.body && !panelRef.current?.contains(focus)) return; // another layer owns the keyboard
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onCloseRef.current(); }
      else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); inputRef.current?.focus(); }
    };
    window.addEventListener('keydown', trap, true);
    return () => {
      window.removeEventListener('keydown', trap, true);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (active < 0) return;
    if (active === 0) { listRef.current?.scrollTo({ top: 0 }); return; }
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runItem = (item: Item | undefined) => {
    if (!item || item.command.disabled) return;
    rememberCommand(item.command.id);
    onCloseRef.current();
    item.command.run();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || !flat.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
      setActiveId(flat[next].command.id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(flat[active]);
    }
  };

  const count = flat.length;
  const countText = count === 0 ? 'No results' : `${count} result${count === 1 ? '' : 's'}`;
  let index = -1;

  return <div className="cp-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onCloseRef.current(); }}>
    <div className="cp-panel" ref={panelRef} role="dialog" aria-modal="true" aria-label="Command palette"
      onMouseDown={e => { if (e.target !== inputRef.current) e.preventDefault(); }}>
      <div className="cp-search">
        <Search className="cp-search-icon" size={19} strokeWidth={1.9} aria-hidden="true" />
        <input ref={inputRef} className="cp-input" data-command-palette-input="" value={query} placeholder={placeholder}
          role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label="Search commands"
          aria-activedescendant={active >= 0 ? optionId(active) : undefined} autoComplete="off" spellCheck={false}
          onChange={e => { setQuery(e.target.value); setActiveId(null); }} onKeyDown={onKeyDown} />
        <button type="button" className="cp-kbd cp-esc" tabIndex={-1} aria-label="Close command palette" onClick={() => onCloseRef.current()}>Esc</button>
      </div>
      <div className="cp-list" id={listId} ref={listRef} role="listbox" aria-label="Commands">
        {sections.map(section => <div key={section.label} className="cp-group" role="group" aria-labelledby={`${baseId}-g-${section.label}`}>
          <div className="cp-group-label" id={`${baseId}-g-${section.label}`} role="presentation">{section.label}</div>
          {section.items.map(item => {
            index += 1;
            const i = index;
            const { command } = item;
            const Icon = command.icon || CommandGlyph;
            return <div key={command.id} id={optionId(i)} data-index={i} role="option" aria-selected={i === active} aria-disabled={command.disabled || undefined}
              className="cp-option" onMouseMove={() => { if (i !== active) setActiveId(command.id); }} onClick={() => runItem(item)}>
              <span className="cp-icon" aria-hidden="true"><Icon size={16} strokeWidth={1.8} /></span>
              <span className="cp-label"><Highlight text={command.label} indices={item.indices} /></span>
              {command.hint && <span className="cp-hint">{command.hint}</span>}
              <span className="cp-enter" aria-hidden="true"><CornerDownLeft size={13} strokeWidth={2} /></span>
            </div>;
          })}
        </div>)}
        {count === 0 && <div className="cp-empty">
          <span className="cp-empty-icon" aria-hidden="true"><SearchX size={22} strokeWidth={1.6} /></span>
          <strong>No commands match “{query.trim()}”</strong>
          <span>Try a page name, a device, or a theme.</span>
        </div>}
      </div>
      <div className="cp-footer" aria-hidden="true">
        <span><kbd className="cp-kbd">↑</kbd><kbd className="cp-kbd">↓</kbd> navigate</span>
        <span className="cp-dot">·</span>
        <span><kbd className="cp-kbd">↵</kbd> run</span>
        <span className="cp-dot">·</span>
        <span><kbd className="cp-kbd">Esc</kbd> close</span>
        <span className="cp-count">{countText}</span>
      </div>
      <div className="cp-sr" role="status" aria-live="polite">{countText}</div>
    </div>
  </div>;
}
