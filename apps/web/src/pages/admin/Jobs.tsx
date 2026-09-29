import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useParams } from 'react-router';
import Pager from '../../Pager';
import Select from '../../Select';
import { openAdminDownload, useAdminJob, useAdminJobs } from '../../api';
import { Err, Field, fmtCost, fmtDate, fmtDuration, fmtNum, Table, useFilters } from './ui';

const STATUSES = [['', 'Tutti gli stati'], ['queued', 'In coda'], ['running', 'In corso'], ['done', 'Completato'], ['failed', 'Fallito']] as const;
const KINDS = [['', 'Tutti i tipi'], ['summarize', 'Riassunto'], ['analyze', 'Analisi']] as const;
const LAB = [['', 'Lab e normali'], ['false', 'Solo normali'], ['true', 'Solo Lab']] as const;

export default function AdminJobs() {
  const f = useFilters();
  const filters = { status: f.get('status'), kind: f.get('kind'), lab: f.get('lab'), userId: f.get('userId'), documentId: f.get('documentId'), page: f.page };
  const jobs = useAdminJobs(filters);
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Job</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Stato" value={filters.status} onChange={(v) => f.set({ status: v })} options={STATUSES} />
        <Select label="Tipo" value={filters.kind} onChange={(v) => f.set({ kind: v })} options={KINDS} />
        <Select label="Lab" value={filters.lab} onChange={(v) => f.set({ lab: v })} options={LAB} />
      </div>
      {(filters.userId || filters.documentId) && (
        <p className="text-sm">
          {filters.userId && <>Utente: <Link className="underline" to={`/admin/users/${filters.userId}`}>{filters.userId}</Link>{' '}<button className="underline" onClick={() => f.set({ userId: '' })}>rimuovi</button>{' · '}</>}
          {filters.documentId && <>Documento: <Link className="underline" to={`/admin/documents/${filters.documentId}`}>{filters.documentId}</Link>{' '}<button className="underline" onClick={() => f.set({ documentId: '' })}>rimuovi</button></>}
        </p>
      )}
      <Err error={jobs.error} />
      <Table head={['Data', 'Tipo', 'Stato', 'Modello', 'Crediti', 'Durata', 'Utente', 'Documento']} empty={jobs.data?.items.length === 0 ? 'Nessun job trovato.' : undefined}>
        {jobs.data?.items.map((j) => (
          <tr key={j.id}>
            <td className="p-2"><Link to={`/admin/jobs/${j.id}`} className="underline">{fmtDate(j.createdAt)}</Link></td>
            <td className="p-2">{j.kind}{j.benchmarkId && ' (lab)'}</td>
            <td className={`p-2 ${j.status === 'failed' ? 'text-red-600' : ''}`}>{j.status === 'running' ? `${j.progress}%` : j.status}</td>
            <td className="p-2">{j.modelId ?? j.model ?? ''}</td><td className="p-2">{j.credits}</td><td className="p-2">{fmtDuration(j.durationMs)}</td>
            <td className="p-2"><Link to={`/admin/users/${j.user.id}`} className="underline">{j.user.email}</Link></td>
            <td className="max-w-48 truncate p-2"><Link to={`/admin/documents/${j.document.id}`} className="underline">{j.document.filename}</Link></td>
          </tr>
        ))}
      </Table>
      {jobs.data && <Pager data={jobs.data} onPage={f.setPage} />}
    </section>
  );
}

// usage is aggregated by phase: either { draft: {...}, verify: {...} } or a list with a `phase` field.
function usageRows(u: unknown): [string, Record<string, number>][] {
  if (Array.isArray(u)) return u.map((r, i) => [String(r.phase ?? i), r]);
  if (u && typeof u === 'object') return Object.entries(u as Record<string, Record<string, number>>);
  return [];
}

export function AdminJobPage() {
  const { id } = useParams();
  const job = useAdminJob(id);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  const done = job.data?.status === 'done';
  useEffect(() => {
    if (!done) return;
    // not api(): the response is markdown, not JSON
    fetch(`/api/admin/jobs/${id}/content`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setContent, () => setContent(null));
  }, [done, id]);
  const download = (format: 'md' | 'docx') => { setError(''); openAdminDownload(`/admin/jobs/${id}/download?format=${format}`).catch((e) => setError(e.message)); };

  const j = job.data;
  if (job.error) return <p className="text-red-600">{job.error.message}</p>;
  if (!j) return <p>Caricamento…</p>;
  const usage = usageRows(j.usage);
  return (
    <section className="space-y-5">
      <div>
        <Link to="/admin/jobs" className="text-sm underline">← Job</Link>
        <h1 className="text-xl font-semibold">Job {j.kind}{j.benchmarkId && ' (lab)'}</h1>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded border bg-white p-4 text-sm sm:grid-cols-3">
        <Field label="Stato"><span className={j.status === 'failed' ? 'text-red-600' : ''}>{j.status} · {j.phase} · {j.progress}%</span></Field>
        <Field label="Utente"><Link className="underline" to={`/admin/users/${j.user.id}`}>{j.user.email}</Link></Field>
        <Field label="Documento"><Link className="underline" to={`/admin/documents/${j.document.id}`}>{j.document.filename}</Link></Field>
        <Field label="Modello">{j.modelId ?? '—'}{j.model && <span className="font-mono text-xs"> ({j.model})</span>}</Field>
        <Field label="Crediti">{j.credits}</Field><Field label="Tentativi">{j.attempts}</Field>
        <Field label="Creato">{fmtDate(j.createdAt)}</Field><Field label="Finito">{fmtDate(j.finishedAt)}</Field><Field label="Durata">{fmtDuration(j.durationMs)}</Field>
        <Field label="Token in / out">{fmtNum(j.inputTokens)} / {fmtNum(j.outputTokens)}</Field><Field label="Costo stimato">{fmtCost(j.costUsd)}</Field>
        {j.benchmarkId && <Field label="Lab"><Link className="underline" to={`/admin/benchmarks/${j.benchmarkId}`}>apri run</Link></Field>}
      </dl>
      {j.error && <p className="break-words text-red-600">{j.error}</p>}
      {j.warnings?.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-medium">Avvisi</p>
          <ul className="list-disc pl-5">{j.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
      <div>
        <h2 className="mb-1 font-medium">Opzioni</h2>
        <pre className="overflow-x-auto rounded border bg-white p-3 text-xs">{JSON.stringify(j.options, null, 2)}</pre>
      </div>
      {usage.length > 0 && (
        <>
          <h2 className="font-medium">Utilizzo LLM</h2>
          <Table head={['Fase', 'Chiamate', 'Fallite', 'Token in', 'Token out', 'Durata']}>
            {usage.map(([phase, u]) => (
              <tr key={phase}>
                <td className="p-2">{phase}</td><td className="p-2">{fmtNum(u.calls)}</td><td className="p-2">{fmtNum(u.failedCalls)}</td>
                <td className="p-2">{fmtNum(u.inputTokens)}</td><td className="p-2">{fmtNum(u.outputTokens)}</td><td className="p-2">{fmtDuration(u.durationMs)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
      {j.ledger?.length > 0 && (
        <>
          <h2 className="font-medium">Movimenti crediti</h2>
          <Table head={['Data', 'Tipo', 'Crediti']}>
            {j.ledger.map((l) => <tr key={l.id}><td className="p-2">{fmtDate(l.createdAt)}</td><td className="p-2">{l.type}</td><td className="p-2">{l.amount}</td></tr>)}
          </Table>
        </>
      )}
      {done && (
        <div className="space-y-3">
          <div className="flex gap-3">
            <button onClick={() => download('md')} className="rounded bg-black px-4 py-2 text-white">Scarica .md</button>
            <button onClick={() => download('docx')} className="rounded bg-black px-4 py-2 text-white">Scarica .docx</button>
          </div>
          {error && <p className="text-red-600">{error}</p>}
          {content && <div className="prose-summary rounded border bg-white p-4"><Markdown disallowedElements={['img']}>{content}</Markdown></div>}
        </div>
      )}
    </section>
  );
}
