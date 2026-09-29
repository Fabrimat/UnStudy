import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import Pager from '../Pager';
import Select from '../Select';
import { api, busy, Doc, docStatus, Page, qs } from '../api';

const STATUSES = [['', 'All statuses'], ['analyzing', 'Analyzing'], ['ready', 'Ready'], ['rejected', 'Rejected'], ['summarized', 'Summarized']] as const;
const SORTS = [['createdAt:desc', 'Newest first'], ['createdAt:asc', 'Oldest first'], ['filename:asc', 'Name A–Z'], ['filename:desc', 'Name Z–A']] as const;

export default function Documents() {
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const status = sp.get('status') ?? '';
  const sort = sp.get('sort') ?? 'createdAt:desc';
  const page = Number(sp.get('page')) || 1;
  const [search, setSearch] = useState(q);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');

  const set = (patch: Record<string, string>) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
      return next;
    }, { replace: true });
  };

  useEffect(() => {
    const t = setTimeout(() => search !== q && set({ q: search, page: '' }), 300);
    return () => clearTimeout(t);
  }, [search]);

  const [sortBy, order] = sort.split(':');
  const docs = useQuery({
    queryKey: ['documents', 'list', { q, status, sort, page }],
    queryFn: () => api<Page<Doc>>(`/documents${qs({ page, q, status, sort: sortBy, order })}`),
    refetchInterval: (query) => (query.state.data?.items.some(busy) ? 3000 : false),
  });

  const done = () => {
    setError('');
    qc.invalidateQueries({ queryKey: ['documents'] });
    qc.invalidateQueries({ queryKey: ['stats'] });
  };
  const fail = (e: Error) => setError(e.message); // a 409 carries the API's explanation
  const rename = useMutation({
    mutationFn: (r: { id: string; name: string }) => api(`/documents/${r.id}`, { method: 'PATCH', body: JSON.stringify({ filename: r.name.trim() }) }),
    onSuccess: () => { setRenaming(null); done(); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/documents/${id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError: fail,
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Documents</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          Search
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="File name" className="mt-1 w-full rounded border bg-white p-2" />
        </label>
        <Select label="Status" value={status} onChange={(v) => set({ status: v, page: '' })} options={STATUSES} />
        <Select label="Sort" value={sort} onChange={(v) => set({ sort: v, page: '' })} options={SORTS} />
      </div>
      {error && <p className="text-red-600">{error}</p>}
      <ul className="divide-y rounded border bg-white">
        {docs.data?.items.length === 0 && <li className="p-3 text-gray-500">No documents found.</li>}
        {docs.data?.items.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-4 p-3">
            {renaming?.id === d.id ? (
              <input
                autoFocus
                maxLength={200}
                value={renaming.name}
                onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renaming.name.trim()) rename.mutate(renaming);
                  if (e.key === 'Escape') setRenaming(null);
                }}
                className="min-w-0 flex-1 rounded border bg-white p-1"
              />
            ) : (
              <Link to={`/documents/${d.id}`} className="truncate underline">{d.filename}</Link>
            )}
            <span className="hidden shrink-0 text-sm text-gray-600 sm:inline">{docStatus(d)}</span>
            <span className="flex shrink-0 gap-3 text-sm">
              <button className="underline" onClick={() => setRenaming({ id: d.id, name: d.filename })}>Rename</button>
              <button
                className="text-red-600 underline"
                onClick={() => window.confirm(`Delete "${d.filename}" and all its summaries? This cannot be undone and used credits are not returned.`) && remove.mutate(d.id)}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      {docs.data && <Pager data={docs.data} onPage={(p) => set({ page: String(p) })} />}
    </section>
  );
}
