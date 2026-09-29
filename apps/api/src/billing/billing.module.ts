import { Module } from '@nestjs/common';
import Stripe from 'stripe';
import { AuthModule } from '../auth/auth.module';
import { config } from '../config';
import { BillingController } from './billing.controller';
import { BillingService, STRIPE_CLIENT } from './billing.service';

@Module({
  imports: [AuthModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    // Injectable token so tests swap in a fake; null when billing is off.
    { provide: STRIPE_CLIENT, useFactory: () => (config.stripe ? new Stripe(config.stripe.secretKey) : null) },
  ],
})
export class BillingModule {}
