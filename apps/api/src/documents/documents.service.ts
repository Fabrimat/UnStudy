import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Document, Job, Prisma, User } from '@summarize/db';
import { randomUUID } from 'node:crypto';
import { creditsFor } from '../credits/credits';
import { toJobDto } from '../jobs/job.dto';
import { PrismaService } from '../prisma.service';
import { labPromptKey, labSourceKey, StorageService } from '../storage/storage.service';
import { page } from '../pagination';
import { ListDocumentsDto, MAX_UPLOAD_BYTES } from './documents.dto';

const MAX_UPLOADS_PER_HOUR = 30;
const withSummaries = {
  // Lab (benchmark) jobs belong to the admin tool, never to the document page.
  jobs: { where: { kind: 'summarize' as const, benchmarkId: null }, orderBy: { createdAt: 'desc' as const } },
  _count: { select: { jobs: { where: { kind: 'analyze' as const } } } },
};

export function toDocDto(doc: Document & { jobs?: Job[]; _count?: { jobs: number } }) {
  const { id, filename, sizeBytes, status, rejectReason, pages, words, chapters, createdAt } = doc;
  return {
    id, filename, sizeBytes, status, rejectReason, pages, words, chapters, createdAt,
    credits: words ? creditsFor(words) : null,
    fileDeleted: !!doc.fileDeletedAt,
    // An interrupted upload (no PUT, no confirm) never gets an analyze job, so the doc is stuck
    // "uploaded" forever; the web uses this to tell that apart from a normal in-flight analyze (F3).
    analysisQueued: (doc._count?.jobs ?? 0) > 0,
    jobs: (doc.jobs ?? []).map(toJobDto),
  };
}

@Injectable()
export class DocumentsService {
  private logger = new Logger(DocumentsService.name);

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async create(user: User, filename: string, sizeBytes: number) {
    const recent = await this.prisma.document.count({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= MAX_UPLOADS_PER_HOUR) {
      this.logger.warn(`Upload limit reached: user ${user.id}`);
      throw new HttpException('Upload limit reached, try again in an hour', 429);
    }
    const id = randomUUID();
    const s3Key = `users/${user.id}/documents/${id}.pdf`;
    // User lock + deletedAt check: account deletion must not leave an orphan document behind.
    const doc = await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ deletedAt: Date | null }[]>`SELECT "deletedAt" FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      if (row?.deletedAt) throw new UnauthorizedException();
      return tx.document.create({ data: { id, userId: user.id, filename, sizeBytes, s3Key } });
    });
    this.logger.log(`Upload URL issued: doc ${id}, ${sizeBytes} bytes`);
    return { document: toDocDto(doc), uploadUrl: await this.storage.uploadUrl(s3Key, sizeBytes) };
  }

  async confirmUpload(user: User, id: string) {
    await this.findOwned(user, id); // 404 if not the caller's document
    const result = await this.prisma.$transaction(async (tx) => {
      // Lock the document row so two concurrent confirms serialize: the second one only ever
      // observes the first's committed status/job, instead of both racing past the same checks.
      await tx.$queryRaw`SELECT id FROM "Document" WHERE id = ${id}::uuid FOR UPDATE`;
      const doc = await tx.document.findUniqueOrThrow({ where: { id } });
      const alreadyQueued = await tx.job.count({ where: { documentId: id, kind: 'analyze' } });
      if (doc.status !== 'uploaded' || alreadyQueued) throw new ConflictException('Document already submitted');
      const head = await this.storage.head(doc.s3Key);
      if (!head) throw new BadRequestException('File not uploaded yet');
      if (head.size !== doc.sizeBytes || head.size > MAX_UPLOAD_BYTES) {
        // Throwing here would roll back this update, so commit the rejection and report it to the
        // caller, which throws only after the transaction has committed.
        const rejected = await tx.document.update({
          where: { id },
          data: { status: 'rejected', rejectReason: 'Uploaded file does not match the declared size' },
        });
        return { rejected: true as const, doc: rejected };
      }
      await tx.job.create({ data: { userId: user.id, documentId: id, kind: 'analyze' } });
      return { rejected: false as const, doc };
    });
    if (result.rejected) {
      this.logger.warn(`Document rejected: doc ${id}, size mismatch`);
      throw new BadRequestException('Uploaded file does not match the declared size');
    }
    this.logger.log(`Document confirmed: doc ${id}`);
    return toDocDto({ ...result.doc, _count: { jobs: 1 } }); // the analyze job was just created above
  }

  async list(user: User, q: ListDocumentsDto) {
    const where: Prisma.DocumentWhereInput = { userId: user.id };
    if (q.q) where.filename = { contains: q.q, mode: 'insensitive' };
    if (q.status === 'analyzing') where.status = 'uploaded';
    else if (q.status === 'ready') where.status = 'analyzed';
    else if (q.status === 'rejected') where.status = 'rejected';
    else if (q.status === 'summarized') where.jobs = { some: { kind: 'summarize', status: 'done', benchmarkId: null } };
    const res = await page(
      this.prisma,
      q,
      (p) =>
        this.prisma.document.findMany({
          where, ...p, include: withSummaries,
          orderBy: [{ [q.sort]: q.order }, { id: 'asc' }],
        }),
      this.prisma.document.count({ where }),
    );
    return { ...res, items: res.items.map(toDocDto) };
  }

  async rename(user: User, id: string, filename: string) {
    await this.findOwned(user, id);
    const doc = await this.prisma.document.update({ where: { id }, data: { filename }, include: withSummaries });
    this.logger.log(`Document renamed: user ${user.id}, doc ${id}`);
    return toDocDto(doc);
  }

  async remove(user: User, id: string) {
    await this.prisma.$transaction(async (tx) => {
      // Same user lock as JobsService.create, so no job can start while the document is being deleted.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      const doc = await tx.document.findFirst({ where: { id, userId: user.id }, include: { jobs: true } });
      if (!doc) throw new NotFoundException('Document not found');
      if (doc.jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
        throw new ConflictException('Document has jobs in progress');
      }
      const labJobs = doc.jobs.filter((j) => j.benchmarkId); // their benchmarks cascade with the document
      const labRuns = new Set(labJobs.map((j) => j.benchmarkId!));
      const keys = [doc.s3Key, ...doc.jobs.flatMap((j) => [j.resultMdKey, j.resultDocxKey]), ...[...labRuns].map((b) => labSourceKey(user.id, b)), ...labJobs.map((j) => labPromptKey(user.id, j.benchmarkId!, j.id))].filter((k): k is string => !!k);
      // S3 first: if it fails the transaction rolls back and the DB stays intact.
      await this.storage.delete(keys);
      await tx.document.delete({ where: { id } });
    }, { timeout: 15_000 }); // the S3 round trip runs inside the transaction; the 5 s default is tight
    this.logger.log(`Document deleted: user ${user.id}, doc ${id}`);
  }

  async get(user: User, id: string) {
    return toDocDto(await this.findOwned(user, id));
  }

  private async findOwned(user: User, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, userId: user.id }, include: withSummaries });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }
}
