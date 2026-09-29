-- One purchase per Stripe payment intent, enforced by the DB (the webhook also checks under a row lock).
-- Partial index: Prisma can't express it in schema.prisma, so it lives only here.
CREATE UNIQUE INDEX "CreditLedger_purchase_paymentIntentId_key" ON "CreditLedger"("paymentIntentId") WHERE type = 'purchase';
