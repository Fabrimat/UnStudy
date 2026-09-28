import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, resetDb } from './helpers';

const collect = (res: any, cb: (err: Error | null, body: string) => void) => {
  let body = '';
  res.on('data', (chunk: Buffer) => (body += chunk));
  res.on('end', () => cb(null, body));
};

describe('job events', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  async function queuedJob(userId: string) {
    const doc = await prisma.document.create({ data: { userId, filename: 'a.pdf', sizeBytes: 1, s3Key: 'k', status: 'analyzed', words: 10 } });
    return prisma.job.create({ data: { userId, documentId: doc.id, kind: 'summarize', credits: 1 } });
  }

  it('streams changes until the job finishes', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    const job = await queuedJob(user.id);
    setTimeout(() => prisma.job.update({ where: { id: job.id }, data: { status: 'running', progress: 40, phase: 'Chapter 1/1: draft' } }).then(), 500);
    setTimeout(() => prisma.job.update({ where: { id: job.id }, data: { status: 'done', progress: 100, phase: 'done' } }).then(), 3000);

    const res = await request(app.getHttpServer())
      .get(`/api/jobs/${job.id}/events`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(collect)
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const events = (res.body as string).split('\n\n').filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, '')));
    expect(events.map((e) => e.status)).toEqual(['queued', 'running', 'done']);
    expect(events[1]).toMatchObject({ progress: 40, phase: 'Chapter 1/1: draft' });
  }, 15_000);

  it('returns 404 for someone else job', async () => {
    const alice = await loginAs(app, 'alice@x.com');
    const bob = await loginAs(app, 'bob@x.com');
    const job = await queuedJob(alice.user.id);
    await request(app.getHttpServer()).get(`/api/jobs/${job.id}/events`).set('Cookie', bob.cookie).expect(404);
  });
});
