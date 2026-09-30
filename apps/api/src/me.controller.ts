import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import { Response } from 'express';
import { AccountService } from './auth/account.service';
import { LegalService } from './auth/legal.service';
import { AllowPendingLegal, CurrentUser, SESSION_COOKIE, SessionGuard } from './auth/session.guard';
import { CatalogService } from './catalog/catalog.service';
import { LedgerService } from './credits/ledger.service';
import { AcceptLegalDto, DeleteAccountDto, PreferencesDto } from './preferences.dto';
import { page, PageQueryDto } from './pagination';
import { PrismaService } from './prisma.service';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private ledger: LedgerService, private prisma: PrismaService, private catalog: CatalogService, private legal: LegalService, private account: AccountService) {}

  @Get()
  @AllowPendingLegal()
  async me(@CurrentUser() user: User) {
    // A saved model that was disabled or removed is dropped from the view (the stored preference stays).
    const { model, ...prefs } = user.preferences as Record<string, unknown>;
    const preferences = typeof model === 'string' && (await this.catalog.userModels()).some((m) => m.id === model) ? { ...prefs, model } : prefs;
    return { id: user.id, email: user.email, name: user.name, balance: await this.ledger.balance(user.id), preferences, role: user.role, legal: { pending: await this.legal.pending(user.id) } };
  }

  @Post('legal/accept')
  @HttpCode(200)
  @AllowPendingLegal()
  acceptLegal(@CurrentUser() user: User, @Body() dto: AcceptLegalDto) {
    return this.legal.accept(user, dto.documents);
  }

  @Delete()
  @HttpCode(204)
  @AllowPendingLegal()
  async deleteAccount(@CurrentUser() user: User, @Body() dto: DeleteAccountDto, @Res({ passthrough: true }) res: Response) {
    if (dto.confirm.trim().toLowerCase() !== user.email.toLowerCase()) throw new BadRequestException('Confirmation does not match your email');
    await this.account.delete(user);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Patch('preferences')
  async setPreferences(@CurrentUser() user: User, @Body() dto: PreferencesDto) {
    if (typeof dto.model === 'string') await this.catalog.userModel(dto.model);
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
    const done = { userId: user.id, kind: 'summarize' as const, status: 'done' as const, benchmarkId: null };
    const [documents, summariesDone, spent, pages] = await this.prisma.$transaction([
      this.prisma.document.count({ where: { userId: user.id } }),
      this.prisma.job.count({ where: done }),
      // From the ledger, so deleting a finished summary does not lower the total.
      this.prisma.creditLedger.aggregate({ where: { userId: user.id, type: { in: ['reserve', 'refund', 'charge'] } }, _sum: { amount: true } }),
      this.prisma.$queryRaw<{ pages: number }[]>`
        SELECT COALESCE(SUM(d.pages), 0)::int AS pages FROM "Job" j JOIN "Document" d ON d.id = j."documentId"
        WHERE j."userId" = ${user.id}::uuid AND j.kind = 'summarize' AND j.status = 'done' AND j."benchmarkId" IS NULL`,
    ]);
    return { documents, summariesDone, creditsSpent: -(spent._sum.amount ?? 0), pagesSummarized: pages[0].pages };
  }
}
