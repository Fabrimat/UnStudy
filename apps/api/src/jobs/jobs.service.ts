import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { creditsFor } from '../credits/credits';
import { LedgerService } from '../credits/ledger.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { toJobDto } from './job.dto';
import { CreateJobDto, ListJobsDto } from './jobs.dto';
import { MAX_ACTIVE_SUMMARIES } from './options';

@Injectable()
export class JobsService {
  private logger = new Logger(JobsService.name);

  constructor(private prisma: PrismaService, private ledger: LedgerService, private storage: StorageService) {}

  async create(user: User, dto: CreateJobDto) {
    const { documentId, ...options } = dto;
    const job = await this.prisma.$transaction(async (tx) => {
      // Row lock on the user serialises concurrent starts, so the balance check below cannot race.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id: documentId, userId: user.id } });
      if (!doc) throw new NotFoundException('Document not found');
      if (doc.status !== 'analyzed' || !doc.words || doc.fileDeletedAt) throw new ConflictException('Document is not ready');
      const active = await tx.job.count({
        where: { userId: user.id, kind: 'summarize', status: { in: ['queued', 'running'] } },
      });
      if (active >= MAX_ACTIVE_SUMMARIES) throw new HttpException(`You already have ${MAX_ACTIVE_SUMMARIES} summaries in progress`, 429);
      const credits = creditsFor(doc.words);
      const balance = await this.ledger.balance(user.id, tx);
      if (balance < credits) {
        this.logger.warn(`Not enough credits: user ${user.id}, needed ${credits}, balance ${balance}`);
        throw new HttpException({ message: 'Not enough credits', needed: credits, balance }, 402);
      }
      const job = await tx.job.create({ data: { userId: user.id, documentId, kind: 'summarize', options, credits } });
      await tx.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -credits, jobId: job.id } });
      return toJobDto(job);
    });
    this.logger.log(`Job created: ${job.id}, ${job.credits} credits reserved`);
    return job;
  }

  async get(user: User, id: string) {
    return toJobDto(await this.findOwned(user, id));
  }

  async list(user: User, q: ListJobsDto) {
    const where: Prisma.JobWhereInput = { userId: user.id, kind: 'summarize' };
    if (q.active) where.status = { in: ['queued', 'running'] };
    else if (q.status) where.status = q.status;
    if (q.method) where.options = { path: ['preset'], equals: q.method };
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
