import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { User } from '@summarize/db';
import { creditsFor } from '../credits/credits';
import { LedgerService } from '../credits/ledger.service';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { toJobDto } from './job.dto';
import { CreateJobDto } from './jobs.dto';
import { MAX_ACTIVE_SUMMARIES } from './options';

@Injectable()
export class JobsService {
  constructor(private prisma: PrismaService, private ledger: LedgerService, private storage: StorageService) {}

  create(user: User, dto: CreateJobDto) {
    const { documentId, ...options } = dto;
    return this.prisma.$transaction(async (tx) => {
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
      if (balance < credits) throw new HttpException({ message: 'Not enough credits', needed: credits, balance }, 402);
      const job = await tx.job.create({ data: { userId: user.id, documentId, kind: 'summarize', options, credits } });
      await tx.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -credits, jobId: job.id } });
      return toJobDto(job);
    });
  }

  async get(user: User, id: string) {
    return toJobDto(await this.findOwned(user, id));
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
