import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { User } from '@summarize/db';
import { config, ModelEntry } from '../config';
import { resolveSettings } from '../jobs/jobs.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateBenchmarkDto, ListBenchmarksDto } from './admin.dto';

type Usage = { calls: number; inputTokens: number; outputTokens: number; durationMs: number; failedCalls: number };
const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, failedCalls: 0 });
const PHASES = ['draft', 'verify'] as const;

const entryOf = (id: string): ModelEntry | undefined => config.models.find((m) => m.id === id);
// A catalogue entry may have been removed since the run: show the bare id, cost stays unknown.
const modelView = (id: string) => {
  const e = entryOf(id);
  return { modelId: id, label: e?.label ?? id, provider: e?.provider ?? null, model: e?.model ?? null };
};

// USD for one phase's tokens; null when the entry has no prices.
function phaseCost(entry: ModelEntry | undefined, u: Usage): number | null {
  if (entry?.priceIn === undefined || entry.priceOut === undefined) return null;
  return (entry.priceIn * u.inputTokens) / 1e6 + (entry.priceOut * u.outputTokens) / 1e6;
}

type Lane = { draft: string; verify: string | null };

@Injectable()
export class BenchmarksService {
  private logger = new Logger(BenchmarksService.name);

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async create(user: User, dto: CreateBenchmarkDto) {
    for (const l of dto.lanes) {
      if (!entryOf(l.draft) || (l.verify !== null && !entryOf(l.verify))) throw new BadRequestException('Unknown model');
    }
    let words = 0;
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: dto.documentId, userId: user.id } });
      if (!doc) throw new NotFoundException('Document not found');
      if (doc.status !== 'analyzed' || !doc.words || doc.fileDeletedAt) throw new ConflictException('Document is not ready');
      const settings = await resolveSettings(tx, user.id, doc, dto);
      words = settings.words;
      const { customInstructions: _, ...publicOptions } = settings.build({});
      const bench = await tx.benchmark.create({
        data: {
          userId: user.id,
          documentId: doc.id,
          options: { ...(dto.name && { name: dto.name }), ...publicOptions, lanes: dto.lanes.map(({ draft, verify }) => ({ draft, verify })) },
        },
      });
      // Free and unmetered: credits 0, no ledger rows; benchmark jobs are skipped by the MAX_ACTIVE_SUMMARIES count.
      for (const [lane, l] of dto.lanes.entries()) {
        await tx.job.create({
          data: {
            userId: user.id,
            documentId: doc.id,
            kind: 'summarize',
            credits: 0,
            benchmarkId: bench.id,
            options: settings.build({ modelId: l.draft, model: entryOf(l.draft)!.model, phaseModels: { draft: l.draft, verify: l.verify }, lane }),
          },
        });
      }
      return bench.id;
    });
    this.logger.log(`Benchmark created: ${id}, ${dto.lanes.length} lanes, ${words} words`);
    return this.get(user, id);
  }

  async list(user: User, q: ListBenchmarksDto) {
    const where = { userId: user.id };
    const res = await page(
      this.prisma,
      q,
      (p) =>
        this.prisma.benchmark.findMany({
          where, ...p, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          include: { document: { select: { id: true, filename: true } }, jobs: { select: { status: true } } },
        }),
      this.prisma.benchmark.count({ where }),
    );
    return {
      ...res,
      items: res.items.map((b) => ({
        id: b.id,
        name: (b.options as { name?: string }).name ?? null,
        createdAt: b.createdAt,
        document: b.document,
        lanes: b.jobs.length,
        done: b.jobs.filter((j) => j.status === 'done').length,
        failed: b.jobs.filter((j) => j.status === 'failed').length,
        running: b.jobs.filter((j) => j.status === 'running').length,
      })),
    };
  }

  async get(user: User, id: string) {
    const b = await this.prisma.benchmark.findFirst({
      where: { id, userId: user.id },
      include: { document: { select: { id: true, filename: true, words: true, pages: true } }, jobs: true },
    });
    if (!b) throw new NotFoundException('Benchmark not found');
    const jobIds = b.jobs.map((j) => j.id);
    const [all, failed] = await this.prisma.$transaction([
      this.prisma.llmCall.groupBy({
        by: ['jobId', 'phase'], where: { jobId: { in: jobIds } }, orderBy: [{ jobId: 'asc' }, { phase: 'asc' }],
        _count: { _all: true }, _sum: { inputTokens: true, outputTokens: true, durationMs: true },
      }),
      this.prisma.llmCall.groupBy({
        by: ['jobId', 'phase'], where: { jobId: { in: jobIds }, ok: false }, orderBy: [{ jobId: 'asc' }, { phase: 'asc' }],
        _count: { _all: true },
      }),
    ]);
    const lanes = b.jobs
      .map((j) => {
        const o = j.options as { lane?: number; modelId?: string; phaseModels?: Lane };
        const pm: Lane = o.phaseModels ?? { draft: o.modelId ?? '', verify: null };
        const usage = { draft: emptyUsage(), verify: emptyUsage() };
        for (const r of all.filter((r) => r.jobId === j.id)) {
          const c = r._count as { _all: number };
          usage[r.phase] = {
            calls: c._all,
            inputTokens: r._sum?.inputTokens ?? 0,
            outputTokens: r._sum?.outputTokens ?? 0,
            durationMs: r._sum?.durationMs ?? 0,
            failedCalls: (failed.find((f) => f.jobId === j.id && f.phase === r.phase)?._count as { _all: number } | undefined)?._all ?? 0,
          };
        }
        const entries = { draft: entryOf(pm.draft), verify: pm.verify ? entryOf(pm.verify) : undefined };
        // null as soon as a phase that made calls has no prices
        let costUsd: number | null = 0;
        for (const ph of PHASES) {
          if (!usage[ph].calls) continue;
          const c = phaseCost(entries[ph], usage[ph]);
          costUsd = c === null || costUsd === null ? null : costUsd + c;
        }
        return {
          index: o.lane ?? 0,
          jobId: j.id,
          draft: modelView(pm.draft),
          verify: pm.verify ? modelView(pm.verify) : null,
          status: j.status,
          progress: j.progress,
          phase: j.phase,
          error: j.error,
          durationMs: j.durationMs,
          createdAt: j.createdAt,
          finishedAt: j.finishedAt,
          warnings: Array.isArray(j.warnings) ? (j.warnings as string[]) : [],
          usage,
          costUsd,
        };
      })
      .sort((a, c) => a.index - c.index);
    return { id: b.id, name: (b.options as { name?: string }).name ?? null, createdAt: b.createdAt, options: b.options, document: b.document, lanes };
  }

  async remove(user: User, id: string) {
    const b = await this.prisma.benchmark.findFirst({ where: { id, userId: user.id }, include: { jobs: true } });
    if (!b) throw new NotFoundException('Benchmark not found');
    if (b.jobs.some((j) => j.status === 'queued' || j.status === 'running')) throw new ConflictException('Benchmark has lanes in progress');
    await this.storage.delete(b.jobs.flatMap((j) => [j.resultMdKey, j.resultDocxKey]).filter((k): k is string => !!k));
    await this.prisma.benchmark.delete({ where: { id } });
    this.logger.log(`Benchmark deleted: ${id}`);
  }
}
