import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser } from '../auth/session.guard';
import { AdminGuard } from './admin.guard';
import { CreditsDto, ListUsersDto } from './admin.dto';
import { UsersAdminService } from './users.service';

@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private users: UsersAdminService) {}

  @Get()
  list(@Query() q: ListUsersDto) {
    return this.users.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Post(':id/credits')
  credits(@CurrentUser() admin: User, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreditsDto) {
    return this.users.adjustCredits(admin, id, dto);
  }
}
