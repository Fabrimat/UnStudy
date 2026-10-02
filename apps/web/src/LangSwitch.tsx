import { locale, locales, setLocale, t } from './i18n';

export default function LangSwitch() {
  return (
    <label className="flex items-center gap-2">
      {t('common.language')}
      <select value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)} className="h-11 rounded-full border border-line bg-white px-3.5 text-sm text-ink">
        {locales.map((l) => <option key={l} value={l}>{new Intl.DisplayNames([l], { type: 'language' }).of(l)}</option>)}
      </select>
    </label>
  );
}
