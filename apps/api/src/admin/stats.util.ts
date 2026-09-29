import { ModelEntry } from '../config';
import { tokensCost } from './usage';

const DAY_MS = 86_400_000;

// UTC calendar days ending today, oldest first: ['2026-09-01', ..., '2026-09-30'].
export function windowDays(days: number, now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(today - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

export type ModelUsageRow = { modelId: string; provider: string | null; calls: number; failedCalls: number; inputTokens: number; outputTokens: number; avgDurationMs: number };

// Prices come from the CURRENT catalog. Legacy rows (no catalog id) fall back to the provider model id.
export const priceEntry = (catalog: ModelEntry[], key: string) => catalog.find((m) => m.id === key) ?? catalog.find((m) => m.model === key);

// Sum of per-model costs; null as soon as one needed price is missing (a model with no calls costs nothing).
export function totalCost(rows: ModelUsageRow[], catalog: ModelEntry[]): number | null {
  let sum = 0;
  for (const r of rows) {
    const c = tokensCost(priceEntry(catalog, r.modelId), r.inputTokens, r.outputTokens);
    if (c === null) return null;
    sum += c;
  }
  return sum;
}
