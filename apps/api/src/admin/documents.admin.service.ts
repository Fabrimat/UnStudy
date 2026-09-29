import { GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { ListAdminDocumentsDto } from './admin.dto';
import { jobInclude, jobSummary } from './jobs.admin.service';

@Injectable()
export class DocumentsAdminService {
  private logger = new Logger(DocumentsAdminService.name);

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  private summary(d: {
    id: string; filename: string; status: string; sizeBytes: number; pages: number | null; words: number | null; usedOcr: boolean;
    createdAt: Date; fileDeletedAt: Date | null; rejectReason: string | null; user: { id: string; email: string }; _count: { jobs: number };
  }) {
    const { id, filename, status, sizeBytes, pages, words, usedOcr, createdAt, fileDeletedAt, rejectReason, user, _count } = d;
    return { id, filename, status, sizeBytes, pages, words, usedOcr, createdAt, fileDeletedAt, rejectReason, user, jobs: _count.jobs };
  }

  private include = {
    user: { select: { id: true, email: true } },
    _count: { select: { jobs: { where: { kind: 'summarize' as const } } } },
  } satisfies Prisma.DocumentInclude;

  async list(q: ListAdminDocumentsDto) {
    const where: Prisma.DocumentWhereInput = {
      ...(q.q && { filename: { contains: q.q, mode: 'insensitive' } }),
      ...(q.userId && { userId: q.userId }),
      ...(q.status && { status: q.status }),
    };
    const res = await page(
      this.prisma,
      q,
      (p) => this.prisma.document.findMany({ where, ...p, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: this.include }),
      this.prisma.document.count({ where }),
    );
    return { ...res, items: res.items.map((d) => this.summary(d)) };
  }

  async get(id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id }, include: this.include });
    if (!doc) throw new NotFoundException('Document not found');
    const jobs = await this.prisma.job.findMany({ where: { documentId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], include: jobInclude });
    return { ...this.summary(doc), chapters: doc.chapters, jobs: jobs.map(jobSummary) };
  }

  // Presigned URL, logged at issue time (privacy audit).
  async fileUrl(admin: User, id: string) {
    const doc = await this.prisma.document.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.fileDeletedAt) throw new GoneException('File was deleted');
    this.logger.log(`Admin ${admin.id} opened original file: document ${id}, owner ${doc.userId}`);
    return { url: await this.storage.downloadUrl(doc.s3Key, doc.filename) };
  }
}
