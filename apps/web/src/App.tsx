import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { api, LEGAL_REQUIRED, Me, useMe } from './api';
import { t } from './i18n';
import AdminLab from './pages/AdminLab';
import { AdminDocumentPage, AdminDocuments, AdminEmails, AdminJobPage, AdminJobs, AdminLayout, AdminLegal, AdminModels, AdminOverview, AdminProviders, AdminUserPage, AdminUsers } from './pages/admin';
import BenchmarkPage from './pages/BenchmarkPage';
import Credits from './pages/Credits';
import Dashboard from './pages/Dashboard';
import DocumentPage from './pages/DocumentPage';
import Documents from './pages/Documents';
import JobPage from './pages/JobPage';
import Jobs from './pages/Jobs';
import Accept, { LegalLinks, LegalPage } from './pages/Legal';
import Login from './pages/Login';
import Methods from './pages/Methods';
import Settings from './pages/Settings';
import Verify from './pages/Verify';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/verify" element={<Verify />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} />
      <Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route element={<RequireUser />}>
        <Route path="/accept" element={<Accept />} />
        <Route path="/" element={<Dashboard />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/credits" element={<Credits />} />
        <Route path="/methods" element={<Methods />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/documents/:id" element={<DocumentPage />} />
        <Route path="/jobs/:id" element={<JobPage />} />
        <Route element={<RequireAdmin />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminOverview />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="users/:id" element={<AdminUserPage />} />
            <Route path="documents" element={<AdminDocuments />} />
            <Route path="documents/:id" element={<AdminDocumentPage />} />
            <Route path="jobs" element={<AdminJobs />} />
            <Route path="jobs/:id" element={<AdminJobPage />} />
            <Route path="models" element={<AdminModels />} />
            <Route path="providers" element={<AdminProviders />} />
            <Route path="legal" element={<AdminLegal />} />
            <Route path="emails" element={<AdminEmails />} />
            <Route path="lab" element={<AdminLab />} />
            <Route path="benchmarks/:id" element={<BenchmarkPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

function RequireUser() {
  const me = useMe();
  const qc = useQueryClient();
  const location = useLocation();
  // A 403 legal_acceptance_required from any call: refresh `me`, which then carries the pending documents.
  useEffect(() => {
    const refresh = () => qc.invalidateQueries({ queryKey: ['me'] });
    window.addEventListener(LEGAL_REQUIRED, refresh);
    return () => window.removeEventListener(LEGAL_REQUIRED, refresh);
  }, [qc]);
  if (me.isPending) return <p className="p-8">{t('common.loading')}</p>;
  if (me.error) return <Navigate to="/login" replace />;
  if (me.data.legal.pending.length && location.pathname !== '/accept') return <Navigate to="/accept" state={{ from: location }} replace />;
  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <Header me={me.data} />
      <Outlet />
      <footer className="border-t pt-3 text-xs text-gray-500"><LegalLinks /></footer>
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
      <Link to="/" className="text-lg font-semibold">{t('common.appName')}</Link>
      <nav className="flex gap-4 text-sm">
        {([['/', t('nav.dashboard')], ['/documents', t('nav.documents')], ['/jobs', t('nav.summaries')], ['/credits', t('nav.credits')], ['/methods', t('nav.methods')], ['/settings', t('nav.settings')]] as const).map(([to, text]) => (
          <NavLink key={to} to={to} end className={({ isActive }) => (isActive ? 'font-semibold underline' : 'hover:underline')}>{text}</NavLink>
        ))}
        {me.role === 'admin' && (
          <NavLink to="/admin" className={({ isActive }) => (isActive ? 'font-semibold underline' : 'hover:underline')}>{t('nav.admin')}</NavLink>
        )}
      </nav>
      <div className="flex items-center gap-4 text-sm">
        <span data-testid="balance" className="rounded bg-gray-200 px-2 py-1">{t('common.credits', { n: me.balance })}</span>
        <span>{me.email}</span>
        <button onClick={logout} className="underline">{t('nav.logout')}</button>
      </div>
    </header>
  );
}
