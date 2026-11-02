import { money, shortId, time } from '../format';
import type { Account, LedgerEvent, Transfer } from '../types';

export function LiveFeed({ events, connected }: { events: LedgerEvent[]; connected: boolean }) {
  return (
    <section className="card feed">
      <header className="card-head">
        <h2>Live events</h2>
        <span className={`dot ${connected ? 'on' : 'off'}`} title={connected ? 'SSE connected' : 'Reconnecting'} />
        <span className="muted">{connected ? 'streaming' : 'reconnecting…'}</span>
      </header>
      <ol className="events">
        {events.length === 0 && <li className="empty">Events appear here the moment the outbox relay publishes them.</li>}
        {events.map((e) => (
          <li key={e.id} className="event">
            <div className="event-top">
              <span className={`tag ${e.type.replace('.', '-')}`}>{e.type}</span>
              <span className="mono subtle">{time(e.createdAt)}</span>
            </div>
            <div className="event-body">{describe(e)}</div>
            <div className="mono subtle tiny">evt {shortId(e.id)}{e.requestId ? ` · req ${e.requestId.slice(0, 8)}` : ''}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function describe(e: LedgerEvent) {
  if (e.type === 'transfer.completed') {
    const t = e.data as Transfer;
    const amount = <strong className="mono">{money(t.amount, t.currency)}</strong>;
    return t.kind === 'DEPOSIT'
      ? <>Deposit of {amount} into {shortId(t.toAccountId)}</>
      : <>{amount} {shortId(t.fromAccountId)} → {shortId(t.toAccountId)}{t.description ? ` · ${t.description}` : ''}</>;
  }
  if (e.type === 'account.created') {
    const a = e.data as Account;
    return <>Account <strong>{a.name}</strong> opened ({a.currency})</>;
  }
  return e.type;
}
