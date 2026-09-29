import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateMethodDto, UpdateMethodDto } from './methods.dto';
import { MethodsService } from './methods.service';

@Controller('methods')
@UseGuards(SessionGuard)
export class MethodsController {
  constructor(private methods: MethodsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.methods.list(user);
  }

  @Get('presets')
  presets() {
    return this.methods.presets;
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateMethodDto) {
    return this.methods.create(user, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMethodDto) {
    return this.methods.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.methods.remove(user, id);
  }
}
