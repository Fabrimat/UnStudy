import { useState } from 'react';
import { useAdminStats } from '../../api';
import { t } from '../../i18n';
import { Chart } from './charts';
import { Err, fmtCost, fmtDuration, fmtNum, Table } from './ui';

const DAYS = [7, 30, 90, 365];

export default function AdminOverview() {
  const [days, setDays] = useState(30);
  const stats = useAdminStats(days);
  const d = stats.data;
  const s = d?.series ?? [];
  const col = (k: keyof (typeof s)[number]) => s.map((r) => Number(r[k]));
  const labels = s.map((r) => r.day);
  const tot = d?.totals;
  const cards: [string, string][] = tot
    ? [
        [t('admin.overview.users'), fmtNum(tot.users)], [t('admin.overview.activeUsers'), fmtNum(tot.activeUsers30d)], [t('admin.common.documents'), fmtNum(tot.documents)],
        [t('admin.overview.jobsQueuedRunning'), `${tot.jobs.queued} / ${tot.jobs.running}`], [t('admin.overview.jobsDone'), fmtNum(tot.jobs.done)], [t('admin.overview.jobsFailed'), fmtNum(tot.jobs.failed)],
        [t('admin.overview.creditsPurchased'), fmtNum(tot.creditsPurchased)], [t('admin.overview.creditsGranted'), fmtNum(tot.creditsGranted)], [t('admin.overview.creditsRevoked'), fmtNum(tot.creditsRevoked)],
        [t('admin.overview.creditsSpent'), fmtNum(tot.creditsSpent)], [t('admin.overview.creditsOutstanding'), fmtNum(tot.creditsOutstanding)],
        [t('admin.overview.llmCalls'), `${fmtNum(tot.llm.calls)} (${fmtNum(tot.llm.failedCalls)})`],
        [t('admin.common.tokensInOut'), `${fmtNum(tot.llm.inputTokens)} / ${fmtNum(tot.llm.outputTokens)}`], [t('admin.overview.llmCost'), fmtCost(tot.llm.costUsd)],
      ]
    : [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{t('admin.nav.overview')}</h1>
        <label className="text-sm">
          {t('admin.overview.period')}{' '}
          <select className="rounded border bg-white p-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((n) => <option key={n} value={n}>{t('admin.overview.days', { n })}</option>)}
          </select>
        </label>
      </div>
      <Err error={stats.error} />
      {stats.isPending && <p>{t('common.loading')}</p>}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {cards.map(([label, value]) => (
              <div key={label} className="rounded border bg-white p-3">
                <p className="text-xs text-gray-500">{label}</p>
                <p className="text-lg font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <Chart title={t('admin.overview.newUsers')} kind="bar" days={labels} series={[{ name: t('admin.overview.signups'), color: '#2563eb', values: col('signups') }]} />
            <Chart title={t('admin.overview.jobsPerDay')} kind="bar" days={labels} series={[{ name: t('admin.overview.completed'), color: '#16a34a', values: col('jobsDone') }, { name: t('admin.overview.failed'), color: '#dc2626', values: col('jobsFailed') }]} />
            <Chart title={t('admin.overview.chartCredits')} kind="line" days={labels} series={[{ name: t('admin.overview.spent'), color: '#d97706', values: col('creditsSpent') }, { name: t('admin.overview.purchased'), color: '#2563eb', values: col('creditsPurchased') }]} />
            <Chart title={t('admin.overview.tokens')} kind="line" days={labels} series={[{ name: t('admin.overview.input'), color: '#7c3aed', values: col('inputTokens') }, { name: t('admin.overview.output'), color: '#0891b2', values: col('outputTokens') }]} />
          </div>
          <h2 className="font-medium">{t('admin.overview.modelsInPeriod')}</h2>
          <Table head={[t('common.model'), t('admin.common.provider'), t('admin.common.calls'), t('admin.common.failedCalls'), t('admin.common.tokensIn'), t('admin.common.tokensOut'), t('admin.overview.avgDuration'), t('admin.common.cost')]} empty={d.models.length ? undefined : t('admin.overview.noCalls')}>
            {d.models.map((m) => (
              <tr key={`${m.provider}/${m.modelId}`}>
                <td className="p-2 font-mono">{m.modelId}</td><td className="p-2">{m.provider}</td>
                <td className="p-2">{fmtNum(m.calls)}</td><td className={`p-2 ${m.failedCalls ? 'text-red-600' : ''}`}>{fmtNum(m.failedCalls)}</td>
                <td className="p-2">{fmtNum(m.inputTokens)}</td><td className="p-2">{fmtNum(m.outputTokens)}</td>
                <td className="p-2">{fmtDuration(m.avgDurationMs)}</td><td className="p-2">{fmtCost(m.costUsd)}</td>
              </tr>
            ))}
          </Table>
        </>
      )}
    </section>
  );
}
