import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, User } from '@summarize/db';
import Stripe from 'stripe';
import { config } from '../config';
import { PrismaService } from '../prisma.service';

export const STRIPE_CLIENT = 'STRIPE_CLIENT';
const PRICE_TTL_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class BillingService {
  private logger = new Logger(BillingService.name);
  // ponytail: per-process cache, one Stripe call per pack per 10 min per instance.
  private prices = new Map<string, { at: number; amount: number; currency: string }>();

  constructor(@Inject(STRIPE_CLIENT) private stripe: Stripe | null, private prisma: PrismaService) {}

  get enabled() {
    return !!config.stripe && !!this.stripe;
  }

  async packs() {
    const cfg = config.stripe;
    const stripe = this.stripe;
    if (!cfg || !stripe) return { enabled: false, packs: [] };
    const packs = await Promise.all(
      cfg.packs.map(async (p) => {
        let hit = this.prices.get(p.id);
        if (!hit || Date.now() - hit.at > PRICE_TTL_MS) {
          const price = await stripe.prices.retrieve(p.priceId);
          if (price.unit_amount == null) throw new ServiceUnavailableException('Price unavailable');
          hit = { at: Date.now(), amount: price.unit_amount, currency: price.currency };
          this.prices.set(p.id, hit);
        }
        return { id: p.id, credits: p.credits, amount: hit.amount, currency: hit.currency };
      }),
    );
    return { enabled: true, packs };
  }

  async checkout(user: User, packId: string) {
    const cfg = config.stripe;
    if (!cfg || !this.stripe) throw new ServiceUnavailableException('Billing is disabled');
    const pack = cfg.packs.find((p) => p.id === packId);
    if (!pack) throw new NotFoundException('Unknown pack');
    const metadata = { userId: user.id, packId: pack.id, credits: String(pack.credits) };
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: pack.priceId, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email,
      metadata,
      payment_intent_data: { metadata },
      invoice_creation: { enabled: true },
      automatic_tax: { enabled: cfg.automaticTax },
      success_url: `${config.webOrigin}/credits?paid=1`,
      cancel_url: `${config.webOrigin}/credits`,
    });
    if (!session.url) throw new ServiceUnavailableException('Checkout unavailable');
    return { url: session.url };
  }

  async handleWebhook(rawBody: Buffer, signature: string) {
    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, signature, config.stripe!.webhookSecret);
    } catch {
      throw new BadRequestException('Invalid signature');
    }
    const t = event.type;
    if (t !== 'checkout.session.completed' && t !== 'checkout.session.async_payment_succeeded' && t !== 'charge.refunded') return;
    await this.prisma.$transaction(async (tx) => {
      // PK insert first: a redelivered event inserts nothing and the handler is skipped.
      const { count } = await tx.stripeEvent.createMany({ data: [{ id: event.id, type: t }], skipDuplicates: true });
      if (!count) return this.logger.log(`Duplicate event ${event.id}`);
      if (t === 'charge.refunded') return this.refund(tx, event.id, event.data.object as Stripe.Charge);
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== 'paid') return; // async method still pending: only the event is recorded
      return this.credit(tx, event.id, session);
    });
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    return rows.length > 0;
  }

  private async credit(tx: Prisma.TransactionClient, eventId: string, s: Stripe.Checkout.Session) {
    const userId = s.metadata?.userId;
    const amount = Number(s.metadata?.credits);
    const paymentIntentId = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
    if (!userId || !UUID.test(userId) || !Number.isInteger(amount) || amount < 1 || amount > 100000 || !paymentIntentId) {
      return this.logger.error(`Event ${eventId}: invalid session metadata (session ${s.id})`); // retrying cannot fix it
    }
    if (!(await this.lockUser(tx, userId))) return this.logger.error(`Event ${eventId}: unknown user ${userId}`);
    // Defence beyond the event PK: one purchase per payment intent.
    if (await tx.creditLedger.findFirst({ where: { type: 'purchase', paymentIntentId } })) return;
    await tx.creditLedger.create({ data: { userId, type: 'purchase', amount, stripeEventId: eventId, paymentIntentId } });
    this.logger.log(`Purchase +${amount} credits for user ${userId} (event ${eventId})`);
  }

  private async refund(tx: Prisma.TransactionClient, eventId: string, charge: Stripe.Charge) {
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    const purchase = paymentIntentId ? await tx.creditLedger.findFirst({ where: { type: 'purchase', paymentIntentId } }) : null;
    if (!purchase || !paymentIntentId) {
      // Not from our Checkout (no metadata copied from payment_intent_data): nothing to revoke, don't make Stripe retry.
      if (!charge.metadata?.userId) return this.logger.warn(`Event ${eventId}: refund of a payment not from our Checkout, ignored`);
      // Out-of-order event: fail (rolls back the event row) so Stripe retries once the purchase exists.
      this.logger.warn(`Event ${eventId}: refund before its purchase, asking Stripe to retry`);
      throw new HttpException('Purchase not found', 500);
    }
    await this.lockUser(tx, purchase.userId);
    const { _sum } = await tx.creditLedger.aggregate({ where: { type: 'revoke', paymentIntentId }, _sum: { amount: true } });
    // Cumulative: proportional share of everything refunded so far, minus what earlier events already revoked.
    const target = charge.amount > 0 ? Math.round((purchase.amount * charge.amount_refunded) / charge.amount) : 0;
    const toRevoke = target - Math.abs(_sum.amount ?? 0);
    if (toRevoke <= 0) return;
    await tx.creditLedger.create({ data: { userId: purchase.userId, type: 'revoke', amount: -toRevoke, stripeEventId: eventId, paymentIntentId } });
    this.logger.log(`Revoked ${toRevoke} credits for user ${purchase.userId} (event ${eventId})`);
  }
}
