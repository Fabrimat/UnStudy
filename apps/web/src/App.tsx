import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { LEGAL_REQUIRED, Me, useLogout, useMe } from './api';
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
import { Logo } from './ui';

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
    <div className="flex min-h-screen flex-col gap-6 px-4 pb-24 pt-4 sm:pb-10 sm:pl-[116px] sm:pr-7 sm:pt-6 lg:pr-10 nav:px-10 nav:pt-7">
      <TabBar />
      <Rail />
      <Header me={me.data} />
      <div className="mx-auto w-full min-w-0 max-w-[1240px] flex-1"><Outlet /></div>
      <footer className="mx-auto w-full max-w-[1240px] border-t border-line pt-2 text-[13px] text-muted">
        <LegalLinks />
        <p className="pb-2">© 2026 {t('common.appName')}</p>
      </footer>
    </div>
  );
}

// UI convenience only: the server answers 404 to non-admins.
function RequireAdmin() {
  const me = useMe();
  if (me.data?.role !== 'admin') return <Navigate to="/" replace />;
  return <Outlet />;
}

const NAV = [
  ['/', 'nav.home', 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  ['/documents', 'nav.docs', 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5'],
  ['/jobs', 'nav.summaries', 'M4 6h16 M4 12h16 M4 18h10'],
  ['/credits', 'nav.credits', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v10 M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4'],
  ['/settings', 'nav.settings', 'M4 7h10 M18 7h2 M4 17h2 M10 17h10 M14 5v4 M6 15v4'],
] as const;

const Icon = ({ d }: { d: string }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

function TabBar() {
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-white px-1 pb-[env(safe-area-inset-bottom)] sm:hidden">
      {NAV.map(([to, label, d]) => (
        <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `relative flex min-h-16 min-w-0 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${isActive ? 'font-bold text-ink' : 'text-muted'}`}>
          {({ isActive }) => (
            <>
              <span className={`absolute -top-px h-[3px] w-7 rounded-b-[3px] ${isActive ? 'bg-accent' : 'bg-transparent'}`} />
              <Icon d={d} />
              {t(label)}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function Rail() {
  return (
    <nav aria-label="Main" className="fixed inset-y-0 left-0 z-10 hidden w-[88px] flex-col gap-1.5 border-r border-line bg-white px-2 py-5 sm:flex nav:hidden">
      <Link to="/" aria-label={t('common.appName')} className="flex justify-center pb-4"><Logo size={36} /></Link>
      {NAV.map(([to, label, d]) => (
        <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `flex min-h-16 flex-col items-center justify-center gap-1 rounded-[14px] text-[11px] font-medium ${isActive ? 'bg-ink text-white' : 'text-muted hover:bg-alt'}`}>
          <Icon d={d} />
          {t(label)}
        </NavLink>
      ))}
    </nav>
  );
}

function Header({ me }: { me: Me }) {
  const logout = useLogout();
  const pill = ({ isActive }: { isActive: boolean }) => `rounded-full px-4 py-3 ${isActive ? 'bg-ink text-white' : 'text-soft hover:bg-alt'}`;
  return (
    <header className="mx-auto flex w-full max-w-[1240px] items-center justify-between gap-x-6 gap-y-3 sm:justify-end nav:justify-between">
      <Link to="/" className="flex items-center gap-2.5 text-[22px] font-bold tracking-tight sm:hidden nav:flex"><Logo />{t('common.appName')}</Link>
      <nav aria-label="Main" className="hidden gap-1 text-sm font-medium nav:flex">
        {([['/', t('nav.dashboard')], ['/documents', t('nav.documents')], ['/jobs', t('nav.summaries')], ['/credits', t('nav.credits')], ['/methods', t('nav.methods')], ['/settings', t('nav.settings')]] as const).map(([to, text]) => (
          <NavLink key={to} to={to} end={to === '/'} className={pill}>{text}</NavLink>
        ))}
        {me.role === 'admin' && <NavLink to="/admin" className={pill}>{t('nav.admin')}</NavLink>}
      </nav>
      <div className="flex items-center gap-4 text-sm">
        <span data-testid="balance" className="flex items-center gap-2 rounded-full border border-[#D8CFE0] bg-white px-3.5 py-2 font-mono text-[13px]">
          <span className="size-2 rounded-full bg-ink shadow-[0_0_0_3px_#C93C20]" />{t('common.credits', { n: me.balance })}
        </span>
        <span className="hidden text-muted sm:inline">{me.email}</span>
        <button onClick={logout} className="hidden py-2.5 underline underline-offset-[3px] sm:inline">{t('nav.logout')}</button>
      </div>
    </header>
  );
}
