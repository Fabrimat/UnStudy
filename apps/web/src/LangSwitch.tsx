import { locale, locales, setLocale } from './i18n';

export default function LangSwitch() {
  return (
    <span className="space-x-2">
      {locales.map((l) => (
        <button key={l} type="button" disabled={l === locale} onClick={() => setLocale(l)} className={l === locale ? 'font-semibold' : 'underline'}>
          {l.toUpperCase()}
        </button>
      ))}
    </span>
  );
}
