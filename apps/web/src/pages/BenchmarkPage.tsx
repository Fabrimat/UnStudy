import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, BenchmarkDetail, lengthLabel, Lane, laneActive, LANGUAGES, methodLabel, PhaseUsage, Scores, useMethods } from '../api';
import { fmt, t } from '../i18n';

const fmtDuration = (ms: number | null) => {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
const fmtCost = (c: number | null) => (c === null ? '—' : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);
const fmtTok = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const f1 = (n: number) => n.toFixed(1);
const scoreLine = (s: Scores) => t('benchmark.scoreLine', { accuracy: f1(s.accuracy), coverage: f1(s.coverage), concision: f1(s.concision), structure: f1(s.structure) });
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
      navigate('/admin/lab');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) qc.invalidateQueries({ queryKey: ['admin', 'benchmarks', id] });
    },
  });

  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation({
    mutationFn: (name: string) => api(`/admin/benchmarks/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['admin', 'benchmarks'] });
    },
  });

  if (bench.error) return <p className="text-red-600">{bench.error.message}</p>;
  if (!bench.data) return <p>{t('common.loading')}</p>;
  const b = bench.data;
  const running = b.lanes.some(laneActive);
  const o = b.options;
  const lang = LANGUAGES.find(([v]) => v === o.language)?.[1] ?? String(o.language ?? '');
  const extras = Array.isArray(o.extras) && o.extras.length ? (o.extras as string[]).join(', ') : t('benchmark.extrasNone');
  const done = b.lanes.filter((l) => l.status === 'done');

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin/lab" className="text-sm underline">{t('benchmark.backToLab')}</Link>
          {draft === null ? (
            <h1 className="text-xl font-semibold">
              {b.name || t('adminLab.untitled')}
              <button onClick={() => { rename.reset(); setDraft(b.name ?? ''); }} className="ml-3 rounded border bg-white px-2 py-0.5 align-middle text-xs font-normal">{t('benchmark.rename')}</button>
            </h1>
          ) : (
            <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); rename.mutate(draft); }}>
              <input
                autoFocus
                value={draft}
                maxLength={80}
                placeholder={t('benchmark.namePlaceholder')}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setDraft(null)}
                className="rounded border px-2 py-1 text-lg font-semibold"
              />
              <button type="submit" disabled={rename.isPending} className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50">{t('common.save')}</button>
              <button type="button" onClick={() => setDraft(null)} className="rounded border bg-white px-3 py-1 text-sm">{t('common.cancel')}</button>
            </form>
          )}
          {rename.error && <p className="text-sm text-red-600">{rename.error.message}</p>}
          <p className="text-sm text-gray-600">
            <Link className="underline" to={`/documents/${b.document.id}`}>{b.document.filename}</Link>
            {' '}· {t('benchmark.docMeta', { pages: b.document.pages ?? '', words: b.document.words ?? '' })} · {fmt.date(b.createdAt)}
          </p>
          <p className="text-sm text-gray-600">
            {lang} · {lengthLabel(o)} · {methodLabel(o, methods.data)} · {t('benchmark.extras', { extras })}
            {Array.isArray(o.chapters) && ` · ${t('common.parts', { n: o.chapters.length })}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <span title={t('benchmark.waitLanes')} className="rounded border bg-white px-3 py-1 text-sm opacity-50">{t('benchmark.downloadZip')}</span>
          ) : (
            <a href={`/api/admin/benchmarks/${b.id}/zip`} download className="rounded border bg-white px-3 py-1 text-sm">{t('benchmark.downloadZip')}</a>
          )}
        <button
          disabled={running || remove.isPending}
          title={running ? t('benchmark.waitLanes') : undefined}
          onClick={() => window.confirm(t('benchmark.confirmDelete')) && remove.mutate()}
          className="rounded border border-red-300 bg-white px-3 py-1 text-sm text-red-700 disabled:opacity-50"
        >
          {t('benchmark.deleteRun')}
        </button>
        </div>
      </div>
      {remove.error && (
        <p className="text-red-600">
          {remove.error instanceof ApiError && remove.error.status === 409 ? t('benchmark.stillRunning') : remove.error.message}
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
  return `${fmtTok(u.inputTokens)} / ${fmtTok(u.outputTokens)}${u.failedCalls ? t('benchmark.failedCalls', { n: u.failedCalls }) : ''}`;
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
            {[t('benchmark.colLane'), t('benchmark.colDraft'), t('benchmark.colFactCheck'), t('common.status'), t('benchmark.colTime'), t('benchmark.colDraftTok'), t('benchmark.colCheckTok'), t('benchmark.colCost'), t('benchmark.colScore'), t('benchmark.colWarn')].map((h) => <th key={h} className="whitespace-nowrap px-3 py-2">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y">
          {lanes.map((l) => (
            <tr key={l.jobId} className="align-top">
              <td className="px-3 py-2 font-mono">{laneLabel(l)}{l.harness && <Badge />}</td>
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
                {l.judgeCostUsd !== null && l.judgeCostUsd > 0 && <span className="block text-xs font-normal text-gray-600">{t('benchmark.judgeCost', { cost: fmtCost(l.judgeCostUsd) })}</span>}
                {l.status === 'done' && l.costUsd !== null && l.costUsd === cheapest && priced.length > 1 && ' ★'}
              </td>
              <td className="whitespace-nowrap px-3 py-2"><ScoreCell lane={l} /></td>
              <td className="px-3 py-2 font-mono">{l.warnings.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t px-3 py-1 text-xs text-gray-500">{t('benchmark.legend')} {t('benchmark.scoreLegend')}</p>
    </div>
  );
}

function ScoreCell({ lane: l }: { lane: Lane }) {
  const ev = l.evaluation;
  if (!ev) return <span className="text-gray-500">—</span>;
  if (!ev.scores || ev.overall === null) return <span className="text-xs text-gray-500" title={ev.error ?? undefined}>{t('benchmark.judgeFailed', { error: ev.error ?? '' })}</span>;
  return (
    <>
      <div className="font-mono font-semibold">{f1(ev.overall)}</div>
      <div className="font-mono text-xs text-gray-600">{scoreLine(ev.scores)}</div>
    </>
  );
}

function Badge() {
  return <span className="ml-1 rounded bg-indigo-100 px-1 text-xs font-normal text-indigo-800">{t('benchmark.harness')}</span>;
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
  if (l.status === 'done') return <span className="font-medium text-green-700">{t('common.done')}</span>;
  if (l.status === 'failed') return (
    <div>
      <span className="font-medium text-red-600">{t('common.failed')}</span>
      {l.error && <p className="mt-1 break-words text-xs text-red-600">{l.error}</p>}
    </div>
  );
  return (
    <div>
      <div className="h-2 w-full rounded bg-gray-200"><div className="h-2 rounded bg-black transition-all" style={{ width: `${l.progress}%` }} /></div>
      <p className="mt-1 text-xs text-gray-600">{l.progress}% · {l.status === 'queued' ? t('jobStatus.queued') : l.phase}</p>
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
    queryFn: () => fetch(`/api/jobs/${l.jobId}/content`, { credentials: 'same-origin' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(t('benchmark.couldNotLoadSummary', { status: r.status }))))),
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
          <span className="font-mono">{laneLabel(l)}</span> {l.draft.label}{l.harness && <Badge />}
          {l.verify ? ` → ${l.verify.label}` : t('benchmark.noFactCheck')}
        </h3>
        {done && (
          <div className="flex gap-2 text-xs">
            <button onClick={() => dl.mutate('md')} className="rounded bg-black px-2 py-1 text-white">.md</button>
            <button onClick={() => dl.mutate('docx')} className="rounded bg-black px-2 py-1 text-white">.docx</button>
          </div>
        )}
      </div>
      {dl.error && <p className="text-xs text-red-600">{dl.error.message}</p>}
      {l.status === 'failed' && <p className="text-sm text-red-600">{l.error ?? t('common.failed')}</p>}
      {l.warnings.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-amber-700">{t(l.warnings.length === 1 ? 'benchmark.warningOne' : 'benchmark.warningOther', { n: l.warnings.length })}</summary>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs">{l.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {l.evaluation && (
        <details className="text-sm">
          <summary className="cursor-pointer">{t('benchmark.evalDetails')} · {t('benchmark.judgeNote', { judge: l.evaluation.judge })}</summary>
          {l.evaluation.error && <p className="mt-1 text-xs text-gray-500">{t('benchmark.judgeFailed', { error: l.evaluation.error })}</p>}
          <ul className="mt-1 space-y-1 text-xs">
            {l.evaluation.chapters.map((c) => (
              <li key={c.index}>
                <span className="font-medium">{t('benchmark.chapterScores', { title: c.title, scores: c.scores ? scoreLine(c.scores) : t('benchmark.noScore') })}</span>
                {c.issues.length > 0 && <ul className="list-disc pl-5 text-gray-600">{c.issues.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {done && content.error && <p className="text-sm text-red-600">{content.error.message}</p>}
      {done && content.isPending && <p className="text-sm text-gray-600">{t('common.loading')}</p>}
      {content.data && (
        <div className="prose-summary max-h-[70vh] overflow-y-auto rounded border p-3">
          <Markdown disallowedElements={['img']}>{content.data}</Markdown>
        </div>
      )}
    </div>
  );
}
