import { useState } from 'react';
import { api } from '../api';
import { money, parseMoney, shortId, time } from '../format';
import type { Account } from '../types';

interface Line {
  entryId: number;
  transferId: string;
  amount: number;
  balanceAfter: number;
  counterpartyAccountId: string;
  kind: string;
  description?: string;
  createdAt: string;
}

export function AccountsPanel({ accounts, onChange }: { accounts: Account[]; onChange: () => void }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [depositFor, setDepositFor] = useState<string | null>(null);
  const [depositAmount, setDepositAmount] = useState('1000');

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/accounts', { method: 'POST', body: { name: name.trim(), currency } });
      setName('');
      onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const deposit = async (accountId: string) => {
    const amount = parseMoney(depositAmount);
    if (!amount) return setError('Enter a positive amount with up to 2 decimals');
    setError(null);
    try {
      await api('/deposits', { method: 'POST', body: { accountId, amount, description: 'Dashboard top-up' }, idempotencyKey: crypto.randomUUID() });
      setDepositFor(null);
      onChange();
      if (open === accountId) toggle(accountId, true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggle = async (id: string, keepOpen = false) => {
    if (open === id && !keepOpen) return setOpen(null);
    setOpen(id);
    const res = await api<{ data: Line[] }>(`/accounts/${id}/transactions?limit=10`);
    setLines(res.data);
  };

  return (
    <section className="card">
      <header className="card-head">
        <h2>Accounts</h2>
        <span className="muted">{accounts.length}</span>
      </header>

      <form className="row" onSubmit={create}>
        <input placeholder="Account name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} aria-label="Currency">
          {['USD', 'INR', 'EUR'].map((c) => <option key={c}>{c}</option>)}
        </select>
        <button disabled={!name.trim()}>Create</button>
      </form>
      {error && <p className="error">{error}</p>}

      <table className="table">
        <thead>
          <tr><th>Name</th><th>ID</th><th className="num">Balance</th><th /></tr>
        </thead>
        <tbody>
          {accounts.length === 0 && (
            <tr><td colSpan={4} className="empty">No accounts yet. Create two, fund one, then send a transfer.</td></tr>
          )}
          {accounts.map((a) => (
            <AccountRow key={a.id} a={a} open={open === a.id} lines={open === a.id ? lines : []}
              onToggle={() => toggle(a.id)}
              depositing={depositFor === a.id} depositAmount={depositAmount} setDepositAmount={setDepositAmount}
              onDepositStart={() => setDepositFor(depositFor === a.id ? null : a.id)} onDeposit={() => deposit(a.id)} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AccountRow(props: {
  a: Account; open: boolean; lines: Line[]; onToggle: () => void;
  depositing: boolean; depositAmount: string; setDepositAmount: (v: string) => void; onDepositStart: () => void; onDeposit: () => void;
}) {
  const { a } = props;
  return (
    <>
      <tr className={props.open ? 'selected' : ''}>
        <td><button className="link" onClick={props.onToggle}>{a.name}</button></td>
        <td>
          <button className="link mono subtle" title="Copy account id" onClick={() => navigator.clipboard?.writeText(a.id)}>
            {shortId(a.id)}
          </button>
        </td>
        <td className="num mono">{money(a.balance, a.currency)}</td>
        <td className="actions"><button className="small" onClick={props.onDepositStart}>Fund</button></td>
      </tr>
      {props.depositing && (
        <tr className="subrow">
          <td colSpan={4}>
            <div className="row">
              <span className="muted">Deposit from external funding account</span>
              <input className="mono narrow" value={props.depositAmount} onChange={(e) => props.setDepositAmount(e.target.value)} />
              <button className="small primary" onClick={props.onDeposit}>Deposit {a.currency}</button>
            </div>
          </td>
        </tr>
      )}
      {props.open && (
        <tr className="subrow">
          <td colSpan={4}>
            {props.lines.length === 0 ? <span className="muted">No entries yet.</span> : (
              <table className="table inner">
                <tbody>
                  {props.lines.map((l) => (
                    <tr key={l.entryId}>
                      <td className="mono subtle">{time(l.createdAt)}</td>
                      <td>{l.kind === 'DEPOSIT' ? 'Deposit' : l.amount < 0 ? `To ${shortId(l.counterpartyAccountId)}` : `From ${shortId(l.counterpartyAccountId)}`}</td>
                      <td className={`num mono ${l.amount < 0 ? 'debit' : 'credit'}`}>{money(l.amount, a.currency)}</td>
                      <td className="num mono subtle">{money(l.balanceAfter, a.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
