import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import Select from '../Select';
import { api, ApiError, Doc, FRACTIONS, Job, LANGUAGES, styleOptions, uploadFailed, useMe, useMethods } from '../api';

function errorText(e: Error) {
  if (e instanceof ApiError && e.status === 402) {
    return `Not enough credits: this document needs ${e.body.needed}, you have ${e.body.balance}. Credit purchases are coming soon.`;
  }
  return e.message;
}

export default function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const methods = useMethods();
  const prefs = me.data?.preferences;
  // Picked values win; otherwise fall back to the saved preferences, then defaults.
  const [picked, setPicked] = useState<{ language?: string; fraction?: number; method?: string }>({});
  const language = picked.language ?? prefs?.language ?? 'auto';
  const fraction = picked.fraction ?? prefs?.fraction ?? 3;
  const wanted = picked.method ?? prefs?.method ?? 'studio';
  const options = styleOptions(methods.data);
  // A deleted custom method (or one not loaded yet) falls back to studio.
  const method = options.some(([v]) => v === wanted) ? wanted : 'studio';
  const [bibliographicLine, setBibliographicLine] = useState('');
  const doc = useQuery({
    queryKey: ['documents', id],
    queryFn: () => api<Doc>(`/documents/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'uploaded' && !uploadFailed(q.state.data) ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () =>
      api<Job>('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          documentId: id, language, fraction, method,
          ...(bibliographicLine.trim() ? { bibliographicLine: bibliographicLine.trim() } : {}),
        }),
      }),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ['me'] }); // the reservation just moved the header balance
      navigate(`/jobs/${job.id}`);
    },
  });

  if (doc.error) return <p className="text-red-600">{doc.error.message}</p>;
  if (!doc.data) return <p>Loading…</p>;
  const d = doc.data;
  if (d.status === 'uploaded') {
    return <p>{uploadFailed(d) ? 'Upload failed — please upload the file again' : `Analyzing ${d.filename}…`}</p>;
  }
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
        <Select label="Language" value={language} onChange={(v) => setPicked({ ...picked, language: v })} options={LANGUAGES} />
        <Select label="Length" value={fraction} onChange={(v) => setPicked({ ...picked, fraction: v })} options={FRACTIONS} />
        <Select label="Style" value={method} onChange={(v) => setPicked({ ...picked, method: v })} options={options} />
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
