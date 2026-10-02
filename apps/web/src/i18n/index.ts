import en from './en';
import it from './it';

const catalogs = { en, it };
export type Locale = keyof typeof catalogs;
export const locales = Object.keys(catalogs) as Locale[];

const isLocale = (v: unknown): v is Locale => typeof v === 'string' && v in catalogs;
function detect(): Locale {
  try {
    const saved = localStorage.getItem('lang');
    if (isLocale(saved)) return saved;
  } catch { /* storage unavailable */ }
  return navigator.language?.toLowerCase().startsWith('it') ? 'it' : 'en';
}
// ponytail: module constant, so switching language reloads the page.
export const locale: Locale = detect();

export function setLocale(l: Locale) {
  try { localStorage.setItem('lang', l); } catch { /* storage unavailable */ }
  location.reload();
}

const intlLocale = locale === 'it' ? 'it-IT' : 'en';

type Paths<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}` }[keyof T & string];
export type Key = Paths<typeof en>;

export function t(key: Key, vars?: Record<string, string | number>): string {
  const msg = key.split('.').reduce<any>((o, k) => o?.[k], catalogs[locale]);
  if (typeof msg !== 'string') return key;
  return vars ? msg.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : msg;
}

export const fmt = {
  date: (d: Date | string) => new Date(d).toLocaleString(intlLocale),
  // seconds to days; beyond ~7 days the absolute date
  relative: (d: Date | string) => {
    const s = (new Date(d).getTime() - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' });
    for (const [unit, size, max] of [['second', 1, 60], ['minute', 60, 3600], ['hour', 3600, 86400], ['day', 86400, 7 * 86400]] as const)
      if (Math.abs(s) < max) return rtf.format(Math.round(s / size), unit);
    return fmt.date(d);
  },
  number: (n: number) => n.toLocaleString(intlLocale),
  price: (amount: number, currency: string) =>
    new Intl.NumberFormat(intlLocale, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100),
};

// Worker phases are English strings; unknown ones pass through.
export function phaseLabel(phase: string): string {
  const sub = (s: string) => (s === 'draft' ? t('phase.draft') : s === 'fact-check' ? t('phase.factCheck') : s);
  let m = /^Chapter (\d+)\/(\d+)(?:: (.+))?$/.exec(phase);
  if (m) return t('phase.chapter', { i: m[1], n: m[2] }) + (m[3] ? ` · ${sub(m[3])}` : '');
  m = /^Reading page (\d+)\/(\d+)$/.exec(phase);
  if (m) return t('phase.reading', { i: m[1], n: m[2] });
  m = /^Judging chapter (\d+)\/(\d+)$/.exec(phase);
  if (m) return t('phase.judging', { i: m[1], n: m[2] });
  const k = ({ Saving: 'saving', starting: 'starting', retrying: 'retrying' } as Record<string, 'saving' | 'starting' | 'retrying'>)[phase];
  return k ? t(`phase.${k}`) : phase;
}

// Each catalog must have exactly the keys of en (a missing or extra key fails the build).
export type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };
