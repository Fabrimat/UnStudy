import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { ModelEntry } from '../config';
import { resolveSettings } from '../jobs/jobs.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { labPromptKey, labSourceKey, StorageService } from '../storage/storage.service';
import { CreateBenchmarkDto, ListBenchmarksDto } from './admin.dto';
import { zip } from '../zip';
import { jobCost, usageByJob } from './usage';

// A catalogue entry may have been removed since the run: show the bare id, cost stays unknown.
const modelView = (e: ModelEntry | undefined, id: string) => {
  return { modelId: id, label: e?.label ?? id, provider: e?.provider ?? null, model: e?.model ?? null };
};

const active = (j: { status: string }) => j.status === 'queued' || j.status === 'running';
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_');

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

  // ponytail: built in memory (Lab runs are a few MB); stream if runs ever reach hundreds of MB
  async zip(user: User, id: string) {
    const detail = await this.get(user, id);
    const jobs = await this.prisma.job.findMany({ where: { benchmarkId: id }, select: { id: true, status: true, resultMdKey: true } });
    if (jobs.some(active)) throw new ConflictException('Benchmark has lanes in progress');
    const files: { name: string; data: Buffer }[] = [
      { name: 'benchmark.json', data: Buffer.from(JSON.stringify({ ...detail, exportedAt: new Date() }, null, 2)) },
    ];
    const text = await this.storage.getObject(labSourceKey(user.id, id));
    files.push(
      text
        ? { name: `source/${safe(detail.document.filename.replace(/\.pdf$/i, ''))}.txt`, data: text }
        : {
            name: 'source/README.txt',
            data: Buffer.from('The extracted text is not available for this document (this run predates text export).\nA new Lab run on this document will create it.\n'),
          },
    );
    for (const l of detail.lanes) {
      const key = jobs.find((j) => j.id === l.jobId)?.resultMdKey;
      const md = l.status === 'done' && key ? await this.storage.getObject(key) : null;
      const prompt = await this.storage.getObject(labPromptKey(user.id, id, l.jobId));
      const base = `${String(l.index + 1).padStart(2, '0')}-${safe(l.draft.modelId)}${l.verify ? `-${safe(l.verify.modelId)}` : ''}`;
      if (md) files.push({ name: `results/${base}.md`, data: md });
      if (prompt) files.push({ name: `prompts/${base}.txt`, data: prompt });
    }
    this.logger.log(`Benchmark exported: admin ${user.id}, ${id}`);
    return { filename: `lab-${safe(detail.name || id)}.zip`, data: zip(files) };
  }

  // empty name = untitled
  async rename(user: User, id: string, name: string) {
    const b = await this.prisma.benchmark.findFirst({ where: { id, userId: user.id } });
    if (!b) throw new NotFoundException('Benchmark not found');
    const { name: _, ...rest } = b.options as Record<string, unknown>;
    await this.prisma.benchmark.update({ where: { id }, data: { options: { ...(name && { name }), ...rest } as object } });
    return this.get(user, id);
  }

  async remove(user: User, id: string) {
    const b = await this.prisma.benchmark.findFirst({ where: { id, userId: user.id }, include: { jobs: true } });
    if (!b) throw new NotFoundException('Benchmark not found');
    if (b.jobs.some(active)) throw new ConflictException('Benchmark has lanes in progress');
    await this.storage.delete(b.jobs.flatMap((j) => [j.resultMdKey, j.resultDocxKey]).filter((k): k is string => !!k).concat(labSourceKey(user.id, id), b.jobs.map((j) => labPromptKey(user.id, id, j.id))));
    await this.prisma.benchmark.delete({ where: { id } });
    this.logger.log(`Benchmark deleted: ${id}`);
  }
}
