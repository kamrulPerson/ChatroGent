import { useState } from 'react';
import { api } from '../api/client';

export default function LoginPage({ onSuccess, notice }: { onSuccess: () => void; notice?: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api.login(email.trim(), password);
      onSuccess();
    } catch (err: any) {
      setError(err?.message || 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">RemitWise</div>
        <p className="railnote">Sandbox sign-in. No real money moves.</p>
      </aside>
      <main className="main">
        <section className="card login" aria-label="Sign in">
          <h1>Sign in</h1>
          <p className="fine">Use a sandbox demo account provided with this build.</p>
          {notice && <p className="msg notice" role="status">{notice}</p>}
          <form onSubmit={submit}>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <p className="msg notice" role="alert">{error}</p>}
            <button className="btn primary" type="submit" disabled={busy || !email || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
        </section>
      </main>
    </div>
  );
}
