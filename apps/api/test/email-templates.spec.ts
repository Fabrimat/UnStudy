import { INestApplication } from '@nestjs/common';
import Stripe from 'stripe';
import request from 'supertest';
import { MailService } from '../src/auth/mail.service';
import { fill, tokensOf } from '../src/auth/email-templates';
import { STRIPE_CLIENT } from '../src/billing/billing.service';
import { config } from '../src/config';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const SECRET = 'whsec_test';

describe('email template rendering', () => {
  it('replaces known tokens in one pass and leaves unknown ones', () => {
    expect(fill('Hi {name}, {link} {x}', { name: 'Ada', link: '{name}' })).toBe('Hi Ada, {name} {x}');
    expect(tokensOf('{a} and {b} {a}')).toEqual(['a', 'b', 'a']);
  });
});

describe('email templates', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sent: { to: string; subject: string; text: string }[] = [];

  beforeAll(async () => {
    (config as any).stripe = { secretKey: 'sk_test', webhookSecret: SECRET, packs: [{ id: 'small', credits: 50, priceId: 'price_small' }], automaticTax: false };
    app = await createApp((b) =>
      b
        .overrideProvider(MailService)
        .useValue({ send: async (to: string, subject: string, text: string) => void sent.push({ to, subject, text }) })
        .overrideProvider(STRIPE_CLIENT)
        .useValue({}),
    );
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    sent.length = 0;
    await resetDb(prisma);
  });

  const http = () => request(app.getHttpServer());
  const send = (method: 'put' | 'post', cookie: string, url: string, body: object) => http()[method](url).set('Origin', ORIGIN).set('Cookie', cookie).send(body);
  const admin = async () => {
    const a = await loginAs(app, 'admin@x.com');
    await prisma.user.update({ where: { id: a.user.id }, data: { role: 'admin' } });
    return a;
  };
  const url = '/api/admin/email-templates/magic_link';

  it('lists defaults, saves an override, previews and resets', async () => {
    const a = await admin();
    const list = await http().get('/api/admin/email-templates').set('Cookie', a.cookie).expect(200);
    expect(list.body.find((t: any) => t.key === 'magic_link')).toMatchObject({ isDefault: true, updatedAt: null, placeholders: [{ name: 'link', required: true }, { name: 'email', required: false }] });

    const tpl = { subject: 'Hello {email}', body: 'Go: {link}' };
    const prev = await send('post', a.cookie, `${url}/preview`, tpl).expect(200);
    expect(prev.body).toEqual({ subject: 'Hello ada@example.com', body: 'Go: https://example.com/auth/verify?token=example' });

    const saved = await send('put', a.cookie, url, tpl).expect(200);
    expect(saved.body).toMatchObject({ key: 'magic_link', isDefault: false, ...tpl });
    await expect(prisma.emailTemplate.count()).resolves.toBe(1);

    await http().delete(url).set('Origin', ORIGIN).set('Cookie', a.cookie).expect(204);
    await expect(prisma.emailTemplate.count()).resolves.toBe(0);
  });

  it('rejects unknown placeholders, a missing {link}, bad subjects and unknown keys', async () => {
    const a = await admin();
    const bad = await send('put', a.cookie, url, { subject: 's', body: 'Go {link} {nope}' }).expect(400);
    expect(JSON.stringify(bad.body)).toContain('{nope}');
    await send('put', a.cookie, url, { subject: '{link}', body: 'no link here' }).expect(400);
    await send('post', a.cookie, `${url}/preview`, { subject: 's', body: 'no link here' }).expect(400);
    await send('put', a.cookie, url, { subject: 'two\nlines', body: '{link}' }).expect(400);
    await send('put', a.cookie, url, { subject: '', body: '{link}' }).expect(400);
    await send('put', a.cookie, '/api/admin/email-templates/nope', { subject: 's', body: 'b' }).expect(404);
    await expect(prisma.emailTemplate.count()).resolves.toBe(0);
  });

  it('is hidden from non-admins', async () => {
    const u = await loginAs(app, 'u@x.com');
    await http().get('/api/admin/email-templates').set('Cookie', u.cookie).expect(404);
    await send('put', u.cookie, url, { subject: 's', body: '{link}' }).expect(404);
  });

  it('magic link uses the default, then the override', async () => {
    const link = () => http().post('/api/auth/magic-link').set('Origin', ORIGIN).send({ email: 'ada@example.com' }).expect(204);
    await link();
    expect(sent.at(-1)).toMatchObject({ to: 'ada@example.com', subject: 'Your Summarize login link' });
    expect(sent.at(-1)!.text).toMatch(/^Open this link to log in \(valid for 15 minutes\):\n\nhttp\S+token=[\w-]+\n\nIf you did not ask/);

    const a = await admin();
    await send('put', a.cookie, url, { subject: 'Custom for {email}', body: 'Here: {link}' }).expect(200);
    await link();
    expect(sent.at(-1)).toMatchObject({ subject: 'Custom for ada@example.com' });
    expect(sent.at(-1)!.text).toMatch(/^Here: http\S+token=[\w-]+$/);
  });

  it('sends the purchase receipt once, not on replay', async () => {
    const { user } = await loginAs(app, 'buyer@x.com');
    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', metadata: { userId: user.id, packId: 'small', credits: '50' } } },
    };
    const hook = () => {
      const payload = JSON.stringify(event);
      return http()
        .post('/api/billing/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }))
        .send(payload)
        .expect(200);
    };
    await hook();
    await hook();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'buyer@x.com', subject: 'Your Summarize purchase' });
    expect(sent[0].text).toContain('50 credits');
  });
});
