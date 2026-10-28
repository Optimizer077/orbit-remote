import { useMemo, useState } from 'react';
import { Activity, Clock3, KeyRound, Link2, Plus, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import type { AuditEntry } from '../api';
import { eventName, SECURITY_EVENT } from './event-names';
import './pages.css';

export type ActivityPageProps = { entries: AuditEntry[]; refreshing?: boolean; onRefresh: () => void; /** Opens "Invite a computer" from the empty state. */ onInvite?: () => void };
// One formatter per pattern: toLocaleDateString/toLocaleTimeString with options build a new one per call, twice
// per row, for up to 500 rows. Same output, since both use the default locale and these exact options.
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function eventIcon(action: string) { return SECURITY_EVENT.test(action) ? KeyRound : /session|connect/i.test(action) ? Link2 : Activity; }

export function ActivityPage({ entries, refreshing = false, onRefresh, onInvite }: ActivityPageProps) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'connections' | 'security'>('all');
  const shown = useMemo(() => entries.filter(entry =>
    (filter !== 'connections' || /session|connect/i.test(entry.action)) &&
    (filter !== 'security' || SECURITY_EVENT.test(entry.action)) &&
    `${eventName(entry.action)} ${entry.action} ${entry.deviceName || ''} ${entry.detail || ''} ${entry.outcome || ''}`.toLowerCase().includes(query.toLowerCase().trim())), [entries, query, filter]);
  return <section className="op-page op-activity-page" aria-labelledby="activity-page-title"><header className="op-page-heading"><div><span className="op-eyebrow">A CLEAR VIEW OF YOUR NETWORK</span><h1 id="activity-page-title">Nothing behind the scenes.</h1><p>A local record of who connected, what changed, and when.</p></div><button className="button secondary" onClick={onRefresh} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} />Refresh activity</button></header>
    <div className="op-page-toolbar"><div className="op-segmented" role="group" aria-label="Filter activity"><button className={filter === 'all' ? 'active' : ''} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All activity <span>{entries.length}</span></button><button className={filter === 'connections' ? 'active' : ''} aria-pressed={filter === 'connections'} onClick={() => setFilter('connections')}>Connections</button><button className={filter === 'security' ? 'active' : ''} aria-pressed={filter === 'security'} onClick={() => setFilter('security')}>Access & security</button></div><label className="op-search"><Search size={17} /><input value={query} onChange={event => setQuery(event.target.value)} aria-label="Find an activity event" placeholder="Search activity…" />{query && <button aria-label="Clear activity search" onClick={() => setQuery('')}><X size={15} /></button>}</label></div>
    <div className="op-audit-card"><div className="op-card-title"><div><span className="op-title-symbol"><Activity size={19} /></span><h2>Activity on this computer</h2></div><span>{shown.length} {shown.length === 1 ? 'event' : 'events'}</span></div>{shown.length ? <div className="op-table-scroll"><table className="op-audit-table"><thead><tr><th scope="col">Event</th><th scope="col">Device & details</th><th scope="col">Result</th><th scope="col">Time</th></tr></thead><tbody>{shown.map((entry, index) => { const Icon = eventIcon(entry.action); const failed = /denied|fail|error|reject/i.test(entry.outcome || ''); const date = new Date(entry.timestamp); return <tr key={entry.id || `${entry.timestamp}-${index}`}><td><span className="op-event-name"><span className="op-event-icon"><Icon size={17} /></span>{eventName(entry.action)}</span></td><td><strong>{entry.deviceName || entry.deviceId?.slice(0, 12) || 'This computer'}</strong><span>{entry.detail || 'No additional details recorded'}</span></td><td><span className={`op-result ${failed ? 'failed' : ''}`}>{entry.outcome || 'Recorded'}</span></td><td><time dateTime={entry.timestamp}>{Number.isNaN(date.getTime()) ? 'Time unavailable' : <>{DATE_FORMAT.format(date)}<span>{TIME_FORMAT.format(date)}</span></>}</time></td></tr>; })}</tbody></table></div> : <div className="op-activity-empty"><span className="op-empty-symbol"><Clock3 size={30} strokeWidth={1.5} /></span><h2>{entries.length ? 'No events match this view' : 'Your activity starts here'}</h2><p>{entries.length ? 'Try another search or show all activity.' : 'Nothing has happened yet. When you invite a computer, or one connects to this computer, it shows up here.'}</p>{entries.length > 0 ? <button className="button secondary" onClick={() => { setQuery(''); setFilter('all'); }}>Show all activity</button> : onInvite && <button className="button primary" onClick={onInvite}><Plus size={16} />Invite a computer</button>}</div>}</div>
    <div className="op-audit-footnote"><ShieldCheck size={16} aria-hidden="true" /><p>Kept only on this computer. Keeps the most recent 500 events. This list is not a tamper-proof record.</p></div>
  </section>;
}

export default ActivityPage;
