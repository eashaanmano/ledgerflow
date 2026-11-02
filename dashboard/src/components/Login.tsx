import { useState } from 'react';
import { ApiError, login } from '../api';

export function Login({ onLogin }: { onLogin: (clientId: string) => void }) {
  const [key, setKey] = useState('sk_test_demo');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(key));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'That API key was not accepted.' : 'Gateway is not reachable.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden>◧</span> LedgerFlow
        </div>
        <p className="muted">Sign in with an API key. It is exchanged for a 15-minute token and only kept for this tab.</p>
        <label>
          API key
          <input className="mono" value={key} onChange={(e) => setKey(e.target.value)} autoFocus spellCheck={false} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy || !key.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="hint mono">Demo key: sk_test_demo</p>
      </form>
    </div>
  );
}
