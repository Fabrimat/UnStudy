import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import { LegalKind, useAdminLegal, usePublishLegal } from '../../api';
import { fmt, t } from '../../i18n';
import { Err, inputCls } from './ui';

export default function AdminLegal() {
  const [kind, setKind] = useState<LegalKind>('terms');
  const history = useAdminLegal(kind);
  const publish = usePublishLegal(kind);
  const [text, setText] = useState('');
  const latest = history.data?.[0]?.body;
  // Prefill with the current text whenever the kind changes or a new version lands.
  useEffect(() => setText(latest ?? ''), [kind, latest]);
  const title = t(`legal.${kind}`);

  return (
    <div className="space-y-4">
      <label className="block text-sm">
        {t('admin.legal.kind')}
        <select value={kind} onChange={(e) => setKind(e.target.value as LegalKind)} className={`${inputCls} w-auto`}>
          <option value="terms">{t('legal.terms')}</option>
          <option value="privacy">{t('legal.privacy')}</option>
        </select>
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block text-sm">
          {t('admin.legal.text')}
          <textarea value={text} maxLength={100_000} onChange={(e) => setText(e.target.value)} rows={20} className={`${inputCls} font-mono`} />
        </label>
        <div className="text-sm">
          {t('admin.legal.preview')}
          <div className="prose-summary mt-1 rounded border bg-white p-4"><Markdown skipHtml disallowedElements={['img']}>{text}</Markdown></div>
        </div>
      </div>
      <button
        className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        disabled={!text.trim() || text.trim() === latest || publish.isPending}
        onClick={() => window.confirm(t('admin.legal.confirmPublish', { title })) && publish.mutate(text.trim())}
      >
        {t('admin.legal.publish')}
      </button>
      <Err error={publish.error ?? history.error} />
      <section>
        <h2 className="mb-1 font-semibold">{t('admin.legal.history')}</h2>
        {history.data?.length === 0 && <p className="text-sm text-gray-500">{t('admin.legal.none')}</p>}
        <ul className="space-y-1 text-sm">
          {history.data?.map((d) => (
            <li key={d.id}>{t('admin.legal.row', { version: d.version, date: fmt.date(d.createdAt), by: d.createdBy, n: d.acceptances })}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
