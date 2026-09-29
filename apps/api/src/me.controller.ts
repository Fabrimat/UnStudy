import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from './auth/session.guard';
import { LedgerService } from './credits/ledger.service';
import { page, PageQueryDto } from './pagination';
import { PrismaService } from './prisma.service';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private ledger: LedgerService, private prisma: PrismaService) {}

  @Get()
  async me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name, balance: await this.ledger.balance(user.id) };
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
      this.prisma.job.aggregate({ where: done, _sum: { credits: true } }),
      this.prisma.$queryRaw<{ pages: number }[]>`
        SELECT COALESCE(SUM(d.pages), 0)::int AS pages FROM "Job" j JOIN "Document" d ON d.id = j."documentId"
        WHERE j."userId" = ${user.id}::uuid AND j.kind = 'summarize' AND j.status = 'done'`,
    ]);
    return { documents, summariesDone, creditsSpent: spent._sum.credits ?? 0, pagesSummarized: pages[0].pages };
  }
}
