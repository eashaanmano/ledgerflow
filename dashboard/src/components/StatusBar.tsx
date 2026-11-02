import { api } from '../api';
import { time } from '../format';
import { usePolling } from '../usePolling';
import type { BreakerSnapshot, ReconciliationRun } from '../types';

export function StatusBar({ clientId, onLogout }: { clientId: string; onLogout: () => void }) {
  const recon = usePolling(() => api<ReconciliationRun | undefined>('/admin/reconciliation/latest'), 10_000);
  const health = usePolling(async () => {
    const res = await fetch('/gateway-health');
    return (await res.json()) as { breakers: BreakerSnapshot[] };
  }, 3000);

  const runNow = async () => {
    await api('/admin/reconciliation/run', { method: 'POST' });
    recon.refresh();
  };

  const r = recon.data;
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden>◧</span> LedgerFlow</div>
      <div className="status">
        {health.data?.breakers.map((b) => (
          <span key={b.name} className={`chip breaker ${b.state.toLowerCase()}`} title={`${b.failures}/${b.total} failures in window`}>
            {b.name}: {b.state.replace('_', '-').toLowerCase()}
          </span>
        ))}
        <button className={`chip recon ${r ? (r.ok ? 'ok' : 'bad') : ''}`} onClick={runNow} title="Run reconciliation now">
          {r ? (r.ok ? `Ledger balanced · ${time(r.finished_at)}` : `MISMATCH: sum ${r.total_sum}, ${r.mismatched_accounts} accounts`) : 'Reconcile'}
        </button>
        <span className="mono subtle">{clientId}</span>
        <button className="small" onClick={onLogout}>Sign out</button>
      </div>
    </header>
  );
}
