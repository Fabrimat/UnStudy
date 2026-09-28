import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { MailService } from '../src/auth/mail.service';
import { PrismaService } from '../src/prisma.service';
import { createApp, ORIGIN, resetDb } from './helpers';

describe('magic link auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sent: { to: string; text: string }[] = [];

  beforeAll(async () => {
    app = await createApp((b) =>
      b.overrideProvider(MailService).useValue({
        send: async (to: string, _subject: string, text: string) => void sent.push({ to, text }),
      }),
    );
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    sent.length = 0;
    await resetDb(prisma);
  });

  const http = () => request(app.getHttpServer());
  const requestLink = (email: string) => http().post('/api/auth/magic-link').set('Origin', ORIGIN).send({ email });
  const verify = (token: string) => http().post('/api/auth/magic-link/verify').set('Origin', ORIGIN).send({ token });
  const tokenFromMail = () => /token=([\w-]+)/.exec(sent.at(-1)!.text)![1];
  const sidCookie = (res: request.Response) =>
    (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sid='))!.split(';')[0];

  it('logs in with a magic link and reads /me', async () => {
    await requestLink('Ada@Example.com').expect(204);
    expect(sent[0].to).toBe('ada@example.com');
    expect(sent[0].text).toContain('http://localhost:5173/auth/verify?token=');
    const res = await verify(tokenFromMail()).expect(204);
    expect(res.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    const me = await http().get('/api/me').set('Cookie', sidCookie(res)).expect(200);
    expect(me.body).toMatchObject({ email: 'ada@example.com' });
  });

  it('accepts each link only once', async () => {
    await requestLink('a@b.co').expect(204);
    const token = tokenFromMail();
    await verify(token).expect(204);
    await verify(token).expect(401);
  });

  it('rejects an expired link', async () => {
    await requestLink('a@b.co').expect(204);
    await prisma.magicLinkToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await verify(tokenFromMail()).expect(401);
  });

  it('sends at most 5 links per hour per email', async () => {
    for (let i = 0; i < 5; i++) await requestLink('a@b.co').expect(204);
    await requestLink('a@b.co').expect(429);
  });

  it('keeps the hourly limit under concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => requestLink('race@b.co')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([204, 204, 204, 204, 204, 429, 429, 429]);
    await expect(prisma.magicLinkToken.count({ where: { email: 'race@b.co' } })).resolves.toBe(5);
  });

  it('requires a session for /me and logout ends it', async () => {
    await http().get('/api/me').expect(401);
    await requestLink('a@b.co').expect(204);
    const cookie = sidCookie(await verify(tokenFromMail()).expect(204));
    await http().post('/api/auth/logout').set('Origin', ORIGIN).set('Cookie', cookie).expect(204);
    await http().get('/api/me').set('Cookie', cookie).expect(401);
  });

  it('rejects invalid input', async () => {
    await requestLink('not-an-email').expect(400);
    await verify('short').expect(400);
  });

  it('links a verified provider login to the existing user', async () => {
    const auth = app.get(AuthService);
    const byEmail = await auth.loginWithProvider('email', 'x@y.com', 'x@y.com', true);
    const byGoogle = await auth.loginWithProvider('google', 'g-123', 'X@y.com', true);
    expect(byGoogle.id).toBe(byEmail.id);
    const again = await auth.loginWithProvider('google', 'g-123', 'x@y.com', false);
    expect(again.id).toBe(byEmail.id);
    await expect(auth.loginWithProvider('google', 'g-999', 'new@y.com', false)).rejects.toThrow('Email not verified');
  });
});
