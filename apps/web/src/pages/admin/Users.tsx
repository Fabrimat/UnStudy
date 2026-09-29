import { useState } from 'react';
import { Link, useParams } from 'react-router';
import Pager from '../../Pager';
import { ApiError, useAdminCredits, useAdminUser, useAdminUsers } from '../../api';
import { Err, Field, fmtDate, inputCls, Table, useFilters } from './ui';

export default function AdminUsers() {
  const f = useFilters();
  const q = f.get('q');
  const users = useAdminUsers(q, f.page);
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Utenti</h1>
      <input value={q} onChange={(e) => f.set({ q: e.target.value })} placeholder="Cerca per email o nome…" className={inputCls} />
      <Err error={users.error} />
      <Table head={['Email', 'Nome', 'Ruolo', 'Registrato', 'Ultimo accesso', 'Crediti', 'Documenti', 'Job']} empty={users.data?.items.length === 0 ? 'Nessun utente trovato.' : undefined}>
        {users.data?.items.map((u) => (
          <tr key={u.id} className={u.deletedAt ? 'text-gray-400' : ''}>
            <td className="p-2"><Link to={`/admin/users/${u.id}`} className="underline">{u.email}</Link>{u.deletedAt && ' (eliminato)'}</td>
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
    const text = `${n > 0 ? 'Aggiungere' : 'Togliere'} ${Math.abs(n)} crediti a ${u.email}?\nNota: ${note.trim()}`;
    if (window.confirm(text)) credits.mutate({ amount: n, note: note.trim() }, { onSuccess: () => { setAmount(''); setNote(''); } });
  }

  if (user.error) return <p className="text-red-600">{user.error.message}</p>;
  if (!u) return <p>Caricamento…</p>;
  const err = credits.error;
  return (
    <section className="space-y-5">
      <div>
        <Link to="/admin/users" className="text-sm underline">← Utenti</Link>
        <h1 className="text-xl font-semibold">{u.email}{u.deletedAt && ' (eliminato)'}</h1>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded border bg-white p-4 text-sm sm:grid-cols-3">
        <Field label="Nome">{u.name ?? '—'}</Field><Field label="Ruolo">{u.role}</Field><Field label="Crediti"><span data-testid="admin-balance" className="font-semibold">{u.balance}</span></Field>
        <Field label="Registrato">{fmtDate(u.createdAt)}</Field><Field label="Ultimo accesso">{fmtDate(u.lastActiveAt)}</Field>
        <Field label="Eliminato">{fmtDate(u.deletedAt)}</Field>
        <Field label="Documenti"><Link className="underline" to={`/admin/documents?userId=${u.id}`}>{u.documents}</Link></Field>
        <Field label="Job"><Link className="underline" to={`/admin/jobs?userId=${u.id}`}>{u.jobs}</Link></Field>
        <Field label="Preferenze"><span className="font-mono text-xs">{JSON.stringify(u.preferences)}</span></Field>
      </dl>

      <form onSubmit={submit} className="space-y-3 rounded border bg-white p-4">
        <h2 className="font-medium">Aggiungi / togli crediti</h2>
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr_auto]">
          <label className="block text-sm">Crediti (+/−)
            <input type="number" step={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="es. 50 o -10" className={inputCls} />
          </label>
          <label className="block text-sm">Nota (obbligatoria)
            <input maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
          </label>
          <button disabled={!valid || !!u.deletedAt || credits.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50 sm:mt-6">Applica</button>
        </div>
        {err && (
          <p className="text-red-600">
            {err.message}{err instanceof ApiError && err.status === 409 && typeof err.body?.balance === 'number' ? ` (saldo attuale: ${err.body.balance})` : ''}
          </p>
        )}
        {credits.isSuccess && <p className="text-sm text-green-700">Fatto. Nuovo saldo: {credits.data.balance}</p>}
      </form>

      <h2 className="font-medium">Movimenti recenti</h2>
      <Table head={['Data', 'Tipo', 'Crediti', 'Nota', 'Admin', 'Job']} empty={u.ledger.length === 0 ? 'Nessun movimento.' : undefined}>
        {u.ledger.map((l) => (
          <tr key={l.id}>
            <td className="p-2">{fmtDate(l.createdAt)}</td><td className="p-2">{l.type}</td>
            <td className={`p-2 ${l.amount < 0 ? 'text-red-600' : 'text-green-700'}`}>{l.amount > 0 ? `+${l.amount}` : l.amount}</td>
            <td className="max-w-64 truncate p-2" title={l.note ?? undefined}>{l.note ?? ''}</td><td className="p-2">{l.adminEmail ?? ''}</td>
            <td className="p-2">{l.jobId && <Link className="underline" to={`/admin/jobs/${l.jobId}`}>apri</Link>}</td>
          </tr>
        ))}
      </Table>
    </section>
  );
}
