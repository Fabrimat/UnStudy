import { NavLink, Outlet } from 'react-router';
import { fmt, t } from '../../i18n';

const TABS = [['/admin', 'overview'], ['/admin/users', 'users'], ['/admin/documents', 'documents'], ['/admin/jobs', 'jobs'], ['/admin/models', 'models'], ['/admin/providers', 'providers'], ['/admin/legal', 'legal'], ['/admin/emails', 'emails'], ['/admin/lab', 'lab']] as const;

export default function AdminLayout() {
  return (
    <div className="space-y-5">
      <nav className="flex gap-4 overflow-x-auto border-b pb-2 text-sm">
        {TABS.map(([to, text]) => (
          <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => `whitespace-nowrap ${isActive ? 'font-semibold underline' : 'hover:underline'}`}>{t(`admin.nav.${text}`)}</NavLink>
        ))}
      </nav>
      <Outlet />
      <p className="border-t pt-2 text-xs text-gray-500">
        {t('admin.build', { time: fmt.date(__BUILD_TIME__) })}
        {__COMMIT__ && (
          <>
            {' · '}
            <a href={`https://github.com/Fabrimat/UnStudy/commit/${__COMMIT__}`} target="_blank" rel="noreferrer" className="font-mono hover:underline">{__COMMIT__.slice(0, 7)}</a>
          </>
        )}
      </p>
    </div>
  );
}
