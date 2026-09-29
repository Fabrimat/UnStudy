import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import Select from '../Select';
import { api, ApiError, Method, PRESETS, useMethods } from '../api';
import { t } from '../i18n';

const MAX = 4000;
type Draft = { id: string | null; name: string; instructions: string };

export default function Methods() {
  const qc = useQueryClient();
  const methods = useMethods();
  const presets = useQuery({ queryKey: ['methods', 'presets'], queryFn: () => api<{ id: string; text: string }[]>('/methods/presets') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');

  const done = () => {
    setError('');
    setDraft(null);
    qc.invalidateQueries({ queryKey: ['methods'] });
  };
  const onError = (e: Error) => setError(e instanceof ApiError && e.status === 409 ? t('methods.limit') : e.message);
  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body = JSON.stringify({ name: d.name.trim(), instructions: d.instructions.trim() });
      return d.id ? api<Method>(`/methods/${d.id}`, { method: 'PATCH', body }) : api<Method>('/methods', { method: 'POST', body });
    },
    onSuccess: done,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/methods/${id}`, { method: 'DELETE' }),
    onSuccess: done,
    onError,
  });

  const startFrom = (id: string) => {
    const text = presets.data?.find((p) => p.id === id)?.text;
    if (!draft || text === undefined) return;
    if (draft.instructions && !window.confirm(t('methods.replace'))) return;
    setDraft({ ...draft, instructions: text });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('nav.methods')}</h1>
        {!draft && <button onClick={() => setDraft({ id: null, name: '', instructions: '' })} className="rounded bg-black px-4 py-2 text-white">{t('methods.new')}</button>}
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {draft && (
        <form
          className="space-y-3 rounded border bg-white p-4"
          onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}
        >
          <label className="block">
            {t('methods.name')}
            <input required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value.replace(/[\r\n]/g, ' ') })} className="mt-1 w-full rounded border bg-white p-2" />
          </label>
          <Select label={t('methods.startFrom')} value="" onChange={startFrom} options={[['', t('methods.choosePreset')], ...PRESETS]} />
          <label className="block">
            {t('methods.instructions')}
            <textarea required rows={12} maxLength={MAX} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} className="mt-1 w-full rounded border bg-white p-2 font-mono text-sm" />
          </label>
          <p className="text-sm text-gray-600">
            {draft.instructions.length}/{MAX} · {t('methods.hint')}
          </p>
          <div className="flex gap-3">
            <button disabled={save.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{t('common.save')}</button>
            <button type="button" onClick={() => setDraft(null)} className="underline">{t('common.cancel')}</button>
          </div>
        </form>
      )}
      {methods.data?.length === 0 && !draft && <p className="text-gray-500">{t('methods.none')}</p>}
      <ul className="space-y-2">
        {methods.data?.map((m) => (
          <li key={m.id} className="rounded border bg-white p-3">
            <div className="flex items-center justify-between gap-3">
              <strong>{m.name}</strong>
              <span className="flex gap-3 text-sm">
                <button className="underline" onClick={() => setDraft({ id: m.id, name: m.name, instructions: m.instructions })}>{t('methods.edit')}</button>
                <button
                  className="text-red-600 underline"
                  onClick={() => window.confirm(t('methods.confirmDelete', { name: m.name })) && remove.mutate(m.id)}
                >
                  {t('common.delete')}
                </button>
              </span>
            </div>
            <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-gray-600">{m.instructions}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
