import { INestApplication } from '@nestjs/common';
import { MailService } from '../src/auth/mail.service';
import { JobNotifier } from '../src/jobs/notifier.service';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, resetDb } from './helpers';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

describe('job notifier', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let notifier: JobNotifier;
  const sent: { to: string; subject: string; text: string }[] = [];
  const deleted: string[][] = [];

  beforeAll(async () => {
    app = await createApp((b) =>
      b
        .overrideProvider(MailService)
        .useValue({ send: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) })
        .overrideProvider(StorageService)
        .useValue({ delete: async (keys: string[]) => void deleted.push(keys) }),
    );
    prisma = app.get(PrismaService);
    notifier = app.get(JobNotifier);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    sent.length = 0;
    deleted.length = 0;
    await resetDb(prisma);
  });

  const doc = async (userId: string, createdAt = new Date(), filename = 'book.pdf') =>
    prisma.document.create({ data: { userId, s3Key: `users/${userId}/${filename}`, filename, sizeBytes: 1, createdAt } });
  const job = async (userId: string, documentId: string, data: object = {}) =>
    prisma.job.create({ data: { userId, documentId, kind: 'summarize', status: 'failed', credits: 7, finishedAt: new Date(), ...data } });

  describe('failure email', () => {
    it('mails a failed summary once', async () => {
      const { user } = await loginAs(app, 'ada@x.com');
      const d = await doc(user.id, new Date(), 'Report.pdf');
      await job(user.id, d.id);
      await notifier.run();
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('ada@x.com');
      expect(sent[0].subject).toContain('Report.pdf');
      expect(sent[0].text).toContain('7 credits');
      await notifier.run();
      expect(sent).toHaveLength(1);
    });

    it('skips lab lanes, analyze jobs and old failures', async () => {
      const { user } = await loginAs(app, 'ada@x.com');
      const d = await doc(user.id);
      const bench = await prisma.benchmark.create({ data: { userId: user.id, documentId: d.id, options: {} } });
      await job(user.id, d.id, { benchmarkId: bench.id });
      await job(user.id, d.id, { kind: 'analyze' });
      await job(user.id, d.id, { finishedAt: ago(2) });
      await notifier.run();
      expect(sent).toHaveLength(0);
    });
  });

  describe('PDF retention', () => {
    it('deletes PDFs older than 30 days, keeps recent ones and ones in use', async () => {
      const { user } = await loginAs(app, 'ada@x.com');
      const old = await doc(user.id, ago(31), 'old.pdf');
      const recent = await doc(user.id, ago(29), 'recent.pdf');
      const busy = await doc(user.id, ago(31), 'busy.pdf');
      await job(user.id, busy.id, { status: 'running', finishedAt: null });
      await notifier.sweep();
      expect(deleted).toEqual([[old.s3Key]]);
      expect((await prisma.document.findUnique({ where: { id: old.id } }))!.fileDeletedAt).not.toBeNull();
      expect((await prisma.document.findUnique({ where: { id: recent.id } }))!.fileDeletedAt).toBeNull();
      expect((await prisma.document.findUnique({ where: { id: busy.id } }))!.fileDeletedAt).toBeNull();
      await notifier.sweep();
      expect(deleted).toHaveLength(1);
    });
  });
});
