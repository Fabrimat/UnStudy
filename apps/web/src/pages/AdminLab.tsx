import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import LengthPicker from '../LengthPicker';
import Pager from '../Pager';
import Select from '../Select';
import {
  AdminModel, api, BenchmarkDetail, BenchmarkSummary, Doc, EXTRAS, Extra, LANGUAGES, LaneSpec, Page, priceHint, qs, styleOptions,
  useAdminModels, useMethods,
} from '../api';

const MAX_LANES = 8;
type LaneDraft = { draft: string; verify: string }; // verify: 'same' | 'none' | model id

const toSpec = (l: LaneDraft): LaneSpec => ({ draft: l.draft, verify: l.verify === 'same' ? l.draft : l.verify === 'none' ? null : l.verify });

export default function AdminLab() {
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Lab</h1>
        <p className="text-sm text-gray-600">Run one summary across several model lanes in parallel and compare speed, cost and output. Lab runs cost no credits.</p>
      </div>
      <NewRun />
      <PastRuns />
    </section>
  );
}

function NewRun() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const methods = useMethods();
  const admin = useAdminModels();
  const models = (admin.data?.models ?? []).filter((m) => m.enabled);
  const [docQ, setDocQ] = useState('');
  const docs = useQuery({
    queryKey: ['documents', 'list', 'lab', 'ready', docQ],
    queryFn: () => api<Page<Doc>>(`/documents${qs({ q: docQ, status: 'ready' })}`),
  });
  const docList = (docs.data?.items ?? []).filter((d) => d.status === 'analyzed');
  const [documentId, setDocumentId] = useState('');
  const doc = docList.find((d) => d.id === documentId) ?? docList[0];
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('auto');
  const [lengthPercent, setLengthPercent] = useState(33);
  const [wantedMethod, setMethod] = useState('studio');
  const styles = styleOptions(methods.data);
  const method = styles.some(([v]) => v === wantedMethod) ? wantedMethod : 'studio';
  const [extras, setExtras] = useState<Extra[]>([]);
  const [bibliographicLine, setBib] = useState('');
  const [chapters, setChapters] = useState<number[] | null>(null); // null = all
  const [lanes, setLanes] = useState<LaneDraft[]>([]);

  const chapterList = doc?.chapters ?? [];
  const selected = chapters ?? chapterList.map((_, i) => i);
  const allSelected = selected.length === chapterList.length;
  const words = allSelected ? doc?.words ?? 0 : selected.reduce((n, i) => n + (chapterList[i]?.words ?? 0), 0);
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const firstModel = models[0]?.id ?? '';
  const shown: LaneDraft[] = lanes.length ? lanes : firstModel ? [{ draft: firstModel, verify: 'same' }] : [];
  const setLane = (i: number, patch: Partial<LaneDraft>) => setLanes(shown.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const start = useMutation({
    mutationFn: () =>
      api<BenchmarkDetail>('/admin/benchmarks', {
        method: 'POST',
        body: JSON.stringify({
          documentId: doc!.id, language, lengthPercent, method,
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(allSelected ? {} : { chapters: [...selected].sort((a, b) => a - b) }),
          ...(extras.length ? { extras } : {}),
          ...(bibliographicLine.trim() ? { bibliographicLine: bibliographicLine.trim() } : {}),
          lanes: shown.map(toSpec),
        }),
      }),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['admin', 'benchmarks'] });
      navigate(`/admin/benchmarks/${b.id}`);
    },
  });

  const modelText = (m: AdminModel) => `${m.label} · ${m.provider}/${m.model}${m.adminOnly ? ' · admin-only' : ''}`;
  const modelOpts = models.map((m) => [m.id, modelText(m)] as const);
  const byId = (id: string) => models.find((m) => m.id === id);

  return (
    <div className="space-y-4 rounded border bg-white p-4">
      <h2 className="font-medium">New run</h2>
      {admin.error && <p className="text-red-600">{admin.error.message}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block">
            Document
            <input value={docQ} onChange={(e) => setDocQ(e.target.value)} placeholder="Filter by name…" className="mt-1 w-full rounded border bg-white p-2" />
          </label>
          <select
            className="mt-1 w-full rounded border bg-white p-2"
            value={doc?.id ?? ''}
            onChange={(e) => { setDocumentId(e.target.value); setChapters(null); }}
          >
            {docList.length === 0 && <option value="">No analyzed documents</option>}
            {docList.map((d) => <option key={d.id} value={d.id}>{d.filename} ({d.words} words)</option>)}
          </select>
        </div>
        <label className="block">
          Run name (optional)
          <input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border bg-white p-2" />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select label="Language" value={language} onChange={setLanguage} options={LANGUAGES} />
        <Select label="Style" value={method} onChange={setMethod} options={styles} />
      </div>
      <LengthPicker value={lengthPercent} onChange={setLengthPercent} words={words} />
      <div className="text-sm">
        Extra sections:{' '}
        {EXTRAS.map(([v, label]) => (
          <label key={v} className="mr-3">
            <input type="checkbox" checked={extras.includes(v)} onChange={() => setExtras(toggle(extras, v))} /> {label}
          </label>
        ))}
      </div>
      {chapterList.length > 1 && (
        <details className="text-sm">
          <summary className="cursor-pointer">Parts to summarize ({selected.length}/{chapterList.length})</summary>
          <div className="mt-1 space-y-1">
            <p>
              <button type="button" className="underline" onClick={() => setChapters(null)}>All</button>{' · '}
              <button type="button" className="underline" onClick={() => setChapters([])}>None</button>
            </p>
            {chapterList.map((c, i) => (
              <label key={i} className="block">
                <input type="checkbox" checked={selected.includes(i)} onChange={() => setChapters(toggle(selected, i))} />{' '}
                {c.title}{c.pageFrom ? ` (pp. ${c.pageFrom}–${c.pageTo})` : ''} · {c.words} words
              </label>
            ))}
          </div>
        </details>
      )}
      <label className="block text-sm">
        Bibliographic line (optional)
        <input maxLength={300} value={bibliographicLine} onChange={(e) => setBib(e.target.value)} className="mt-1 w-full rounded border bg-white p-2" />
      </label>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Lanes ({shown.length}/{MAX_LANES})</h3>
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              disabled={models.length === 0}
              onClick={() => setLanes(models.slice(0, MAX_LANES).map((m) => ({ draft: m.id, verify: 'same' })))}
              className="rounded border bg-white px-3 py-1 disabled:opacity-50"
              title={models.length > MAX_LANES ? `Only the first ${MAX_LANES} models fit` : undefined}
            >
              One lane per model
            </button>
            <button
              type="button"
              disabled={shown.length >= MAX_LANES || !firstModel}
              onClick={() => setLanes([...shown, { draft: firstModel, verify: 'same' }])}
              className="rounded border bg-white px-3 py-1 disabled:opacity-50"
            >
              + Add lane
            </button>
          </div>
        </div>
        {shown.map((l, i) => {
          const d = byId(l.draft);
          const v = l.verify === 'same' ? d : l.verify === 'none' ? undefined : byId(l.verify);
          return (
            <div key={i} className="grid items-start gap-3 rounded border bg-gray-50 p-3 sm:grid-cols-[2rem_1fr_1fr_auto]">
              <span className="pt-2 font-mono text-sm text-gray-500">#{i + 1}</span>
              <div>
                <Select label="Draft model" value={l.draft} onChange={(x) => setLane(i, { draft: x })} options={modelOpts} />
                {d && <p className="mt-1 text-xs text-gray-600">{d.provider} · <span className="font-mono">{d.model}</span> · {priceHint(d)}</p>}
              </div>
              <div>
                <Select
                  label="Fact-check model"
                  value={l.verify}
                  onChange={(x) => setLane(i, { verify: x })}
                  options={[['same', 'Same as draft'], ['none', 'None — skip fact-check'], ...modelOpts]}
                />
                <p className="mt-1 text-xs text-gray-600">
                  {v ? <>{v.provider} · <span className="font-mono">{v.model}</span> · {priceHint(v)}</> : 'No fact-check pass'}
                </p>
              </div>
              <button
                type="button"
                disabled={shown.length <= 1}
                onClick={() => setLanes(shown.filter((_, j) => j !== i))}
                className="rounded border bg-white px-3 py-2 text-sm disabled:opacity-50 sm:mt-6"
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>

      <button
        disabled={start.isPending || !doc || shown.length === 0 || selected.length === 0}
        onClick={() => start.mutate()}
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
      >
        Start run ({shown.length} lane{shown.length === 1 ? '' : 's'})
      </button>
      {start.error && <p className="text-red-600">{start.error.message}</p>}
    </div>
  );
}

function PastRuns() {
  const [page, setPage] = useState(1);
  const runs = useQuery({
    queryKey: ['admin', 'benchmarks', 'list', page],
    queryFn: () => api<Page<BenchmarkSummary>>(`/admin/benchmarks${qs({ page })}`),
    refetchInterval: (q) => (q.state.data?.items.some((b) => b.running > 0) ? 3000 : false),
  });
  if (runs.error) return <p className="text-red-600">{runs.error.message}</p>;
  if (!runs.data) return <p>Loading…</p>;
  return (
    <div className="space-y-3">
      <h2 className="font-medium">Past runs</h2>
      {runs.data.items.length === 0 ? (
        <p className="text-sm text-gray-600">No runs yet.</p>
      ) : (
        <ul className="divide-y rounded border bg-white text-sm">
          {runs.data.items.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div>
                <Link className="font-medium underline" to={`/admin/benchmarks/${b.id}`}>{b.name || 'Untitled run'}</Link>
                <p className="text-xs text-gray-600">{b.document.filename} · {new Date(b.createdAt).toLocaleString()}</p>
              </div>
              <p className="font-mono text-xs">
                {b.lanes} lanes ·{' '}
                <span className="text-green-700">{b.done} done</span> ·{' '}
                <span className={b.failed ? 'text-red-600' : ''}>{b.failed} failed</span> ·{' '}
                <span className={b.running ? 'text-amber-700' : ''}>{b.running} running</span>
              </p>
            </li>
          ))}
        </ul>
      )}
      {runs.data.total > runs.data.pageSize && <Pager data={runs.data} onPage={setPage} />}
    </div>
  );
}
