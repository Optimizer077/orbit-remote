import { useEffect, useId, useRef, type Dispatch, type SetStateAction } from 'react';
import { Keyboard, X } from 'lucide-react';
import './shortcuts.css';

/**
 * Keyboard shortcut sheet (Linear/Raycast-style "?" list). Every entry is a shortcut that exists in
 * the app today; check App.tsx / CommandPalette.tsx before adding one.
 *   Ctrl/Cmd+K  usePaletteShortcut (CommandPalette.tsx), off while the pair or manage dialog is open
 *   ↑ ↓ Enter Esc  palette input handlers (CommandPalette.tsx)
 *   Esc, Tab   Modal in App.tsx (closes; Tab/Shift+Tab wrap inside the dialog)
 *   Ctrl+Alt+Enter  local viewer fullscreen/controls in App.tsx
 *   Esc, F11   remote keys while Control is enabled; local fullscreen exit while viewing
 *   ?          useShortcutsHelpKey below
 */

export type ShortcutsHelpProps = {
  open: boolean;
  onClose(): void;
  /** Local platform ('mac', 'darwin', 'windows', 'linux', or a navigator string). Defaults to this computer. */
  platform?: string;
};

const DETECTED_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
export const isMacPlatform = (platform?: string) => platform ? /mac|darwin|iphone|ipad/i.test(platform) : DETECTED_MAC;

type KeyName = 'Mod' | 'Ctrl' | 'Alt' | 'F11' | 'Shift' | 'K' | '?' | 'Esc' | 'Tab' | 'Up' | 'Down' | 'Enter';
type Shortcut = { id: string; label: string; note?: string; /** Alternatives; each is a chord pressed together. */ combos: KeyName[][] };
export type ShortcutGroup = { title: string; note?: string; items: Shortcut[] };

function keyFace(key: KeyName, mac: boolean): { glyph: string; spoken: string } {
  switch (key) {
    case 'Ctrl': return { glyph: 'Ctrl', spoken: 'Control' };
    case 'Alt': return mac ? { glyph: 'Option', spoken: 'Option' } : { glyph: 'Alt', spoken: 'Alt' };
    case 'Mod': return mac ? { glyph: '⌘', spoken: 'Command' } : { glyph: 'Ctrl', spoken: 'Control' };
    case 'Shift': return mac ? { glyph: '⇧', spoken: 'Shift' } : { glyph: 'Shift', spoken: 'Shift' };
    case 'Up': return { glyph: '↑', spoken: 'Up arrow' };
    case 'Down': return { glyph: '↓', spoken: 'Down arrow' };
    case 'Enter': return mac ? { glyph: 'Return', spoken: 'Return' } : { glyph: 'Enter', spoken: 'Enter' };
    case '?': return { glyph: '?', spoken: 'Question mark' };
    case 'Esc': return { glyph: 'Esc', spoken: 'Escape' };
    default: return { glyph: key, spoken: key };
  }
}

/** The shortcut list. Pure, so the lab and tests can inspect it. */
export function shortcutGroups(): ShortcutGroup[] {
  return [
    { title: 'General', items: [
      { id: 'palette', label: 'Open or close the command palette', note: 'Not while you control a remote computer', combos: [['Mod', 'K']] },
      { id: 'help', label: 'Show keyboard shortcuts', note: 'When you are not typing in a field', combos: [['?']] },
      { id: 'close', label: 'Close the open dialog', combos: [['Esc']] },
      { id: 'focus', label: 'Move between controls', note: 'Dialogs keep focus inside until closed', combos: [['Tab'], ['Shift', 'Tab']] },
    ] },
    { title: 'Command palette', items: [
      { id: 'cp-move', label: 'Move between commands', combos: [['Up'], ['Down']] },
      { id: 'cp-run', label: 'Run the selected command', combos: [['Enter']] },
      { id: 'cp-close', label: 'Close the palette', combos: [['Esc']] },
    ] },
    { title: 'Session', note: 'While Control is enabled, Escape, F11 and ordinary shortcuts go to the remote computer when its screen has focus.', items: [
      { id: 'local-fullscreen', label: 'Toggle local fullscreen and show local controls', note: 'The reserved local chord while the remote viewer has focus', combos: [['Ctrl', 'Alt', 'Enter']] },
      { id: 'remote-keys', label: 'Send Escape or F11 to the remote computer', note: 'While Control is enabled and the remote screen has focus', combos: [['Esc'], ['F11']] },
      { id: 'exit-viewing', label: 'Leave local fullscreen', note: 'While viewing or with no active remote viewer', combos: [['Esc'], ['F11']] },
    ] },
  ];
}

// ---------- "?" opens the sheet ----------

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target.getAttribute('role') === 'textbox' || target.getAttribute('role') === 'combobox') return true;
  return target instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(target.type);
}

/**
 * Opens the shortcut sheet on "?" (Shift+/ on US layouts). Same guards as usePaletteShortcut:
 * ignored while typing in a text field, for keys a capturing remote viewer already consumed
 * (it calls preventDefault), anywhere inside `.remote-viewer.controlling`, inside another modal
 * dialog, and entirely while `enabled` is false. AltGr layouts (Ctrl+Alt) still work.
 */
export function useShortcutsHelpKey(setOpen: Dispatch<SetStateAction<boolean>>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.isComposing || e.key !== '?') return;
      if (e.metaKey || e.ctrlKey !== e.altKey) return; // plain or AltGr only
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('.remote-viewer.controlling')) return;
      if (isTextField(target)) return;
      if (target?.closest('[aria-modal="true"]')) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setOpen, enabled]);
}

// ---------- Component ----------

export function ShortcutsHelp(props: ShortcutsHelpProps) {
  return props.open ? <ShortcutsDialog {...props} /> : null;
}

const FOCUSABLE = 'button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function ShortcutsDialog({ onClose, platform }: ShortcutsHelpProps) {
  const mac = isMacPlatform(platform);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descId = useId();

  // Focus the close button on open, trap Tab, close on Esc, restore focus on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus({ preventScroll: true });
    const trap = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      const focus = document.activeElement;
      if (!panel || (focus && focus !== document.body && !panel.contains(focus))) return; // another layer owns the keyboard
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.getClientRects().length);
      if (!items.length) return;
      const i = items.indexOf(focus as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i < 0 || i === items.length - 1 ? 0 : i + 1);
      e.preventDefault(); e.stopPropagation();
      items[next].focus();
    };
    window.addEventListener('keydown', trap, true);
    return () => {
      window.removeEventListener('keydown', trap, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const groups = shortcutGroups();
  const chord = (keys: KeyName[]) => keys.map(k => keyFace(k, mac));

  return <div className="sh-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onCloseRef.current(); }}>
    <div className="sh-panel" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId}>
      <header className="sh-head">
        <span className="sh-head-icon" aria-hidden="true"><Keyboard size={18} strokeWidth={1.8} /></span>
        <div className="sh-head-text">
          <h2 id={titleId}>Keyboard shortcuts</h2>
          <p id={descId}>{mac ? 'Showing Mac keys.' : 'Showing Windows and Linux keys.'} Only shortcuts that work today are listed.</p>
        </div>
        <button ref={closeRef} type="button" className="sh-close" aria-label="Close keyboard shortcuts" onClick={() => onCloseRef.current()}><X size={17} strokeWidth={2} aria-hidden="true" /></button>
      </header>
      <div className="sh-body">
        {groups.map(group => <section key={group.title} className="sh-group" aria-labelledby={`${titleId}-${group.title}`}>
          <h3 className="sh-group-title" id={`${titleId}-${group.title}`}>{group.title}</h3>
          <ul className="sh-list">
            {group.items.map(item => <li key={item.id} className="sh-row" data-shortcut={item.id}>
              <span className="sh-label">{item.label}{item.note && <span className="sh-note">{item.note}</span>}</span>
              <span className="sh-keys">
                <span className="sh-sr">{item.combos.map(c => chord(c).map(k => k.spoken).join(' plus ')).join(', or ')}</span>
                <span className="sh-combos" aria-hidden="true">{item.combos.map((c, ci) => <span key={ci} className="sh-combo">
                  {ci > 0 && <span className="sh-or">or</span>}
                  {chord(c).map((k, ki) => <kbd key={ki} className={`sh-kbd${k.glyph.length === 1 ? ' is-glyph' : ''}`}>{k.glyph}</kbd>)}
                </span>)}</span>
              </span>
            </li>)}
          </ul>
          {group.note && <p className="sh-group-note">{group.note}</p>}
        </section>)}
      </div>
      <footer className="sh-foot">
        <span>Press <kbd className="sh-kbd is-glyph">?</kbd> to open this list</span>
        <span className="sh-foot-sep" aria-hidden="true">·</span>
        <span><kbd className="sh-kbd">Esc</kbd> to close</span>
      </footer>
    </div>
  </div>;
}
