import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateJobDto } from './jobs.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(SessionGuard)
export class JobsController {
  constructor(private jobs: JobsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/download')
  download(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Query('format') format: string) {
    return this.jobs.downloadUrl(user, id, format);
  }
}
