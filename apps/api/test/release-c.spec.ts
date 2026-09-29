import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parseModels } from '../src/config';
import { creditsForJob } from '../src/credits/credits';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const OPTIONS = { language: 'auto', lengthPercent: 20, method: 'studio' };
const entry = { id: 'fast', label: 'Fast', model: 'p/fast', multiplier: 1 };

describe('release C: job tweaks', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const send = (verb: 'post' | 'patch', cookie: string, url: string, body: object) => http()[verb](url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const setup = async (chapterWords = [1500, 2000, 3000], balance = 100) => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'grant', amount: balance } });
    const words = chapterWords.reduce((a, b) => a + b, 0);
    const doc = await prisma.document.create({
      data: {
        userId: user.id, filename: 'a.pdf', sizeBytes: 1, s3Key: `users/${user.id}/x.pdf`, status: 'analyzed', pages: 10, words,
        chapters: chapterWords.map((w, i) => ({ title: `c${i}`, pageFrom: i + 1, pageTo: i + 1, words: w })),
      },
    });
    return { user, cookie, doc };
  };

  it('prices only the chosen chapters and stores them sorted', async () => {
    const { cookie, doc } = await setup();
    const res = await send('post', cookie, '/api/jobs', { documentId: doc.id, ...OPTIONS, chapters: [2, 0], extras: ['questions', 'glossary'] }).expect(201);
    expect(res.body.credits).toBe(5); // 4500 words
    expect(res.body.options).toMatchObject({ chapters: [0, 2], extras: ['questions', 'glossary'], lengthPercent: 20, modelId: 'default' });
    expect(res.body.options.model).toBeUndefined();
    const all = await send('post', cookie, '/api/jobs', { documentId: doc.id, ...OPTIONS }).expect(201);
    expect(all.body.credits).toBe(7);
    expect(all.body.options.chapters).toBeUndefined();
    expect(all.body.options.extras).toBeUndefined();
  });

  it('rejects bad chapters, extras, length, legacy fraction and unknown model', async () => {
    const { cookie, doc } = await setup();
    const bad = (extra: object) => send('post', cookie, '/api/jobs', { documentId: doc.id, ...OPTIONS, ...extra }).expect(400);
    for (const chapters of [[3], [0, 0], [], [-1], [1.5]]) await bad({ chapters });
    await bad({ extras: ['poem'] });
    await bad({ extras: ['glossary', 'glossary'] });
    await bad({ lengthPercent: 4 });
    await bad({ lengthPercent: 51 });
    await bad({ model: 'nope' });
    await send('post', cookie, '/api/jobs', { documentId: doc.id, language: 'auto', method: 'studio', fraction: 5 }).expect(400);
    await send('post', cookie, '/api/jobs', { documentId: doc.id, ...OPTIONS, lengthPercent: 5 }).expect(201);
    await send('post', cookie, '/api/jobs', { documentId: doc.id, ...OPTIONS, lengthPercent: 50, model: 'default' }).expect(201);
  });

  it('rejects chapters on a legacy document without a chapter list', async () => {
    const { user, cookie } = await setup();
    const old = await prisma.document.create({ data: { userId: user.id, filename: 'o.pdf', sizeBytes: 1, s3Key: 'k', status: 'analyzed', pages: 1, words: 500 } });
    await send('post', cookie, '/api/jobs', { documentId: old.id, ...OPTIONS, chapters: [0] }).expect(400);
    await send('post', cookie, '/api/jobs', { documentId: old.id, ...OPTIONS }).expect(201);
  });

  it('GET /models hides the provider id', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = await http().get('/api/models').set('Cookie', cookie).expect(200);
    expect(res.body).toEqual([{ id: 'default', label: 'Default', multiplier: 1 }]);
    await http().get('/api/models').expect(401);
  });

  it('validates preferences lengthPercent and model', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const pref = (body: object) => send('patch', cookie, '/api/me/preferences', body);
    expect((await pref({ lengthPercent: 25, model: 'default' }).expect(200)).body).toEqual({ lengthPercent: 25, model: 'default' });
    expect((await pref({ lengthPercent: null, model: null }).expect(200)).body).toEqual({});
    for (const body of [{ lengthPercent: 4 }, { lengthPercent: 51 }, { lengthPercent: 2.5 }, { model: 'nope' }]) await pref(body).expect(400);
  });

  it('exposes fileDeleted on documents', async () => {
    const { cookie, doc } = await setup();
    expect((await http().get(`/api/documents/${doc.id}`).set('Cookie', cookie).expect(200)).body.fileDeleted).toBe(false);
    await prisma.document.update({ where: { id: doc.id }, data: { fileDeletedAt: new Date() } });
    expect((await http().get(`/api/documents/${doc.id}`).set('Cookie', cookie).expect(200)).body.fileDeleted).toBe(true);
  });
});

describe('creditsForJob', () => {
  it('applies the multiplier in integer arithmetic', () => {
    expect(creditsForJob(10_000, 1.1)).toBe(11); // 10 * 1.1 = 11.000000000000002 in floats
    expect(creditsForJob(10_000, 1)).toBe(10);
    expect(creditsForJob(1, 0.01)).toBe(1);
    expect(creditsForJob(2_500, 2)).toBe(6);
  });
});

describe('parseModels', () => {
  it('falls back to a single default entry when unset', () => {
    expect(parseModels(undefined, 'p/m')).toEqual([{ id: 'default', label: 'Default', model: 'p/m', multiplier: 1, provider: 'default', temperature: 0.4, adminOnly: false }]);
    expect(() => parseModels(undefined, undefined)).toThrow('LLM_MODEL is required');
    expect(parseModels('  ', 'p/x')[0].model).toBe('p/x');
  });
  it('parses a valid catalogue', () => {
    expect(parseModels(JSON.stringify([entry, { ...entry, id: 'big', multiplier: 2.5 }]), undefined)).toHaveLength(2);
  });
  it('throws on invalid catalogues', () => {
    const j = JSON.stringify;
    for (const raw of ['{oops', '[]', j({}), j([{ ...entry, multiplier: 0 }]), j([{ ...entry, multiplier: 101 }]), j([{ ...entry, id: 'Bad Id' }]), j([{ ...entry, label: '' }]), j([entry, entry]), j([null])])
      expect(() => parseModels(raw, undefined)).toThrow();
  });
});
