import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Document, Prisma, User } from '@summarize/db';
import { config } from '../config';
import { creditsForJob } from '../credits/credits';
import { LedgerService } from '../credits/ledger.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { toJobDto } from './job.dto';
import { CreateJobDto, JobSettingsDto, ListJobsDto } from './jobs.dto';
import { MAX_ACTIVE_SUMMARIES } from './options';

// Chapter validation + word count + custom-method snapshot, shared by user jobs and admin Lab runs.
// System preset keeps `preset` for the worker; a custom method is snapshotted so later edits/deletes never touch the job.
export async function resolveSettings(tx: Prisma.TransactionClient, userId: string, doc: Document, dto: JobSettingsDto) {
  const { language, lengthPercent, method, chapters, extras, bibliographicLine } = dto;
  const docChapters = doc.chapters;
  let words = doc.words ?? 0;
  const picked = chapters && [...chapters].sort((a, b) => a - b);
  if (picked) {
    if (!Array.isArray(docChapters) || picked.some((i) => i >= docChapters.length)) throw new BadRequestException('Invalid chapters');
    words = picked.reduce((sum, i) => sum + (Number((docChapters[i] as { words?: number } | null)?.words) || 0), 0);
  }
  const common = { language, lengthPercent, ...(bibliographicLine !== undefined && { bibliographicLine }), ...(picked && { chapters: picked }), ...(extras?.length && { extras }) };
  let head: Prisma.InputJsonObject = { method, preset: method };
  let customChars = 0;
  if (method.startsWith('custom:')) {
    const m = await tx.summaryMethod.findFirst({ where: { id: method.slice(7), userId } });
    if (!m) throw new NotFoundException('Method not found');
    head = { method, methodName: m.name, customInstructions: m.instructions };
    customChars = m.instructions.length;
  }
  // extra: per-job fields (modelId, model, phaseModels, lane)
  return { words, customChars, build: (extra: Prisma.InputJsonObject): Prisma.InputJsonObject => ({ ...common, ...extra, ...head }) };
}

@Injectable()
export class JobsService {
  private logger = new Logger(JobsService.name);

  constructor(private prisma: PrismaService, private ledger: LedgerService, private storage: StorageService) {}

  async create(user: User, dto: CreateJobDto) {
    const { documentId, model: modelId } = dto;
    // adminOnly models are indistinguishable from unknown ones for users.
    const entry = modelId === undefined ? config.userModels[0] : config.userModels.find((m) => m.id === modelId);
    if (!entry) throw new BadRequestException('Unknown model');
    let customChars = 0;
    const job = await this.prisma.$transaction(async (tx) => {
      // Row lock on the user serialises concurrent starts, so the balance check below cannot race.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: documentId, userId: user.id } });
      if (!doc) throw new NotFoundException('Document not found');
      if (doc.status !== 'analyzed' || !doc.words || doc.fileDeletedAt) throw new ConflictException('Document is not ready');
      const active = await tx.job.count({
        where: { userId: user.id, kind: 'summarize', benchmarkId: null, status: { in: ['queued', 'running'] } },
      });
      if (active >= MAX_ACTIVE_SUMMARIES) throw new HttpException(`You already have ${MAX_ACTIVE_SUMMARIES} summaries in progress`, 429);
      const settings = await resolveSettings(tx, user.id, doc, dto);
      customChars = settings.customChars;
      const options = settings.build({ modelId: entry.id, model: entry.model });
      const credits = creditsForJob(settings.words, entry.multiplier);
      const balance = await this.ledger.balance(user.id, tx);
      if (balance < credits) {
        this.logger.warn(`Not enough credits: user ${user.id}, needed ${credits}, balance ${balance}`);
        throw new HttpException({ message: 'Not enough credits', needed: credits, balance }, 402);
      }
      const job = await tx.job.create({ data: { userId: user.id, documentId, kind: 'summarize', options, credits } });
      await tx.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -credits, jobId: job.id } });
      return toJobDto(job);
    });
    this.logger.log(`Job created: ${job.id}, ${job.credits} credits reserved, method ${customChars ? `custom (${customChars} chars)` : dto.method}`);
    return job;
  }

  async get(user: User, id: string) {
    return toJobDto(await this.findOwned(user, id));
  }

  async list(user: User, q: ListJobsDto) {
    const where: Prisma.JobWhereInput = { userId: user.id, kind: 'summarize', benchmarkId: null };
    if (q.active) where.status = { in: ['queued', 'running'] };
    else if (q.status) where.status = q.status;
    // Old jobs only have options.preset.
    if (q.method) where.OR = [{ options: { path: ['method'], equals: q.method } }, { options: { path: ['preset'], equals: q.method } }];
    if (q.documentId) where.documentId = q.documentId;
    const res = await page(
      this.prisma,
      q,
      (p) =>
        this.prisma.job.findMany({
          where, ...p, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          include: { document: { select: { id: true, filename: true } } },
        }),
      this.prisma.job.count({ where }),
    );
    return { ...res, items: res.items.map((j) => ({ ...toJobDto(j), document: j.document })) };
  }

  async content(user: User, id: string) {
    const job = await this.findOwned(user, id);
    if (job.status !== 'done' || !job.resultMdKey) throw new NotFoundException('Summary not ready');
    return (await this.storage.get(job.resultMdKey)).toString('utf-8');
  }

  async remove(user: User, id: string) {
    const job = await this.findOwned(user, id);
    if (job.status !== 'done' && job.status !== 'failed') throw new ConflictException('Summary is still in progress');
    await this.storage.delete([job.resultMdKey, job.resultDocxKey].filter((k): k is string => !!k));
    await this.prisma.job.delete({ where: { id } });
    this.logger.log(`Job deleted: user ${user.id}, job ${id}`);
  }

  async downloadUrl(user: User, id: string, format: string) {
    if (format !== 'md' && format !== 'docx') throw new BadRequestException('format must be md or docx');
    const job = await this.findOwned(user, id);
    const key = format === 'md' ? job.resultMdKey : job.resultDocxKey;
    if (job.status !== 'done' || !key) throw new NotFoundException('Summary not ready');
    const base = job.document.filename.replace(/\.pdf$/i, '');
    return { url: await this.storage.downloadUrl(key, `${base} - Summary.${format}`) };
  }

  private async findOwned(user: User, id: string) {
    const job = await this.prisma.job.findFirst({ where: { id, userId: user.id }, include: { document: true } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }
}
