import { NavLink, Outlet } from 'react-router';
import { t } from '../../i18n';

const TABS = [['/admin', 'overview'], ['/admin/users', 'users'], ['/admin/documents', 'documents'], ['/admin/jobs', 'jobs'], ['/admin/models', 'models'], ['/admin/lab', 'lab']] as const;

export default function AdminLayout() {
  return (
    <div className="space-y-5">
      <nav className="flex gap-4 overflow-x-auto border-b pb-2 text-sm">
        {TABS.map(([to, text]) => (
          <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => `whitespace-nowrap ${isActive ? 'font-semibold underline' : 'hover:underline'}`}>{t(`admin.nav.${text}`)}</NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
