import './admin-env';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const SETTINGS = { language: 'auto', lengthPercent: 20, method: 'studio' };
const UUID = '00000000-0000-4000-8000-000000000000';

describe('admin console', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const get = (cookie: string, url: string) => http().get(`/api${url}`).set('Cookie', cookie);
  const send = (method: 'post' | 'patch', cookie: string, url: string, body: object) =>
    http()[method](`/api${url}`).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const admin = async (email = 'admin@x.com') => {
    const a = await loginAs(app, email);
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'admin' } });
    return a;
  };
  const doc = (userId: string, filename = 'reading.pdf') =>
    prisma.document.create({
      data: {
        userId, filename, sizeBytes: 100, s3Key: `users/${userId}/documents/x.pdf`, status: 'analyzed', pages: 10, words: 2500,
        chapters: [{ title: 'A', pageFrom: 1, pageTo: 10, words: 2500 }],
      },
    });

  it('returns 404 to non-admins on every new route', async () => {
    const user = await loginAs(app, 'u@x.com');
    const gets = ['/admin/users', `/admin/users/${user.user.id}`, '/admin/documents', `/admin/documents/${UUID}`, `/admin/documents/${UUID}/file`,
      '/admin/jobs', `/admin/jobs/${UUID}`, `/admin/jobs/${UUID}/content`, `/admin/jobs/${UUID}/download?format=md`, '/admin/stats'];
    for (const url of gets) {
      await http().get(`/api${url}`).expect(404);
      await get(user.cookie, url).expect(404);
    }
    await send('post', user.cookie, '/admin/models', { id: 'x' }).expect(404);
    await send('post', user.cookie, '/admin/models/order', { ids: ['fast'] }).expect(404);
    await send('patch', user.cookie, '/admin/models/fast', { enabled: false }).expect(404);
    await send('post', user.cookie, `/admin/users/${user.user.id}/credits`, { amount: 5, note: 'x' }).expect(404);
  });

  describe('model catalog', () => {
    it('seeds from the env catalog on first read and keeps env order as position', async () => {
      const a = await admin();
      expect(await prisma.modelPreset.count()).toBe(0);
      const res = await get(a.cookie, '/admin/models').expect(200);
      expect(res.body.models.map((m: { id: string; position: number; enabled: boolean }) => [m.id, m.position, m.enabled])).toEqual([
        ['lab', 0, true], ['fast', 1, true], ['big', 2, true],
      ]);
      expect(res.body.models[1]).toMatchObject({ provider: 'fake', model: 'p/fast', priceIn: 1, priceOut: 2, temperature: 0.4, adminOnly: false });
      expect(JSON.stringify(res.body)).not.toMatch(/ADMIN_SPEC_KEY|sk-should-never-leak/);
    });

    it('creates, patches and reorders models with validation', async () => {
      const a = await admin();
      const body = { id: 'mini', label: 'Mini', provider: 'fake', model: 'p/mini', multiplier: 0.5 };
      const created = await send('post', a.cookie, '/admin/models', body).expect(201);
      expect(created.body).toMatchObject({ ...body, temperature: 0.4, priceIn: null, adminOnly: false, enabled: true, position: 3 });
      await send('post', a.cookie, '/admin/models', body).expect(409);
      await send('post', a.cookie, '/admin/models', { ...body, id: 'other', provider: 'nope' }).expect(400);
      await send('post', a.cookie, '/admin/models', { ...body, id: 'Bad Id' }).expect(400);
      await send('post', a.cookie, '/admin/models', { ...body, id: 'z', multiplier: 101 }).expect(400);
      await send('post', a.cookie, '/admin/models', { ...body, id: 'z', label: 'x'.repeat(81) }).expect(400);
      const nullTemp = await send('post', a.cookie, '/admin/models', { ...body, id: 'reason', temperature: null }).expect(201);
      expect(nullTemp.body.temperature).toBeNull();

      const patched = await send('patch', a.cookie, '/admin/models/mini', { label: 'Mini 2', multiplier: 2, priceIn: 3, temperature: null }).expect(200);
      expect(patched.body).toMatchObject({ label: 'Mini 2', multiplier: 2, priceIn: 3, temperature: null });
      await send('patch', a.cookie, '/admin/models/mini', { provider: 'nope' }).expect(400);
      await send('patch', a.cookie, '/admin/models/mini', { multiplier: null }).expect(400);
      await send('patch', a.cookie, '/admin/models/mini', { id: 'renamed' }).expect(400);
      await send('patch', a.cookie, '/admin/models/ghost', { label: 'x' }).expect(404);

      await send('post', a.cookie, '/admin/models/order', { ids: ['fast'] }).expect(400);
      await send('post', a.cookie, '/admin/models/order', { ids: ['lab', 'fast', 'big', 'mini', 'ghost'] }).expect(400);
      const ids = ['mini', 'big', 'reason', 'fast', 'lab'];
      await send('post', a.cookie, '/admin/models/order', { ids }).expect(200);
      expect((await get(a.cookie, '/admin/models')).body.models.map((m: { id: string }) => m.id)).toEqual(ids);
      // the user default is the first enabled non-adminOnly row by position
      expect((await get(a.cookie, '/models')).body[0].id).toBe('mini');
    });

    it('refuses writes that would leave no enabled user-visible model', async () => {
      const a = await admin();
      await send('patch', a.cookie, '/admin/models/big', { enabled: false }).expect(200);
      const before = (await get(a.cookie, '/admin/models')).body.models;
      await send('patch', a.cookie, '/admin/models/fast', { enabled: false }).expect(409);
      await send('patch', a.cookie, '/admin/models/fast', { adminOnly: true }).expect(409);
      expect((await get(a.cookie, '/admin/models')).body.models).toEqual(before); // rolled back
      await send('patch', a.cookie, '/admin/models/big', { enabled: true }).expect(200);
      await send('patch', a.cookie, '/admin/models/fast', { enabled: false }).expect(200); // big still serves users
    });

    it('rejects disabled models with a distinct message and hides a stale preference', async () => {
      const a = await admin();
      const { user, cookie } = await loginAs(app, 'u@x.com');
      await prisma.creditLedger.create({ data: { userId: user.id, type: 'grant', amount: 100 } });
      const d = await doc(user.id);
      await send('patch', cookie, '/me/preferences', { model: 'big', language: 'en' }).expect(200);
      expect((await get(cookie, '/me')).body.preferences).toEqual({ model: 'big', language: 'en' });

      await send('patch', a.cookie, '/admin/models/big', { enabled: false }).expect(200);
      expect((await get(cookie, '/models')).body.map((m: { id: string }) => m.id)).toEqual(['fast']);
      const me = (await get(cookie, '/me')).body;
      expect(me.preferences).toEqual({ language: 'en' });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).preferences).toMatchObject({ model: 'big' }); // stored value kept

      const job = (model: string) => send('post', cookie, '/jobs', { documentId: d.id, ...SETTINGS, model });
      expect((await job('big').expect(400)).body.message).toBe('Model no longer available');
      expect((await job('nope').expect(400)).body.message).toBe('Unknown model');
      expect((await job('lab').expect(400)).body.message).toBe('Unknown model'); // adminOnly stays indistinguishable from unknown
      expect((await send('patch', cookie, '/me/preferences', { model: 'big' }).expect(400)).body.message).toBe('Model no longer available');
      await job('fast').expect(201);

      // the Lab refuses disabled ids too
      const adminDoc = await doc(a.user.id);
      const lane = (draft: string) => ({ documentId: adminDoc.id, ...SETTINGS, lanes: [{ draft, verify: null }] });
      expect((await send('post', a.cookie, '/admin/benchmarks', lane('big')).expect(400)).body.message).toBe('Model no longer available');
      await send('post', a.cookie, '/admin/benchmarks', lane('lab')).expect(201);
    });
  });

  describe('credits', () => {
    it('grants and revokes with adminId and note, and never lets the balance go negative', async () => {
      const a = await admin();
      const u = await loginAs(app, 'u@x.com');
      const url = `/admin/users/${u.user.id}/credits`;
      expect((await send('post', a.cookie, url, { amount: 50, note: ' welcome ' }).expect(201)).body).toEqual({ balance: 50 });
      expect((await send('post', a.cookie, url, { amount: -20, note: 'chargeback' }).expect(201)).body).toEqual({ balance: 30 });
      const over = await send('post', a.cookie, url, { amount: -31, note: 'too much' }).expect(409);
      expect(over.body).toMatchObject({ balance: 30 });
      await send('post', a.cookie, url, { amount: 0, note: 'x' }).expect(400);
      await send('post', a.cookie, url, { amount: 100001, note: 'x' }).expect(400);
      await send('post', a.cookie, url, { amount: 5, note: '' }).expect(400);
      await send('post', a.cookie, url, { amount: 5, note: 'x'.repeat(201) }).expect(400);
      await send('post', a.cookie, `/admin/users/${UUID}/credits`, { amount: 5, note: 'x' }).expect(404);

      const rows = await prisma.creditLedger.findMany({ where: { userId: u.user.id }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => [r.type, r.amount, r.adminId, r.note])).toEqual([
        ['grant', 50, a.user.id, 'welcome'], ['revoke', -20, a.user.id, 'chargeback'],
      ]);
      const detail = (await get(a.cookie, `/admin/users/${u.user.id}`).expect(200)).body;
      expect(detail).toMatchObject({ email: 'u@x.com', balance: 30, documents: 0, jobs: 0 });
      expect(detail.ledger[0]).toMatchObject({ type: 'revoke', amount: -20, note: 'chargeback', adminEmail: 'admin@x.com' });
      expect(detail.lastActiveAt).not.toBeNull();
    });

    it('refuses deleted users and lists users with search and balance', async () => {
      const a = await admin();
      const u = await loginAs(app, 'Findme@x.com');
      await loginAs(app, 'other@x.com');
      await send('post', a.cookie, `/admin/users/${u.user.id}/credits`, { amount: 7, note: 'x' }).expect(201);
      const list = (await get(a.cookie, '/admin/users?q=findME').expect(200)).body;
      expect(list).toMatchObject({ total: 1, items: [{ email: 'findme@x.com', balance: 7, role: 'user' }] });
      expect((await get(a.cookie, '/admin/users').expect(200)).body.total).toBe(3);
      await prisma.user.update({ where: { id: u.user.id }, data: { deletedAt: new Date() } });
      await send('post', a.cookie, `/admin/users/${u.user.id}/credits`, { amount: 1, note: 'x' }).expect(409);
    });
  });

  describe('documents and jobs of other users', () => {
    it('lets an admin list, open and download anyone\'s documents and jobs', async () => {
      const a = await admin();
      const owner = await loginAs(app, 'owner@x.com');
      const d = await doc(owner.user.id, 'secret.pdf');
      const key = `users/${owner.user.id}/results/s.md`;
      await app.get(StorageService).put(key, Buffer.from('# Summary\n'), 'text/markdown');
      const job = await prisma.job.create({
        data: {
          userId: owner.user.id, documentId: d.id, kind: 'summarize', status: 'done', credits: 3, resultMdKey: key, resultDocxKey: `${key}.docx`,
          options: { modelId: 'fast', model: 'p/fast', customInstructions: 'private text', method: 'custom:1' }, model: 'p/fast', warnings: ['w1'],
          inputTokens: 1000, outputTokens: 500, finishedAt: new Date(),
        },
      });
      await prisma.llmCall.create({ data: { jobId: job.id, attempt: 1, chapter: 0, phase: 'draft', model: 'p/fast', modelId: 'fast', inputTokens: 1_000_000, outputTokens: 0, durationMs: 10, ok: true } });
      await prisma.creditLedger.create({ data: { userId: owner.user.id, jobId: job.id, type: 'reserve', amount: -3 } });
      const other = await doc(a.user.id, 'mine.pdf');

      const docs = (await get(a.cookie, '/admin/documents?q=SECRET').expect(200)).body;
      expect(docs).toMatchObject({ total: 1, items: [{ id: d.id, filename: 'secret.pdf', user: { id: owner.user.id, email: 'owner@x.com' }, jobs: 1, status: 'analyzed' }] });
      expect((await get(a.cookie, `/admin/documents?userId=${a.user.id}`)).body.items.map((i: { id: string }) => i.id)).toEqual([other.id]);
      expect((await get(a.cookie, '/admin/documents?status=rejected')).body.total).toBe(0);
      const detail = (await get(a.cookie, `/admin/documents/${d.id}`).expect(200)).body;
      expect(detail.chapters).toHaveLength(1);
      expect(detail.jobs[0]).toMatchObject({ id: job.id, status: 'done', modelId: 'fast', user: { email: 'owner@x.com' }, document: { filename: 'secret.pdf' } });
      const file = (await get(a.cookie, `/admin/documents/${d.id}/file`).expect(200)).body;
      expect(file.url).toContain('secret.pdf');
      await prisma.document.update({ where: { id: other.id }, data: { fileDeletedAt: new Date() } });
      await get(a.cookie, `/admin/documents/${other.id}/file`).expect(410);
      await get(a.cookie, `/admin/documents/${UUID}`).expect(404);

      const jobs = (await get(a.cookie, `/admin/jobs?userId=${owner.user.id}&status=done&kind=summarize&lab=false`).expect(200)).body;
      expect(jobs).toMatchObject({ total: 1, items: [{ id: job.id, credits: 3, model: 'p/fast', benchmarkId: null }] });
      expect((await get(a.cookie, '/admin/jobs?lab=true')).body.total).toBe(0);
      expect((await get(a.cookie, `/admin/jobs?documentId=${other.id}`)).body.total).toBe(0);
      const one = (await get(a.cookie, `/admin/jobs/${job.id}`).expect(200)).body;
      expect(one).toMatchObject({ warnings: ['w1'], inputTokens: 1000, outputTokens: 500, costUsd: 1 });
      expect(one.usage.draft).toMatchObject({ calls: 1, inputTokens: 1_000_000 });
      expect(one.ledger).toMatchObject([{ type: 'reserve', amount: -3 }]);
      expect(one.options.customInstructions).toBeUndefined();
      const content = await get(a.cookie, `/admin/jobs/${job.id}/content`).expect(200);
      expect(content.text).toBe('# Summary\n');
      expect(content.headers['content-type']).toMatch(/text\/markdown/);
      expect((await get(a.cookie, `/admin/jobs/${job.id}/download?format=md`).expect(200)).body.url).toContain('secret');
      await get(a.cookie, `/admin/jobs/${job.id}/download?format=pdf`).expect(400);
      // the owner endpoints stay owner-only
      await get(a.cookie, `/jobs/${job.id}/content`).expect(404);
      await get(owner.cookie, `/jobs/${job.id}/content`).expect(200);
    });
  });

  describe('stats', () => {
    it('returns totals, a zero-filled series and per-model usage', async () => {
      const a = await admin();
      const u = await loginAs(app, 'u@x.com');
      const d = await doc(u.user.id);
      const now = new Date();
      const job = (status: 'done' | 'failed', extra = {}) =>
        prisma.job.create({ data: { userId: u.user.id, documentId: d.id, kind: 'summarize', status, credits: 2, finishedAt: now, options: {}, ...extra } });
      const done = await job('done');
      await job('failed');
      const bench = await prisma.benchmark.create({ data: { userId: a.user.id, documentId: (await doc(a.user.id)).id, options: {} } });
      const lab = await job('done', { benchmarkId: bench.id }); // Lab: LLM usage counts, jobs do not
      await prisma.creditLedger.createMany({
        data: [
          { userId: u.user.id, type: 'purchase', amount: 100 },
          { userId: u.user.id, type: 'grant', amount: 10 },
          { userId: u.user.id, type: 'revoke', amount: -4 },
          { userId: u.user.id, type: 'reserve', amount: -2, jobId: done.id },
        ],
      });
      const call = (jobId: string, modelId: string | null, i: number, o: number, ok = true) =>
        prisma.llmCall.create({ data: { jobId, attempt: 1, chapter: 0, phase: 'draft', model: 'p/fast', modelId, provider: 'fake', inputTokens: i, outputTokens: o, durationMs: 100, ok } });
      await call(done.id, 'fast', 1_000_000, 500_000);
      await call(done.id, 'fast', 0, 0, false);
      await call(lab.id, 'big', 100_000, 0);

      const res = await get(a.cookie, '/admin/stats?days=7').expect(200);
      const { totals, series, models } = res.body;
      expect(totals).toMatchObject({
        users: 2, activeUsers30d: 2, documents: 2, jobs: { queued: 0, running: 0, done: 1, failed: 1 },
        creditsPurchased: 100, creditsGranted: 10, creditsRevoked: 4, creditsSpent: 2, creditsOutstanding: 104,
        llm: { calls: 3, failedCalls: 1, inputTokens: 1_100_000, outputTokens: 500_000 },
      });
      expect(totals.llm.costUsd).toBeCloseTo(1 + 1 + 1); // fast: 1*1 + 0.5*2, big: 0.1*10
      expect(series).toHaveLength(7);
      expect(series.map((s: { day: string }) => s.day)).toEqual([...series.map((s: { day: string }) => s.day)].sort());
      expect(Object.keys(series[0]).sort()).toEqual(['creditsPurchased', 'creditsSpent', 'day', 'documents', 'inputTokens', 'jobsDone', 'jobsFailed', 'outputTokens', 'signups']);
      expect(series[0]).toMatchObject({ signups: 0, documents: 0, jobsDone: 0, creditsSpent: 0, inputTokens: 0 });
      expect(series[6]).toMatchObject({ signups: 2, documents: 2, jobsDone: 1, jobsFailed: 1, creditsSpent: 2, creditsPurchased: 100, inputTokens: 1_100_000, outputTokens: 500_000 });
      expect(models).toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: 'fast', provider: 'fake', calls: 2, failedCalls: 1, inputTokens: 1_000_000, avgDurationMs: 100 }),
        expect.objectContaining({ modelId: 'big', calls: 1, costUsd: 1 }),
      ]));
      expect(models.find((m: { modelId: string }) => m.modelId === 'fast').costUsd).toBeCloseTo(2);
      expect((await get(a.cookie, '/admin/stats').expect(200)).body.series).toHaveLength(30);
      expect((await get(a.cookie, '/admin/stats?days=365').expect(200)).body.series).toHaveLength(365);
      await get(a.cookie, '/admin/stats?days=0').expect(400);
      await get(a.cookie, '/admin/stats?days=366').expect(400);
    });
  });
});
