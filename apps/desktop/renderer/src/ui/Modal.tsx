import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Link2, X } from 'lucide-react';

/**
 * Focus-trapped dialog shared by the workspace, pairing and remote-session tools.
 * A child marked `data-autofocus` receives focus on open; otherwise the dialog itself does.
 */
export function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const subtitleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    (ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current)?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && ref.current) {
        const els = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]'));
        const first = els[0], last = els[els.length - 1];
        // Shift+Tab from the dialog itself (its initial focus) would otherwise leave the dialog.
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (old?.isConnected) { old.focus(); return; }
      // The dialog's action changed the page (for example, pairing opens Devices): start at its heading.
      const heading = document.querySelector<HTMLElement>('main h1');
      if (heading) { heading.tabIndex = -1; heading.focus(); }
    };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-label={title} aria-describedby={subtitle ? subtitleId : undefined} tabIndex={-1}>
    <button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><X size={20} /></button>
    <div className="modal-icon"><Link2 size={22} /></div><h2 tabIndex={-1}>{title}</h2>{subtitle && <p className="modal-subtitle" id={subtitleId}>{subtitle}</p>}{children}
  </div></div>;
}
