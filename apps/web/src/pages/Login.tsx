import { useQuery } from '@tanstack/react-query';
import { FormEvent, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { Logo } from '../ui';
import { LegalLinks } from './Legal';

export default function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ google: boolean }>('/auth/providers') });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/magic-link', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const google = providers.data?.google;
  return (
    <div className="flex min-h-screen flex-wrap gap-3 bg-ground p-3 sm:p-6 lg:p-4">
      <section className="hidden min-w-0 flex-[1_1_420px] flex-col justify-between gap-8 rounded-[28px] bg-ink p-14 text-white lg:flex">
        <span className="flex items-center gap-2.5 text-[22px] font-bold tracking-tight"><Logo onDark />{t('common.appName')}</span>
        <h1 className="font-serif text-[clamp(44px,9vw,80px)] font-semibold leading-[0.98] tracking-tight text-balance">
          {t('login.hero1')} <span className="italic text-[#FF9C82] underline decoration-accent decoration-[6px] underline-offset-8">{t('login.hero2')}</span> {t('login.hero3')}
        </h1>
      </section>
      <main className="flex min-w-0 flex-[1_1_340px] flex-col justify-center gap-6 py-2 sm:py-6 lg:px-14 lg:py-16">
        <div className="mx-auto flex w-full max-w-[440px] flex-col gap-6 rounded-[28px] bg-white px-5 py-6 sm:p-10 lg:rounded-none lg:bg-transparent lg:p-0">
          <div className="flex flex-col gap-5 lg:hidden">
            <span className="flex items-center gap-2.5 text-[22px] font-bold tracking-tight"><Logo />{t('common.appName')}</span>
            <h1 className="font-serif text-[clamp(34px,9vw,48px)] font-semibold leading-[1.02] tracking-tight text-balance">
              {t('login.hero1')} <span className="italic text-accent">{t('login.hero2')}</span> {t('login.hero3')}
            </h1>
          </div>
          <h2 className="font-serif text-[28px] font-semibold tracking-tight">{t('login.signIn')}</h2>
          {sent ? (
            <p>{t('login.sent', { email })}</p>
          ) : (
            <>
              <p className="hidden text-base text-soft sm:block">{t('login.intro')}</p>
              {google && (
                <>
                  <a href="/api/auth/google" className="flex h-[52px] items-center justify-center gap-3 rounded-full border-[1.5px] border-ink bg-white text-base font-medium hover:opacity-90">
                    <span aria-hidden="true" className="text-xl font-bold leading-none text-[#4285F4]">G</span>{t('login.google')}
                  </a>
                  <div className="flex items-center gap-3 text-[13px] text-muted"><span className="h-px flex-1 bg-line" />{t('login.orEmail')}<span className="h-px flex-1 bg-line" /></div>
                </>
              )}
              <form onSubmit={submit} className="flex flex-col gap-3">
                <label className="flex flex-col gap-3 text-sm font-medium">
                  {t('login.email')}
                  <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="h-[52px] w-full rounded-[14px] border-[1.5px] border-edge bg-white px-4 text-base font-normal text-ink focus:border-ink focus:outline-3 focus:outline-accent" />
                </label>
                <button className="h-[52px] rounded-full bg-accent text-base font-medium text-white hover:opacity-90">{t('login.send')}</button>
                {error && <p className="text-[#A3231B]">{error}</p>}
              </form>
            </>
          )}
          <footer className="text-[13px] text-muted"><LegalLinks /><p>© 2026 {t('common.appName')}</p></footer>
        </div>
      </main>
    </div>
  );
}
