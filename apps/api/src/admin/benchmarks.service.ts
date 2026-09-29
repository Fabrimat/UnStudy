import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { ModelEntry } from '../config';
import { resolveSettings } from '../jobs/jobs.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { CreateBenchmarkDto, ListBenchmarksDto } from './admin.dto';
import { jobCost, usageByJob } from './usage';

// A catalogue entry may have been removed since the run: show the bare id, cost stays unknown.
const modelView = (e: ModelEntry | undefined, id: string) => {
  return { modelId: id, label: e?.label ?? id, provider: e?.provider ?? null, model: e?.model ?? null };
};

type Lane = { draft: string; verify: string | null };

@Injectable()
export class BenchmarksService {
  private logger = new Logger(BenchmarksService.name);

  constructor(private prisma: PrismaService, private storage: StorageService, private catalog: CatalogService) {}

  async create(user: User, dto: CreateBenchmarkDto) {
    // Lab may use adminOnly models but not disabled ones.
    const picked = new Map<string, ModelEntry>();
    for (const l of dto.lanes) {
      for (const id of l.verify === null ? [l.draft] : [l.draft, l.verify]) picked.set(id, await this.catalog.labModel(id));
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
            options: settings.build({ modelId: l.draft, model: picked.get(l.draft)!.model, phaseModels: { draft: l.draft, verify: l.verify }, lane }),
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
    const catalog = await this.catalog.all();
    const entryOf = (id: string) => catalog.find((m) => m.id === id);
    const usages = await usageByJob(this.prisma, jobIds);
    const lanes = b.jobs
      .map((j) => {
        const o = j.options as { lane?: number; modelId?: string; phaseModels?: Lane };
        const pm: Lane = o.phaseModels ?? { draft: o.modelId ?? '', verify: null };
        const usage = usages.get(j.id)!;
        const costUsd = jobCost(usage, { draft: entryOf(pm.draft), verify: pm.verify ? entryOf(pm.verify) : undefined });
        return {
          index: o.lane ?? 0,
          jobId: j.id,
          draft: modelView(entryOf(pm.draft), pm.draft),
          verify: pm.verify ? modelView(entryOf(pm.verify), pm.verify) : null,
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
