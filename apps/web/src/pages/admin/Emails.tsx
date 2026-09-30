import { useEffect, useRef, useState } from 'react';
import { EmailTemplate, useAdminEmailTemplates, usePreviewEmailTemplate, useResetEmailTemplate, useSaveEmailTemplate } from '../../api';
import { Key, t } from '../../i18n';
import { btnCls, Err, inputCls } from './ui';

function Editor({ tpl }: { tpl: EmailTemplate }) {
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const save = useSaveEmailTemplate(tpl.key);
  const preview = usePreviewEmailTemplate(tpl.key);
  const reset = useResetEmailTemplate(tpl.key);
  // Follow the server after save / reset.
  useEffect(() => {
    setSubject(tpl.subject);
    setBody(tpl.body);
  }, [tpl.subject, tpl.body]);

  const insert = (name: string) => {
    const el = bodyRef.current;
    const at = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? at;
    setBody(`${body.slice(0, at)}{${name}}${body.slice(end)}`);
  };

  return (
    <section className="space-y-3 rounded border bg-white p-4">
      <h2 className="flex items-center gap-2 font-semibold">
        {t(`admin.emails.names.${tpl.key}` as Key)}
        <span className="rounded border px-2 text-xs font-normal">{tpl.isDefault ? t('admin.emails.default') : t('admin.emails.custom')}</span>
      </h2>
      <label className="block text-sm">
        {t('admin.emails.subject')}
        <input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} className={inputCls} />
      </label>
      <label className="block text-sm">
        {t('admin.emails.body')}
        <textarea ref={bodyRef} value={body} maxLength={20_000} rows={8} onChange={(e) => setBody(e.target.value)} className={`${inputCls} font-mono`} />
      </label>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {t('admin.emails.placeholders')}
        {tpl.placeholders.map((p) => (
          <button key={p.name} type="button" className={btnCls} onClick={() => insert(p.name)}>{`{${p.name}}${p.required ? '*' : ''}`}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <button className={btnCls} disabled={preview.isPending} onClick={() => preview.mutate({ subject, body })}>{t('admin.emails.preview')}</button>
        <button className="rounded bg-black px-4 py-1 text-sm text-white disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate({ subject, body })}>
          {t('admin.emails.save')}
        </button>
        <button className={btnCls} disabled={tpl.isDefault || reset.isPending} onClick={() => window.confirm(t('admin.emails.confirmReset')) && reset.mutate()}>
          {t('admin.emails.reset')}
        </button>
      </div>
      <Err error={save.error ?? preview.error ?? reset.error} />
      {preview.data && (
        <div className="rounded border bg-gray-50 p-3 text-sm">
          <p className="font-semibold">{preview.data.subject}</p>
          <pre className="whitespace-pre-wrap font-sans">{preview.data.body}</pre>
        </div>
      )}
    </section>
  );
}

export default function AdminEmails() {
  const list = useAdminEmailTemplates();
  return (
    <div className="space-y-4">
      <Err error={list.error} />
      {list.data?.map((tpl) => <Editor key={tpl.key} tpl={tpl} />)}
    </div>
  );
}
