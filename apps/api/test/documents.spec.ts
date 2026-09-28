import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% test file\n');

describe('documents', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  const create = (cookie: string, body: object) =>
    http().post('/api/documents').set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const confirm = (cookie: string, id: string) =>
    http().post(`/api/documents/${id}/uploaded`).set('Origin', ORIGIN).set('Cookie', cookie);

  it('uploads through a signed URL and queues the analysis', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'Reading.pdf', sizeBytes: PDF.length }).expect(201);
    expect(res.body.document).toMatchObject({ filename: 'Reading.pdf', status: 'uploaded', credits: null });
    const put = await fetch(res.body.uploadUrl, { method: 'PUT', body: PDF, headers: { 'Content-Type': 'application/pdf' } });
    expect(put.status).toBe(200);
    await confirm(cookie, res.body.document.id).expect(201);
    const jobs = await prisma.job.findMany({ where: { documentId: res.body.document.id } });
    expect(jobs).toMatchObject([{ kind: 'analyze', status: 'queued', userId: user.id }]);
    await confirm(cookie, res.body.document.id).expect(409);
  });

  it('queues one analysis even when confirmed twice at once', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'Reading.pdf', sizeBytes: PDF.length }).expect(201);
    await fetch(res.body.uploadUrl, { method: 'PUT', body: PDF, headers: { 'Content-Type': 'application/pdf' } });
    const [a, b] = await Promise.all([confirm(cookie, res.body.document.id), confirm(cookie, res.body.document.id)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const jobs = await prisma.job.findMany({ where: { documentId: res.body.document.id, kind: 'analyze' } });
    expect(jobs).toHaveLength(1);
  });

  it('refuses to confirm before the file is uploaded', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(201);
    await confirm(cookie, res.body.document.id).expect(400);
  });

  it('rejects a stored file whose size differs from the declared one', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const res = await create(cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(201);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: res.body.document.id } });
    await app.get(StorageService).put(doc.s3Key, Buffer.alloc(20), 'application/pdf');
    await confirm(cookie, doc.id).expect(400);
    expect((await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('rejected');
  });

  it('validates filename, size and ids', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    await create(cookie, { filename: 'a.pdf', sizeBytes: 50 * 1024 * 1024 + 1 }).expect(400);
    await create(cookie, { filename: 'notes.docx', sizeBytes: 10 }).expect(400);
    await create(cookie, { filename: 'a.pdf', sizeBytes: 0 }).expect(400);
    await http().get('/api/documents/not-a-uuid').set('Cookie', cookie).expect(400);
  });

  it('hides other users documents', async () => {
    const alice = await loginAs(app, 'alice@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    const res = await create(alice.cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(201);
    await http().get(`/api/documents/${res.body.document.id}`).set('Cookie', bob.cookie).expect(404);
    await confirm(bob.cookie, res.body.document.id).expect(404);
    expect((await http().get('/api/documents').set('Cookie', bob.cookie).expect(200)).body).toEqual([]);
    expect((await http().get('/api/documents').set('Cookie', alice.cookie).expect(200)).body).toHaveLength(1);
  });

  it('limits uploads to 30 per hour', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await prisma.document.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ userId: user.id, filename: `${i}.pdf`, sizeBytes: 1, s3Key: `k${i}` })),
    });
    await create(cookie, { filename: 'a.pdf', sizeBytes: 10 }).expect(429);
  });

  it('requires a session', async () => {
    await http().get('/api/documents').expect(401);
  });
});
