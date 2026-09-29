import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import Pager from '../Pager';
import Select from '../Select';
import { api, JobWithDoc, Page, qs } from '../api';

const STATUSES = [['', 'All statuses'], ['queued', 'Queued'], ['running', 'Running'], ['done', 'Done'], ['failed', 'Failed']] as const;
const STYLES = [['', 'All styles'], ['studio', 'Study summary'], ['schematico', 'Structured notes'], ['abstract', 'Short abstract']] as const;

export default function Jobs() {
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const method = sp.get('method') ?? '';
  const page = Number(sp.get('page')) || 1;
  const [error, setError] = useState('');

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setSp(next, { replace: true });
  };

  const jobs = useQuery({
    queryKey: ['jobs', 'list', { status, method, page }],
    queryFn: () => api<Page<JobWithDoc>>(`/jobs${qs({ page, status, method })}`),
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === 'queued' || j.status === 'running') ? 3000 : false),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/jobs/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setError('');
      qc.invalidateQueries({ queryKey: ['jobs'] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (e) => setError(e.message),
  });

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Summaries</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Status" value={status} onChange={(v) => set({ status: v, page: '' })} options={STATUSES} />
        <Select label="Style" value={method} onChange={(v) => set({ method: v, page: '' })} options={STYLES} />
      </div>
      {error && <p className="text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50">
            <tr>{['Document', 'Date', 'Style', 'Length', 'Language', 'Status', 'Credits', ''].map((h) => <th key={h} className="p-2 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y">
            {jobs.data?.items.length === 0 && <tr><td colSpan={8} className="p-3 text-gray-500">No summaries found.</td></tr>}
            {jobs.data?.items.map((j) => (
              <tr key={j.id}>
                <td className="max-w-48 truncate p-2"><Link to={`/jobs/${j.id}`} className="underline">{j.document.filename}</Link></td>
                <td className="p-2">{new Date(j.createdAt).toLocaleString()}</td>
                <td className="p-2">{String(j.options.preset ?? '')}</td>
                <td className="p-2">{j.options.fraction ? `1/${j.options.fraction}` : ''}</td>
                <td className="p-2">{String(j.options.language ?? '')}</td>
                <td className="p-2">{j.status === 'running' ? `${j.progress}%` : j.status}</td>
                <td className="p-2">{j.credits}</td>
                <td className="p-2">
                  {(j.status === 'done' || j.status === 'failed') && (
                    <button
                      className="text-red-600 underline"
                      onClick={() => window.confirm(`Delete this summary of "${j.document.filename}"? This cannot be undone and used credits are not returned.`) && remove.mutate(j.id)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {jobs.data && <Pager data={jobs.data} onPage={(p) => set({ page: String(p) })} />}
    </section>
  );
}
