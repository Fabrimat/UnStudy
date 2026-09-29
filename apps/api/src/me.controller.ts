import { BadRequestException, Body, Controller, Get, NotFoundException, Patch, Query, UseGuards } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { CurrentUser, SessionGuard } from './auth/session.guard';
import { config } from './config';
import { LedgerService } from './credits/ledger.service';
import { PreferencesDto } from './preferences.dto';
import { page, PageQueryDto } from './pagination';
import { PrismaService } from './prisma.service';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private ledger: LedgerService, private prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name, balance: await this.ledger.balance(user.id), preferences: user.preferences };
  }

  @Patch('preferences')
  async setPreferences(@CurrentUser() user: User, @Body() dto: PreferencesDto) {
    if (typeof dto.model === 'string' && !config.models.some((m) => m.id === dto.model)) throw new BadRequestException('Unknown model');
    return this.prisma.$transaction(async (tx) => {
      // User row lock: two concurrent PATCHes must not lose each other's merge.
      const [row] = await tx.$queryRaw<{ preferences: Prisma.JsonObject }[]>`SELECT preferences FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      if (typeof dto.method === 'string' && dto.method.startsWith('custom:')) {
        if (!(await tx.summaryMethod.findFirst({ where: { id: dto.method.slice(7), userId: user.id } }))) throw new NotFoundException('Method not found');
      }
      const merged: Record<string, unknown> = { ...row.preferences };
      for (const [k, v] of Object.entries(dto)) {
        if (v === null) delete merged[k];
        else if (v !== undefined) merged[k] = v;
      }
      const updated = await tx.user.update({ where: { id: user.id }, data: { preferences: merged as Prisma.InputJsonObject } });
      return updated.preferences;
    });
  }

  @Get('ledger')
  async history(@CurrentUser() user: User, @Query() q: PageQueryDto) {
    const where = { userId: user.id };
    const res = await page(
      this.prisma,
      q,
      (p) =>
        this.prisma.creditLedger.findMany({
          where, ...p, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          include: { job: { select: { document: { select: { filename: true } } } } },
        }),
      this.prisma.creditLedger.count({ where }),
    );
    return {
      ...res,
      items: res.items.map(({ id, type, amount, createdAt, jobId, job }) => ({
        id, type, amount, createdAt, jobId, filename: job?.document.filename ?? null,
      })),
    };
  }

  @Get('stats')
  async stats(@CurrentUser() user: User) {
    const done = { userId: user.id, kind: 'summarize' as const, status: 'done' as const };
    const [documents, summariesDone, spent, pages] = await this.prisma.$transaction([
      this.prisma.document.count({ where: { userId: user.id } }),
      this.prisma.job.count({ where: done }),
      // From the ledger, so deleting a finished summary does not lower the total.
      this.prisma.creditLedger.aggregate({ where: { userId: user.id, type: { in: ['reserve', 'refund', 'charge'] } }, _sum: { amount: true } }),
      this.prisma.$queryRaw<{ pages: number }[]>`
        SELECT COALESCE(SUM(d.pages), 0)::int AS pages FROM "Job" j JOIN "Document" d ON d.id = j."documentId"
        WHERE j."userId" = ${user.id}::uuid AND j.kind = 'summarize' AND j.status = 'done'`,
    ]);
    return { documents, summariesDone, creditsSpent: -(spent._sum.amount ?? 0), pagesSummarized: pages[0].pages };
  }
}
