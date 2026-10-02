import './admin-env';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { unzip } from './unzip';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const SETTINGS = { language: 'auto', lengthPercent: 20, method: 'studio' };
const LANES = [{ draft: 'fast', verify: 'big' }, { draft: 'lab', verify: null }];

describe('admin lab', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const post = (cookie: string, url: string, body: object) => http().post(url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const admin = async (email = 'admin@x.com') => {
    const a = await loginAs(app, email);
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'admin' } });
    return a;
  };
  const doc = (userId: string, words = 2500) =>
    prisma.document.create({
      data: {
        userId, filename: 'reading.pdf', sizeBytes: 100, s3Key: `users/${userId}/documents/x.pdf`, status: 'analyzed', pages: 10, words,
        chapters: [{ title: 'A', pageFrom: 1, pageTo: 5, words: 1000 }, { title: 'B', pageFrom: 6, pageTo: 10, words: words - 1000 }],
      },
    });

  it('returns 404 to anonymous and non-admin callers, 200 to an admin', async () => {
    const user = await loginAs(app, 'u@x.com');
    await http().get('/api/admin/models').expect(404);
    await http().get('/api/admin/models').set('Cookie', user.cookie).expect(404);
    await http().get('/api/admin/benchmarks').set('Cookie', user.cookie).expect(404);
    const a = await admin();
    await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200);
    expect((await http().get('/api/me').set('Cookie', a.cookie)).body.role).toBe('admin');
    expect((await http().get('/api/me').set('Cookie', user.cookie)).body.role).toBe('user');
  });

  it('reads the role fresh on every request', async () => {
    const a = await admin();
    await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200);
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'user' } });
    await http().get('/api/admin/models').set('Cookie', a.cookie).expect(404);
  });

  it('lists providers and models without keys', async () => {
    const a = await admin();
    const res = await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200);
    expect(res.body.providers).toMatchObject([{ id: 'fake', keyEnv: 'LLM_KEY_FAKE', key: { status: 'unknown' } }]);
    expect(res.body.models).toHaveLength(3);
    expect(res.body.models[0]).toMatchObject({ id: 'lab', adminOnly: true, temperature: null, priceIn: null });
    expect(JSON.stringify(res.body)).not.toMatch(/ADMIN_SPEC_KEY|sk-should-never-leak/);
  });

  it('hides adminOnly models from users and rejects them for jobs and preferences', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'grant', amount: 100 } });
    const d = await doc(user.id);
    expect((await http().get('/api/models').set('Cookie', cookie).expect(200)).body.map((m: { id: string }) => m.id)).toEqual(['fast', 'big']);
    await post(cookie, '/api/jobs', { documentId: d.id, ...SETTINGS, model: 'lab' }).expect(400);
    await http().patch('/api/me/preferences').set('Origin', ORIGIN).set('Cookie', cookie).send({ model: 'lab' }).expect(400);
    const job = await post(cookie, '/api/jobs', { documentId: d.id, ...SETTINGS }).expect(201);
    expect(job.body.options.modelId).toBe('fast'); // first non-adminOnly, not the first entry
    await post(cookie, '/api/jobs', { documentId: d.id, ...SETTINGS, phaseModels: { draft: 'lab', verify: null } }).expect(400);
  });

  it('creates one free job per lane with phaseModels, no ledger rows', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, name: 'Run 1', ...SETTINGS, lanes: LANES }).expect(201);
    expect(res.body.name).toBe('Run 1');
    expect(res.body.document).toMatchObject({ id: d.id, filename: 'reading.pdf', words: 2500, pages: 10 });
    expect(res.body.lanes.map((l: { index: number }) => l.index)).toEqual([0, 1]);
    expect(res.body.lanes[0]).toMatchObject({ draft: { modelId: 'fast', provider: 'fake', model: 'p/fast' }, verify: { modelId: 'big' }, status: 'queued', costUsd: 0 });
    expect(res.body.lanes[1]).toMatchObject({ draft: { modelId: 'lab' }, verify: null });
    const jobs = await prisma.job.findMany({ where: { benchmarkId: res.body.id } });
    expect(jobs).toHaveLength(2);
    for (const j of jobs) expect(j).toMatchObject({ credits: 0, kind: 'summarize', userId: a.user.id });
    const byLane = jobs.sort((x, y) => (x.options as { lane: number }).lane - (y.options as { lane: number }).lane);
    expect(byLane[0].options).toMatchObject({ ...SETTINGS, preset: 'studio', modelId: 'fast', model: 'p/fast', lane: 0, phaseModels: { draft: 'fast', verify: 'big' } });
    expect(byLane[1].options).toMatchObject({ modelId: 'lab', model: 'p/lab', lane: 1, phaseModels: { draft: 'lab', verify: null } });
    expect(await prisma.creditLedger.count({ where: { userId: a.user.id } })).toBe(0);
  });

  it('flags harness lanes in job options and detail, rejects non-boolean', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const lanes = [{ draft: 'fast', verify: 'big', harness: true }, LANES[0]];
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes }).expect(201);
    expect(res.body.lanes.map((l: { harness: boolean }) => l.harness)).toEqual([true, false]);
    const jobs = (await prisma.job.findMany({ where: { benchmarkId: res.body.id } })).sort((x, y) => (x.options as { lane: number }).lane - (y.options as { lane: number }).lane);
    expect(jobs[0].options).toMatchObject({ harness: true, phaseModels: { draft: 'fast', verify: 'big' } });
    expect(jobs[1].options).not.toHaveProperty('harness');
    await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: [{ ...LANES[0], harness: 'yes' }] }).expect(400);
  });

  it('snapshots custom methods and validates chosen chapters like user jobs', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const m = await prisma.summaryMethod.create({ data: { userId: a.user.id, name: 'Mine', instructions: 'be brief' } });
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, method: `custom:${m.id}`, chapters: [1, 0], lanes: [LANES[0]] }).expect(201);
    const [job] = await prisma.job.findMany({ where: { benchmarkId: res.body.id } });
    expect(job.options).toMatchObject({ method: `custom:${m.id}`, methodName: 'Mine', customInstructions: 'be brief', chapters: [0, 1] });
    expect(res.body.options.customInstructions).toBeUndefined();
    await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, chapters: [5], lanes: [LANES[0]] }).expect(400);
  });

  it('validates documents, models and lanes', async () => {
    const a = await admin();
    const other = await loginAs(app, 'u@x.com');
    const mine = await doc(a.user.id);
    const theirs = await doc(other.user.id);
    const pending = await prisma.document.create({ data: { userId: a.user.id, filename: 'p.pdf', sizeBytes: 1, s3Key: 'k' } });
    const create = (body: object) => post(a.cookie, '/api/admin/benchmarks', { ...SETTINGS, lanes: LANES, ...body });
    await create({ documentId: theirs.id }).expect(404);
    await create({ documentId: pending.id }).expect(409);
    await create({ documentId: mine.id, lanes: [{ draft: 'nope', verify: null }] }).expect(400);
    await create({ documentId: mine.id, lanes: [{ draft: 'fast', verify: 'nope' }] }).expect(400);
    await create({ documentId: mine.id, lanes: [{ draft: 'fast' }] }).expect(400);
    await create({ documentId: mine.id, lanes: [] }).expect(400);
    await create({ documentId: mine.id, lanes: Array(9).fill(LANES[0]) }).expect(400);
    await create({ documentId: mine.id, name: 'x'.repeat(81) }).expect(400);
    await create({ documentId: mine.id, lanes: Array(8).fill(LANES[0]) }).expect(201);
    expect(await prisma.job.count({ where: { userId: a.user.id, benchmarkId: { not: null } } })).toBe(8);
  });

  it('keeps lab jobs out of /jobs, /me/stats, the document page and the active-summaries cap', async () => {
    const a = await admin();
    await prisma.creditLedger.create({ data: { userId: a.user.id, type: 'grant', amount: 100 } });
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: LANES }).expect(201);
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'done' } });
    expect((await http().get('/api/jobs').set('Cookie', a.cookie).expect(200)).body.total).toBe(0);
    const stats = (await http().get('/api/me/stats').set('Cookie', a.cookie).expect(200)).body;
    expect(stats).toMatchObject({ summariesDone: 0, pagesSummarized: 0, creditsSpent: 0 });
    expect((await http().get(`/api/documents/${d.id}`).set('Cookie', a.cookie).expect(200)).body.jobs).toEqual([]);
    expect((await http().get('/api/documents?status=summarized').set('Cookie', a.cookie).expect(200)).body.total).toBe(0);
    // running lab lanes must not use up the 3 normal slots
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'running' } });
    for (let i = 0; i < 3; i++) await post(a.cookie, '/api/jobs', { documentId: d.id, ...SETTINGS }).expect(201);
  });

  it('lists only the own benchmarks with lane counters', async () => {
    const a = await admin();
    const b = await admin('admin2@x.com');
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: LANES }).expect(201);
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id, options: { path: ['lane'], equals: 0 } }, data: { status: 'done' } });
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id, options: { path: ['lane'], equals: 1 } }, data: { status: 'failed' } });
    const list = (await http().get('/api/admin/benchmarks').set('Cookie', a.cookie).expect(200)).body;
    expect(list).toMatchObject({ total: 1, page: 1, items: [{ id: res.body.id, lanes: 2, done: 1, failed: 1, running: 0, document: { filename: 'reading.pdf' } }] });
    expect((await http().get('/api/admin/benchmarks').set('Cookie', b.cookie).expect(200)).body.total).toBe(0);
    await http().get(`/api/admin/benchmarks/${res.body.id}`).set('Cookie', b.cookie).expect(404);
  });

  it('computes usage and cost per lane from LlmCall rows', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: LANES }).expect(201);
    const [l0, l1] = res.body.lanes;
    const call = (jobId: string, phase: 'draft' | 'verify', model: string, i: number, o: number, ok = true) =>
      prisma.llmCall.create({ data: { jobId, attempt: 1, chapter: 0, phase, model, inputTokens: i, outputTokens: o, durationMs: 100, ok } });
    await call(l0.jobId, 'draft', 'p/fast', 1_000_000, 500_000);
    await call(l0.jobId, 'draft', 'p/fast', 0, 0, false);
    await call(l0.jobId, 'verify', 'p/big', 100_000, 10_000);
    await call(l1.jobId, 'draft', 'p/lab', 1000, 1000);
    const lanes = (await http().get(`/api/admin/benchmarks/${res.body.id}`).set('Cookie', a.cookie).expect(200)).body.lanes;
    expect(lanes[0].usage.draft).toEqual({ calls: 2, inputTokens: 1_000_000, outputTokens: 500_000, durationMs: 200, failedCalls: 1 });
    expect(lanes[0].usage.verify).toMatchObject({ calls: 1, inputTokens: 100_000, outputTokens: 10_000 });
    expect(lanes[0].costUsd).toBeCloseTo(1 + 0.5 * 2 + 0.1 * 10 + 0.01 * 20); // 3.2
    expect(lanes[1].costUsd).toBeNull(); // 'lab' has no prices
  });

  it('stores an optional judge in benchmark and job options, validates it, and returns evaluation + judge cost', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: [LANES[1]], judge: 'fast' }).expect(201);
    expect(res.body.options.judge).toBe('fast');
    const [job] = await prisma.job.findMany({ where: { benchmarkId: res.body.id } });
    expect(job.options).toMatchObject({ judge: 'fast' });
    expect(res.body.lanes[0]).toMatchObject({ evaluation: null, judgeCostUsd: 0 });
    const evaluation = { judge: 'fast', overall: 7.5, scores: { accuracy: 8, coverage: 7, concision: 7, structure: 8 }, chapters: [], error: null };
    await prisma.job.update({ where: { id: job.id }, data: { evaluation } });
    await prisma.llmCall.create({ data: { jobId: job.id, attempt: 1, chapter: 0, phase: 'judge', model: 'p/fast', modelId: 'fast', inputTokens: 1_000_000, outputTokens: 500_000, durationMs: 100, ok: true } });
    const lane = (await http().get(`/api/admin/benchmarks/${res.body.id}`).set('Cookie', a.cookie).expect(200)).body.lanes[0];
    expect(lane.evaluation).toEqual(evaluation);
    expect(lane.usage.judge).toMatchObject({ calls: 1 });
    expect(lane.judgeCostUsd).toBeCloseTo(2); // fast: 1 in + 0.5 * 2 out
    expect(lane.costUsd).toBe(0); // judge not counted in lane cost
    await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: [LANES[1]], judge: 'nope' }).expect(400);
  });

  it('renames a benchmark, even while running; rejects multi-line names and other callers', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, name: 'Old', ...SETTINGS, lanes: LANES }).expect(201);
    const patch = (cookie: string, id: string, body: object) => http().patch(`/api/admin/benchmarks/${id}`).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'running' } });
    expect((await patch(a.cookie, res.body.id, { name: '  New name ' }).expect(200)).body.name).toBe('New name');
    const got = (await http().get(`/api/admin/benchmarks/${res.body.id}`).set('Cookie', a.cookie).expect(200)).body;
    expect(got.name).toBe('New name');
    expect(got.options.lanes).toHaveLength(2);
    await patch(a.cookie, res.body.id, { name: 'a\nb' }).expect(400);
    await patch(a.cookie, res.body.id, { name: 'x'.repeat(81) }).expect(400);
    expect((await patch(a.cookie, res.body.id, { name: '' }).expect(200)).body.name).toBeNull();
    await patch(a.cookie, '00000000-0000-4000-8000-000000000000', { name: 'x' }).expect(404);
    const u = await loginAs(app, 'u@x.com');
    await patch(u.cookie, res.body.id, { name: 'x' }).expect(404);
    const b = await admin('b@x.com');
    await patch(b.cookie, res.body.id, { name: 'x' }).expect(404);
  });

  it('exports a finished run as a zip; 404 for others, 409 while running', async () => {
    const a = await admin();
    const b = await admin('b@x.com');
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, name: 'Run: 1', ...SETTINGS, lanes: LANES }).expect(201);
    const get = (cookie: string) => http().get(`/api/admin/benchmarks/${res.body.id}/zip`).set('Cookie', cookie).buffer().parse((r, cb) => {
      const c: Buffer[] = [];
      r.on('data', (x: Buffer) => c.push(x));
      r.on('end', () => cb(null, Buffer.concat(c)));
    });
    await get(b.cookie).expect(404);
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'running' } });
    await get(a.cookie).expect(409);
    const key = `users/${a.user.id}/results/zip.md`;
    await app.get(StorageService).put(key, Buffer.from('# S\n'), 'text/markdown');
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id, options: { path: ['lane'], equals: 0 } }, data: { status: 'done', resultMdKey: key } });
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id, options: { path: ['lane'], equals: 1 } }, data: { status: 'failed' } });
    const jobs = await prisma.job.findMany({ where: { benchmarkId: res.body.id }, orderBy: { createdAt: 'asc' } });
    const lane1 = jobs.find((j) => (j.options as { lane: number }).lane === 1)!;
    await app.get(StorageService).put(`users/${a.user.id}/lab/${res.body.id}/prompts/${lane1.id}.txt`, Buffer.from('prompt'), 'text/plain');
    const ok = await get(a.cookie).expect(200);
    expect(ok.headers['content-type']).toContain('application/zip');
    expect(ok.headers['content-disposition']).toContain('lab-Run__1.zip');
    const files = unzip(ok.body);
    expect(Object.keys(files).sort()).toEqual(['benchmark.json', 'prompts/02-lab.txt', 'results/01-fast-big.md', 'source/README.txt']);
    const json = JSON.parse(files['benchmark.json'].toString());
    expect(json.id).toBe(res.body.id);
    expect(files['prompts/02-lab.txt'].toString()).toBe('prompt');
    expect(json.exportedAt).toBeDefined();
    expect(files['results/01-fast-big.md'].toString()).toBe('# S\n');
    await app.get(StorageService).put(`users/${a.user.id}/lab/${res.body.id}/source.txt`, Buffer.from('ocr'), 'text/plain');
    expect(unzip((await get(a.cookie).expect(200)).body)['source/reading.txt'].toString()).toBe('ocr');
  });

  it('refuses to delete a running benchmark, otherwise deletes files and rows', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: LANES }).expect(201);
    const del = () => http().delete(`/api/admin/benchmarks/${res.body.id}`).set('Origin', ORIGIN).set('Cookie', a.cookie);
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'running' } });
    await del().expect(409);
    const key = `users/${a.user.id}/results/lab.md`;
    const storage = app.get(StorageService);
    await storage.put(key, Buffer.from('# S\n'), 'text/markdown');
    const src = `users/${a.user.id}/lab/${res.body.id}/source.txt`;
    await storage.put(src, Buffer.from('ocr'), 'text/plain');
    const [job] = await prisma.job.findMany({ where: { benchmarkId: res.body.id } });
    const prompt = `users/${a.user.id}/lab/${res.body.id}/prompts/${job.id}.txt`;
    await storage.put(prompt, Buffer.from('p'), 'text/plain');
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'done', resultMdKey: key } });
    await del().expect(204);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.head(src)).toBeNull();
    expect(await storage.head(prompt)).toBeNull();
    expect(await prisma.benchmark.count()).toBe(0);
    expect(await prisma.job.count({ where: { benchmarkId: res.body.id } })).toBe(0);
    await del().expect(404);
  });

  it('deleting a document also deletes the source text of its lab runs', async () => {
    const a = await admin();
    const d = await doc(a.user.id);
    const res = await post(a.cookie, '/api/admin/benchmarks', { documentId: d.id, ...SETTINGS, lanes: LANES }).expect(201);
    const src = `users/${a.user.id}/lab/${res.body.id}/source.txt`;
    const storage = app.get(StorageService);
    await storage.put(src, Buffer.from('ocr'), 'text/plain');
    const [job] = await prisma.job.findMany({ where: { benchmarkId: res.body.id } });
    const prompt = `users/${a.user.id}/lab/${res.body.id}/prompts/${job.id}.txt`;
    await storage.put(prompt, Buffer.from('p'), 'text/plain');
    await prisma.job.updateMany({ where: { benchmarkId: res.body.id }, data: { status: 'done' } });
    await http().delete(`/api/documents/${d.id}`).set('Origin', ORIGIN).set('Cookie', a.cookie).expect(204);
    expect(await storage.head(src)).toBeNull();
    expect(await storage.head(prompt)).toBeNull();
    expect(await prisma.benchmark.count()).toBe(0);
  });

  describe('providers', () => {
    const send = (method: 'post' | 'patch' | 'delete', cookie: string, url: string, body?: object) =>
      http()[method](url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
    const model = { id: 'extra', label: 'Extra', model: 'p/extra', multiplier: 1 };
    const unknown = { status: 'unknown', source: null, checkedAt: null };

    it('returns 404 to non-admin callers on every route', async () => {
      const { cookie } = await loginAs(app, 'u@x.com');
      await http().get('/api/admin/providers').set('Cookie', cookie).expect(404);
      await send('post', cookie, '/api/admin/providers', { id: 'p1', baseUrl: 'https://x/v1' }).expect(404);
      await send('patch', cookie, '/api/admin/providers/fake', { baseUrl: 'https://x/v1' }).expect(404);
      await send('delete', cookie, '/api/admin/providers/fake').expect(404);
    });

    it('seeds from env on first read, shows keyEnv and no keys', async () => {
      const a = await admin();
      const res = await http().get('/api/admin/providers').set('Cookie', a.cookie).expect(200);
      expect(res.body).toEqual([{ id: 'fake', baseUrl: 'fake', tokenParam: 'max_tokens', maxConcurrency: null, keyEnv: 'LLM_KEY_FAKE', key: unknown }]);
      expect(JSON.stringify(res.body)).not.toMatch(/ADMIN_SPEC_KEY|sk-should-never-leak|apiKeyEnv/);
    });

    it('reports the worker key status: unknown, ok, missing, stale', async () => {
      const a = await admin();
      const get = async () => (await http().get('/api/admin/providers').set('Cookie', a.cookie).expect(200)).body[0];
      expect((await get()).key).toEqual(unknown);
      const now = new Date();
      await prisma.providerKeyStatus.create({ data: { id: 'fake', hasKey: true, source: 'LLM_PROVIDERS', checkedAt: now } });
      expect((await get()).key).toEqual({ status: 'ok', source: 'LLM_PROVIDERS', checkedAt: now.toISOString() });
      await prisma.providerKeyStatus.update({ where: { id: 'fake' }, data: { hasKey: false, source: 'none' } });
      expect((await get()).key).toMatchObject({ status: 'missing', source: 'none' });
      const old = new Date(Date.now() - 20 * 60_000);
      await prisma.providerKeyStatus.update({ where: { id: 'fake' }, data: { hasKey: true, source: 'LLM_KEY', checkedAt: old } });
      const p = await get();
      expect(p.key).toEqual({ status: 'unknown', source: 'LLM_KEY', checkedAt: old.toISOString() });
      expect(Object.keys(p.key).sort()).toEqual(['checkedAt', 'source', 'status']);
      const m = await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200);
      expect(m.body.providers[0].key.status).toBe('unknown');
      expect((await send('patch', a.cookie, '/api/admin/providers/fake', { maxConcurrency: 2 }).expect(200)).body.key.source).toBe('LLM_KEY');
    });

    it('creates, rejects duplicates and invalid input', async () => {
      const a = await admin();
      const url = '/api/admin/providers';
      const res = await send('post', a.cookie, url, { id: 'my-llm', baseUrl: ' https://api.x.com/v1 ', maxConcurrency: 4 }).expect(201);
      expect(res.body).toEqual({ id: 'my-llm', baseUrl: 'https://api.x.com/v1', tokenParam: 'max_tokens', maxConcurrency: 4, keyEnv: 'LLM_KEY_MY_LLM', key: unknown });
      await send('post', a.cookie, url, { id: 'my-llm', baseUrl: 'fake' }).expect(409);
      await send('post', a.cookie, url, { id: 'ok', baseUrl: 'fake', tokenParam: 'max_completion_tokens' }).expect(201);
      const list = (await http().get(url).set('Cookie', a.cookie)).body.map((p: { id: string }) => p.id);
      expect(list).toEqual(['fake', 'my-llm', 'ok']);
      for (const bad of [{ id: 'Bad_Id', baseUrl: 'fake' }, { id: 'x', baseUrl: 'ftp://x' }, { id: 'x', baseUrl: 'http://u:p@x' }, { id: 'x', baseUrl: '' },
        { id: 'x', baseUrl: 'nope' }, { id: 'x', baseUrl: 'fake', tokenParam: 'foo' }, { id: 'x', baseUrl: 'fake', maxConcurrency: 0 }, { id: 'x', baseUrl: 'fake', maxConcurrency: 65 }]) {
        await send('post', a.cookie, url, bad).expect(400);
      }
    });

    it('updates fields, null clears maxConcurrency, 404 when unknown', async () => {
      const a = await admin();
      const url = '/api/admin/providers/fake';
      const res = await send('patch', a.cookie, url, { baseUrl: 'http://localhost:1234/v1', tokenParam: 'max_completion_tokens', maxConcurrency: 8 }).expect(200);
      expect(res.body).toMatchObject({ id: 'fake', baseUrl: 'http://localhost:1234/v1', tokenParam: 'max_completion_tokens', maxConcurrency: 8 });
      expect((await send('patch', a.cookie, url, { maxConcurrency: null }).expect(200)).body).toMatchObject({ baseUrl: 'http://localhost:1234/v1', maxConcurrency: null });
      await send('patch', a.cookie, url, { baseUrl: 'ftp://x' }).expect(400);
      await send('patch', a.cookie, url, { baseUrl: null }).expect(400);
      await send('patch', a.cookie, '/api/admin/providers/nope', { baseUrl: 'fake' }).expect(404);
    });

    it('refuses to delete a provider used by a model, deletes an unused one', async () => {
      const a = await admin();
      await send('post', a.cookie, '/api/admin/providers', { id: 'spare', baseUrl: 'fake' }).expect(201);
      const res = await send('delete', a.cookie, '/api/admin/providers/fake').expect(409);
      expect(res.body.message).toBe('Provider is used by models');
      await send('delete', a.cookie, '/api/admin/providers/spare').expect(204);
      await send('delete', a.cookie, '/api/admin/providers/spare').expect(404);
    });

    it('does not check the provider when a model update leaves it unchanged', async () => {
      const a = await admin();
      await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200); // seed
      await prisma.llmProvider.deleteMany(); // models reference 'fake', table now empty
      await send('patch', a.cookie, '/api/admin/models/fast', { label: 'Renamed' }).expect(200);
      await send('patch', a.cookie, '/api/admin/models/fast', { provider: 'fake' }).expect(200);
      await send('patch', a.cookie, '/api/admin/models/fast', { provider: 'ghost' }).expect(400);
    });

    it('checks the provider of a model against the DB', async () => {
      const a = await admin();
      await send('post', a.cookie, '/api/admin/models', { ...model, provider: 'mine' }).expect(400);
      await send('post', a.cookie, '/api/admin/providers', { id: 'mine', baseUrl: 'https://x/v1' }).expect(201);
      await send('post', a.cookie, '/api/admin/models', { ...model, provider: 'mine' }).expect(201);
      await send('patch', a.cookie, '/api/admin/models/extra', { provider: 'ghost' }).expect(400);
      await send('delete', a.cookie, '/api/admin/providers/mine').expect(409);
      const res = await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200);
      expect(res.body.providers.map((p: { id: string }) => p.id)).toEqual(['fake', 'mine']);
      expect(JSON.stringify(res.body)).not.toMatch(/apiKeyEnv|sk-should-never-leak/);
    });
  });
});

describe('admin lab presets', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await resetDb(prisma);
    await prisma.labPreset.deleteMany({ where: { name: { startsWith: 'T ' } } });
  });

  const http = () => request(app.getHttpServer());
  const post = (cookie: string, body: object) => http().post('/api/admin/lab-presets').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const admin = async () => {
    const a = await loginAs(app, 'admin@x.com');
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'admin' } });
    return a;
  };

  it('lists the seeded presets', async () => {
    const a = await admin();
    const res = await http().get('/api/admin/lab-presets').set('Cookie', a.cookie).expect(200);
    const four = res.body.find((p: any) => p.name.startsWith('Benchmark 4 '));
    expect(four.judge).toBe('gpt-6-sol');
    expect(four.lanes).toHaveLength(8);
    expect(res.body.find((p: any) => p.name.startsWith('Benchmark 4b')).lanes).toHaveLength(6);
  });

  it('creates, rejects a duplicate name, validates lanes and deletes', async () => {
    const a = await admin();
    const lanes = [{ draft: 'x', verify: null }, { draft: 'y', verify: 'y', harness: true }];
    const made = await post(a.cookie, { name: ' T one ', judge: 'x', lanes }).expect(201);
    expect(made.body).toMatchObject({ name: 'T one', judge: 'x', lanes: [{ draft: 'x', verify: null }, { draft: 'y', verify: 'y', harness: true }] });
    await post(a.cookie, { name: 'T one', lanes }).expect(409);
    await post(a.cookie, { name: 'T two', lanes: [] }).expect(400);
    await post(a.cookie, { name: 'T two', lanes: Array(9).fill(lanes[0]) }).expect(400);
    await post(a.cookie, { name: 'T two', lanes: [{ draft: 1 }] }).expect(400);
    await post(a.cookie, { name: '', lanes }).expect(400);
    await http().delete(`/api/admin/lab-presets/${made.body.id}`).set('Origin', ORIGIN).set('Cookie', a.cookie).expect(204);
    await http().delete(`/api/admin/lab-presets/${made.body.id}`).set('Origin', ORIGIN).set('Cookie', a.cookie).expect(404);
  });

  it('is hidden from non-admins (404, like every admin route)', async () => {
    const u = await loginAs(app, 'u@x.com');
    await http().get('/api/admin/lab-presets').set('Cookie', u.cookie).expect(404);
    await post(u.cookie, { name: 'T x', lanes: [{ draft: 'x', verify: null }] }).expect(404);
  });
});
