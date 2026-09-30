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
  number: (n: number) => n.toLocaleString(intlLocale),
  price: (amount: number, currency: string) =>
    new Intl.NumberFormat(intlLocale, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100),
};

// Each catalog must have exactly the keys of en (a missing or extra key fails the build).
export type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };
