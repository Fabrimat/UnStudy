import { useState } from 'react';
import { t } from '../../i18n';
import { AdminProvider, AdminProviderInput, TokenParam, useAdminProviders, useDeleteAdminProvider, useSaveAdminProvider } from '../../api';
import { btnCls, Err, inputCls } from './ui';

type Draft = { baseUrl: string; tokenParam: TokenParam; maxConcurrency: string };

const toDraft = (p: AdminProvider): Draft => ({ baseUrl: p.baseUrl, tokenParam: p.tokenParam, maxConcurrency: p.maxConcurrency === null ? '' : String(p.maxConcurrency) });
const toInput = (d: Draft): AdminProviderInput => ({
  baseUrl: d.baseUrl.trim(), tokenParam: d.tokenParam, maxConcurrency: d.maxConcurrency.trim() === '' ? null : Number(d.maxConcurrency),
});
const validDraft = (d: Draft) => {
  const n = toInput(d).maxConcurrency;
  return d.baseUrl.trim() !== '' && (n === null || (Number.isInteger(n) && n >= 1 && n <= 64));
};

const cell = 'rounded border bg-white p-1';

// The editable cells shared by the rows and the add form.
function DraftCells({ d, set }: { d: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <>
      <td className="p-2"><input maxLength={500} value={d.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} className={`${cell} w-80 font-mono`} aria-label={t('admin.providers.baseUrl')} placeholder={t('admin.providers.baseUrlHint')} /></td>
      <td className="p-2">
        <select value={d.tokenParam} onChange={(e) => set({ tokenParam: e.target.value as TokenParam })} className={cell} aria-label={t('admin.providers.tokenParam')}>
          <option value="max_tokens">max_tokens</option>
          <option value="max_completion_tokens">max_completion_tokens</option>
        </select>
      </td>
      <td className="p-2"><input type="number" min={1} max={64} step={1} value={d.maxConcurrency} onChange={(e) => set({ maxConcurrency: e.target.value })} className={`${cell} w-24`} aria-label={t('admin.providers.maxConcurrency')} placeholder={t('admin.providers.unlimited')} /></td>
    </>
  );
}

const HEAD = [t('admin.providers.baseUrl'), t('admin.providers.tokenParam'), t('admin.providers.maxConcurrency')];

function ProviderRow({ p, onError }: { p: AdminProvider; onError: (e: string) => void }) {
  const [d, setD] = useState(() => toDraft(p));
  const save = useSaveAdminProvider();
  const del = useDeleteAdminProvider();
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(p));
  const done = { onSuccess: () => onError(''), onError: (e: Error) => onError(`${p.id}: ${e.message}`) };
  return (
    <tr>
      <td className="p-2 font-mono">{p.id}</td>
      <DraftCells d={d} set={(x) => setD({ ...d, ...x })} />
      <td className="p-2 font-mono">{p.keyEnv}</td>
      <td className="whitespace-nowrap p-2">
        <button className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50" disabled={!dirty || !validDraft(d) || save.isPending} onClick={() => save.mutate({ id: p.id, ...toInput(d) }, done)}>
          {t('common.save')}
        </button>{' '}
        <button className={btnCls} disabled={del.isPending} onClick={() => window.confirm(t('admin.providers.confirmDelete', { id: p.id })) && del.mutate(p.id, done)}>
          {t('common.delete')}
        </button>
      </td>
    </tr>
  );
}

const blank: Draft = { baseUrl: '', tokenParam: 'max_tokens', maxConcurrency: '' };

export default function AdminProviders() {
  const admin = useAdminProviders();
  const save = useSaveAdminProvider();
  const providers = admin.data ?? [];
  const [error, setError] = useState('');
  const [newId, setNewId] = useState('');
  const [nd, setNd] = useState<Draft>(blank);
  const validNew = /^[a-z0-9-]{1,32}$/.test(newId) && validDraft(nd);

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('admin.nav.providers')}</h1>
        <p className="text-sm text-gray-600">{t('admin.providers.intro')}</p>
      </div>
      <Err error={admin.error} />
      {error && <p className="text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50">
            <tr>
              {['ID', ...HEAD].map((h) => <th key={h} className="whitespace-nowrap p-2 font-medium">{h}</th>)}
              <th className="p-2 font-medium">{t('admin.providers.keyEnv')}<div className="text-xs font-normal text-gray-500">{t('admin.providers.keyHint')}</div></th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y">
            {providers.map((p) => <ProviderRow key={`${p.id}:${JSON.stringify(p)}`} p={p} onError={setError} />)}
          </tbody>
        </table>
      </div>

      <form
        className="space-y-3 rounded border bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ id: newId, create: true, ...toInput(nd) }, { onSuccess: () => { setNewId(''); setNd(blank); } });
        }}
      >
        <h2 className="font-medium">{t('admin.providers.add')}</h2>
        <label className="block text-sm">{t('admin.providers.idHint')}
          <input value={newId} onChange={(e) => setNewId(e.target.value)} maxLength={32} className={`${inputCls} max-w-xs font-mono`} />
        </label>
        <div className="overflow-x-auto">
          <table className="text-left text-sm">
            <thead><tr>{HEAD.map((h) => <th key={h} className="whitespace-nowrap p-2 font-medium">{h}</th>)}</tr></thead>
            <tbody><tr><DraftCells d={nd} set={(x) => setNd({ ...nd, ...x })} /></tr></tbody>
          </table>
        </div>
        <button disabled={!validNew || save.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{t('admin.providers.add')}</button>
        <Err error={save.error} />
      </form>
    </section>
  );
}
