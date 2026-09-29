import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import Pager from '../Pager';
import { api, LedgerEntry, Page, qs } from '../api';

export default function Credits() {
  const [sp, setSp] = useSearchParams();
  const page = Number(sp.get('page')) || 1;
  const ledger = useQuery({
    queryKey: ['ledger', page],
    queryFn: () => api<Page<LedgerEntry>>(`/me/ledger${qs({ page })}`),
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Credits</h1>
      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50">
            <tr>{['Date', 'Type', 'Amount', 'Document'].map((h) => <th key={h} className="p-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y">
            {ledger.data?.items.length === 0 && <tr><td colSpan={4} className="p-3 text-gray-500">No transactions yet.</td></tr>}
            {ledger.data?.items.map((e) => (
              <tr key={e.id}>
                <td className="p-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="p-2">{e.type}</td>
                <td className="p-2">{e.amount > 0 ? `+${e.amount}` : e.amount}</td>
                <td className="max-w-64 truncate p-2">
                  {e.jobId ? <Link to={`/jobs/${e.jobId}`} className="underline">{e.filename ?? 'Summary'}</Link> : (e.filename ?? '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ledger.data && <Pager data={ledger.data} onPage={(p) => setSp(p > 1 ? { page: String(p) } : {})} />}
    </section>
  );
}
