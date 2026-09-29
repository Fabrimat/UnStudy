import { useMutation, useQueryClient } from '@tanstack/react-query';
import Select from '../Select';
import LengthPicker from '../LengthPicker';
import { api, LANGUAGES, lengthOf, modelOptions, Preferences, styleOptions, useMe, useMethods, useModels } from '../api';

export default function Settings() {
  const qc = useQueryClient();
  const me = useMe();
  const methods = useMethods();
  const models = useModels().data;
  const save = useMutation({
    mutationFn: (patch: { [K in keyof Preferences]?: Preferences[K] | null }) => api<Preferences>('/me/preferences', { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const prefs = me.data?.preferences ?? {};
  const options = styleOptions(methods.data);
  // A deleted custom method falls back to studio, like the summary page.
  const method = options.some(([v]) => v === prefs.method) ? prefs.method! : 'studio';

  // A model no longer in the catalog falls back to the first one.
  const model = models?.some((m) => m.id === prefs.model) ? prefs.model! : models?.[0]?.id;

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="text-sm text-gray-600">Defaults for new summaries.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Language" value={prefs.language ?? 'auto'} onChange={(language) => save.mutate({ language })} options={LANGUAGES} />
        <Select label="Style" value={method} onChange={(m) => save.mutate({ method: m })} options={options} />
        {models && models.length > 1 && model && <Select label="Model" value={model} onChange={(m) => save.mutate({ model: m })} options={modelOptions(models)} />}
      </div>
      <LengthPicker value={lengthOf(prefs)} onChange={(lengthPercent) => save.mutate({ lengthPercent, fraction: null })} />
      {save.isSuccess && <p className="text-green-700">Saved</p>}
      {save.error && <p className="text-red-600">{save.error.message}</p>}
    </section>
  );
}
