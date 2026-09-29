import { Page, pageCount } from './api';

export default function Pager({ data, onPage }: { data: Page<unknown>; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <button disabled={data.page <= 1} onClick={() => onPage(data.page - 1)} className="rounded border bg-white px-3 py-1 disabled:opacity-50">Previous</button>
      <span>Page {data.page} of {pageCount(data)}</span>
      <button disabled={data.page >= pageCount(data)} onClick={() => onPage(data.page + 1)} className="rounded border bg-white px-3 py-1 disabled:opacity-50">Next</button>
    </div>
  );
}
