import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

describe('library: documents, jobs, ledger, stats', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let storage: StorageService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    storage = app.get(StorageService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const get = (cookie: string, url: string) => http().get(url).set('Cookie', cookie);
  const patch = (cookie: string, url: string, body: object) => http().patch(url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const del = (cookie: string, url: string) => http().delete(url).set('Origin', ORIGIN).set('Cookie', cookie);
  const doc = (userId: string, filename = 'a.pdf', extra: object = {}) =>
    prisma.document.create({
      data: { userId, filename, sizeBytes: 1, s3Key: `users/${userId}/documents/${filename}-${Math.random()}.pdf`, status: 'analyzed', pages: 10, words: 2500, ...extra },
    });
  const job = (userId: string, documentId: string, extra: object = {}) =>
    prisma.job.create({ data: { userId, documentId, kind: 'summarize', options: { preset: 'studio', fraction: 3, language: 'auto' }, credits: 3, ...extra } });

  it('renames a document and validates the name', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    const d = await doc(user.id);
    const res = await patch(cookie, `/api/documents/${d.id}`, { filename: '  New name  ' }).expect(200);
    expect(res.body.filename).toBe('New name');
    for (const filename of ['', '   ', 'x'.repeat(201), 'a\nb']) {
      await patch(cookie, `/api/documents/${d.id}`, { filename }).expect(400);
    }
    await patch(bob.cookie, `/api/documents/${d.id}`, { filename: 'hack' }).expect(404);
  });

  it('refuses to delete a document with an active job', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    await job(user.id, d.id, { status: 'queued' });
    await del(cookie, `/api/documents/${d.id}`).expect(409);
    expect(await prisma.document.count()).toBe(1);
  });

  it('deletes a document with its S3 objects and keeps the ledger', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    const j = await job(user.id, d.id, { status: 'done', resultMdKey: `${d.s3Key}.md`, resultDocxKey: `${d.s3Key}.docx` });
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -3, jobId: j.id } });
    for (const [k, type] of [[d.s3Key, 'application/pdf'], [j.resultMdKey!, 'text/markdown'], [j.resultDocxKey!, 'application/zip']]) {
      await storage.put(k, Buffer.from('x'), type);
    }
    await del(cookie, `/api/documents/${d.id}`).expect(204);
    for (const k of [d.s3Key, j.resultMdKey!, j.resultDocxKey!]) expect(await storage.head(k)).toBeNull();
    expect(await prisma.document.count()).toBe(0);
    expect(await prisma.creditLedger.findMany()).toMatchObject([{ jobId: null, amount: -3 }]);
    await del(cookie, `/api/documents/${d.id}`).expect(404);
  });

  it('keeps the database intact when S3 deletion fails', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    const spy = jest.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('s3 down'));
    await del(cookie, `/api/documents/${d.id}`).expect(500);
    spy.mockRestore();
    expect(await prisma.document.count()).toBe(1);
  });

  it('deletes only finished jobs', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    const running = await job(user.id, d.id, { status: 'running' });
    const done = await job(user.id, d.id, { status: 'done', resultMdKey: `${d.s3Key}.md` });
    await storage.put(done.resultMdKey!, Buffer.from('# hi'), 'text/markdown');
    await del(cookie, `/api/jobs/${running.id}`).expect(409);
    await del(cookie, `/api/jobs/${done.id}`).expect(204);
    expect(await storage.head(done.resultMdKey!)).toBeNull();
    expect(await prisma.job.count()).toBe(1);
  });

  it('serves the markdown of a done job, 404 otherwise', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    const done = await job(user.id, d.id, { status: 'done', resultMdKey: `${d.s3Key}.md` });
    await storage.put(done.resultMdKey!, Buffer.from('# Ciao è'), 'text/markdown');
    const res = await get(cookie, `/api/jobs/${done.id}/content`).expect(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.text).toBe('# Ciao è');
    const running = await job(user.id, d.id, { status: 'running' });
    await get(cookie, `/api/jobs/${running.id}/content`).expect(404);
  });

  it('returns 404 on other users resources', async () => {
    const { user } = await loginAs(app, 'u@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    const d = await doc(user.id);
    const j = await job(user.id, d.id, { status: 'done', resultMdKey: `${d.s3Key}.md` });
    await del(bob.cookie, `/api/documents/${d.id}`).expect(404);
    await del(bob.cookie, `/api/jobs/${j.id}`).expect(404);
    await get(bob.cookie, `/api/jobs/${j.id}/content`).expect(404);
    expect((await get(bob.cookie, '/api/documents').expect(200)).body.total).toBe(0);
    expect((await get(bob.cookie, '/api/jobs').expect(200)).body.total).toBe(0);
    expect((await get(bob.cookie, '/api/me/ledger').expect(200)).body.total).toBe(0);
    expect((await get(bob.cookie, '/api/me/stats').expect(200)).body).toEqual({ documents: 0, summariesDone: 0, creditsSpent: 0, pagesSummarized: 0 });
    expect(await prisma.document.count()).toBe(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it('paginates, filters and sorts documents', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const b = await doc(user.id, 'b.pdf', { createdAt: new Date('2026-01-01') });
    await doc(user.id, 'a.pdf', { createdAt: new Date('2026-01-02') });
    await doc(user.id, 'c-report.pdf', { status: 'uploaded', createdAt: new Date('2026-01-03') });
    await doc(user.id, 'd.pdf', { status: 'rejected', createdAt: new Date('2026-01-04') });
    await job(user.id, b.id, { status: 'done' });

    const all = (await get(cookie, '/api/documents?pageSize=3').expect(200)).body;
    expect(all).toMatchObject({ total: 4, page: 1, pageSize: 3 });
    expect(all.items.map((i: any) => i.filename)).toEqual(['d.pdf', 'c-report.pdf', 'a.pdf']);
    expect((await get(cookie, '/api/documents?pageSize=3&page=2').expect(200)).body.items).toHaveLength(1);
    const beyond = (await get(cookie, '/api/documents?page=9').expect(200)).body;
    expect(beyond).toMatchObject({ items: [], total: 4 });

    const names = async (qs: string) => (await get(cookie, `/api/documents?${qs}`).expect(200)).body.items.map((i: any) => i.filename);
    expect(await names('sort=filename&order=asc')).toEqual(['a.pdf', 'b.pdf', 'c-report.pdf', 'd.pdf']);
    expect(await names('q=REPORT')).toEqual(['c-report.pdf']);
    expect(await names('status=analyzing')).toEqual(['c-report.pdf']);
    expect(await names('status=ready&sort=filename&order=asc')).toEqual(['a.pdf', 'b.pdf']);
    expect(await names('status=rejected')).toEqual(['d.pdf']);
    expect(await names('status=summarized')).toEqual(['b.pdf']);

    for (const qs of ['pageSize=0', 'pageSize=101', 'page=0', 'page=x', 'status=nope', 'sort=size']) {
      await get(cookie, `/api/documents?${qs}`).expect(400);
    }
  });

  it('lists summarize jobs with filters, newest first', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d1 = await doc(user.id, 'one.pdf');
    const d2 = await doc(user.id, 'two.pdf');
    await prisma.job.create({ data: { userId: user.id, documentId: d1.id, kind: 'analyze', status: 'done' } });
    await job(user.id, d1.id, { status: 'done', createdAt: new Date('2026-01-01') });
    await job(user.id, d2.id, { status: 'running', createdAt: new Date('2026-01-02'), options: { preset: 'abstract', fraction: 5, language: 'en' } });
    const list = async (qs = '') => (await get(cookie, `/api/jobs?${qs}`).expect(200)).body;
    const all = await list();
    expect(all.total).toBe(2);
    expect(all.items.map((j: any) => j.document.filename)).toEqual(['two.pdf', 'one.pdf']);
    expect(all.items[0].document).toEqual({ id: d2.id, filename: 'two.pdf' });
    expect(all.items[0].inputTokens).toBeUndefined();
    expect((await list('status=done')).items).toHaveLength(1);
    expect((await list('method=abstract')).items).toMatchObject([{ status: 'running' }]);
    expect((await list('active=true')).items).toMatchObject([{ status: 'running' }]);
    expect((await list(`documentId=${d1.id}`)).total).toBe(1);
    await get(cookie, '/api/jobs?pageSize=101').expect(400);
    await get(cookie, '/api/jobs?status=x').expect(400);
  });

  it('reports stats and a paginated ledger', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d1 = await doc(user.id, 'one.pdf', { pages: 10 });
    const d2 = await doc(user.id, 'two.pdf', { pages: 7 });
    const done = await job(user.id, d1.id, { status: 'done', credits: 3 });
    await job(user.id, d2.id, { status: 'done', credits: 5 });
    const failed = await job(user.id, d2.id, { status: 'failed', credits: 4 });
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'grant', amount: 20, createdAt: new Date('2026-01-01') } });
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -3, jobId: done.id, createdAt: new Date('2026-01-02') } });
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -4, jobId: failed.id, createdAt: new Date('2026-01-03') } });

    expect((await get(cookie, '/api/me/stats').expect(200)).body).toEqual({ documents: 2, summariesDone: 2, creditsSpent: 8, pagesSummarized: 17 });

    const first = (await get(cookie, '/api/me/ledger?pageSize=2').expect(200)).body;
    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(first.items).toMatchObject([
      { type: 'reserve', amount: -4, jobId: failed.id, filename: 'two.pdf' },
      { type: 'reserve', amount: -3, jobId: done.id, filename: 'one.pdf' },
    ]);
    const second = (await get(cookie, '/api/me/ledger?pageSize=2&page=2').expect(200)).body;
    expect(second.items).toMatchObject([{ type: 'grant', amount: 20, jobId: null, filename: null }]);
    await get(cookie, '/api/me/ledger?pageSize=0').expect(400);
  });
});
