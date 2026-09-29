import { Body, Controller, Delete, Get, Header, HttpCode, Logger, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { Response } from 'express';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateJobDto, ListJobsDto } from './jobs.dto';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(SessionGuard)
export class JobsController {
  private logger = new Logger(JobsController.name);

  constructor(private jobs: JobsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateJobDto) {
    return this.jobs.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: User, @Query() query: ListJobsDto) {
    return this.jobs.list(user, query);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/content')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  content(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.content(id, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.remove(user, id);
  }

  @Get(':id/download')
  download(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Query('format') format: string) {
    return this.jobs.downloadUrl(id, format, user.id);
  }

  // ponytail: one DB poll every 2 s per open stream; switch to LISTEN/NOTIFY if many viewers watch at once.
  @Get(':id/events')
  async events(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const first = await this.jobs.get(user, id); // throws 404 before any header is sent
    this.logger.debug(`SSE opened: job ${id}`);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    let last = '';
    const send = (job: typeof first) => {
      const data = JSON.stringify(job);
      if (data !== last) res.write(`data: ${data}\n\n`);
      last = data;
      return job.status === 'done' || job.status === 'failed';
    };
    res.on('close', () => this.logger.debug(`SSE closed: job ${id}`));
    if (send(first)) return res.end();
    const timer = setInterval(async () => {
      try {
        if (send(await this.jobs.get(user, id))) {
          clearInterval(timer);
          res.end();
        }
      } catch (e) {
        this.logger.warn(`SSE poll failed: job ${id}: ${(e as Error).message}`);
        clearInterval(timer);
        res.end();
      }
    }, 2000);
    res.on('close', () => clearInterval(timer));
  }
}
