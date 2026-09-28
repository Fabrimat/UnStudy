import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, ApiError, Doc, Job, useMe } from '../api';

const LANGUAGES = [['auto', 'Same as the document'], ['en', 'English'], ['it', 'Italian'], ['nl', 'Dutch'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish']] as const;
const FRACTIONS = [[3, '1/3 of the original'], [5, '1/5 of the original'], [10, '1/10 of the original']] as const;
const PRESETS = [['studio', 'Study summary (continuous prose)'], ['schematico', 'Structured notes (bullet points)'], ['abstract', 'Short abstract']] as const;

function Select<T extends string | number>(props: { label: string; value: T; onChange: (v: T) => void; options: readonly (readonly [T, string])[] }) {
  return (
    <label className="block">
      {props.label}
      <select
        className="mt-1 w-full rounded border bg-white p-2"
        value={props.value}
        onChange={(e) => props.onChange((typeof props.value === 'number' ? Number(e.target.value) : e.target.value) as T)}
      >
        {props.options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

function errorText(e: Error) {
  if (e instanceof ApiError && e.status === 402) {
    return `Not enough credits: this document needs ${e.body.needed}, you have ${e.body.balance}. Credit purchases are coming soon.`;
  }
  return e.message;
}

export default function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const [language, setLanguage] = useState<string>('auto');
  const [fraction, setFraction] = useState<number>(3);
  const [preset, setPreset] = useState<string>('studio');
  const [bibliographicLine, setBibliographicLine] = useState('');
  const doc = useQuery({
    queryKey: ['documents', id],
    queryFn: () => api<Doc>(`/documents/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'uploaded' ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () =>
      api<Job>('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          documentId: id, language, fraction, preset,
          ...(bibliographicLine.trim() ? { bibliographicLine: bibliographicLine.trim() } : {}),
        }),
      }),
    onSuccess: (job) => navigate(`/jobs/${job.id}`),
  });

  if (doc.error) return <p className="text-red-600">{doc.error.message}</p>;
  if (!doc.data) return <p>Loading…</p>;
  const d = doc.data;
  if (d.status === 'uploaded') return <p>Analyzing {d.filename}…</p>;
  if (d.status === 'rejected') return <p>{d.filename} was rejected: {d.rejectReason}</p>;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{d.filename}</h1>
      <p className="text-sm text-gray-600">{d.pages} pages · {d.words} words · {d.chapters?.length} part(s)</p>
      <ol className="list-decimal space-y-1 pl-6 text-sm">
        {d.chapters?.map((c, i) => (
          <li key={i}>{c.title}{c.pageFrom ? ` (pp. ${c.pageFrom}–${c.pageTo})` : ''} · {c.words} words</li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Language" value={language} onChange={setLanguage} options={LANGUAGES} />
        <Select label="Length" value={fraction} onChange={setFraction} options={FRACTIONS} />
        <Select label="Style" value={preset} onChange={setPreset} options={PRESETS} />
      </div>
      <label className="block">
        Bibliographic line (optional)
        <input
          maxLength={300}
          value={bibliographicLine}
          onChange={(e) => setBibliographicLine(e.target.value)}
          placeholder="**Arend Lijphart** – *Patterns of Democracy*, Yale University Press, 2012"
          className="mt-1 w-full rounded border bg-white p-2"
        />
      </label>
      <p>Cost: <strong>{d.credits} credits</strong> · Your balance: {me.data?.balance} credits</p>
      <button disabled={start.isPending} onClick={() => start.mutate()} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">
        Start summary
      </button>
      {start.error && <p className="text-red-600">{errorText(start.error)}</p>}
      {d.jobs.length > 0 && (
        <ul className="space-y-1 text-sm">
          {d.jobs.map((j) => (
            <li key={j.id}>
              <Link className="underline" to={`/jobs/${j.id}`}>Summary of {new Date(j.createdAt).toLocaleString()}</Link> — {j.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
