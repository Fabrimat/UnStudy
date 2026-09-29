import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { LedgerService } from '../credits/ledger.service';
import { page } from '../pagination';
import { PrismaService } from '../prisma.service';
import { CreditsDto, ListUsersDto } from './admin.dto';

type Row = Pick<User, 'id' | 'email' | 'name' | 'role' | 'createdAt' | 'deletedAt'>;

@Injectable()
export class UsersAdminService {
  private logger = new Logger(UsersAdminService.name);

  constructor(private prisma: PrismaService, private ledger: LedgerService) {}

  // Balance, counts and last login for a set of users: one grouped query each, never per user.
  private async decorate(rows: Row[]) {
    const ids = rows.map((r) => r.id);
    const [balances, docs, jobs, sessions] = await Promise.all([
      this.prisma.creditLedger.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _sum: { amount: true } }),
      this.prisma.document.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _count: { _all: true } }),
      this.prisma.job.groupBy({ by: ['userId'], where: { userId: { in: ids }, kind: 'summarize' }, _count: { _all: true } }),
      this.prisma.session.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _max: { createdAt: true } }),
    ]);
    return rows.map(({ id, email, name, role, createdAt, deletedAt }) => ({
      id, email, name, role, createdAt, deletedAt,
      balance: balances.find((b) => b.userId === id)?._sum.amount ?? 0,
      documents: docs.find((d) => d.userId === id)?._count._all ?? 0,
      jobs: jobs.find((j) => j.userId === id)?._count._all ?? 0,
      lastActiveAt: sessions.find((s) => s.userId === id)?._max.createdAt ?? null,
    }));
  }

  async list(q: ListUsersDto) {
    const where: Prisma.UserWhereInput = q.q
      ? { OR: [{ email: { contains: q.q, mode: 'insensitive' } }, { name: { contains: q.q, mode: 'insensitive' } }] }
      : {};
    const res = await page(
      this.prisma,
      q,
      (p) => this.prisma.user.findMany({ where, ...p, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
      this.prisma.user.count({ where }),
    );
    return { ...res, items: await this.decorate(res.items) };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    const [[view], ledger] = await Promise.all([
      this.decorate([user]),
      this.prisma.creditLedger.findMany({
        where: { userId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 50,
        include: { admin: { select: { email: true } } },
      }),
    ]);
    return {
      ...view,
      preferences: user.preferences,
      ledger: ledger.map(({ id, type, amount, createdAt, jobId, note, admin }) => ({ id, type, amount, createdAt, jobId, note, adminEmail: admin?.email ?? null })),
    };
  }

  async adjustCredits(admin: User, id: string, dto: CreditsDto) {
    const balance = await this.prisma.$transaction(async (tx) => {
      // Same row lock as JobsService.create: a concurrent job start cannot spend what a revoke is taking back.
      const [row] = await tx.$queryRaw<{ deletedAt: Date | null }[]>`SELECT "deletedAt" FROM "User" WHERE id = ${id}::uuid FOR UPDATE`;
      if (!row) throw new NotFoundException('User not found');
      if (row.deletedAt) throw new ConflictException('User is deleted');
      const current = await this.ledger.balance(id, tx);
      if (current + dto.amount < 0) throw new ConflictException({ message: 'Balance cannot go negative', balance: current });
      await tx.creditLedger.create({
        data: { userId: id, type: dto.amount > 0 ? 'grant' : 'revoke', amount: dto.amount, adminId: admin.id, note: dto.note },
      });
      return current + dto.amount;
    });
    this.logger.warn(`Credits ${dto.amount > 0 ? 'granted' : 'revoked'}: admin ${admin.id}, user ${id}, amount ${dto.amount}, balance ${balance}${admin.id === id ? ', self' : ''}`);
    return { balance };
  }
}
