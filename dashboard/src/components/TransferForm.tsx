import { useEffect, useState } from 'react';
import { ApiError, apiWithMeta } from '../api';
import { money, parseMoney, shortId } from '../format';
import type { Account, Transfer } from '../types';

type Result =
  | { kind: 'ok'; lines: string[] }
  | { kind: 'error'; message: string; retryable: boolean };

/*
 * The idempotency key is created once per intended payment and reused on retry. A network error
 * leaves the key in place so "Retry" cannot double-charge; editing the form starts a new payment.
 */
export function TransferForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('25.00');
  const [description, setDescription] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (!from && accounts[0]) setFrom(accounts[0].id);
    if (!to && accounts[1]) setTo(accounts[1].id);
  }, [accounts, from, to]);

  const fromAccount = accounts.find((a) => a.id === from);
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setKey(crypto.randomUUID());
    setResult(null);
  };

  const send = async (copies: number) => {
    const minor = parseMoney(amount);
    if (!fromAccount || !minor) {
      setResult({ kind: 'error', message: 'Choose a source account and a positive amount (max 2 decimals).', retryable: false });
      return;
    }
    setBusy(true);
    setResult(null);
    const body = { fromAccountId: from, toAccountId: to.trim(), amount: minor, currency: fromAccount.currency, description: description || undefined };
    try {
      const responses = await Promise.all(
        Array.from({ length: copies }, () => apiWithMeta<Transfer>('/transfers', { method: 'POST', body, idempotencyKey: key })),
      );
      const ids = new Set(responses.map((r) => r.data.id));
      const lines = responses.map((r, i) =>
        `#${i + 1} → ${r.meta.status} transfer ${shortId(r.data.id)}${r.meta.replayed ? ' (replayed)' : ''} · req ${r.meta.requestId?.slice(0, 8)}`);
      if (copies > 1) lines.push(ids.size === 1 ? `Same key, ${copies} requests, one transfer. Money moved once.` : 'Unexpected: different transfer ids');
      else lines.unshift(`Sent ${money(minor, fromAccount.currency)}`);
      setResult({ kind: 'ok', lines });
      setKey(crypto.randomUUID());
      onDone();
    } catch (err) {
      const e = err as ApiError;
      const retryable = !(e instanceof ApiError) || e.status >= 500 || e.status === 429;
      setResult({ kind: 'error', message: `${e.message}${e.requestId ? ` · req ${e.requestId.slice(0, 8)}` : ''}`, retryable });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <header className="card-head"><h2>Transfer</h2></header>
      <div className="form">
        <label>
          From
          <select value={from} onChange={(e) => edit(setFrom)(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {money(a.balance, a.currency)}</option>)}
          </select>
        </label>
        <label>
          To <span className="muted">(pick or paste any account id)</span>
          <input className="mono" list="dest-accounts" value={to} onChange={(e) => edit(setTo)(e.target.value)} spellCheck={false} />
          <datalist id="dest-accounts">
            {accounts.filter((a) => a.id !== from).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </datalist>
        </label>
        <div className="row">
          <label className="grow">
            Amount {fromAccount && <span className="muted">({fromAccount.currency})</span>}
            <input className="mono" inputMode="decimal" value={amount} onChange={(e) => edit(setAmount)(e.target.value)} />
          </label>
          <label className="grow">
            Description
            <input value={description} onChange={(e) => edit(setDescription)(e.target.value)} maxLength={255} />
          </label>
        </div>
        <div className="key mono" title="Idempotency-Key header for this payment">Idempotency-Key: {key}</div>
        <div className="row">
          <button className="primary" disabled={busy || accounts.length < 1} onClick={() => send(1)}>
            {result?.kind === 'error' && result.retryable ? 'Retry with same key' : 'Send transfer'}
          </button>
          <button disabled={busy || accounts.length < 1} onClick={() => send(3)} title="Fire three identical requests at once">
            Send 3× with same key
          </button>
        </div>
        {result?.kind === 'ok' && <ul className="result mono">{result.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
        {result?.kind === 'error' && <p className="error">{result.message}</p>}
      </div>
    </section>
  );
}
