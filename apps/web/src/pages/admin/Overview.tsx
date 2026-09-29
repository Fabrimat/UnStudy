import { useState } from 'react';
import { useAdminStats } from '../../api';
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
  const t = d?.totals;
  const cards: [string, string][] = t
    ? [
        ['Utenti', fmtNum(t.users)], ['Attivi (30 giorni)', fmtNum(t.activeUsers30d)], ['Documenti', fmtNum(t.documents)],
        ['Job in coda / in corso', `${t.jobs.queued} / ${t.jobs.running}`], ['Job completati', fmtNum(t.jobs.done)], ['Job falliti', fmtNum(t.jobs.failed)],
        ['Crediti acquistati', fmtNum(t.creditsPurchased)], ['Crediti regalati', fmtNum(t.creditsGranted)], ['Crediti revocati', fmtNum(t.creditsRevoked)],
        ['Crediti spesi', fmtNum(t.creditsSpent)], ['Crediti in circolazione', fmtNum(t.creditsOutstanding)],
        ['Chiamate LLM (fallite)', `${fmtNum(t.llm.calls)} (${fmtNum(t.llm.failedCalls)})`],
        ['Token in / out', `${fmtNum(t.llm.inputTokens)} / ${fmtNum(t.llm.outputTokens)}`], ['Costo LLM stimato', fmtCost(t.llm.costUsd)],
      ]
    : [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Panoramica</h1>
        <label className="text-sm">
          Periodo{' '}
          <select className="rounded border bg-white p-1" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {DAYS.map((n) => <option key={n} value={n}>{n} giorni</option>)}
          </select>
        </label>
      </div>
      <Err error={stats.error} />
      {stats.isPending && <p>Caricamento…</p>}
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
            <Chart title="Nuovi utenti" kind="bar" days={labels} series={[{ name: 'Iscrizioni', color: '#2563eb', values: col('signups') }]} />
            <Chart title="Job (per giorno)" kind="bar" days={labels} series={[{ name: 'Completati', color: '#16a34a', values: col('jobsDone') }, { name: 'Falliti', color: '#dc2626', values: col('jobsFailed') }]} />
            <Chart title="Crediti" kind="line" days={labels} series={[{ name: 'Spesi', color: '#d97706', values: col('creditsSpent') }, { name: 'Acquistati', color: '#2563eb', values: col('creditsPurchased') }]} />
            <Chart title="Token" kind="line" days={labels} series={[{ name: 'Input', color: '#7c3aed', values: col('inputTokens') }, { name: 'Output', color: '#0891b2', values: col('outputTokens') }]} />
          </div>
          <h2 className="font-medium">Modelli nel periodo</h2>
          <Table head={['Modello', 'Provider', 'Chiamate', 'Fallite', 'Token in', 'Token out', 'Durata media', 'Costo']} empty={d.models.length ? undefined : 'Nessuna chiamata nel periodo.'}>
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
