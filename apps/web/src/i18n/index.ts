import en from './en';

const catalogs = { en };
export type Locale = keyof typeof catalogs;
// ponytail: fixed until a second catalog exists; then pick from navigator.language / user preference.
export const locale: Locale = 'en';

type Paths<T> = { [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}` }[keyof T & string];
export type Key = Paths<typeof en>;

export function t(key: Key, vars?: Record<string, string | number>): string {
  const msg = key.split('.').reduce<any>((o, k) => o?.[k], catalogs[locale]);
  if (typeof msg !== 'string') return key;
  return vars ? msg.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : msg;
}

export const fmt = {
  date: (d: Date | string) => new Date(d).toLocaleString(locale),
  number: (n: number) => n.toLocaleString(locale),
  price: (amount: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() }).format(amount / 100),
};
