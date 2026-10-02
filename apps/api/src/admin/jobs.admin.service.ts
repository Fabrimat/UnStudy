import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Job, Prisma, User } from '@summarize/db';
import { CatalogService } from '../catalog/catalog.service';
import { JobsService } from '../jobs/jobs.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { ListAdminJobsDto } from './admin.dto';
import { jobCost, usageByJob } from './usage';

export const jobInclude = {
  user: { select: { id: true, email: true } },
  document: { select: { id: true, filename: true } },
} satisfies Prisma.JobInclude;

type JobRow = Job & { user: { id: string; email: string }; document: { id: string; filename: string } };

// Summary shape shared by the jobs list and the document detail.
export const jobSummary = (j: JobRow) => ({
  id: j.id, kind: j.kind, status: j.status, phase: j.phase, progress: j.progress, credits: j.credits, attempts: j.attempts,
  modelId: (j.options as { modelId?: string }).modelId ?? null,
  model: j.model, createdAt: j.createdAt, finishedAt: j.finishedAt, durationMs: j.durationMs, error: j.error, benchmarkId: j.benchmarkId,
  user: j.user, document: j.document,
});

@Injectable()
export class JobsAdminService {
  private logger = new Logger(JobsAdminService.name);

  constructor(private prisma: PrismaService, private jobs: JobsService, private catalog: CatalogService) {}

  async list(q: ListAdminJobsDto) {
    const where: Prisma.JobWhereInput = {
      ...(q.userId && { userId: q.userId }),
      ...(q.documentId && { documentId: q.documentId }),
      ...(q.status && { status: q.status }),
      ...(q.kind && { kind: q.kind }),
      ...(q.lab && { benchmarkId: q.lab === 'true' ? { not: null } : null }),
    };
    const res = await page(
      this.prisma,
      q,
      (p) => this.prisma.job.findMany({ where, ...p, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: jobInclude }),
      this.prisma.job.count({ where }),
    );
    return { ...res, items: res.items.map(jobSummary) };
  }

  async get(id: string) {
    const job = await this.prisma.job.findUnique({ where: { id }, include: jobInclude });
    if (!job) throw new NotFoundException('Job not found');
    const [usages, ledger, catalog] = await Promise.all([
      usageByJob(this.prisma, [id]),
      this.prisma.creditLedger.findMany({ where: { jobId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.catalog.all(),
    ]);
    const usage = usages.get(id)!;
    const o = job.options as { modelId?: string; phaseModels?: { draft: string; verify: string | null } };
    // Without phaseModels the fact-check ran on the draft model.
    const draftId = o.phaseModels?.draft ?? o.modelId;
    const verifyId = o.phaseModels ? o.phaseModels.verify : o.modelId;
    const entry = (mid?: string | null) => (mid ? catalog.find((m) => m.id === mid) : undefined);
    // customInstructions is the owner's private method text; admins see the method name only.
    const { customInstructions: _, ...options } = job.options as Record<string, unknown>;
    return {
      ...jobSummary(job),
      options,
      warnings: Array.isArray(job.warnings) ? job.warnings : [],
      inputTokens: job.inputTokens,
      outputTokens: job.outputTokens,
      usage,
      costUsd: jobCost(usage, { draft: entry(draftId), verify: entry(verifyId) }),
      ledger: ledger.map(({ id, type, amount, createdAt, note }) => ({ id, type, amount, createdAt, note })),
    };
  }

  // Same code path as the owner's endpoints, minus the ownership filter. Audit-logged at issue time.
  async content(admin: User, id: string) {
    const text = await this.jobs.content(id);
    await this.audit(admin, 'content', id);
    return text;
  }

  async download(admin: User, id: string, format: string) {
    const res = await this.jobs.downloadUrl(id, format);
    await this.audit(admin, `download ${format}`, id);
    return res;
  }

  // The worker's heartbeat/finish UPDATEs are fenced on status='running', so once this commits it drops the job without writing.
  // Mirrors the worker's _fail: refund summaries, reject the document of an analyze job, token totals from LlmCall.
  async stop(admin: User, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const j = await tx.job.findUnique({ where: { id } });
      if (!j) throw new NotFoundException('Job not found');
      const refund = j.kind === 'summarize' && j.credits > 0;
      const error = j.benchmarkId ? `Stopped by an administrator (during: ${j.phase || '?'})` : refund ? 'Stopped by an administrator. Your credits have been refunded.' : 'Stopped by an administrator.';
      const sums = await tx.llmCall.aggregate({ where: { jobId: id }, _sum: { inputTokens: true, outputTokens: true } });
      const { count } = await tx.job.updateMany({
        where: { id, status: { in: ['queued', 'running'] } },
        data: { status: 'failed', phase: 'failed', finishedAt: new Date(), error, inputTokens: sums._sum.inputTokens ?? 0, outputTokens: sums._sum.outputTokens ?? 0 },
      });
      if (!count) throw new ConflictException('Job is not active');
      if (refund) await tx.creditLedger.createMany({ data: [{ userId: j.userId, type: 'refund', amount: j.credits, jobId: id }], skipDuplicates: true });
      if (j.kind === 'analyze') await tx.document.updateMany({ where: { id: j.documentId, status: 'uploaded' }, data: { status: 'rejected', rejectReason: error } });
    });
    this.logger.log(`Admin ${admin.id} stopped job ${id}`);
  }

  // Lab lanes only (user summaries were already refunded). Keeps attempts (the worker's fence) and earlier LlmCall rows (real spend).
  async retry(admin: User, id: string) {
    const j = await this.prisma.job.findUnique({ where: { id }, select: { benchmarkId: true } });
    if (!j) throw new NotFoundException('Job not found');
    if (!j.benchmarkId) throw new ConflictException('Only Lab lanes can be retried');
    const { count } = await this.prisma.job.updateMany({
      where: { id, status: 'failed' },
      data: { status: 'queued', phase: 'retrying', progress: 0, error: null, finishedAt: null, durationMs: null, heartbeatAt: null, warnings: [], evaluation: Prisma.DbNull },
    });
    if (!count) throw new ConflictException('Job is not failed');
    this.logger.log(`Admin ${admin.id} retried lane ${id}`);
  }

  private async audit(admin: User, what: string, id: string) {
    const j = await this.prisma.job.findUnique({ where: { id }, select: { userId: true } });
    this.logger.log(`Admin ${admin.id} read job ${what}: job ${id}, owner ${j?.userId}`);
  }
}
