import { Controller, Get, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from './auth/session.guard';

@Controller('me')
@UseGuards(SessionGuard)
export class MeController {
  @Get()
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name };
  }
}
