export type ChartSeries = { name: string; color: string; values: number[] };

const W = 600, H = 190, L = 44, R = 8, T = 8, B = 22;
const fmt = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(Math.round(n * 10) / 10));

// Small inline-SVG chart: "bar" stacks the series, "line" overlays them. Hover a day for its values.
export function Chart({ title, days, series, kind }: { title: string; days: string[]; series: ChartSeries[]; kind: 'bar' | 'line' }) {
  const n = days.length;
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const rawMax = Math.max(...(kind === 'bar' ? totals : series.flatMap((s) => s.values)), 0);
  const max = rawMax > 0 ? rawMax : 1;
  const iw = W - L - R, ih = H - T - B;
  const step = iw / Math.max(n, 1);
  const x = (i: number) => L + (kind === 'bar' ? step * (i + 0.5) : n > 1 ? (iw * i) / (n - 1) : iw / 2);
  const y = (v: number) => T + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const labelIdx = [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);
  return (
    <figure className="rounded border bg-white p-3">
      <figcaption className="mb-1 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="flex gap-3 text-xs text-gray-600">
          {series.map((s) => <span key={s.name}><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}</span>)}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="#e5e7eb" />
            <text x={L - 4} y={y(t) + 3} textAnchor="end" fontSize="10" fill="#6b7280">{fmt(t)}</text>
          </g>
        ))}
        {labelIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize="10" fill="#6b7280">{days[i]?.slice(5)}</text>
        ))}
        {kind === 'bar'
          ? days.map((_, i) => {
              let acc = 0;
              return series.map((s) => {
                const v = s.values[i] ?? 0;
                const top = y(acc + v), h = y(acc) - top;
                acc += v;
                return v > 0 ? <rect key={s.name + i} x={x(i) - step * 0.4} y={top} width={step * 0.8} height={h} fill={s.color} /> : null;
              });
            })
          : series.map((s) => (
              <polyline key={s.name} fill="none" stroke={s.color} strokeWidth="1.5" strokeLinejoin="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            ))}
        {days.map((d, i) => (
          <rect key={d} x={L + step * i} y={T} width={step} height={ih} fill="transparent">
            <title>{`${d}\n${series.map((s) => `${s.name}: ${s.values[i] ?? 0}`).join('\n')}`}</title>
          </rect>
        ))}
      </svg>
    </figure>
  );
}
