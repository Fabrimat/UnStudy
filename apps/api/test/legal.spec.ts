import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

describe('legal documents', () => {
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
  const admin = async () => {
    const a = await loginAs(app, 'admin@x.com');
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'admin' } });
    return a;
  };

  it('requires nothing while no document is published', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    await http().get('/api/documents').set('Cookie', cookie).expect(200);
    const me = await http().get('/api/me').set('Cookie', cookie).expect(200);
    expect(me.body.legal).toEqual({ pending: [] });
    await http().get('/api/legal/terms').expect(404);
  });

  it('blocks users until they accept the current version, and again after a new one', async () => {
    const a = await admin();
    const u = await loginAs(app, 'u@x.com');
    await post(a.cookie, '/api/admin/legal/terms', { body: '  # Terms v1  ' }).expect(201);
    expect((await http().get('/api/legal/terms').expect(200)).body).toMatchObject({ kind: 'terms', version: 1, body: '# Terms v1' });

    const blocked = await http().get('/api/documents').set('Cookie', u.cookie).expect(403);
    expect(blocked.body).toEqual({ code: 'legal_acceptance_required' });
    const me = await http().get('/api/me').set('Cookie', u.cookie).expect(200);
    expect(me.body.legal.pending).toEqual([{ kind: 'terms', version: 1 }]);
    await http().get('/api/admin/models').set('Cookie', a.cookie).expect(200); // admin routes are not gated

    await post(u.cookie, '/api/me/legal/accept', { documents: [{ kind: 'terms', version: 2 }] }).expect(409);
    await http().get('/api/documents').set('Cookie', u.cookie).expect(403);
    const ok = await post(u.cookie, '/api/me/legal/accept', { documents: [{ kind: 'terms', version: 1 }] }).expect(200);
    expect(ok.body.pending).toEqual([]);
    await post(u.cookie, '/api/me/legal/accept', { documents: [{ kind: 'terms', version: 1 }] }).expect(200); // idempotent
    await http().get('/api/documents').set('Cookie', u.cookie).expect(200);

    await post(a.cookie, '/api/admin/legal/terms', { body: 'Terms v2' }).expect(201);
    await http().get('/api/documents').set('Cookie', u.cookie).expect(403);
    const hist = await http().get('/api/admin/legal/terms').set('Cookie', a.cookie).expect(200);
    expect(hist.body.map((d: { version: number; acceptances: number }) => [d.version, d.acceptances])).toEqual([[2, 0], [1, 1]]);
  });

  it('keeps publishing admin-only and validates input', async () => {
    const u = await loginAs(app, 'u@x.com');
    await post(u.cookie, '/api/admin/legal/terms', { body: 'x' }).expect(404);
    const a = await admin();
    await post(a.cookie, '/api/admin/legal/terms', { body: '   ' }).expect(400);
    await post(a.cookie, '/api/admin/legal/nope', { body: 'x' }).expect(400);
    await http().get('/api/legal/nope').expect(404);
  });
});
