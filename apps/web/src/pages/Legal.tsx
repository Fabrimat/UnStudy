import { useState } from 'react';
import Markdown from 'react-markdown';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError, LegalKind, LegalRef, useAcceptLegal, useLegal, useMe } from '../api';
import LangSwitch from '../LangSwitch';
import { fmt, t } from '../i18n';

const KINDS = ['terms', 'privacy'] as const;

export function LegalLinks() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
      <span className="flex gap-5" aria-label={t('legal.footerLabel')}>
        {KINDS.map((k) => <Link key={k} to={`/${k}`} className="py-3 underline underline-offset-4">{t(`legal.${k}`)}</Link>)}
      </span>
      <LangSwitch />
    </div>
  );
}

export function Copyright() {
  return (
    <div className="flex flex-col gap-1 pb-2">
      <p>© {new Date().getFullYear()} <a href="https://www.larosa.work" target="_blank" rel="noopener" className="underline underline-offset-[3px]">Fabrizio La Rosa</a> · {t('footer.vat')} BE1031214819 · {t('footer.city')}</p>
      <p className="flex items-center gap-1.5">{t('footer.builtWith')} <svg width="14" height="14" viewBox="0 0 24 24" aria-label={t('footer.love')} role="img"><path d="M12 21s-7.5-4.6-9.6-9.2C1 8.5 3 5 6.4 5c2.1 0 3.7 1.2 5.6 3.3C13.900 6.200 15.500 5 17.600 5 21 5 23 8.500 21.600 11.800 19.500 16.400 12 21 12 21z" className="fill-accent" /></svg> {t('footer.by')} Fabrizio La Rosa</p>
    </div>
  );
}

// Text of the current version; "not published yet" on 404.
function LegalText({ kind }: { kind: LegalKind }) {
  const doc = useLegal(kind);
  if (doc.isPending) return <p>{t('common.loading')}</p>;
  if (doc.error) return <p className="text-muted">{doc.error instanceof ApiError && doc.error.status === 404 ? t('legal.notPublished') : doc.error.message}</p>;
  return (
    <>
      <p className="text-xs text-muted">{t('legal.version', { version: doc.data.version, date: fmt.date(doc.data.createdAt) })}</p>
      <div className="prose-summary rounded-3xl bg-white p-5"><Markdown skipHtml disallowedElements={['img']}>{doc.data.body}</Markdown></div>
    </>
  );
}

// Public page (/terms, /privacy), outside RequireUser.
export function LegalPage({ kind }: { kind: LegalKind }) {
  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="font-serif text-3xl font-semibold">{t(`legal.${kind}`)}</h1>
      <LegalText kind={kind} />
      <p className="text-sm"><Link to="/" className="underline">{t('common.appName')}</Link></p>
    </main>
  );
}

// Shown by RequireUser while the user has documents to accept; goes back to where they were headed.
export default function Accept() {
  const me = useMe();
  const accept = useAcceptLegal();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: { pathname: string; search: string } } | null)?.from;
  const back = from ? from.pathname + from.search : '/';
  const [checked, setChecked] = useState<string[]>([]);
  const pending: LegalRef[] = me.data?.legal.pending ?? [];
  if (me.data && !pending.length && !accept.isPending) return <Navigate to={back} replace />;
  const key = (d: LegalRef) => `${d.kind}:${d.version}`;
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <h1 className="font-serif text-3xl font-semibold">{t('legal.acceptTitle')}</h1>
      <p>{t('legal.acceptIntro')}</p>
      {pending.map((d) => (
        <section key={key(d)} className="space-y-2">
          <h2 className="font-serif text-xl font-semibold">{t(`legal.${d.kind}`)}</h2>
          <LegalText kind={d.kind} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={checked.includes(key(d))} onChange={(e) => setChecked(e.target.checked ? [...checked, key(d)] : checked.filter((k) => k !== key(d)))} />
            {t('legal.acceptCheck', { title: t(`legal.${d.kind}`), version: d.version })}
          </label>
        </section>
      ))}
      <button
        className="rounded-full bg-ink px-5 py-3 text-white disabled:opacity-50"
        disabled={accept.isPending || pending.some((d) => !checked.includes(key(d)))}
        onClick={() => accept.mutate(pending, { onSuccess: () => navigate(back, { replace: true }) })}
      >
        {t('legal.accept')}
      </button>
      {accept.error && <p className="text-red-600">{accept.error.message}</p>}
    </main>
  );
}
