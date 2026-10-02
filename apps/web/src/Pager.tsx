import { Page, pageCount } from './api';
import { t } from './i18n';

export default function Pager({ data, onPage }: { data: Page<unknown>; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <button disabled={data.page <= 1} onClick={() => onPage(data.page - 1)} className="rounded-full border border-line bg-white px-4 py-2 disabled:opacity-50">{t('common.previous')}</button>
      <span>{t('common.pageOf', { page: data.page, total: pageCount(data) })}</span>
      <button disabled={data.page >= pageCount(data)} onClick={() => onPage(data.page + 1)} className="rounded-full border border-line bg-white px-4 py-2 disabled:opacity-50">{t('common.next')}</button>
    </div>
  );
}
