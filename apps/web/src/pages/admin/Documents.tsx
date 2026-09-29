import { useState } from 'react';
import { Link, useParams } from 'react-router';
import Pager from '../../Pager';
import Select from '../../Select';
import { fmt, t } from '../../i18n';
import { AdminJob, openAdminDownload, useAdminDoc, useAdminDocs } from '../../api';
import { btnCls, Err, Field, fmtDate, fmtNum, inputCls, Table, useFilters } from './ui';

const STATUSES = [['', t('common.allStatuses')], ['uploaded', t('admin.documents.uploaded')], ['analyzed', t('admin.documents.analyzed')], ['rejected', t('admin.documents.rejected')]] as const;
const kb = (b: number) => `${fmt.number(Math.max(1, Math.round(b / 1024)))} KB`;

export function AdminJobRows({ jobs, showUser }: { jobs: AdminJob[]; showUser?: boolean }) {
  return (
    <>
      {jobs.map((j) => (
        <tr key={j.id}>
          <td className="p-2"><Link to={`/admin/jobs/${j.id}`} className="underline">{fmtDate(j.createdAt)}</Link></td>
          <td className="p-2">{j.kind}{j.benchmarkId && t('admin.common.labTag')}</td>
          <td className={`p-2 ${j.status === 'failed' ? 'text-red-600' : ''}`}>{j.status === 'running' ? `${j.progress}%` : j.status}</td>
          <td className="p-2">{j.modelId ?? j.model ?? ''}</td><td className="p-2">{j.credits}</td>
          {showUser && <td className="p-2"><Link to={`/admin/users/${j.user.id}`} className="underline">{j.user.email}</Link></td>}
          {showUser && <td className="max-w-48 truncate p-2"><Link to={`/admin/documents/${j.document.id}`} className="underline">{j.document.filename}</Link></td>}
        </tr>
      ))}
    </>
  );
}

export default function AdminDocuments() {
  const f = useFilters();
  const filters = { q: f.get('q'), status: f.get('status'), userId: f.get('userId'), page: f.page };
  const docs = useAdminDocs(filters);
  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">{t('admin.nav.documents')}</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">{t('admin.common.search')}
          <input value={filters.q} onChange={(e) => f.set({ q: e.target.value })} placeholder={t('admin.documents.filename')} className={inputCls} />
        </label>
        <Select label={t('common.status')} value={filters.status} onChange={(v) => f.set({ status: v })} options={STATUSES} />
      </div>
      {filters.userId && (
        <p className="text-sm">{t('admin.common.user')}: <Link className="underline" to={`/admin/users/${filters.userId}`}>{filters.userId}</Link>{' '}
          <button className="underline" onClick={() => f.set({ userId: '' })}>{t('admin.documents.removeFilter')}</button></p>
      )}
      <Err error={docs.error} />
      <Table head={[t('admin.documents.file'), t('admin.common.user'), t('common.status'), t('admin.common.pages'), t('admin.common.words'), t('admin.documents.size'), t('admin.documents.uploadedAt'), t('admin.common.jobs')]} empty={docs.data?.items.length === 0 ? t('admin.documents.none') : undefined}>
        {docs.data?.items.map((d) => (
          <tr key={d.id}>
            <td className="max-w-48 truncate p-2"><Link to={`/admin/documents/${d.id}`} className="underline">{d.filename}</Link></td>
            <td className="p-2"><Link to={`/admin/users/${d.user.id}`} className="underline">{d.user.email}</Link></td>
            <td className="p-2">{d.status}</td><td className="p-2">{fmtNum(d.pages)}</td><td className="p-2">{fmtNum(d.words)}</td>
            <td className="p-2">{kb(d.sizeBytes)}</td><td className="p-2">{fmtDate(d.createdAt)}</td><td className="p-2">{d.jobs}</td>
          </tr>
        ))}
      </Table>
      {docs.data && <Pager data={docs.data} onPage={f.setPage} />}
    </section>
  );
}

export function AdminDocumentPage() {
  const { id } = useParams();
  const doc = useAdminDoc(id);
  const [error, setError] = useState('');
  const d = doc.data;
  if (doc.error) return <p className="text-red-600">{doc.error.message}</p>;
  if (!d) return <p>{t('common.loading')}</p>;
  return (
    <section className="space-y-5">
      <div>
        <Link to="/admin/documents" className="text-sm underline">← {t('admin.nav.documents')}</Link>
        <h1 className="break-words text-xl font-semibold">{d.filename}</h1>
      </div>
      <dl className="grid grid-cols-2 gap-3 rounded border bg-white p-4 text-sm sm:grid-cols-3">
        <Field label={t('admin.common.user')}><Link className="underline" to={`/admin/users/${d.user.id}`}>{d.user.email}</Link></Field>
        <Field label={t('common.status')}>{d.status}{d.rejectReason && `: ${d.rejectReason}`}</Field>
        <Field label={t('admin.documents.uploadedAt')}>{fmtDate(d.createdAt)}</Field>
        <Field label={t('admin.common.pages')}>{fmtNum(d.pages)}</Field><Field label={t('admin.common.words')}>{fmtNum(d.words)}</Field><Field label={t('admin.documents.size')}>{kb(d.sizeBytes)}</Field>
        <Field label={t('admin.documents.ocr')}>{d.usedOcr ? t('admin.documents.yes') : t('admin.documents.no')}</Field>
        <Field label={t('admin.documents.originalFile')}>{d.fileDeletedAt ? t('admin.documents.deletedOn', { date: fmtDate(d.fileDeletedAt) }) : t('admin.documents.available')}</Field>
      </dl>
      <div>
        <button
          disabled={!!d.fileDeletedAt}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          onClick={() => { setError(''); openAdminDownload(`/admin/documents/${d.id}/file`).catch((e) => setError(e.message)); }}
        >
          {t('admin.documents.download')}
        </button>
        {error && <p className="mt-2 text-red-600">{error}</p>}
      </div>
      <h2 className="font-medium">{t('admin.documents.chapters', { n: d.chapters?.length ?? 0 })}</h2>
      <Table head={[t('admin.documents.chapterTitle'), t('admin.common.pages'), t('admin.common.words')]} empty={d.chapters?.length ? undefined : t('admin.documents.noChapters')}>
        {d.chapters?.map((c, i) => (
          <tr key={i}><td className="p-2">{c.title}</td><td className="p-2">{c.pageFrom ? `${c.pageFrom}–${c.pageTo}` : ''}</td><td className="p-2">{fmtNum(c.words)}</td></tr>
        ))}
      </Table>
      <div className="flex items-center justify-between">
        <h2 className="font-medium">{t('admin.documents.jobs', { n: d.jobs.length })}</h2>
        <Link className={btnCls} to={`/admin/jobs?documentId=${d.id}`}>{t('admin.documents.viewJobs')}</Link>
      </div>
      <Table head={[t('common.date'), t('admin.common.type'), t('common.status'), t('common.model'), t('admin.common.credits')]} empty={d.jobs.length === 0 ? t('admin.documents.noJobs') : undefined}>
        <AdminJobRows jobs={d.jobs} />
      </Table>
    </section>
  );
}
