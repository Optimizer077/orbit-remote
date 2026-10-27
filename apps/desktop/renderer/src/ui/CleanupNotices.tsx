import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, RefreshCw, Unplug } from 'lucide-react';
import { api, type CleanupEntry, type CleanupSnapshot } from '../api';
import './cleanup-notices.css';

function checkedSnapshot(value: CleanupSnapshot): CleanupSnapshot {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries) || value.entries.length > 64 ||
    value.entries.some(entry => !entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 128 ||
      typeof entry.deviceName !== 'string' || !entry.deviceName || Array.from(entry.deviceName).length > 128 ||
      !['failed', 'retrying'].includes(entry.state) || typeof entry.retryScheduled !== 'boolean')) throw new Error('Invalid cleanup snapshot.');
  return value;
}

/** Owner workspace only: this component never receives remote deletion credentials. */
export function CleanupNotices() {
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const [entries, setEntries] = useState<CleanupEntry[]>([]);
  const [readError, setReadError] = useState('');
  const [actionError, setActionError] = useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const mounted = useRef(false), revision = useRef(-1), dirty = useRef(false);
  const request = useRef<Promise<void> | null>(null), busyIds = useRef(new Set<string>());
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const refresh = useCallback((): Promise<void> => {
    dirty.current = true;
    if (request.current) return request.current;
    const run = async () => {
      while (mounted.current && dirty.current) {
        dirty.current = false;
        try {
          const snapshot = checkedSnapshot(await api.cleanupList());
          if (!mounted.current) return;
          if (snapshot.revision < revision.current) continue;
          revision.current = snapshot.revision;
          setEntries(snapshot.entries); setReadError('');
        } catch {
          if (mounted.current) setReadError('Could not refresh previous session cleanup.');
        }
      }
    };
    const pending = run().finally(() => {
      if (request.current === pending) request.current = null;
      if (mounted.current && dirty.current) void refresh();
    });
    request.current = pending;
    return pending;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.orbit?.onCleanupChanged?.(change => {
      if (!Number.isSafeInteger(change?.revision) || change.revision < 0 || change.revision < revision.current) return;
      revision.current = change.revision;
      void refresh();
    });
    void refresh();
    return () => { mounted.current = false; dirty.current = false; unsubscribe?.(); };
  }, [refresh]);
  const retry = async (id: string, origin: HTMLButtonElement) => {
    if (busyIds.current.has(id) || !entriesRef.current.some(entry => entry.id === id)) return;
    const hadFocus = document.hasFocus(); let cleared = false;
    busyIds.current.add(id); setBusy(new Set(busyIds.current)); setActionError(null);
    try {
      const result = await api.cleanupRetry(id);
      if (!mounted.current) return;
      cleared = result.cleared;
      if (!result.cleared) setActionError({ id, message: 'Cleanup could not be confirmed. You can retry.' });
      await refresh();
    } catch {
      if (mounted.current) setActionError({ id, message: 'Cleanup could not be confirmed. You can retry.' });
    } finally {
      busyIds.current.delete(id);
      if (mounted.current) setBusy(new Set(busyIds.current));
      requestAnimationFrame(() => {
        if (!mounted.current || !hadFocus || !document.hasFocus() ||
          (document.activeElement !== origin && document.activeElement !== document.body)) return;
        const target = cleared ? sectionRef.current?.querySelector<HTMLButtonElement>('li button:not(:disabled)') ??
          document.querySelector<HTMLButtonElement>('[aria-label="Main navigation"] .nav-item.active') : origin;
        if (target?.isConnected) target.focus({ preventScroll: true });
      });
    }
  };
  const first = entries[0];
  const liveSummary = first ? `${entries.length > 1 ? `${entries.length} previous sessions need cleanup. ` : ''}${first.state === 'retrying' || busy.has(first.id) ? 'Retrying cleanup on' : "Couldn't end the session on"} ${first.deviceName}.` : '';
  return <>
    <span className="cleanup-live-status" role="status" aria-live="polite" aria-atomic="true">{liveSummary}</span>
    {(entries.length > 0 || readError) && <section ref={sectionRef} className="cleanup-notices" aria-labelledby={headingId}>
    <header><Unplug size={17} aria-hidden="true" /><div><h2 id={headingId}>Previous session cleanup</h2><p>Your current connection can continue while Orbit closes previous remote sessions.</p></div></header>
    {readError && <div className="cleanup-read-error" role="alert"><span>{readError}</span><button type="button" className="button secondary small" onClick={() => void refresh()}><RefreshCw size={14} />Check again</button></div>}
    {entries.length > 0 && <ul>{entries.map(entry => {
      const retrying = entry.state === 'retrying' || busy.has(entry.id);
      return <li key={entry.id}><div><strong>{retrying ? `Retrying cleanup on ${entry.deviceName}.` : `Couldn't end the session on ${entry.deviceName}.`}</strong><span>{entry.retryScheduled ? 'One automatic retry is scheduled.' : retrying ? 'Waiting for confirmation from the remote host.' : 'Retry when you are ready.'}</span></div><button type="button" className="button secondary small" aria-label={`Retry ending the session on ${entry.deviceName}`} disabled={retrying} onClick={event => void retry(entry.id, event.currentTarget)}>{retrying ? <Loader2 size={14} className="cleanup-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{retrying ? 'Retrying...' : 'Retry'}</button></li>;
    })}</ul>}
    {actionError && entries.some(entry => entry.id === actionError.id) && <p className="cleanup-action-error" role="alert">{actionError.message}</p>}
  </section>}
  </>;
}
