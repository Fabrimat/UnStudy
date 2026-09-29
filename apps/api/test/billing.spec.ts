import { INestApplication } from '@nestjs/common';
import Stripe from 'stripe';
import request from 'supertest';
import { config, parsePacks } from '../src/config';
import { LedgerService } from '../src/credits/ledger.service';
import { STRIPE_CLIENT } from '../src/billing/billing.service';
import { PrismaService } from '../src/prisma.service';
import { createApp, loginAs, ORIGIN, resetDb } from './helpers';

const SECRET = 'whsec_test';
const PACKS = [{ id: 'small', credits: 50, priceId: 'price_small' }];

const fake = () => ({
  prices: { retrieve: jest.fn(async () => ({ unit_amount: 499, currency: 'eur' })) },
  checkout: { sessions: { create: jest.fn(async () => ({ url: 'https://checkout.stripe.test/s1' })) } },
});

describe('billing off', () => {
  let app: INestApplication;
  beforeAll(async () => {
    (config as any).stripe = null;
    app = await createApp();
  });
  afterAll(() => app.close());

  it('reports disabled, 503 on checkout and webhook', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    const http = () => request(app.getHttpServer());
    expect((await http().get('/api/billing/packs').set('Cookie', cookie).expect(200)).body).toEqual({ enabled: false, packs: [] });
    await http().post('/api/billing/checkout').set('Origin', ORIGIN).set('Cookie', cookie).send({ packId: 'small' }).expect(503);
    await http().post('/api/billing/webhook').send({}).expect(503);
  });
});

describe('billing on', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stripe: ReturnType<typeof fake>;
  beforeAll(async () => {
    (config as any).stripe = { secretKey: 'sk_test', webhookSecret: SECRET, packs: PACKS, automaticTax: false };
    stripe = fake();
    app = await createApp((b) => b.overrideProvider(STRIPE_CLIENT).useValue(stripe));
    prisma = app.get(PrismaService);
  });
  afterAll(() => app.close());
  beforeEach(() => resetDb(prisma));

  const http = () => request(app.getHttpServer());
  // No Origin header: Stripe calls server-to-server.
  const hook = (event: object, signed = true) => {
    const payload = JSON.stringify(event);
    const req = http().post('/api/billing/webhook').set('Content-Type', 'application/json');
    if (signed) req.set('Stripe-Signature', Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }));
    return req.send(payload);
  };
  const paid = (userId: string, id = 'evt_1', pi = 'pi_1', extra: object = {}) => ({
    id,
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: pi, metadata: { userId, packId: 'small', credits: '50' }, ...extra } },
  });
  const refunded = (id: string, refunded: number, pi = 'pi_1') => ({
    id,
    type: 'charge.refunded',
    data: { object: { id: 'ch_1', payment_intent: pi, amount: 1000, amount_refunded: refunded, metadata: { userId: 'from-checkout' } } },
  });
  const rows = (type: string) => prisma.creditLedger.findMany({ where: { type: type as any } });

  it('lists packs with price from Stripe, cached', async () => {
    const { cookie } = await loginAs(app, 'u@x.com');
    stripe.prices.retrieve.mockClear();
    const body = { enabled: true, packs: [{ id: 'small', credits: 50, amount: 499, currency: 'eur' }] };
    expect((await http().get('/api/billing/packs').set('Cookie', cookie).expect(200)).body).toEqual(body);
    expect((await http().get('/api/billing/packs').set('Cookie', cookie).expect(200)).body).toEqual(body);
    expect(stripe.prices.retrieve).toHaveBeenCalledTimes(1);
  });

  it('creates a checkout session', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await http().post('/api/billing/checkout').set('Origin', ORIGIN).send({ packId: 'small' }).expect(401);
    await http().post('/api/billing/checkout').set('Origin', ORIGIN).set('Cookie', cookie).send({ packId: 'nope' }).expect(404);
    const res = await http().post('/api/billing/checkout').set('Origin', ORIGIN).set('Cookie', cookie).send({ packId: 'small' }).expect(200);
    expect(res.body).toEqual({ url: 'https://checkout.stripe.test/s1' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        client_reference_id: user.id,
        customer_email: 'u@x.com',
        metadata: { userId: user.id, packId: 'small', credits: '50' },
        payment_intent_data: { metadata: { userId: user.id, packId: 'small', credits: '50' } },
        invoice_creation: { enabled: true },
        automatic_tax: { enabled: false },
        success_url: `${ORIGIN}/credits?paid=1`,
        cancel_url: `${ORIGIN}/credits`,
      }),
    );
  });

  it('rejects a missing or wrong signature', async () => {
    await hook({ id: 'evt_x', type: 'x' }, false).expect(400);
    await http().post('/api/billing/webhook').set('Content-Type', 'application/json').set('Stripe-Signature', 't=1,v1=bad').send('{}').expect(400);
  });

  it('credits a paid checkout once, even when redelivered (no Origin header)', async () => {
    const { user } = await loginAs(app, 'u@x.com');
    await hook(paid(user.id)).expect(200);
    await hook(paid(user.id)).expect(200);
    const purchases = await rows('purchase');
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ amount: 50, jobId: null, paymentIntentId: 'pi_1', stripeEventId: 'evt_1' });
    expect(await app.get(LedgerService).balance(user.id)).toBe(50);
  });

  it('credits one purchase for two events with the same payment intent', async () => {
    const { user } = await loginAs(app, 'u@x.com');
    await hook(paid(user.id, 'evt_1')).expect(200);
    await hook(paid(user.id, 'evt_2')).expect(200);
    expect(await rows('purchase')).toHaveLength(1);
  });

  it('waits for async_payment_succeeded when unpaid', async () => {
    const { user } = await loginAs(app, 'u@x.com');
    await hook(paid(user.id, 'evt_1', 'pi_1', { payment_status: 'unpaid' })).expect(200);
    expect(await rows('purchase')).toHaveLength(0);
    await hook({ ...paid(user.id, 'evt_2'), type: 'checkout.session.async_payment_succeeded' }).expect(200);
    expect(await rows('purchase')).toHaveLength(1);
  });

  it('ignores unknown users, bad metadata and unhandled types with 200', async () => {
    await hook(paid('00000000-0000-4000-8000-000000000000')).expect(200);
    await hook(paid('not-a-uuid', 'evt_2')).expect(200);
    await hook({ id: 'evt_3', type: 'customer.created', data: { object: {} } }).expect(200);
    expect(await rows('purchase')).toHaveLength(0);
  });

  it('revokes credits on a full refund', async () => {
    const { user } = await loginAs(app, 'u@x.com');
    await hook(paid(user.id)).expect(200);
    await hook(refunded('evt_r', 1000)).expect(200);
    expect((await rows('revoke')).map((r) => r.amount)).toEqual([-50]);
  });

  it('sums partial refunds to the purchased credits', async () => {
    const { user } = await loginAs(app, 'u@x.com');
    await hook(paid(user.id)).expect(200);
    await hook(refunded('evt_r1', 500)).expect(200);
    await hook(refunded('evt_r2', 1000)).expect(200);
    expect((await rows('revoke')).reduce((s, r) => s + r.amount, 0)).toBe(-50);
  });

  it('answers 500 and stores nothing for a refund without purchase', async () => {
    await hook(refunded('evt_r', 1000, 'pi_unknown')).expect(500);
    expect(await prisma.stripeEvent.count()).toBe(0);
  });

  it('ignores with 200 a refund of a payment not made through our Checkout', async () => {
    const ev = refunded('evt_foreign', 1000, 'pi_foreign');
    (ev.data.object as { metadata?: object }).metadata = {};
    await hook(ev).expect(200);
    expect(await prisma.creditLedger.count({ where: { type: 'revoke' } })).toBe(0);
  });

  it('blocks new jobs when a refund makes the balance negative', async () => {
    const { user, cookie } = await loginAs(app, 'u@x.com');
    await hook(paid(user.id)).expect(200);
    await prisma.creditLedger.create({ data: { userId: user.id, type: 'reserve', amount: -30 } }); // 30 credits already reserved by a job
    await hook(refunded('evt_r', 1000)).expect(200);
    expect(await app.get(LedgerService).balance(user.id)).toBe(-30);
    const doc = await prisma.document.create({
      data: { userId: user.id, filename: 'a.pdf', sizeBytes: 1, s3Key: `users/${user.id}/x.pdf`, status: 'analyzed', pages: 1, words: 500 },
    });
    await http()
      .post('/api/jobs')
      .set('Origin', ORIGIN)
      .set('Cookie', cookie)
      .send({ documentId: doc.id, language: 'auto', lengthPercent: 20, method: 'studio' })
      .expect(402);
  });
});

describe('parsePacks', () => {
  it('parses a valid list', () => {
    expect(parsePacks(JSON.stringify(PACKS))).toEqual(PACKS);
  });
  it('throws on invalid input', () => {
    const j = JSON.stringify;
    const p = PACKS[0];
    for (const raw of [undefined, '{oops', '[]', j({}), j([null]), j([{ ...p, id: 'Bad Id' }]), j([{ ...p, credits: 0 }]), j([{ ...p, credits: 1.5 }]), j([{ ...p, credits: 100001 }]), j([{ ...p, priceId: '' }]), j([p, p])])
      expect(() => parsePacks(raw)).toThrow();
  });
});
