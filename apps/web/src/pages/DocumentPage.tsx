import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import LengthPicker from '../LengthPicker';
import Select from '../Select';
import {
  api, ApiError, creditsForJob, Doc, EXTRAS, Extra, Job, LANGUAGES, lengthOf, modelOptions, styleOptions, uploadFailed, useMe, useMethods, useModels,
} from '../api';
import { fmt, t } from '../i18n';

function errorText(e: Error) {
  if (e instanceof ApiError && e.status === 402) {
    return t('document.notEnough', { needed: e.body.needed, balance: e.body.balance });
  }
  return e.message;
}

type Picked = { language?: string; lengthPercent?: number; method?: string; model?: string; chapters?: number[]; extras?: Extra[]; bibliographicLine?: string };

export default function DocumentPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const from = searchParams.get('from');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const methods = useMethods();
  const models = useModels().data;
  const prefs = me.data?.preferences;
  // Job being regenerated: its options prefill the form, ahead of the saved preferences.
  const fromJob = useQuery({ queryKey: ['jobs', from], queryFn: () => api<Job>(`/jobs/${from}`), enabled: !!from });
  const fo: Record<string, unknown> = fromJob.data && fromJob.data.documentId === id ? fromJob.data.options : {};
  // Picked values win; otherwise the job being regenerated, the saved preferences, then defaults.
  const [picked, setPicked] = useState<Picked>({});
  const [formOpen, setFormOpen] = useState(false);
  const language = picked.language ?? (fo.language as string | undefined) ?? prefs?.language ?? 'auto';
  const lengthPercent = picked.lengthPercent ?? (fo.lengthPercent ? Number(fo.lengthPercent) : fo.fraction ? Math.round(100 / Number(fo.fraction)) : lengthOf(prefs));
  const wanted = picked.method ?? (fo.method as string | undefined) ?? prefs?.method ?? 'studio';
  const options = styleOptions(methods.data);
  // A deleted custom method (or one not loaded yet) falls back to studio.
  const method = options.some(([v]) => v === wanted) ? wanted : 'studio';
  const wantedModel = picked.model ?? (fo.modelId as string | undefined) ?? prefs?.model;
  // A model gone from the catalog falls back to the first one.
  const modelId = models?.find((m) => m.id === wantedModel) ?? models?.[0];
  const extras = picked.extras ?? (Array.isArray(fo.extras) ? (fo.extras as Extra[]) : []);
  const bibliographicLine = picked.bibliographicLine ?? (fo.bibliographicLine as string | undefined) ?? '';
  const doc = useQuery({
    queryKey: ['documents', id],
    queryFn: () => api<Doc>(`/documents/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'uploaded' && !uploadFailed(q.state.data) ? 2000 : false),
  });
  const chapterList = doc.data?.chapters ?? [];
  // Old jobs may point at chapters that no longer exist; those are dropped.
  const foChapters = Array.isArray(fo.chapters) ? (fo.chapters as number[]).filter((i) => i < chapterList.length) : null;
  const selected = picked.chapters ?? (foChapters?.length ? foChapters : chapterList.map((_, i) => i));
  const allSelected = selected.length === chapterList.length;
  const words = allSelected ? doc.data?.words ?? 0 : selected.reduce((n, i) => n + (chapterList[i]?.words ?? 0), 0);
  const cost = creditsForJob(words, modelId?.multiplier);
  const start = useMutation({
    mutationFn: () =>
      api<Job>('/jobs', {
        method: 'POST',
        body: JSON.stringify({
          documentId: id, language, lengthPercent, method,
          ...(allSelected ? {} : { chapters: [...selected].sort((a, b) => a - b) }),
          ...(extras.length ? { extras } : {}),
          ...(modelId ? { model: modelId.id } : {}),
          ...(bibliographicLine.trim() ? { bibliographicLine: bibliographicLine.trim() } : {}),
        }),
      }),
    onSuccess: (job) => {
      qc.invalidateQueries({ queryKey: ['me'] }); // the reservation just moved the header balance
      navigate(`/jobs/${job.id}`);
    },
  });
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  if (doc.error) return <p className="text-red-600">{doc.error.message}</p>;
  if (!doc.data) return <p>{t('common.loading')}</p>;
  const d = doc.data;
  if (d.status === 'uploaded') {
    return <p>{uploadFailed(d) ? t('api.uploadFailed') : t('document.analyzing', { name: d.filename })}</p>;
  }
  if (d.status === 'rejected') return <p>{t('document.rejected', { name: d.filename, reason: d.rejectReason ?? '' })}</p>;

  return (
    <section className="space-y-4">
      <h1 className="font-serif text-3xl font-semibold tracking-tight">{d.filename}</h1>
      <p className="text-sm text-muted">{t('document.meta', { pages: d.pages ?? '', words: d.words ?? '', parts: d.chapters?.length ?? '' })}</p>
      {d.jobs.length > 0 && (
        <div className="space-y-1">
          <h2 className="font-medium">{t('document.summaries')}</h2>
          <ul className="space-y-1 text-sm">
            {d.jobs.map((j) => (
              <li key={j.id}>
                <Link className="underline" to={`/jobs/${j.id}`}>{t('document.summaryOf', { date: fmt.date(j.createdAt) })}</Link> — {t(`jobStatus.${j.status}`)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* With past summaries the options stay behind a button; a first run or a regenerate opens them directly. */}
      {!(formOpen || from || d.jobs.length === 0) ? (
        <button onClick={() => setFormOpen(true)} className="rounded-full bg-ink px-5 py-3 text-white">{t('document.newSummary')}</button>
      ) : (<>
      {d.jobs.length > 0 && <h2 className="font-medium">{t('document.newSummary')}</h2>}
      <div className="space-y-1 text-sm">
        <p>
          {t('common.partsToSummarize')}{' '}
          <button type="button" className="underline" onClick={() => setPicked({ ...picked, chapters: chapterList.map((_, i) => i) })}>{t('common.all')}</button>{' · '}
          <button type="button" className="underline" onClick={() => setPicked({ ...picked, chapters: [] })}>{t('common.none')}</button>
        </p>
        {chapterList.map((c, i) => (
          <label key={i} className="block">
            <input type="checkbox" checked={selected.includes(i)} onChange={() => setPicked({ ...picked, chapters: toggle(selected, i) })} />{' '}
            {c.title}{c.pageFrom ? t('common.pp', { from: c.pageFrom, to: c.pageTo ?? '' }) : ''} · {t('common.words', { n: c.words })}
          </label>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label={t('common.language')} value={language} onChange={(v) => setPicked({ ...picked, language: v })} options={LANGUAGES} />
        <Select label={t('common.style')} value={method} onChange={(v) => setPicked({ ...picked, method: v })} options={options} />
        {models && models.length > 1 && modelId && <Select label={t('common.model')} value={modelId.id} onChange={(v) => setPicked({ ...picked, model: v })} options={modelOptions(models)} />}
      </div>
      <LengthPicker value={lengthPercent} onChange={(v) => setPicked({ ...picked, lengthPercent: v })} words={words} />
      <div className="text-sm">
        {t('common.extraSections')}{' '}
        {EXTRAS.map(([v, label]) => (
          <label key={v} className="mr-3">
            <input type="checkbox" checked={extras.includes(v)} onChange={() => setPicked({ ...picked, extras: toggle(extras, v) })} /> {label}
          </label>
        ))}
      </div>
      <label className="block">
        {t('common.bibLine')}
        <input
          maxLength={300}
          value={bibliographicLine}
          onChange={(e) => setPicked({ ...picked, bibliographicLine: e.target.value })}
          placeholder={t('document.bibPlaceholder')}
          className="mt-1 w-full rounded-xl border border-edge bg-white px-3 py-2.5"
        />
      </label>
      <p>{t('document.cost')} <strong>{t('common.credits', { n: cost })}</strong> · {t('document.balance', { n: me.data?.balance ?? '' })}</p>
      <button disabled={start.isPending || selected.length === 0} onClick={() => start.mutate()} className="rounded-full bg-ink px-5 py-3 text-white disabled:opacity-50">
        {t('document.start')}
      </button>
      {start.error && <p className="text-red-600">{errorText(start.error)}</p>}
      </>)}
    </section>
  );
}
