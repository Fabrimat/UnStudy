import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { User } from '@summarize/db';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';
import { sha256 } from './tokens';

@Injectable()
export class AccountService {
  private logger = new Logger(AccountService.name);

  constructor(private prisma: PrismaService, private storage: StorageService) {}

  // GDPR erasure. CreditLedger, StripeEvent and LegalAcceptance stay (tax / consent evidence); the User row is anonymized, not removed.
  async delete(user: User) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id}::uuid FOR UPDATE`;
      if (await tx.job.count({ where: { userId: user.id, status: { in: ['queued', 'running'] } } })) {
        throw new ConflictException('A summary is still being processed. Wait for it to finish, then delete your account.');
      }
      const where = { userId: user.id };
      await tx.job.deleteMany({ where });
      await tx.benchmark.deleteMany({ where });
      await tx.document.deleteMany({ where });
      await tx.summaryMethod.deleteMany({ where });
      await tx.session.deleteMany({ where });
      await tx.authAccount.deleteMany({ where });
      await tx.magicLinkToken.deleteMany({ where: { email: user.email } });
      await tx.user.update({
        where: { id: user.id },
        data: { email: `deleted-${sha256(`${user.id}:${user.email.toLowerCase()}`)}@deleted.invalid`, name: null, preferences: {}, role: 'user', deletedAt: new Date() },
      });
    });
    this.logger.log(`user ${user.id} deleted their account`);
    try {
      await this.storage.deletePrefix(`users/${user.id}/`);
    } catch (e) {
      this.logger.error(`S3 cleanup failed for deleted user ${user.id}: ${(e as Error).message}`);
    }
  }
}
