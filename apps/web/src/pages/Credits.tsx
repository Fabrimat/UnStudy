import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import Pager from '../Pager';
import { api, formatPrice, LedgerEntry, Page, qs, useMe, usePacks } from '../api';

const TYPE_LABEL: Record<string, string> = { purchase: 'Purchase', revoke: 'Refund (revoked)' };
const POLL_MS = 2000;
const POLL_MAX_MS = 30_000;

export default function Credits() {
  const [sp, setSp] = useSearchParams();
  const qc = useQueryClient();
  const page = Number(sp.get('page')) || 1;
  const paid = sp.get('paid') === '1';
  const me = useMe();
  const packs = usePacks();
  const ledger = useQuery({
    queryKey: ['ledger', page],
    queryFn: () => api<Page<LedgerEntry>>(`/me/ledger${qs({ page })}`),
  });
  const buy = useMutation({
    mutationFn: (packId: string) => api<{ url: string }>('/billing/checkout', { method: 'POST', body: JSON.stringify({ packId }) }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  // Back from Stripe via bfcache restores the "redirecting" state: re-enable Buy.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && buy.reset();
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, [buy.reset]);

  // After returning from Stripe the webhook may lag: refresh balance + ledger every 2 s for up to 30 s,
  // then drop ?paid=1. ponytail: stops on timeout only, not on first new purchase row.
  const started = useRef(false);
  useEffect(() => {
    if (!paid || started.current) return;
    started.current = true;
    const refresh = () => { qc.invalidateQueries({ queryKey: ['me'] }); qc.invalidateQueries({ queryKey: ['ledger'] }); };
    const tick = setInterval(refresh, POLL_MS);
    const stop = setTimeout(() => {
      clearInterval(tick);
      setSp((p) => { p.delete('paid'); return p; }, { replace: true });
    }, POLL_MAX_MS);
    refresh();
    return () => { clearInterval(tick); clearTimeout(stop); started.current = false; };
  }, [paid, qc, setSp]);

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Credits</h1>
      {paid && <p className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800">Payment received — credits will appear in a few seconds.</p>}
      {me.data && me.data.balance < 0 && (
        <p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Your balance is negative ({me.data.balance} credits), for example after a refund. You can't start new summaries until it is back above zero.
        </p>
      )}
      {packs.data?.enabled && (
        <div className="space-y-2">
          <h2 className="font-medium">Buy credits</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {packs.data.packs.map((p) => (
              <div key={p.id} className="space-y-1 rounded border bg-white p-4">
                <div className="text-lg font-semibold">{p.credits} credits</div>
                <div>{formatPrice(p.amount, p.currency)}</div>
                <div className="text-xs text-gray-500">{formatPrice(p.amount / p.credits, p.currency)} per credit</div>
                <button disabled={buy.isPending || buy.isSuccess} onClick={() => buy.mutate(p.id)} className="mt-2 rounded bg-black px-4 py-2 text-white disabled:opacity-50">
                  Buy
                </button>
              </div>
            ))}
          </div>
          {buy.isError && <p role="alert" className="text-sm text-red-600">{(buy.error as Error).message}</p>}
        </div>
      )}
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
                <td className="p-2">{TYPE_LABEL[e.type] ?? e.type}</td>
                <td className="p-2">{e.amount > 0 ? `+${e.amount}` : e.amount}</td>
                <td className="max-w-64 truncate p-2">
                  {e.jobId ? <Link to={`/jobs/${e.jobId}`} className="underline">{e.filename ?? 'Summary'}</Link> : (e.filename ?? '—')}
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
