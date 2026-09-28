import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Document, Job, User } from '@summarize/db';
import { randomUUID } from 'node:crypto';
import { creditsFor } from '../credits/credits';
import { toJobDto } from '../jobs/job.dto';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { MAX_UPLOAD_BYTES } from './documents.dto';

const MAX_UPLOADS_PER_HOUR = 30;
const withSummaries = {
  jobs: { where: { kind: 'summarize' as const }, orderBy: { createdAt: 'desc' as const } },
  _count: { select: { jobs: { where: { kind: 'analyze' as const } } } },
};

export function toDocDto(doc: Document & { jobs?: Job[]; _count?: { jobs: number } }) {
  const { id, filename, sizeBytes, status, rejectReason, pages, words, chapters, createdAt } = doc;
  return {
    id, filename, sizeBytes, status, rejectReason, pages, words, chapters, createdAt,
    credits: words ? creditsFor(words) : null,
    // An interrupted upload (no PUT, no confirm) never gets an analyze job, so the doc is stuck
    // "uploaded" forever; the web uses this to tell that apart from a normal in-flight analyze (F3).
    analysisQueued: (doc._count?.jobs ?? 0) > 0,
    jobs: (doc.jobs ?? []).map(toJobDto),
  };
}

@Injectable()
export class DocumentsService {
  constructor(private prisma: PrismaService, private storage: StorageService) {}

  async create(user: User, filename: string, sizeBytes: number) {
    const recent = await this.prisma.document.count({
      where: { userId: user.id, createdAt: { gt: new Date(Date.now() - 3600_000) } },
    });
    if (recent >= MAX_UPLOADS_PER_HOUR) throw new HttpException('Upload limit reached, try again in an hour', 429);
    const id = randomUUID();
    const s3Key = `users/${user.id}/documents/${id}.pdf`;
    const doc = await this.prisma.document.create({ data: { id, userId: user.id, filename, sizeBytes, s3Key } });
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
    if (result.rejected) throw new BadRequestException('Uploaded file does not match the declared size');
    return toDocDto({ ...result.doc, _count: { jobs: 1 } }); // the analyze job was just created above
  }

  async list(user: User) {
    const docs = await this.prisma.document.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: withSummaries,
    });
    return docs.map(toDocDto);
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
