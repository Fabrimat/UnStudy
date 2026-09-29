import { Injectable } from '@nestjs/common';
import { CatalogService } from '../catalog/catalog.service';
import { PrismaService } from '../prisma.service';
import { ModelUsageRow, priceEntry, totalCost, windowDays } from './stats.util';
import { tokensCost } from './usage';

type SeriesRow = {
  day: string; signups: number; documents: number; jobsDone: number; jobsFailed: number;
  creditsSpent: number; creditsPurchased: number; inputTokens: number; outputTokens: number;
};

// Day buckets are UTC: the columns are timestamp(3) without tz holding UTC, so date_trunc('day', col) is already UTC.
// Sums are cast to float8/int in SQL so Prisma never hands back BigInt.
@Injectable()
export class StatsService {
  constructor(private prisma: PrismaService, private catalog: CatalogService) {}

  // since: ISO string cast to timestamp (no tz), so the session time zone can never shift the window
  private modelUsage(since: string) {
    return this.prisma.$queryRaw<ModelUsageRow[]>`
      SELECT COALESCE("modelId", model) AS "modelId", provider,
             COUNT(*)::int AS calls,
             (COUNT(*) FILTER (WHERE NOT ok))::int AS "failedCalls",
             COALESCE(SUM("inputTokens"), 0)::float8 AS "inputTokens",
             COALESCE(SUM("outputTokens"), 0)::float8 AS "outputTokens",
             COALESCE(AVG("durationMs"), 0)::float8 AS "avgDurationMs"
      FROM "LlmCall" WHERE "createdAt" >= ${since}::timestamp
      GROUP BY COALESCE("modelId", model), provider
      ORDER BY COALESCE("modelId", model), provider`;
  }

  async get(days: number) {
    const labels = windowDays(days);
    const start = labels[0];
    const end = labels[labels.length - 1];
    const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const summarizeJobs = { kind: 'summarize' as const, benchmarkId: null };
    const [catalog, users, active, documents, jobs, ledger, allUsage, windowUsage, series] = await Promise.all([
      this.catalog.all(),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(DISTINCT "userId")::int AS n FROM "Session" WHERE "createdAt" >= ${since30}::timestamp`,
      this.prisma.document.count(),
      this.prisma.job.groupBy({ by: ['status'], where: summarizeJobs, orderBy: { status: 'asc' }, _count: { _all: true } }),
      this.prisma.creditLedger.groupBy({ by: ['type'], orderBy: { type: 'asc' }, _sum: { amount: true } }),
      this.modelUsage('1970-01-01T00:00:00.000Z'),
      this.modelUsage(`${start}T00:00:00.000Z`),
      this.prisma.$queryRaw<SeriesRow[]>`
        WITH d AS (SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day),
        su AS (
          SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*)::int AS n FROM "User"
          WHERE "createdAt" >= ${start}::date GROUP BY 1),
        dc AS (
          SELECT date_trunc('day', "createdAt")::date AS day, COUNT(*)::int AS n FROM "Document"
          WHERE "createdAt" >= ${start}::date GROUP BY 1),
        jb AS (
          SELECT date_trunc('day', "finishedAt")::date AS day,
                 (COUNT(*) FILTER (WHERE status = 'done'))::int AS done,
                 (COUNT(*) FILTER (WHERE status = 'failed'))::int AS failed
          FROM "Job" WHERE kind = 'summarize' AND "benchmarkId" IS NULL AND "finishedAt" >= ${start}::date GROUP BY 1),
        cl AS (
          SELECT date_trunc('day', "createdAt")::date AS day,
                 COALESCE(-SUM(amount) FILTER (WHERE type IN ('reserve', 'refund', 'charge')), 0)::float8 AS spent,
                 COALESCE(SUM(amount) FILTER (WHERE type = 'purchase'), 0)::float8 AS purchased
          FROM "CreditLedger" WHERE "createdAt" >= ${start}::date GROUP BY 1),
        tk AS (
          SELECT date_trunc('day', "createdAt")::date AS day,
                 COALESCE(SUM("inputTokens"), 0)::float8 AS i, COALESCE(SUM("outputTokens"), 0)::float8 AS o
          FROM "LlmCall" WHERE "createdAt" >= ${start}::date GROUP BY 1)
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
               COALESCE(su.n, 0)::int AS signups, COALESCE(dc.n, 0)::int AS documents,
               COALESCE(jb.done, 0)::int AS "jobsDone", COALESCE(jb.failed, 0)::int AS "jobsFailed",
               COALESCE(cl.spent, 0)::float8 AS "creditsSpent", COALESCE(cl.purchased, 0)::float8 AS "creditsPurchased",
               COALESCE(tk.i, 0)::float8 AS "inputTokens", COALESCE(tk.o, 0)::float8 AS "outputTokens"
        FROM d
        LEFT JOIN su ON su.day = d.day LEFT JOIN dc ON dc.day = d.day LEFT JOIN jb ON jb.day = d.day
        LEFT JOIN cl ON cl.day = d.day LEFT JOIN tk ON tk.day = d.day
        ORDER BY d.day`,
    ]);
    const sum = (type: string) => ledger.find((l) => l.type === type)?._sum.amount ?? 0;
    const jobCount = (status: string) => jobs.find((j) => j.status === status)?._count._all ?? 0;
    const total = (f: (r: ModelUsageRow) => number) => allUsage.reduce((n, r) => n + f(r), 0);
    return {
      totals: {
        users,
        activeUsers30d: active[0].n,
        documents,
        jobs: { queued: jobCount('queued'), running: jobCount('running'), done: jobCount('done'), failed: jobCount('failed') },
        creditsPurchased: sum('purchase'),
        creditsGranted: sum('grant'),
        creditsRevoked: -sum('revoke'),
        creditsSpent: -(sum('reserve') + sum('refund') + sum('charge')),
        creditsOutstanding: ledger.reduce((n, l) => n + (l._sum.amount ?? 0), 0),
        llm: {
          calls: total((r) => r.calls),
          failedCalls: total((r) => r.failedCalls),
          inputTokens: total((r) => r.inputTokens),
          outputTokens: total((r) => r.outputTokens),
          costUsd: totalCost(allUsage, catalog),
        },
      },
      series,
      models: windowUsage.map((r) => ({ ...r, costUsd: tokensCost(priceEntry(catalog, r.modelId), r.inputTokens, r.outputTokens) })),
    };
  }
}
