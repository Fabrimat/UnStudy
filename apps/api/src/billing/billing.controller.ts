import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, RawBodyRequest, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { User } from '@summarize/db';
import { Request } from 'express';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CheckoutDto } from './billing.dto';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private billing: BillingService) {}

  @Get('packs')
  @UseGuards(SessionGuard)
  packs() {
    return this.billing.packs();
  }

  @Post('checkout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  checkout(@CurrentUser() user: User, @Body() dto: CheckoutDto) {
    return this.billing.checkout(user, dto.packId);
  }

  // Authenticated by the Stripe signature, not by session/origin/throttle.
  @Post('webhook')
  @HttpCode(200)
  @SkipThrottle()
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    if (!this.billing.enabled) throw new ServiceUnavailableException('Billing is disabled');
    if (!signature || !req.rawBody) throw new BadRequestException('Missing signature');
    await this.billing.handleWebhook(req.rawBody, signature);
    return { received: true };
  }
}
