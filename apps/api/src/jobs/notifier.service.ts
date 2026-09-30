import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EmailTemplatesService } from '../auth/email-templates.service';
import { MailService } from '../auth/mail.service';
import { config } from '../config';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../storage/storage.service';

const TICK_MS = 60_000;
const SWEEP_EVERY = 60; // ticks: retention runs hourly
const PDF_RETENTION_DAYS = 30;

// Background chores of the API: email the owner of a failed summary, delete uploaded PDFs after 30 days.
@Injectable()
export class JobNotifier implements OnModuleInit, OnModuleDestroy {
  private logger = new Logger(JobNotifier.name);
  private timer?: NodeJS.Timeout;
  private ticks = 0;

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private templates: EmailTemplatesService,
    private storage: StorageService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async tick() {
    await this.run();
    if (this.ticks++ % SWEEP_EVERY === 0) await this.sweep();
  }

  // Never throws: it runs from a timer.
  async run() {
    try {
      // Atomic claim: concurrent API instances skip each other's rows, so a job is mailed at most once.
      // The 1-day window keeps the first deploy from mailing historic failures.
      const jobs = await this.prisma.$queryRaw<{ id: string; userId: string; documentId: string; credits: number }[]>`
        UPDATE "Job" SET "failureEmailedAt" = now() WHERE id IN (
          SELECT id FROM "Job"
          WHERE status = 'failed' AND kind = 'summarize' AND "benchmarkId" IS NULL AND "failureEmailedAt" IS NULL
            AND "finishedAt" > now() - interval '1 day'
          ORDER BY "finishedAt" LIMIT 20 FOR UPDATE SKIP LOCKED)
        RETURNING id, "userId", "documentId", credits`;
      for (const job of jobs) await this.notify(job);
    } catch (e) {
      this.logger.error(`Failure notifier: ${(e as Error).message}`);
    }
  }

  private async notify(job: { id: string; userId: string; documentId: string; credits: number }) {
    try {
      const [user, doc] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: job.userId } }),
        this.prisma.document.findUnique({ where: { id: job.documentId } }),
      ]);
      if (!user || user.deletedAt || !doc) return;
      const { subject, body } = await this.templates.render('job_failed', {
        filename: doc.filename,
        credits: String(job.credits),
        link: `${config.webOrigin}/jobs/${job.id}`,
        email: user.email,
      });
      await this.mail.send(user.email, subject, body);
    } catch (e) {
      // at-most-once: no retry. MailService already logged the masked provider error.
      this.logger.error(`Failed-job email for job ${job.id} not sent: ${(e as Error).message.replace(/[^\s@<>"':,]+@/g, '***@')}`);
    }
  }

  // Results (users/<id>/results/...) are kept. ponytail: fileDeletedAt is not set at a read that finds the file missing, this sweep covers it.
  async sweep() {
    try {
      const docs = await this.prisma.document.findMany({
        where: {
          fileDeletedAt: null,
          createdAt: { lt: new Date(Date.now() - PDF_RETENTION_DAYS * 86_400_000) },
          jobs: { none: { status: { in: ['queued', 'running'] } } },
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      for (const doc of docs) {
        try {
          // ponytail: a job created after the findMany fails in the worker (NoSuchKey -> refund + failure email); acceptable, add a re-check if it matters
          await this.storage.delete([doc.s3Key]);
          await this.prisma.document.update({ where: { id: doc.id }, data: { fileDeletedAt: new Date() } });
        } catch (e) {
          this.logger.error(`PDF retention: document ${doc.id} skipped (${(e as Error).message})`); // retried next run
        }
      }
    } catch (e) {
      this.logger.error(`PDF retention: ${(e as Error).message}`);
    }
  }
}
