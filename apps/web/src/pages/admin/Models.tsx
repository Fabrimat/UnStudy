import { useState } from 'react';
import { t } from '../../i18n';
import { AdminModel, AdminModelInput, AdminProvider, useAdminModels, useReorderAdminModels, useSaveAdminModel } from '../../api';
import { btnCls, Err, inputCls } from './ui';

type Draft = {
  label: string; provider: string; model: string; multiplier: string;
  temperature: string; noTemp: boolean; priceIn: string; priceOut: string; adminOnly: boolean; enabled: boolean;
};

const toDraft = (m: AdminModel): Draft => ({
  label: m.label, provider: m.provider, model: m.model, multiplier: String(m.multiplier),
  temperature: String(m.temperature ?? 0.4), noTemp: m.temperature === null,
  priceIn: m.priceIn === null ? '' : String(m.priceIn), priceOut: m.priceOut === null ? '' : String(m.priceOut),
  adminOnly: m.adminOnly, enabled: m.enabled,
});

const price = (s: string) => (s.trim() === '' ? null : Number(s));
const toInput = (d: Draft): AdminModelInput => ({
  label: d.label.trim(), provider: d.provider, model: d.model.trim(), multiplier: Number(d.multiplier),
  temperature: d.noTemp ? null : Number(d.temperature), priceIn: price(d.priceIn), priceOut: price(d.priceOut),
  adminOnly: d.adminOnly, enabled: d.enabled,
});

const cell = 'rounded border bg-white p-1';

// The editable cells shared by the rows and the add form.
function DraftCells({ d, set, providers }: { d: Draft; set: (p: Partial<Draft>) => void; providers: AdminProvider[] }) {
  const num = (k: 'multiplier' | 'temperature' | 'priceIn' | 'priceOut', w: string, extra?: object) => (
    <input type="number" step="any" min={0} value={d[k]} onChange={(e) => set({ [k]: e.target.value })} className={`${cell} ${w}`} {...extra} />
  );
  return (
    <>
      <td className="p-2"><input maxLength={80} value={d.label} onChange={(e) => set({ label: e.target.value })} className={`${cell} w-36`} aria-label={t('admin.models.label')} /></td>
      <td className="p-2">
        <select value={d.provider} onChange={(e) => set({ provider: e.target.value })} className={cell} aria-label={t('admin.common.provider')}>
          {!providers.some((p) => p.id === d.provider) && <option value={d.provider}>{d.provider || '—'}</option>}
          {providers.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
        </select>
      </td>
      <td className="p-2"><input maxLength={200} value={d.model} onChange={(e) => set({ model: e.target.value })} className={`${cell} w-48 font-mono`} aria-label={t('common.model')} /></td>
      <td className="p-2">{num('multiplier', 'w-20', { 'aria-label': t('admin.models.multiplier') })}</td>
      <td className="p-2">
        {num('temperature', 'w-20', { disabled: d.noTemp, 'aria-label': t('admin.models.temperature') })}
        <label className="ml-2 text-xs"><input type="checkbox" checked={d.noTemp} onChange={(e) => set({ noTemp: e.target.checked })} /> {t('admin.models.dontSend')}</label>
      </td>
      <td className="p-2">{num('priceIn', 'w-20', { 'aria-label': t('admin.models.priceIn') })}</td>
      <td className="p-2">{num('priceOut', 'w-20', { 'aria-label': t('admin.models.priceOut') })}</td>
      <td className="p-2 text-center"><input type="checkbox" checked={d.adminOnly} onChange={(e) => set({ adminOnly: e.target.checked })} aria-label={t('admin.models.adminOnly')} /></td>
      <td className="p-2 text-center"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} aria-label={t('admin.models.enabled')} /></td>
    </>
  );
}

const HEAD = [t('admin.models.label'), t('admin.common.provider'), t('common.model'), t('admin.models.multiplierShort'), t('admin.models.temperature'), t('admin.models.priceIn'), t('admin.models.priceOut'), t('admin.models.adminOnly'), t('admin.models.enabled')];

function ModelRow({ m, providers, index, count, ids, onError }: {
  m: AdminModel; providers: AdminProvider[]; index: number; count: number; ids: string[]; onError: (e: string) => void;
}) {
  const [d, setD] = useState(() => toDraft(m));
  const save = useSaveAdminModel();
  const order = useReorderAdminModels();
  const dirty = JSON.stringify(d) !== JSON.stringify(toDraft(m));
  const move = (delta: number) => {
    const next = [...ids];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    order.mutate(next, { onSuccess: () => onError(''), onError: (e) => onError(`${m.id}: ${e.message}`) });
  };
  return (
    <tr className={m.enabled ? '' : 'bg-gray-50 text-gray-500'}>
      <td className="p-2 font-mono">{m.id}</td>
      <DraftCells d={d} set={(p) => setD({ ...d, ...p })} providers={providers} />
      <td className="whitespace-nowrap p-2">
        <button className={btnCls} disabled={index === 0 || order.isPending} onClick={() => move(-1)} aria-label={t('admin.models.up')} title={t('admin.models.up')}>↑</button>{' '}
        <button className={btnCls} disabled={index === count - 1 || order.isPending} onClick={() => move(1)} aria-label={t('admin.models.down')} title={t('admin.models.down')}>↓</button>{' '}
        <button
          className="rounded bg-black px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ id: m.id, ...toInput(d) }, { onSuccess: () => onError(''), onError: (e) => onError(`${m.id}: ${e.message}`) })}
        >
          {t('common.save')}
        </button>
      </td>
    </tr>
  );
}

const blank = (provider: string): Draft => ({
  label: '', provider, model: '', multiplier: '1', temperature: '0.4', noTemp: false, priceIn: '', priceOut: '', adminOnly: false, enabled: true,
});

export default function AdminModels() {
  const admin = useAdminModels();
  const save = useSaveAdminModel();
  const providers = admin.data?.providers ?? [];
  const models = [...(admin.data?.models ?? [])].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const ids = models.map((m) => m.id);
  const [error, setError] = useState('');
  const [newId, setNewId] = useState('');
  const [nd, setNd] = useState<Draft | null>(null);
  const draft = nd ?? blank(providers[0]?.id ?? '');
  const validNew = /^[a-z0-9-]{1,32}$/.test(newId) && draft.label.trim() !== '' && draft.model.trim() !== '' && draft.provider !== '' && Number(draft.multiplier) > 0;

  return (
    <section className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('admin.nav.models')}</h1>
        <p className="text-sm text-gray-600">
          {t('admin.models.intro')}
        </p>
      </div>
      <Err error={admin.error} />
      {error && <p className="text-red-600">{error}</p>}
      <div className="overflow-x-auto rounded border bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-gray-50"><tr>{['ID', ...HEAD, ''].map((h, i) => <th key={i} className="whitespace-nowrap p-2 font-medium">{h}</th>)}</tr></thead>
          <tbody className="divide-y">
            {models.map((m, i) => (
              <ModelRow key={`${m.id}:${JSON.stringify(m)}`} m={m} providers={providers} index={i} count={models.length} ids={ids} onError={setError} />
            ))}
          </tbody>
        </table>
      </div>

      <form
        className="space-y-3 rounded border bg-white p-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ id: newId, create: true, ...toInput(draft), position: models.length }, {
            onSuccess: () => { setNewId(''); setNd(null); },
          });
        }}
      >
        <h2 className="font-medium">{t('admin.models.add')}</h2>
        <label className="block text-sm">{t('admin.models.idHint')}
          <input value={newId} onChange={(e) => setNewId(e.target.value)} maxLength={32} className={`${inputCls} max-w-xs font-mono`} />
        </label>
        <div className="overflow-x-auto">
          <table className="text-left text-sm">
            <thead><tr>{HEAD.map((h) => <th key={h} className="whitespace-nowrap p-2 font-medium">{h}</th>)}</tr></thead>
            <tbody><tr><DraftCells d={draft} set={(p) => setNd({ ...draft, ...p })} providers={providers} /></tr></tbody>
          </table>
        </div>
        <button disabled={!validNew || save.isPending} className="rounded bg-black px-4 py-2 text-white disabled:opacity-50">{t('admin.models.add')}</button>
        <Err error={save.error} />
      </form>
    </section>
  );
}
