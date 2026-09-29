import { useState } from 'react';
import { Link, useParams } from 'react-router';
import Pager from '../../Pager';
import { t } from '../../i18n';
import { ApiError, useAdminCredits, useAdminUser, useAdminUsers } from '../../api';
import { Err, Field, fmtDate, inputCls, Table, useFilters } from './ui';

export default function AdminUsers() {
  const f = useFilters();
  const q = f.get('q');
  const users = useAdminUsers(q, f.page);
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('admin.nav.users')}</h1>
      <input value={q} onChange={(e) => f.set({ q: e.target.value })} placeholder={t('admin.users.search')} className={inputCls} />
      <Err error={users.error} />
      <Table head={[t('admin.users.email'), t('admin.common.name'), t('admin.common.role'), t('admin.users.registered'), t('admin.users.lastActive'), t('admin.common.credits'), t('admin.common.documents'), t('admin.common.jobs')]} empty={users.data?.items.length === 0 ? t('admin.users.none') : undefined}>
        {users.data?.items.map((u) => (
          <tr key={u.id} className={u.deletedAt ? 'text-gray-400' : ''}>
            <td className="p-2"><Link to={`/admin/users/${u.id}`} className="underline">{u.email}</Link>{u.deletedAt && t('admin.common.deletedTag')}</td>
            <td className="p-2">{u.name ?? ''}</td><td className="p-2">{u.role}</td>
            <td className="p-2">{fmtDate(u.createdAt)}</td><td className="p-2">{fmtDate(u.lastActiveAt)}</td>
            <td className="p-2">{u.balance}</td><td className="p-2">{u.documents}</td><td className="p-2">{u.jobs}</td>
          </tr>
        ))}
      </Table>
      {users.data && <Pager data={users.data} onPage={f.setPage} />}
    </section>
  );
}

export function AdminUserPage() {
  const { id } = useParams();
  const user = useAdminUser(id);
  const credits = useAdminCredits(id!);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const n = Number(amount);
  const valid = Number.isInteger(n) && n !== 0 && Math.abs(n) <= 100000 && note.trim().length > 0;
  const u = user.data;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!u || !valid) return;
    const text = t(n > 0 ? 'admin.users.confirmAdd' : 'admin.users.confirmRemove', { n: Math.abs(n), email: u.email, note: note.trim() });
    if (window.confirm(text)) credits.mutate({ amount: n, note: note.trim() }, { onSuccess: () => { setAmount(''); setNote(''); } });
  }

  if (user.error) return <p className="text-red-600">{user.error.message}</p>;
  if (!u) return <p>{t('common.loading')}</p>;
  const err = credits.error;
  return (
    <section className="space-y-5">
      <div>
        <Link to="/admin/users" className="text-sm underline">← {t('admin.nav.users')}</Link>
        <h1 className="text-xl font-semibold">{u.email}{u.deletedAt && t('admin.common.deletedTag')}</h1>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded border bg-white p-4 text-sm sm:grid-cols-3">
        <Field label={t('admin.common.name')}>{u.name ?? '—'}</Field><Field label={t('admin.common.role')}>{u.role}</Field><Field label={t('admin.common.credits')}><span data-testid="admin-balance" className="font-semibold">{u.balance}</span></Field>
        <Field label={t('admin.users.registered')}>{fmtDate(u.createdAt)}</Field><Field label={t('admin.users.lastActive')}>{fmtDate(u.lastActiveAt)}</Field>
        <Field label={t('admin.users.deleted')}>{fmtDate(u.deletedAt)}</Field>
        <Field label={t('admin.common.documents')}><Link className="underline" to={`/admin/documents?userId=${u.id}`}>{u.documents}</Link></Field>
        <Field label={t('admin.common.jobs')}><Link className="underline" to={`/admin/jobs?userId=${u.id}`}>{u.jobs}</Link></Field>
        <Field label={t('admin.users.preferences')}><span className="font-mono text-xs">{JSON.stringify(u.preferences)}</span></Field>
      </dl>

      <form onSubmit={submit} className="space-y-3 rounded border bg-white p-4">
        <h2 className="font-medium">{t('admin.users.adjust')}</h2>
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto]">
          <label className="block text-sm">{t('admin.users.amount')}
            <input type="number" step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t('admin.users.amountHint')} className={inputCls} />
          </label>
          <label className="block text-sm">{t('admin.users.note')}
            <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
          </label>
          <button disabled={!valid || !!u.deletedAt || credits.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50 sm:mt-6">{t('admin.users.apply')}</button>
        </div>
        {err && (
          <p className="text-red-600">
            {err.message}{err instanceof ApiError && err.status === 409 && typeof err.body?.balance === 'number' ? t('admin.users.currentBalance', { n: err.body.balance }) : ''}
          </p>
        )}
        {credits.isSuccess && <p className="text-sm text-green-700">{t('admin.users.newBalance', { n: credits.data.balance })}</p>}
      </form>

      <h2 className="font-medium">{t('admin.users.recent')}</h2>
      <Table head={[t('common.date'), t('admin.common.type'), t('admin.common.credits'), t('admin.users.noteCol'), t('admin.users.admin'), t('admin.common.jobs')]} empty={u.ledger.length === 0 ? t('admin.users.noLedger') : undefined}>
        {u.ledger.map((l) => (
          <tr key={l.id}>
            <td className="p-2">{fmtDate(l.createdAt)}</td><td className="p-2">{l.type}</td>
            <td className={`p-2 ${l.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>{l.amount > 0 ? `+${l.amount}` : l.amount}</td>
            <td className="max-w-64 truncate p-2" title={l.note ?? undefined}>{l.note ?? ''}</td><td className="p-2">{l.adminEmail ?? ''}</td>
            <td className="p-2">{l.jobId && <Link className="underline" to={`/admin/jobs/${l.jobId}`}>{t('admin.common.open')}</Link>}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}
