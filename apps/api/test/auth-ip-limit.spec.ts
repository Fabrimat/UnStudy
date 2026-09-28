import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MailService } from '../src/auth/mail.service';
import { PrismaService } from '../src/prisma.service';
import { createApp, ORIGIN, resetDb } from './helpers';

// Spec §6: magic link requests are rate-limited per email AND per IP. AuthService already caps
// 5/hour per email; this covers the IP side (F4), on its own app instance so its throttler storage
// starts empty regardless of what auth.spec.ts already sent from the same test IP.
describe('magic link IP rate limit', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createApp((b) =>
      b.overrideProvider(MailService).useValue({ send: async () => {} }),
    );
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const requestLink = (email: string) =>
    request(app.getHttpServer()).post('/api/auth/magic-link').set('Origin', ORIGIN).send({ email });

  it('limits magic-link requests to 30 per hour per IP, even across distinct emails', async () => {
    for (let i = 0; i < 30; i++) await requestLink(`user${i}@x.com`).expect(204);
    await requestLink('user30@x.com').expect(429);
  }, 30000);
});
