import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import Select from '../Select';
import LengthPicker from '../LengthPicker';
import { api, LANGUAGES, lengthOf, modelOptions, Preferences, styleOptions, useDeleteAccount, useLogout, useMe, useMethods, useModels } from '../api';
import { t } from '../i18n';

export default function Settings() {
  const qc = useQueryClient();
  const me = useMe();
  const methods = useMethods();
  const models = useModels().data;
  const save = useMutation({
    mutationFn: (patch: { [K in keyof Preferences]?: Preferences[K] | null }) => api<Preferences>('/me/preferences', { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const navigate = useNavigate();
  const del = useDeleteAccount();
  const logout = useLogout();
  const [confirm, setConfirm] = useState('');
  const prefs = me.data?.preferences ?? {};
  const options = styleOptions(methods.data);
  // A deleted custom method falls back to studio, like the summary page.
  const method = options.some(([v]) => v === prefs.method) ? prefs.method! : 'studio';

  // A model no longer in the catalog falls back to the first one.
  const model = models?.some((m) => m.id === prefs.model) ? prefs.model! : models?.[0]?.id;

  return (
    <section className="space-y-4">
      <h1 className="font-serif text-3xl font-semibold tracking-tight">{t('nav.settings')}</h1>
      <p className="text-sm text-muted">{t('settings.defaults')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label={t('common.language')} value={prefs.language ?? 'auto'} onChange={(language) => save.mutate({ language })} options={LANGUAGES} />
        <Select label={t('common.style')} value={method} onChange={(m) => save.mutate({ method: m })} options={options} />
        {models && models.length > 1 && model && <Select label={t('common.model')} value={model} onChange={(m) => save.mutate({ model: m })} options={modelOptions(models)} />}
      </div>
      <LengthPicker value={lengthOf(prefs)} onChange={(lengthPercent) => save.mutate({ lengthPercent, fraction: null })} />
      {save.isSuccess && <p className="text-green-700">{t('settings.saved')}</p>}
      {save.error && <p className="text-red-600">{save.error.message}</p>}
      <div className="rounded-2xl border border-line bg-white p-4 nav:hidden">
        <h2 className="font-semibold">{t('nav.more')}</h2>
        <ul className="mt-1 divide-y">
          {[['/methods', t('nav.methods')], ...(me.data?.role === 'admin' ? [['/admin', t('nav.admin')]] : [])].map(([to, text]) => (
            <li key={to}><Link to={to} className="block py-3 underline underline-offset-4">{text}</Link></li>
          ))}
          <li className="sm:hidden"><button onClick={logout} className="py-3 underline underline-offset-4">{t('nav.logout')}</button></li>
        </ul>
      </div>
      <div className="space-y-2 rounded-2xl border border-red-300 bg-white p-4">
        <h2 className="font-semibold text-red-700">{t('settings.deleteTitle')}</h2>
        <p className="text-sm text-muted">{t('settings.deleteBody')}</p>
        <input className="w-full rounded border p-2" aria-label={t('settings.deleteConfirm')} placeholder={t('settings.deleteConfirm')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <button
          className="rounded-full bg-red-600 px-4 py-2.5 text-white disabled:opacity-50"
          disabled={del.isPending || !me.data || confirm.trim().toLowerCase() !== me.data.email.toLowerCase()}
          onClick={() => del.mutate(confirm, { onSuccess: () => navigate('/login') })}
        >
          {t('settings.deleteButton')}
        </button>
        {del.error && <p className="text-red-600">{del.error.message}</p>}
      </div>
    </section>
  );
}
