import { ModelEntry } from '../config';
import { PrismaService } from '../prisma.service';

export type Usage = { calls: number; inputTokens: number; outputTokens: number; durationMs: number; failedCalls: number };
export type JobUsage = { draft: Usage; verify: Usage };
export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, failedCalls: 0 });
export const PHASES = ['draft', 'verify'] as const;

// LlmCall rows aggregated per job and phase (jobs without calls get zeros).
export async function usageByJob(prisma: PrismaService, jobIds: string[]): Promise<Map<string, JobUsage>> {
  const [all, failed] = await prisma.$transaction([
    prisma.llmCall.groupBy({
      by: ['jobId', 'phase'], where: { jobId: { in: jobIds } }, orderBy: [{ jobId: 'asc' }, { phase: 'asc' }],
      _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, durationMs: true },
    }),
    prisma.llmCall.groupBy({
      by: ['jobId', 'phase'], where: { jobId: { in: jobIds }, ok: false }, orderBy: [{ jobId: 'asc' }, { phase: 'asc' }],
      _count: { _all: true },
    }),
  ]);
  const out = new Map(jobIds.map((id) => [id, { draft: emptyUsage(), verify: emptyUsage() }]));
  for (const r of all) {
    out.get(r.jobId)![r.phase] = {
      calls: (r._count as { _all: number })._all,
      inputTokens: r._sum?.inputTokens ?? 0,
      outputTokens: r._sum?.outputTokens ?? 0,
      durationMs: r._sum?.durationMs ?? 0,
      failedCalls: (failed.find((f) => f.jobId === r.jobId && f.phase === r.phase)?._count as { _all: number } | undefined)?._all ?? 0,
    };
  }
  return out;
}

// USD for tokens at the entry's prices; null when the entry has no prices.
export function tokensCost(entry: Pick<ModelEntry, 'priceIn' | 'priceOut'> | undefined, inputTokens: number, outputTokens: number): number | null {
  if (entry?.priceIn === undefined || entry.priceOut === undefined) return null;
  return (entry.priceIn * inputTokens) / 1e6 + (entry.priceOut * outputTokens) / 1e6;
}

// null as soon as a phase that made calls has no prices
export function jobCost(usage: JobUsage, entries: { draft?: ModelEntry; verify?: ModelEntry }): number | null {
  let costUsd: number | null = 0;
  for (const ph of PHASES) {
    if (!usage[ph].calls) continue;
    const c = tokensCost(entries[ph], usage[ph].inputTokens, usage[ph].outputTokens);
    costUsd = c === null || costUsd === null ? null : costUsd + c;
  }
  return costUsd;
}
