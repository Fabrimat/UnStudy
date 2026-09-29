import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, BenchmarkDetail, lengthLabel, Lane, laneActive, LANGUAGES, methodLabel, PhaseUsage, useMethods } from '../api';

const fmtDuration = (ms: number | null) => {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const fmtCost = (c: number | null) => (c === null ? '—' : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);
const fmtTok = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const laneLabel = (l: Lane) => `#${l.index + 1}`;

export default function BenchmarkPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const methods = useMethods();
  const bench = useQuery({
    queryKey: ['admin', 'benchmarks', id],
    queryFn: () => api<BenchmarkDetail>(`/admin/benchmarks/${id}`),
    refetchInterval: (q) => (q.state.data?.lanes.some(laneActive) ? 2000 : false),
  });
  const remove = useMutation({
    mutationFn: () => api(`/admin/benchmarks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['admin', 'benchmarks', id] });
      qc.invalidateQueries({ queryKey: ['admin', 'benchmarks'] });
      navigate('/admin');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['admin', 'benchmarks', id] });
    },
  });

  if (bench.error) return <p className="text-red-600">{bench.error.message}</p>;
  if (!bench.data) return <p>Loading…</p>;
  const b = bench.data;
  const running = b.lanes.some(laneActive);
  const o = b.options;
  const lang = LANGUAGES.find(([v]) => v === o.language)?.[1] ?? String(o.language ?? '');
  const extras = Array.isArray(o.extras) && o.extras.length ? (o.extras as string[]).join(', ') : 'none';
  const done = b.lanes.filter((l) => l.status === 'done');

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin" className="text-sm underline">← Lab</Link>
          <h1 className="text-xl font-semibold">{b.name || 'Untitled run'}</h1>
          <p className="text-sm text-gray-600">
            <Link className="underline" to={`/documents/${b.document.id}`}>{b.document.filename}</Link>
            {' '}· {b.document.pages} pages · {b.document.words} words · {new Date(b.createdAt).toLocaleString()}
          </p>
          <p className="text-sm text-gray-600">
            {lang} · {lengthLabel(o)} · {methodLabel(o, methods.data)} · extras: {extras}
            {Array.isArray(o.chapters) && ` · ${o.chapters.length} part(s)`}
          </p>
        </div>
        <button
          disabled={running || remove.isPending}
          title={running ? 'Wait for all lanes to finish' : undefined}
          onClick={() => window.confirm('Delete this run and all its results?') && remove.mutate()}
          className="rounded border border-red-300 bg-white px-3 py-1 text-sm text-red-700 disabled:opacity-50"
        >
          Delete run
        </button>
      </div>
      {remove.error && (
        <p className="text-red-600">
          {remove.error instanceof ApiError && remove.error.status === 409 ? 'Some lanes are still running; try again when they finish.' : remove.error.message}
        </p>
      )}

      <MetricsTable lanes={b.lanes} />

      <div className={`grid gap-4 ${done.length > 1 ? 'md:grid-cols-2' : ''} ${done.length > 2 ? 'xl:grid-cols-3' : ''}`}>
        {b.lanes.filter((l) => l.status === 'done' || l.status === 'failed' || l.warnings.length > 0).map((l) => <LaneOutput key={l.jobId} lane={l} />)}
      </div>
    </section>
  );
}

function usageText(u: PhaseUsage | undefined, used: boolean) {
  if (!used || !u) return '—';
  return `${fmtTok(u.inputTokens)} / ${fmtTok(u.outputTokens)}${u.failedCalls ? ` (${u.failedCalls} failed)` : ''}`;
}

function MetricsTable({ lanes }: { lanes: Lane[] }) {
  const done = lanes.filter((l) => l.status === 'done');
  const fastest = Math.min(...done.filter((l) => l.durationMs !== null).map((l) => l.durationMs!));
  const priced = done.filter((l) => l.costUsd !== null).map((l) => l.costUsd!);
  const cheapest = Math.min(...priced);
  const best = 'bg-green-100 font-semibold text-green-800';
  return (
    <div className="overflow-x-auto rounded border bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-100 text-xs uppercase text-gray-600">
          <tr>
            {['Lane', 'Draft', 'Fact-check', 'Status', 'Time', 'Draft tok in/out', 'Check tok in/out', 'Est. cost', 'Warn'].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {lanes.map((l) => (
            <tr key={l.jobId} className="align-top">
              <td className="px-3 py-2 font-mono">{laneLabel(l)}</td>
              <td className="px-3 py-2"><ModelCell m={l.draft} /></td>
              <td className="px-3 py-2">{l.verify ? <ModelCell m={l.verify} /> : '—'}</td>
              <td className="min-w-32 px-3 py-2"><StatusCell lane={l} /></td>
              <td className={`whitespace-nowrap px-3 py-2 font-mono ${l.status === 'done' && l.durationMs === fastest && done.length > 1 ? best : ''}`}>
                {l.durationMs !== null ? fmtDuration(l.durationMs) : '—'}
                {l.status === 'done' && l.durationMs === fastest && done.length > 1 && ' ⚡'}
              </td>
              <td className="whitespace-nowrap px-3 py-2 font-mono">{usageText(l.usage.draft, l.usage.draft.calls > 0)}</td>
              <td className="whitespace-nowrap px-3 py-2 font-mono">{usageText(l.usage.verify, l.verify !== null)}</td>
              <td className={`whitespace-nowrap px-3 py-2 font-mono ${l.status === 'done' && l.costUsd !== null && l.costUsd === cheapest && priced.length > 1 ? best : ''}`}>
                {fmtCost(l.costUsd)}
                {l.status === 'done' && l.costUsd !== null && l.costUsd === cheapest && priced.length > 1 && ' ★'}
              </td>
              <td className="px-3 py-2 font-mono">{l.warnings.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-3 py-1 text-xs text-gray-500">⚡ fastest done lane · ★ cheapest done lane · costs are estimates from catalog prices.</p>
    </div>
  );
}

function ModelCell({ m }: { m: { label: string; provider: string; model: string } }) {
  return (
    <>
      <div className="font-medium">{m.label}</div>
      <div className="text-xs text-gray-600">{m.provider} · <span className="font-mono">{m.model}</span></div>
    </>
  );
}

function StatusCell({ lane: l }: { lane: Lane }) {
  if (l.status === 'done') return <span className="font-medium text-green-700">Done</span>;
  if (l.status === 'failed') return <span className="font-medium text-red-600" title={l.error ?? undefined}>Failed</span>;
  return (
    <div>
      <div className="h-2 w-full rounded bg-gray-200"><div className="h-2 rounded bg-black transition-all" style={{ width: `${l.progress}%` }} /></div>
      <p className="mt-1 text-xs text-gray-600">{l.progress}% · {l.status === 'queued' ? 'queued' : l.phase}</p>
    </div>
  );
}

function LaneOutput({ lane: l }: { lane: Lane }) {
  const done = l.status === 'done';
  const content = useQuery({
    queryKey: ['jobs', l.jobId, 'content'],
    enabled: done,
    staleTime: Infinity,
    // not api(): the response is markdown, not JSON
    queryFn: () => fetch(`/api/jobs/${l.jobId}/content`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`Could not load summary (${r.status})`)))),
  });
  const dl = useMutation({
    mutationFn: async (format: 'md' | 'docx') => {
      const { url } = await api<{ url: string }>(`/jobs/${l.jobId}/download?format=${format}`);
      window.location.href = url;
    },
  });
  return (
    <div className="min-w-0 space-y-2 rounded border bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          <span className="font-mono">{laneLabel(l)}</span> {l.draft.label}
          {l.verify ? ` → ${l.verify.label}` : ' (no fact-check)'}
        </h3>
        {done && (
          <div className="flex gap-2 text-xs">
            <button onClick={() => dl.mutate('md')} className="rounded bg-black px-2 py-1 text-white">.md</button>
            <button onClick={() => dl.mutate('docx')} className="rounded bg-black px-2 py-1 text-white">.docx</button>
          </div>
        )}
      </div>
      {dl.error && <p className="text-xs text-red-600">{dl.error.message}</p>}
      {l.status === 'failed' && <p className="text-sm text-red-600">{l.error ?? 'Failed'}</p>}
      {l.warnings.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-amber-700">{l.warnings.length} warning{l.warnings.length === 1 ? '' : 's'}</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{l.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {done && content.error && <p className="text-sm text-red-600">{content.error.message}</p>}
      {done && content.isPending && <p className="text-sm text-gray-600">Loading…</p>}
      {content.data && (
        <div className="prose-summary max-h-[70vh] overflow-y-auto rounded border p-3">
          <Markdown disallowedElements={['img']}>{content.data}</Markdown>
        </div>
      )}
    </div>
  );
}
