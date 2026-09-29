import { jobCost } from '../src/admin/usage';
import { totalCost, windowDays } from '../src/admin/stats.util';
import { ModelEntry } from '../src/config';

const entry = (id: string, priceIn?: number, priceOut?: number): ModelEntry => ({
  id, label: id, model: `p/${id}`, multiplier: 1, provider: 'x', temperature: 0.4, adminOnly: false,
  ...(priceIn !== undefined && { priceIn }), ...(priceOut !== undefined && { priceOut }),
});
const row = (modelId: string, inputTokens: number, outputTokens: number) => ({ modelId, provider: 'x', calls: 1, failedCalls: 0, inputTokens, outputTokens, avgDurationMs: 1 });

describe('windowDays', () => {
  it('returns UTC days oldest first, ending today', () => {
    expect(windowDays(3, new Date('2026-03-01T23:59:59Z'))).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(windowDays(1, new Date('2026-09-30T00:00:00Z'))).toEqual(['2026-09-30']);
    expect(windowDays(365)).toHaveLength(365);
  });
});

describe('totalCost', () => {
  const catalog = [entry('fast', 1, 2), entry('lab')];
  it('sums per-model costs from current prices', () => {
    expect(totalCost([row('fast', 1_000_000, 500_000)], catalog)).toBeCloseTo(2);
    expect(totalCost([], catalog)).toBe(0);
  });
  it('falls back to the provider model id for legacy rows', () => {
    expect(totalCost([row('p/fast', 1_000_000, 0)], catalog)).toBeCloseTo(1);
  });
  it('is null when any needed price is missing', () => {
    expect(totalCost([row('fast', 10, 10), row('lab', 10, 10)], catalog)).toBeNull();
    expect(totalCost([row('gone', 10, 10)], catalog)).toBeNull();
  });
});

describe('jobCost', () => {
  const u = (calls: number, i: number, o: number) => ({ calls, inputTokens: i, outputTokens: o, durationMs: 0, failedCalls: 0 });
  it('only needs prices for phases that made calls', () => {
    expect(jobCost({ draft: u(1, 1_000_000, 0), verify: u(0, 0, 0) }, { draft: entry('a', 1, 1) })).toBeCloseTo(1);
    expect(jobCost({ draft: u(1, 1, 1), verify: u(1, 1, 1) }, { draft: entry('a', 1, 1), verify: entry('b') })).toBeNull();
  });
});
