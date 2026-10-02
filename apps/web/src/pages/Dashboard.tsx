import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, busy, Doc, JobWithDoc, Page, qs, Stats, uploadFile, useMe } from '../api';
import { fmt, t } from '../i18n';
import { DocChip } from '../ui';

export default function Dashboard() {
  const qc = useQueryClient();
  const me = useMe();
  const [errors, setErrors] = useState<string[]>([]);
  const stats = useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/me/stats') });
  const active = useQuery({
    queryKey: ['jobs', 'active'],
    queryFn: () => api<Page<JobWithDoc>>(`/jobs${qs({ active: true })}`),
    refetchInterval: (q) => (q.state.data?.items.length ? 3000 : false),
  });
  const docs = useQuery({
    queryKey: ['documents', 'recent'],
    queryFn: () => api<Page<Doc>>(`/documents${qs({ pageSize: 5 })}`),
    refetchInterval: (q) => (q.state.data?.items.some(busy) ? 3000 : false),
  });

  async function upload(files: FileList | null) {
    for (const file of Array.from(files ?? [])) {
      try {
        await uploadFile(file);
      } catch (e) {
        setErrors((list) => [...list, `${file.name}: ${(e as Error).message}`]);
      }
      await Promise.all([qc.invalidateQueries({ queryKey: ['documents'] }), qc.invalidateQueries({ queryKey: ['stats'] })]);
    }
  }

  const s = stats.data;
  const cards = [
    [t('nav.documents'), s?.documents],
    [t('dashboard.summariesDone'), s?.summariesDone],
    [t('dashboard.creditsSpent'), s?.creditsSpent],
    [t('dashboard.pagesSummarized'), s && fmt.number(s.pagesSummarized)],
  ] as const;
  const h2 = 'font-serif text-xl font-semibold tracking-tight';

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-stretch gap-4">
        <label
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            upload(e.dataTransfer.files);
          }}
          className="flex min-h-28 min-w-0 flex-[7_1_340px] cursor-pointer items-center gap-4 rounded-3xl border-2 border-dashed border-edge bg-white px-5 py-4 hover:border-ink sm:min-h-[300px] sm:flex-col sm:justify-center sm:gap-3.5 sm:p-7 sm:text-center"
        >
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-accent">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>
          </span>
          <span className="font-serif text-[clamp(22px,5vw,32px)] font-semibold leading-tight tracking-tight">
            <span className="sm:hidden">{t('dashboard.addPdf')}</span>
            <span className="hidden sm:inline">{t('dashboard.dropTitle')}</span>
          </span>
          <span className="hidden max-w-sm text-base text-[#4A4058] sm:block">{t('dashboard.drop')}</span>
          <span className="mt-1 hidden rounded-full bg-ink px-6 py-3.5 text-[15px] font-medium text-white hover:opacity-90 sm:inline-block">{t('dashboard.browse')}</span>
          <input type="file" accept="application/pdf" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        </label>
        <section className="flex min-w-0 flex-[5_1_260px] flex-col gap-5 rounded-3xl bg-ink p-6 text-white">
          <div className="flex items-end justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[13px] text-[#CFC4DD]">{t('dashboard.balance')}</span>
              <span className="font-mono text-[clamp(44px,8vw,56px)] font-medium leading-none tracking-tighter">{me.data?.balance ?? '…'}</span>
            </div>
            <Link to="/credits" className="rounded-full bg-accent px-[18px] py-3.5 text-sm font-bold text-white hover:opacity-90">{t('credits.buyTitle')}</Link>
          </div>
          <dl className="m-0 hidden grid-cols-2 gap-px overflow-hidden rounded-[14px] bg-[#3D2D57] sm:grid">
            {cards.map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 bg-ink px-3.5 py-3">
                <dt className="text-xs text-[#CFC4DD]">{label}</dt>
                <dd className="font-mono text-[22px] font-medium">{value ?? '…'}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      {errors.map((e) => <p key={e} className="text-[#A3231B]">{e}</p>)}
      <div className="flex flex-wrap items-start gap-4">
        <section className="order-2 flex min-w-0 flex-[7_1_340px] flex-col gap-2 rounded-3xl bg-white px-1 pb-2 pt-5 sm:order-1">
          <div className="flex items-baseline justify-between px-4 pb-1">
            <h2 className={h2}>{t('dashboard.recent')}</h2>
            <Link to="/documents" className="py-2 text-sm underline underline-offset-[3px]">{t('common.all')}</Link>
          </div>
          <ul>
            {docs.data?.items.length === 0 && <li className="px-4 py-3 text-muted">{t('dashboard.noDocuments')}</li>}
            {docs.data?.items.map((d) => (
              <li key={d.id} className="flex min-h-11 items-center gap-3 rounded-[14px] px-4 py-3 hover:bg-[#F8F5FB]">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6A5F78" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" /></svg>
                <Link to={`/documents/${d.id}`} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium">{d.filename}</span>
                  <span className="font-mono text-xs text-muted">{d.status === 'analyzed' ? t('api.pagesCredits', { pages: d.pages ?? '', credits: d.credits ?? '' }) : fmt.date(d.createdAt)}</span>
                </Link>
                <DocChip d={d} />
              </li>
            ))}
          </ul>
        </section>
        {!!active.data?.items.length && (
          <section className="order-1 flex min-w-0 flex-[5_1_260px] flex-col gap-4 rounded-3xl bg-white p-5 sm:order-2">
            <h2 className={h2}>{t('dashboard.inProgress')}</h2>
            {active.data.items.map((j) => (
              <Link key={j.id} to={`/jobs/${j.id}`} className="flex flex-col gap-2">
                <span className="truncate font-medium">{j.document.filename}</span>
                <span className="block h-3 overflow-hidden rounded-md bg-ink"><span className="block h-3 rounded-md bg-accent transition-all" style={{ width: `${j.progress}%` }} /></span>
                <span className="flex justify-between gap-3 text-[13px] text-[#4A4058]"><span>{j.status === 'queued' ? t('common.waitingInQueue') : j.phase}</span><span className="font-mono">{j.progress}%</span></span>
              </Link>
            ))}
          </section>
        )}
      </div>
    </section>
  );
}
