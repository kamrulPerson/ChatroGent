import { useEffect, useState } from 'react';
import ChatPage from './pages/ChatPage';
import DashboardPage from './pages/DashboardPage';
import AuditPage from './pages/AuditPage';
import LoginPage from './pages/LoginPage';
import { autoLogin, hasToken, onAuthExpired, useMock } from './api/client';

type Page = 'chat' | 'dashboard' | 'audit';
const nav: { id: Page; label: string }[] = [
  { id: 'chat', label: 'Assistant' },
  { id: 'dashboard', label: 'My money' },
  { id: 'audit', label: 'Activity log' },
];

export default function App() {
  const [page, setPage] = useState<Page>('chat');
  const [authed, setAuthed] = useState(useMock || hasToken());
  const [checking, setChecking] = useState(!useMock && !hasToken());
  const [notice, setNotice] = useState('');

  // Optional sandbox convenience: when VITE_DEMO_AUTOLOGIN=true and credentials
  // are present in the local .env, sign in automatically. Otherwise the login
  // form is shown. No credentials live in source.
  useEffect(() => {
    let alive = true;
    if (!checking) return;
    autoLogin()
      .then((ok) => { if (alive) setAuthed(ok); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the API rejects our token, clear the session and explain on the login page.
  useEffect(() => onAuthExpired(() => {
    setNotice('Your session expired. Please log in again.');
    setAuthed(false);
  }), []);

  if (checking) {
    return (
      <div className="shell">
        <aside className="rail"><div className="brand">RemitWise</div></aside>
        <main className="main"><p className="empty">Loading…</p></main>
      </div>
    );
  }

  if (!useMock && !authed) return <LoginPage notice={notice} onSuccess={() => { setNotice(''); setAuthed(true); }} />;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">RemitWise</div>
        <nav aria-label="Main">
          {nav.map((n) => (
            <button key={n.id} className={'navbtn' + (page === n.id ? ' on' : '')} aria-current={page === n.id ? 'page' : undefined} onClick={() => setPage(n.id)}>
              {n.label}
            </button>
          ))}
        </nav>
        <p className="railnote">Wireframe v0. All figures are sample data in a sandbox. No real money moves.</p>
      </aside>
      <main className="main">
        {page === 'chat' && <ChatPage />}
        {page === 'dashboard' && <DashboardPage />}
        {page === 'audit' && <AuditPage />}
      </main>
    </div>
  );
}
