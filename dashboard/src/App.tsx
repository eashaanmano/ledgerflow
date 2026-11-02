import { useCallback, useEffect, useState } from 'react';
import { api, hasStoredKey, logout, restoreSession } from './api';
import { AccountsPanel } from './components/AccountsPanel';
import { LiveFeed } from './components/LiveFeed';
import { Login } from './components/Login';
import { StatusBar } from './components/StatusBar';
import { TransferForm } from './components/TransferForm';
import { WebhooksPanel } from './components/WebhooksPanel';
import { useEventStream } from './useEventStream';
import { usePolling } from './usePolling';
import type { Account, LedgerEvent } from './types';

export function App() {
  const [clientId, setClientId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(hasStoredKey);

  useEffect(() => {
    if (!restoring) return;
    restoreSession()
      .then(setClientId, () => logout())
      .finally(() => setRestoring(false));
  }, [restoring]);

  if (restoring) return <div className="login"><p className="muted">Connecting…</p></div>;
  if (!clientId) return <Login onLogin={setClientId} />;
  return <Dashboard clientId={clientId} onLogout={() => { logout(); setClientId(null); }} />;
}

function Dashboard({ clientId, onLogout }: { clientId: string; onLogout: () => void }) {
  const accounts = usePolling(() => api<{ data: Account[] }>('/accounts'), 5000);
  const [events, setEvents] = useState<LedgerEvent[]>([]);

  const onEvent = useCallback((e: LedgerEvent) => {
    setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [e, ...prev].slice(0, 60)));
    accounts.refresh();
  }, [accounts.refresh]);
  const connected = useEventStream(onEvent);

  const list = accounts.data?.data ?? [];
  return (
    <div className="app">
      <StatusBar clientId={clientId} onLogout={onLogout} />
      <main className="layout">
        <div className="col">
          <AccountsPanel accounts={list} onChange={accounts.refresh} />
          <TransferForm accounts={list} onDone={accounts.refresh} />
        </div>
        <LiveFeed events={events} connected={connected} />
        <WebhooksPanel />
      </main>
    </div>
  );
}
