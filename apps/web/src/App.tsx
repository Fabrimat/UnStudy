import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router';
import { api, Me, useMe } from './api';
import AdminLab from './pages/AdminLab';
import BenchmarkPage from './pages/BenchmarkPage';
import Credits from './pages/Credits';
import Dashboard from './pages/Dashboard';
import DocumentPage from './pages/DocumentPage';
import Documents from './pages/Documents';
import JobPage from './pages/JobPage';
import Jobs from './pages/Jobs';
import Login from './pages/Login';
import Methods from './pages/Methods';
import Settings from './pages/Settings';
import Verify from './pages/Verify';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/verify" element={<Verify />} />
      <Route element={<RequireUser />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/credits" element={<Credits />} />
        <Route path="/methods" element={<Methods />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
        <Route element={<RequireAdmin />}>
          <Route path="/admin" element={<AdminLab />} />
          <Route path="/admin/benchmarks/:id" element={<BenchmarkPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

function RequireUser() {
  const me = useMe();
  if (me.isPending) return <p className="p-8">Loading…</p>;
  if (me.error) return <Navigate to="/login" replace />;
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Header me={me.data} />
      <Outlet />
    </div>
  );
}

// UI convenience only: the server answers 404 to non-admins.
function RequireAdmin() {
  const me = useMe();
  if (me.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
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
      <nav className="flex gap-4 text-sm">
        {([['/', 'Dashboard'], ['/documents', 'Documents'], ['/jobs', 'Summaries'], ['/credits', 'Credits'], ['/methods', 'Methods'], ['/settings', 'Settings']] as const).map(([to, text]) => (
          <NavLink key={to} to={to} end className={({ isActive }) => (isActive ? 'font-semibold underline' : 'hover:underline')}>{text}</NavLink>
        ))}
        {me.role === 'admin' && (
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'font-semibold underline' : 'hover:underline')}>Admin</NavLink>
        )}
      </nav>
      <div className="flex items-center gap-4 text-sm">
        <span data-testid="balance" className="rounded bg-gray-200 px-2 py-1">{me.balance} credits</span>
        <span>{me.email}</span>
        <button onClick={logout} className="underline">Log out</button>
      </div>
    </header>
  );
}
