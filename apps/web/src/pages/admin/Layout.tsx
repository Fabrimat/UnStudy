import { NavLink, Outlet } from 'react-router';

const TABS = [['/admin', 'Panoramica'], ['/admin/users', 'Utenti'], ['/admin/documents', 'Documenti'], ['/admin/jobs', 'Job'], ['/admin/models', 'Modelli'], ['/admin/lab', 'Lab']] as const;

export default function AdminLayout() {
  return (
    <div className="space-y-5">
      <nav className="flex gap-4 overflow-x-auto border-b pb-2 text-sm">
        {TABS.map(([to, text]) => (
          <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => `whitespace-nowrap ${isActive ? 'font-semibold underline' : 'hover:underline'}`}>{text}</NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
