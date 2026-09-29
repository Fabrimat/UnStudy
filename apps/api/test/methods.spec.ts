import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

describe('methods and preferences', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const get = (cookie: string, url: string) => http().get(url).set('Cookie', cookie);
  const send = (verb: 'post' | 'patch', cookie: string, url: string, body: object) => http()[verb](url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const del = (cookie: string, url: string) => http().delete(url).set('Origin', ORIGIN).set('Cookie', cookie);
  const mk = async (cookie: string, name = 'Mine', instructions = 'Be brief in {language}.') =>
    (await send('post', cookie, '/api/methods', { name, instructions }).expect(201)).body;
  const doc = (userId: string, words = 2500) =>
    prisma.document.create({ data: { userId, filename: 'a.pdf', sizeBytes: 1, s3Key: `users/${userId}/x-${Math.random()}.pdf`, status: 'analyzed', pages: 10, words } });
  const start = (cookie: string, body: object) => send('post', cookie, '/api/jobs', { language: 'auto', fraction: 3, ...body });
  const grant = (userId: string, amount: number) => prisma.creditLedger.create({ data: { userId, type: 'grant', amount } });

  it('does CRUD and trims input', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const m = await mk(cookie, '  My method ', '  text  ');
    expect(m).toMatchObject({ name: 'My method', instructions: 'text' });
    expect((await get(cookie, '/api/methods').expect(200)).body).toHaveLength(1);
    const up = (await send('patch', cookie, `/api/methods/${m.id}`, { instructions: 'new' }).expect(200)).body;
    expect(up).toMatchObject({ name: 'My method', instructions: 'new' });
    await del(cookie, `/api/methods/${m.id}`).expect(204);
    expect((await get(cookie, '/api/methods').expect(200)).body).toEqual([]);
  });

  it('validates name and instructions', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    for (const body of [
      { name: '', instructions: 'x' }, { name: '   ', instructions: 'x' }, { name: 'x'.repeat(81), instructions: 'x' },
      { name: 'a\nb', instructions: 'x' }, { name: 'ok', instructions: '' }, { name: 'ok', instructions: 'x'.repeat(4001) },
    ]) await send('post', cookie, '/api/methods', body).expect(400);
    await send('post', cookie, '/api/methods', { name: 'x'.repeat(80), instructions: 'x'.repeat(4000) }).expect(201);
  });

  it('caps at 20 methods, even with parallel creates', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    for (let i = 0; i < 19; i++) await mk(cookie, `m${i}`);
    const rs = await Promise.all([send('post', cookie, '/api/methods', { name: 'a', instructions: 'x' }), send('post', cookie, '/api/methods', { name: 'b', instructions: 'x' })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    await send('post', cookie, '/api/methods', { name: 'c', instructions: 'x' }).expect(409);
    expect(await prisma.summaryMethod.count()).toBe(20);
  });

  it('hides methods from other users', async () => {
    const alice = await loginAs(app, 'a@x.com');
    const bob = await loginAs(app, 'b@x.com');
    const m = await mk(alice.cookie);
    expect((await get(bob.cookie, '/api/methods').expect(200)).body).toEqual([]);
    await send('patch', bob.cookie, `/api/methods/${m.id}`, { name: 'hack' }).expect(404);
    await del(bob.cookie, `/api/methods/${m.id}`).expect(404);
    expect(await prisma.summaryMethod.findUnique({ where: { id: m.id } })).toMatchObject({ name: 'Mine' });
  });

  it('serves the three preset texts', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = (await get(cookie, '/api/methods/presets').expect(200)).body;
    expect(res.map((p: any) => p.id)).toEqual(['studio', 'schematico', 'abstract']);
    for (const p of res) expect(p.text.length).toBeGreaterThan(50);
  });

  it('snapshots a custom method into the job and never exposes the instructions', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 10);
    const d = await doc(user.id);
    const m = await mk(cookie, 'Mine', 'secret text');
    const res = await start(cookie, { documentId: d.id, method: `custom:${m.id}` }).expect(201);
    expect(res.body.options).toEqual({ language: 'auto', fraction: 3, method: `custom:${m.id}`, methodName: 'Mine' });
    expect(JSON.stringify(res.body)).not.toContain('secret text');
    const stored = async () => (await prisma.job.findUniqueOrThrow({ where: { id: res.body.id } })).options;
    const snapshot = { language: 'auto', fraction: 3, method: `custom:${m.id}`, methodName: 'Mine', customInstructions: 'secret text' };
    expect(await stored()).toEqual(snapshot);
    await send('patch', cookie, `/api/methods/${m.id}`, { name: 'Renamed', instructions: 'changed' }).expect(200);
    expect(await stored()).toEqual(snapshot);
    await del(cookie, `/api/methods/${m.id}`).expect(204);
    expect(await stored()).toEqual(snapshot);
    expect((await get(cookie, `/api/jobs/${res.body.id}`).expect(200)).body.options.customInstructions).toBeUndefined();
  });

  it('stores preset jobs with method and preset', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await grant(user.id, 10);
    const d = await doc(user.id);
    const res = await start(cookie, { documentId: d.id, method: 'abstract' }).expect(201);
    expect(res.body.options).toEqual({ language: 'auto', fraction: 3, method: 'abstract', preset: 'abstract' });
  });

  it('rejects a foreign custom method without reserving credits, and invalid methods', async () => {
    const alice = await loginAs(app, 'a@x.com');
    const bob = await loginAs(app, 'b@x.com');
    await grant(bob.user.id, 10);
    const d = await doc(bob.user.id);
    const m = await mk(alice.cookie);
    await start(bob.cookie, { documentId: d.id, method: `custom:${m.id}` }).expect(404);
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.creditLedger.count({ where: { type: 'reserve' } })).toBe(0);
    for (const method of ['poem', 'custom:nope', 'custom:', undefined]) await start(bob.cookie, { documentId: d.id, method }).expect(400);
    await start(bob.cookie, { documentId: d.id, preset: 'studio' }).expect(400);
  });

  it('merges preferences, null removes, and validates', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const pref = (body: object) => send('patch', cookie, '/api/me/preferences', body);
    expect((await get(cookie, '/api/me').expect(200)).body.preferences).toEqual({});
    expect((await pref({ language: 'it', fraction: 5 }).expect(200)).body).toEqual({ language: 'it', fraction: 5 });
    expect((await pref({ method: 'abstract' }).expect(200)).body).toEqual({ language: 'it', fraction: 5, method: 'abstract' });
    expect((await pref({ fraction: null }).expect(200)).body).toEqual({ language: 'it', method: 'abstract' });
    expect((await get(cookie, '/api/me').expect(200)).body.preferences).toEqual({ language: 'it', method: 'abstract' });
    for (const body of [{ language: 'xx' }, { fraction: 4 }, { method: 'poem' }, { method: 'custom:zzz' }, { other: 1 }]) await pref(body).expect(400);
  });

  it('accepts only an owned custom method as preference', async () => {
    const alice = await loginAs(app, 'a@x.com');
    const bob = await loginAs(app, 'b@x.com');
    const m = await mk(alice.cookie);
    await send('patch', bob.cookie, '/api/me/preferences', { method: `custom:${m.id}` }).expect(404);
    await send('patch', alice.cookie, '/api/me/preferences', { method: `custom:${m.id}` }).expect(200);
    await del(alice.cookie, `/api/methods/${m.id}`).expect(204);
    expect((await get(alice.cookie, '/api/me').expect(200)).body.preferences).toEqual({ method: `custom:${m.id}` });
  });

  it('computes creditsSpent from the ledger, unchanged by deleting a done job', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    const j = await prisma.job.create({ data: { userId: user.id, documentId: d.id, kind: 'summarize', status: 'done', options: { method: 'studio', preset: 'studio' }, credits: 3 } });
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -3, jobId: j.id } });
    const spent = async () => (await get(cookie, '/api/me/stats').expect(200)).body.creditsSpent;
    expect(await spent()).toBe(3);
    await del(cookie, `/api/jobs/${j.id}`).expect(204);
    expect(await spent()).toBe(3);
  });

  it('filters jobs by method, including old jobs with only preset', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const d = await doc(user.id);
    const m = await mk(cookie);
    const mkJob = (options: object) => prisma.job.create({ data: { userId: user.id, documentId: d.id, kind: 'summarize', options, credits: 3 } });
    const old = await mkJob({ preset: 'abstract', fraction: 3, language: 'auto' });
    const custom = await mkJob({ method: `custom:${m.id}`, methodName: 'Mine', fraction: 3, language: 'auto' });
    const fresh = await mkJob({ method: 'abstract', preset: 'abstract', fraction: 3, language: 'auto' });
    const ids = async (method: string) => (await get(cookie, `/api/jobs?method=${method}`).expect(200)).body.items.map((j: any) => j.id).sort();
    expect(await ids('abstract')).toEqual([old.id, fresh.id].sort());
    expect(await ids(`custom:${m.id}`)).toEqual([custom.id]);
  });
});
