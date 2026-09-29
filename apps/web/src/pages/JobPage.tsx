import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { Link, useNavigate, useParams } from 'react-router';
import { api, Doc, Job } from '../api';
import { t } from '../i18n';

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
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('common.summary')}</h1>
      {job.status === 'done' && (
        <>
          <p className="font-medium text-green-700">{t('common.done')}</p>
          <div className="flex gap-3">
            <button onClick={() => download('md')} className="rounded bg-black px-4 py-2 text-white">{t('job.downloadMd')}</button>
            <button onClick={() => download('docx')} className="rounded bg-black px-4 py-2 text-white">{t('job.downloadDocx')}</button>
          </div>
          {content && <div className="prose-summary rounded border bg-white p-4"><Markdown disallowedElements={['img']}>{content}</Markdown></div>}
        </>
      )}
      {job.status === 'failed' && <p className="text-red-600">{job.error}</p>}
      {(job.status === 'queued' || job.status === 'running') && (
        <>
          <div className="h-3 w-full rounded bg-gray-200">
            <div className="h-3 rounded bg-black transition-all" style={{ width: `${job.progress}%` }} />
          </div>
          <p className="text-sm text-gray-600">{job.progress}% · {job.status === 'queued' ? t('common.waitingInQueue') : job.phase}</p>
        </>
      )}
      {(job.status === 'done' || job.status === 'failed') && (
        <button
          disabled={fileDeleted}
          title={fileDeleted ? t('job.fileDeleted') : undefined}
          onClick={() => navigate(`/documents/${job.documentId}?from=${job.id}`)}
          className="rounded border bg-white px-4 py-2 disabled:opacity-50"
        >
          {t('job.regenerate')}
        </button>
      )}
      <br />
      <Link to="/" className="underline">{t('job.back')}</Link>
    </section>
  );
}
