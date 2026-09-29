import { useMutation, useQueryClient } from '@tanstack/react-query';
import Select from '../Select';
import { api, FRACTIONS, LANGUAGES, Preferences, styleOptions, useMe, useMethods } from '../api';

export default function Settings() {
  const qc = useQueryClient();
  const me = useMe();
  const methods = useMethods();
  const save = useMutation({
    mutationFn: (patch: Preferences) => api<Preferences>('/me/preferences', { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
  const prefs = me.data?.preferences ?? {};
  const options = styleOptions(methods.data);
  // A deleted custom method falls back to studio, like the summary page.
  const method = options.some(([v]) => v === prefs.method) ? prefs.method! : 'studio';

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Settings</h1>
      <p className="text-sm text-gray-600">Defaults for new summaries.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label="Language" value={prefs.language ?? 'auto'} onChange={(language) => save.mutate({ language })} options={LANGUAGES} />
        <Select label="Length" value={prefs.fraction ?? 3} onChange={(fraction) => save.mutate({ fraction })} options={FRACTIONS} />
        <Select label="Style" value={method} onChange={(m) => save.mutate({ method: m })} options={options} />
      </div>
      {save.isSuccess && <p className="text-green-700">Saved</p>}
      {save.error && <p className="text-red-600">{save.error.message}</p>}
    </section>
  );
}
