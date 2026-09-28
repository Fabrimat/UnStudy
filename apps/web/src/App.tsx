import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router';
import { api, Me, useMe } from './api';
import Dashboard from './pages/Dashboard';
import DocumentPage from './pages/DocumentPage';
import JobPage from './pages/JobPage';
import Login from './pages/Login';
import Verify from './pages/Verify';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/verify" element={<Verify />} />
      <Route element={<RequireUser />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
      </Route>
    </Routes>
  );
}

function RequireUser() {
  const me = useMe();
  if (me.isPending) return <p className="p-8">Loading…</p>;
  if (me.error) return <Navigate to="/login" replace />;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Header me={me.data} />
      <Outlet />
    </div>
  );
}

function Header({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  async function logout() {
    await api('/auth/logout', { method: 'POST' });
    qc.clear();
    navigate('/login');
  }
  return (
    <header className="flex items-center justify-between border-b pb-3">
      <Link to="/" className="text-lg font-semibold">Summarize</Link>
      <div className="flex items-center gap-4 text-sm">
        <span data-testid="balance" className="rounded bg-gray-200 px-2 py-1">{me.balance} credits</span>
        <span>{me.email}</span>
        <button onClick={logout} className="underline">Log out</button>
      </div>
    </header>
  );
}
