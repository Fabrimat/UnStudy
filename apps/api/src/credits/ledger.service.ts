import { Injectable } from '@nestjs/common';
import { Prisma } from '@summarize/db';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  // Balance = SUM(amount): reserve is negative, charge is 0, refund gives the reserve back.
  async balance(userId: string, tx: Prisma.TransactionClient = this.prisma): Promise<number> {
    const { _sum } = await tx.creditLedger.aggregate({ where: { userId }, _sum: { amount: true } });
    return _sum.amount ?? 0;
  }
}
