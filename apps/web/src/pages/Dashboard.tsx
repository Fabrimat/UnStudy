import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, busy, Doc, docStatus, JobWithDoc, Page, qs, Stats, uploadFile, useMe } from '../api';

export default function Dashboard() {
  const qc = useQueryClient();
  const me = useMe();
  const [errors, setErrors] = useState<string[]>([]);
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/me/stats') });
  const active = useQuery({
    queryKey: ['jobs', 'active'],
    queryFn: () => api<Page<JobWithDoc>>(`/jobs${qs({ active: true })}`),
    refetchInterval: (q) => (q.state.data?.items.length ? 3000 : false),
  });
  const docs = useQuery({
    queryKey: ['documents', 'recent'],
    queryFn: () => api<Page<Doc>>(`/documents${qs({ pageSize: 5 })}`),
    refetchInterval: (q) => (q.state.data?.items.some(busy) ? 3000 : false),
  });

  async function upload(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      try {
        await uploadFile(file);
      } catch (e) {
        setErrors((list) => [...list, `${file.name}: ${(e as Error).message}`]);
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ['documents'] }), qc.invalidateQueries({ queryKey: ['stats'] })]);
    }
  }

  const s = stats.data;
  const cards = [
    ['Balance', me.data ? `${me.data.balance} credits` : '…'],
    ['Documents', s?.documents],
    ['Summaries done', s?.summariesDone],
    ['Credits spent', s?.creditsSpent],
    ['Pages summarized', s?.pagesSummarized],
  ] as const;

  return (
    <section className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {cards.map(([label, value]) => (
          <div key={label} className="rounded border bg-white p-3">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-lg font-semibold">{value ?? '…'}</p>
          </div>
        ))}
      </div>
      {!!active.data?.items.length && (
        <div className="space-y-2">
          <h2 className="font-semibold">In progress</h2>
          <ul className="divide-y rounded border bg-white">
            {active.data.items.map((j) => (
              <li key={j.id} className="space-y-1 p-3">
                <Link to={`/jobs/${j.id}`} className="block truncate underline">{j.document.filename}</Link>
                <div className="h-2 w-full rounded bg-gray-200">
                  <div className="h-2 rounded bg-black transition-all" style={{ width: `${j.progress}%` }} />
                </div>
                <p className="text-xs text-gray-600">{j.progress}% · {j.status === 'queued' ? 'Waiting in queue' : j.phase}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          upload(e.dataTransfer.files);
        }}
        className="block cursor-pointer rounded-lg border-2 border-dashed bg-white p-10 text-center"
      >
        Drop PDFs here or click to choose (max 50 MB, 400 pages each)
        <input type="file" accept="application/pdf" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {errors.map((e) => <p key={e} className="text-red-600">{e}</p>)}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Recent documents</h2>
          <Link to="/documents" className="text-sm underline">All documents</Link>
        </div>
        <ul className="divide-y rounded border bg-white">
          {docs.data?.items.length === 0 && <li className="p-3 text-gray-500">No documents yet.</li>}
          {docs.data?.items.map((d) => (
            <li key={d.id} className="flex justify-between gap-4 p-3">
              <Link to={`/documents/${d.id}`} className="truncate underline">{d.filename}</Link>
              <span className="shrink-0 text-sm text-gray-600">{docStatus(d)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
