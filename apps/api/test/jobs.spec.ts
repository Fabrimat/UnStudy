import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const OPTIONS = { language: 'auto', fraction: 3, method: 'studio' };

describe('jobs and credits', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const start = (cookie: string, body: object) => http().post('/api/jobs').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const grant = (userId: string, amount: number) => prisma.creditLedger.create({ data: { userId, type: 'grant', amount } });
  const analyzedDoc = (userId: string, words = 2500, filename = 'reading.pdf') =>
    prisma.document.create({
      data: {
        userId, filename, sizeBytes: 100, s3Key: `users/${userId}/documents/x.pdf`, status: 'analyzed', pages: 10, words,
        chapters: [{ title: 'Document', pageFrom: 1, pageTo: 10, words }],
      },
    });
  const balance = async (cookie: string) => (await http().get('/api/me').set('Cookie', cookie).expect(200)).body.balance;

  it('refuses to start without enough credits', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const doc = await analyzedDoc(user.id);
    const res = await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(402);
    expect(res.body).toMatchObject({ needed: 3, balance: 0 });
  });

  it('reserves the quoted credits when a job starts', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 10);
    const doc = await analyzedDoc(user.id, 2500);
    const res = await start(cookie, { documentId: doc.id, ...OPTIONS, bibliographicLine: '**A** – *B*' }).expect(201);
    expect(res.body).toMatchObject({ kind: 'summarize', status: 'queued', credits: 3, options: { ...OPTIONS, bibliographicLine: '**A** – *B*' } });
    expect(res.body.warnings).toBeUndefined();
    expect(await balance(cookie)).toBe(7);
    expect(await prisma.creditLedger.findMany({ where: { jobId: res.body.id } })).toMatchObject([{ type: 'reserve', amount: -3 }]);
  });

  it('never lets two parallel starts overspend', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 3);
    const doc = await analyzedDoc(user.id, 2500);
    const results = await Promise.all([start(cookie, { documentId: doc.id, ...OPTIONS }), start(cookie, { documentId: doc.id, ...OPTIONS })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 402]);
    expect(await balance(cookie)).toBe(0);
  });

  it('allows at most 3 active summaries', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 100);
    const doc = await analyzedDoc(user.id, 500);
    for (let i = 0; i < 3; i++) await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(201);
    await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(429);
  });

  it('checks document state, ownership and options', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    await grant(user.id, 100);
    const doc = await analyzedDoc(user.id);
    const pending = await prisma.document.create({ data: { userId: user.id, filename: 'p.pdf', sizeBytes: 1, s3Key: 'k' } });
    await start(cookie, { documentId: pending.id, ...OPTIONS }).expect(409);
    await start(bob.cookie, { documentId: doc.id, ...OPTIONS }).expect(404);
    await start(cookie, { documentId: doc.id, ...OPTIONS, fraction: 4 }).expect(400);
    await start(cookie, { documentId: doc.id, ...OPTIONS, method: 'poem' }).expect(400);
    await start(cookie, { documentId: doc.id, ...OPTIONS, bibliographicLine: 'a\nb' }).expect(400);
    const job = await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(201);
    await http().get(`/api/jobs/${job.body.id}`).set('Cookie', bob.cookie).expect(404);
    await http().get(`/api/jobs/${job.body.id}`).set('Cookie', cookie).expect(200);
  });

  it('serves downloads only when done, with a unicode-safe filename', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 10);
    const doc = await analyzedDoc(user.id, 500, 'Lijphart – CH 2 & 3 "è".pdf');
    const job = (await start(cookie, { documentId: doc.id, ...OPTIONS }).expect(201)).body;
    await http().get(`/api/jobs/${job.id}/download?format=md`).set('Cookie', cookie).expect(404);
    await http().get(`/api/jobs/${job.id}/download?format=pdf`).set('Cookie', cookie).expect(400);

    const key = `users/${user.id}/results/${job.id}.md`;
    await app.get(StorageService).put(key, Buffer.from('# Summary\n'), 'text/markdown');
    await prisma.job.update({ where: { id: job.id }, data: { status: 'done', resultMdKey: key } });
    const { url } = (await http().get(`/api/jobs/${job.id}/download?format=md`).set('Cookie', cookie).expect(200)).body;
    const file = await fetch(url);
    expect(await file.text()).toBe('# Summary\n');
    const disposition = file.headers.get('content-disposition')!;
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)![1])).toBe('Lijphart – CH 2 & 3 "è" - Summary.md');
  });
});
