import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import { api, Doc, Job, lengthLabel } from '../api';
import { fmt, t } from '../i18n';
import { Chip } from '../ui';

export default function JobPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = (e) => {
      const next: Job = JSON.parse(e.data);
      setJob(next);
      if (next.status === 'done' || next.status === 'failed') {
        source.close(); // close before the browser auto-reconnects to a finished stream
        qc.invalidateQueries({ queryKey: ['me'] });
        qc.invalidateQueries({ queryKey: ['documents'] });
      }
    };
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setConnectionLost(true);
    };
    return () => source.close();
  }, [id, qc]);

  // Shares the cache with DocumentPage; only tells whether the PDF is still there.
  const doc = useQuery({ queryKey: ['documents', job?.documentId], queryFn: () => api<Doc>(`/documents/${job!.documentId}`), enabled: !!job });
  const fileDeleted = doc.data?.fileDeleted ?? false;
  const done = job?.status === 'done';
  useEffect(() => {
    if (!done) return;
    // not api(): the response is markdown, not JSON
    fetch(`/api/jobs/${id}/content`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setContent, () => setContent(null));
  }, [done, id]);

  async function download(format: 'md' | 'docx') {
    const { url } = await api<{ url: string }>(`/jobs/${id}/download?format=${format}`);
    window.location.href = url;
  }

  if (!job) return <p>{connectionLost ? t('job.couldNotLoad') : t('common.loading')}</p>;
  const finished = job.status === 'done' || job.status === 'failed';
  const tone = job.status === 'done' ? 'done' : job.status === 'failed' ? 'bad' : 'run';
  const btn = 'rounded-full bg-ink px-5 py-3.5 text-sm font-medium text-white hover:opacity-90';
  const details = [
    [t('job.source'), doc.data?.pages != null ? t('job.pages', { n: doc.data.pages }) : '…'],
    [t('jobs.colLength'), lengthLabel(job.options) || '…'],
    [t('job.cost'), t('common.credits', { n: job.credits })],
    [t('common.date'), fmt.date(job.createdAt)],
  ];
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link to="/" className="py-3 text-sm text-soft underline underline-offset-[3px]">{t('job.back')}</Link>
          <Chip tone={tone}>{job.status === 'done' ? t('common.done') : job.status === 'failed' ? t('common.failed') : t(`jobs.${job.status}`)}</Chip>
        </div>
        {job.status === 'done' && (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => download('md')} className={btn}>{t('job.downloadMd')}</button>
            <button onClick={() => download('docx')} className={btn}>{t('job.downloadDocx')}</button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <article className="min-w-0 flex-[999_1_340px] rounded-3xl bg-white px-5 py-6">
          <div className="mx-auto flex max-w-[680px] flex-col gap-5">
            <span className="break-words font-mono text-xs text-muted">{t('common.summary').toUpperCase()}{doc.data && ` · ${doc.data.filename}`}</span>
            {job.status === 'done' && content && <div className="prose-summary"><Markdown disallowedElements={['img']}>{content}</Markdown></div>}
            {job.status === 'failed' && <p className="text-[#A3231B]">{job.error}</p>}
            {!finished && (
              <>
                <div className="h-3 w-full overflow-hidden rounded-md bg-ink">
                  <div className="h-3 rounded-md bg-accent transition-all" style={{ width: `${job.progress}%` }} />
                </div>
                <p className="text-sm text-soft">{job.progress}% · {job.status === 'queued' ? t('common.waitingInQueue') : job.phase}</p>
              </>
            )}
          </div>
        </article>
        <aside className="flex min-w-0 flex-[1_1_260px] flex-col gap-4 rounded-3xl bg-white p-5">
          <h2 className="font-serif text-lg font-semibold tracking-tight">{t('job.details')}</h2>
          <dl className="flex flex-col gap-3">
            {details.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4 border-b border-[#EEE8F2] pb-2.5 text-sm">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          {finished && (
            <button
              disabled={fileDeleted}
              title={fileDeleted ? t('job.fileDeleted') : undefined}
              onClick={() => navigate(`/documents/${job.documentId}?from=${job.id}`)}
              className="rounded-full border-[1.5px] border-ink px-5 py-3 text-sm font-medium disabled:opacity-50"
            >
              {t('job.regenerate')}
            </button>
          )}
        </aside>
      </div>
    </section>
  );
}
