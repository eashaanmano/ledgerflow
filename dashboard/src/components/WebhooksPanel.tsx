import { Fragment, useState } from 'react';
import { api } from '../api';
import { relative, shortId, time } from '../format';
import { usePolling } from '../usePolling';
import type { Delivery, DeliveryDetail, DeliveryStatus, Endpoint, ReceiverState } from '../types';

// Matches MOCK_RECEIVER_SECRET in docker-compose. A real customer would keep their own secret.
const MOCK_URL = 'http://mock-receiver:4000/hooks';
const MOCK_SECRET = 'whsec_demo_receiver_secret';
const MODES = [
  { id: 'ok', label: 'Healthy' },
  { id: 'flaky', label: 'Flaky 50%' },
  { id: 'fail', label: 'Down (500)' },
  { id: 'timeout', label: 'Timeout' },
];
const FILTERS: (DeliveryStatus | 'all')[] = ['all', 'pending', 'succeeded', 'dead'];

export function WebhooksPanel() {
  const [filter, setFilter] = useState<DeliveryStatus | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeliveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const endpoints = usePolling(() => api<{ data: Endpoint[] }>('/webhooks/endpoints'), 10_000);
  const deliveries = usePolling(
    () => api<{ data: Delivery[] }>(`/webhooks/deliveries?limit=50${filter === 'all' ? '' : `&status=${filter}`}`),
    1500,
  );
  const stats = usePolling(() => api<Record<DeliveryStatus, number>>('/webhooks/deliveries/stats'), 1500);
  const receiver = usePolling(() => api<ReceiverState>('/mock-receiver/received'), 1500);
  const mode = usePolling(() => api<{ mode: string }>('/mock-receiver/config'), 3000);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    deliveries.refresh();
    stats.refresh();
    endpoints.refresh();
    mode.refresh();
  };

  const registerMock = () => act(() => api('/webhooks/endpoints', {
    method: 'POST', body: { url: MOCK_URL, secret: MOCK_SECRET, events: ['*'], description: 'Built-in mock receiver' },
  }));

  const showDetail = async (id: string) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    setDetail(await api<DeliveryDetail>(`/webhooks/deliveries/${id}`));
  };

  const hasMock = endpoints.data?.data.some((e) => e.active && e.url === MOCK_URL);
  const s = stats.data;

  return (
    <section className="card webhooks">
      <header className="card-head">
        <h2>Webhooks</h2>
        {s && (
          <div className="chips">
            <span className="chip pending">{s.pending + s.delivering} pending</span>
            <span className="chip succeeded">{s.succeeded} delivered</span>
            <span className="chip dead">{s.dead} dead-lettered</span>
          </div>
        )}
      </header>
      {error && <p className="error">{error}</p>}

      <div className="webhook-grid">
        <div className="sub">
          <h3>Mock receiver</h3>
          <p className="muted">Flip it into a failure mode, send transfers, and watch retries back off and recover.</p>
          <div className="segmented" role="radiogroup" aria-label="Receiver mode">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode.data?.mode === m.id}
                className={mode.data?.mode === m.id ? `on ${m.id}` : ''}
                onClick={() => act(() => api('/mock-receiver/config', { method: 'PUT', body: { mode: m.id } }))}>
                {m.label}
              </button>
            ))}
          </div>
          {receiver.error && <p className="muted">Receiver unreachable (stopped?). Deliveries will retry until it is back.</p>}
          {receiver.data && (
            <dl className="stats">
              <div><dt>Unique events</dt><dd className="mono">{receiver.data.uniqueEvents}</dd></div>
              <div><dt>Total POSTs</dt><dd className="mono">{receiver.data.totalPosts}</dd></div>
              <div><dt>Duplicates deduped</dt><dd className="mono">{receiver.data.duplicates}</dd></div>
              <div><dt>Bad signatures</dt><dd className="mono">{receiver.data.badSignatures}</dd></div>
            </dl>
          )}
        </div>

        <div className="sub">
          <h3>Endpoints</h3>
          {!hasMock && <button className="primary small" onClick={registerMock}>Register mock receiver</button>}
          <ul className="endpoints">
            {endpoints.data?.data.length === 0 && <li className="empty">No endpoints registered.</li>}
            {endpoints.data?.data.map((e) => (
              <li key={e.id} className={e.active ? '' : 'inactive'}>
                <div className="mono">{e.url}</div>
                <div className="subtle tiny">
                  {e.events.join(', ')} · secret {e.secretHint} · {e.active ? 'active' : 'disabled'}
                </div>
                {e.active && <button className="small" onClick={() => act(() => api(`/webhooks/endpoints/${e.id}`, { method: 'DELETE' }))}>Disable</button>}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="row between">
        <div className="tabs">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => { setFilter(f); setTimeout(deliveries.refresh); }}>{f}</button>
          ))}
        </div>
        <button className="small" disabled={!s?.dead} onClick={() => act(() => api('/webhooks/dead-letters/replay', { method: 'POST', body: {} }))}>
          Replay all dead ({s?.dead ?? 0})
        </button>
      </div>

      <table className="table deliveries">
        <thead>
          <tr><th>Event</th><th>Status</th><th className="num">Attempts</th><th>Last result</th><th>Next attempt</th><th>Created</th><th /></tr>
        </thead>
        <tbody>
          {deliveries.data?.data.length === 0 && <tr><td colSpan={7} className="empty">No deliveries yet.</td></tr>}
          {deliveries.data?.data.map((d) => (
            <Fragment key={d.id}>
              <tr className={expanded === d.id ? 'selected' : ''}>
                <td><button className="link mono" onClick={() => showDetail(d.id)}>{d.eventType} · {shortId(d.eventId)}</button></td>
                <td><span className={`badge ${d.status}`}>{d.status}</span></td>
                <td className="num mono">{d.attempts}</td>
                <td className="mono subtle">{d.lastStatusCode ?? ''}{d.lastError ? ` ${d.lastError}` : d.lastStatusCode ? '' : '—'}</td>
                <td className="mono subtle">{d.status === 'pending' ? relative(d.nextAttemptAt) : '—'}</td>
                <td className="mono subtle">{time(d.createdAt)}</td>
                <td className="actions">
                  {(d.status === 'dead' || d.status === 'succeeded') && (
                    <button className="small" onClick={() => act(() => api(`/webhooks/deliveries/${d.id}/replay`, { method: 'POST' }))}>Replay</button>
                  )}
                </td>
              </tr>
              {expanded === d.id && detail?.id === d.id && (
                <tr className="subrow">
                  <td colSpan={7}>
                    <div className="detail">
                      <table className="table inner">
                        <thead><tr><th>#</th><th>Status</th><th>Error</th><th className="num">Duration</th><th>Response</th><th>At</th></tr></thead>
                        <tbody>
                          {detail.attemptLog.map((a) => (
                            <tr key={`${a.attempt}-${a.createdAt}`}>
                              <td className="mono">{a.attempt}</td>
                              <td className="mono">{a.statusCode ?? '—'}</td>
                              <td className="mono subtle">{a.error ?? ''}</td>
                              <td className="num mono">{a.durationMs} ms</td>
                              <td className="mono subtle truncate">{a.responseSnippet ?? ''}</td>
                              <td className="mono subtle">{time(a.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <pre className="payload">{JSON.stringify(detail.payload, null, 2)}</pre>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
