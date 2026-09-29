import { ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { fmt } from '../../i18n';

export const fmtDate = (s: string | null | undefined) => (s ? fmt.date(s) : '—');
export const fmtCost = (c: number | null | undefined) => (c === null || c === undefined ? '—' : `$${c.toFixed(c < 1 ? 4 : 2)}`);
export const fmtDuration = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}min`);
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? '—' : fmt.number(n));

export const inputCls = 'mt-1 w-full rounded border bg-white p-2';
export const btnCls = 'rounded border bg-white px-3 py-1 text-sm disabled:opacity-50';

// Query-string backed filters: `get` reads a value, `set` patches values and resets the page.
export function useFilters() {
  const [sp, setSp] = useSearchParams();
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries({ page: '', ...patch })) v ? next.set(k, v) : next.delete(k);
    setSp(next, { replace: true });
  };
  return { get: (k: string) => sp.get(k) ?? '', page: Number(sp.get('page')) || 1, set, setPage: (p: number) => set({ page: String(p) }), sp };
}

export function Err({ error }: { error?: Error | null }) {
  return error ? <p className="text-red-600">{error.message}</p> : null;
}

// Horizontally scrollable table inside its container (mobile-safe).
export function Table({ head, empty, children, cols }: { head: string[]; empty?: string; children: ReactNode; cols?: number }) {
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="w-full whitespace-nowrap text-left text-sm">
        <thead className="border-b bg-gray-50"><tr>{head.map((h, i) => <th key={i} className="p-2 font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y">
          {children}
          {empty && <tr><td colSpan={cols ?? head.length} className="p-3 text-gray-500">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt className="text-xs text-gray-500">{label}</dt><dd className="break-words">{children}</dd></div>;
}
