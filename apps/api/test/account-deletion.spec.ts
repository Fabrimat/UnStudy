import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LedgerService } from '../src/credits/ledger.service';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

describe('account deletion', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const deletePrefix = jest.fn(async (_prefix: string) => {});
  beforeAll(async () => {
    app = await createApp((b) => b.overrideProvider(StorageService).useValue({ deletePrefix, onModuleInit: async () => {} }));
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb(prisma);
    deletePrefix.mockClear();
  });

  const http = () => request(app.getHttpServer());
  const del = (cookie: string, confirm: string) => http().delete('/api/me').set('Origin', ORIGIN).set('Cookie', cookie).send({ confirm });
  const seed = async (userId: string, status: 'done' | 'running' = 'done') => {
    const d = await prisma.document.create({ data: { userId, filename: 'a.pdf', sizeBytes: 1, s3Key: `users/${userId}/documents/a.pdf`, status: 'analyzed' } });
    return prisma.job.create({ data: { userId, documentId: d.id, kind: 'summarize', status, credits: 2, options: {} } });
  };

  it('rejects a wrong confirmation', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    await del(cookie, 'other@x.com').expect(400);
    await http().get('/api/me').set('Cookie', cookie).expect(200);
  });

  it('refuses while a job is queued or running', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await seed(user.id, 'running');
    await del(cookie, 'u@x.com').expect(409);
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(1);
  });

  it('anonymizes the user, keeps the ledger, and lets the same email start over', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const job = await seed(user.id);
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'grant', amount: 10 } });
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'charge', amount: -2, jobId: job.id } });

    await del(cookie, '  U@X.com ').expect(204);
    expect(deletePrefix).toHaveBeenCalledWith(`users/${user.id}/`);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.email).toMatch(/^deleted-[0-9a-f]{64}@deleted\.invalid$/);
    expect(row.name).toBeNull();
    expect(await prisma.document.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.job.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.authAccount.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.creditLedger.count({ where: { userId: user.id } })).toBe(2);

    await http().get('/api/me').set('Cookie', cookie).expect(401);

    const again = await loginAs(app, 'u@x.com');
    expect(again.user.id).not.toBe(user.id);
    expect(await app.get(LedgerService).balance(again.user.id)).toBe(0);

    // Erasure must work again for the same email (anonymized addresses are unique per account).
    await del(again.cookie, 'u@x.com').expect(204);
  });

  it('still succeeds when S3 cleanup fails', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    deletePrefix.mockRejectedValueOnce(new Error('s3 down'));
    await del(cookie, 'u@x.com').expect(204);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).deletedAt).not.toBeNull();
  });
});
