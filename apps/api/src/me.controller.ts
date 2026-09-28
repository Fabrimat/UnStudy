import { Controller, Get, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from './auth/session.guard';
import { LedgerService } from './credits/ledger.service';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  constructor(private ledger: LedgerService) {}

  @Get()
  async me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name, balance: await this.ledger.balance(user.id) };
  }
}
