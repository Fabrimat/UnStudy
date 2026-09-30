import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { LegalKind, User } from '@summarize/db';
import { PrismaService } from '../prisma.service';

const PUBLISH_LOCK = 726002;
const TTL_MS = 30_000;

type Current = { id: string; kind: LegalKind; version: number };
// Module-level so tests (resetDb) can drop it. ponytail: per-process cache; other instances see a publish within TTL_MS.
let cache: { at: number; docs: Current[] } | null = null;
export const invalidateLegal = () => {
  cache = null;
};

@Injectable()
export class LegalService {
  private logger = new Logger('Admin');

  constructor(private prisma: PrismaService) {}

  // Highest version per kind; a kind that was never published is absent (nothing to accept).
  private currentDocs(): Promise<Current[]> {
    return this.prisma.legalDocument.findMany({
      distinct: ['kind'], orderBy: [{ kind: 'asc' }, { version: 'desc' }], select: { id: true, kind: true, version: true },
    });
  }

  private async cachedCurrent() {
    if (!cache || Date.now() - cache.at > TTL_MS) cache = { at: Date.now(), docs: await this.currentDocs() };
    return cache.docs;
  }

  async pending(userId: string) {
    const docs = await this.cachedCurrent();
    if (!docs.length) return [];
    const done = await this.prisma.legalAcceptance.findMany({ where: { userId, documentId: { in: docs.map((d) => d.id) } }, select: { documentId: true } });
    const accepted = new Set(done.map((a) => a.documentId));
    return docs.filter((d) => !accepted.has(d.id)).map(({ kind, version }) => ({ kind, version }));
  }

  async accept(user: User, documents: { kind: LegalKind; version: number }[]) {
    const current = await this.currentDocs(); // uncached: a stale text must never be accepted
    const ids = documents.map((d) => {
      const c = current.find((x) => x.kind === d.kind && x.version === d.version);
      if (!c) throw new ConflictException('Document version is not the current one');
      return c.id;
    });
    await this.prisma.legalAcceptance.createMany({ data: ids.map((documentId) => ({ userId: user.id, documentId })), skipDuplicates: true });
    return { pending: await this.pending(user.id) };
  }

  async publicCurrent(kind: LegalKind) {
    const d = await this.prisma.legalDocument.findFirst({ where: { kind }, orderBy: { version: 'desc' } });
    if (!d) throw new NotFoundException('Not published yet');
    return { kind: d.kind, version: d.version, body: d.body, createdAt: d.createdAt };
  }

  async history(kind: LegalKind) {
    const rows = await this.prisma.legalDocument.findMany({
      where: { kind }, orderBy: { version: 'desc' }, include: { createdBy: { select: { email: true } }, _count: { select: { acceptances: true } } },
    });
    return rows.map((r) => ({ id: r.id, kind: r.kind, version: r.version, body: r.body, createdAt: r.createdAt, createdBy: r.createdBy.email, acceptances: r._count.acceptances }));
  }

  async publish(admin: User, kind: LegalKind, body: string) {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PUBLISH_LOCK})`;
      const last = await tx.legalDocument.findFirst({ where: { kind }, orderBy: { version: 'desc' }, select: { version: true } });
      return tx.legalDocument.create({ data: { kind, body, version: (last?.version ?? 0) + 1, createdById: admin.id } });
    });
    invalidateLegal();
    this.logger.log(`admin ${admin.id} published ${kind} v${row.version}`);
    return { id: row.id, kind: row.kind, version: row.version, body: row.body, createdAt: row.createdAt, createdBy: admin.email, acceptances: 0 };
  }
}
