import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser } from '../auth/session.guard';
import { config } from '../config';
import { AdminGuard } from './admin.guard';
import { CreateBenchmarkDto, ListBenchmarksDto } from './admin.dto';
import { BenchmarksService } from './benchmarks.service';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private benchmarks: BenchmarksService) {}

  // Never includes apiKeyEnv or any key.
  @Get('models')
  models() {
    return {
      providers: config.providers.map(({ id, kind, baseUrl }) => ({ id, kind, baseUrl })),
      models: config.models.map(({ id, label, provider, model, multiplier, temperature, priceIn, priceOut, adminOnly }) => ({
        id, label, provider, model, multiplier, temperature, priceIn: priceIn ?? null, priceOut: priceOut ?? null, adminOnly,
      })),
    };
  }

  @Post('benchmarks')
  create(@CurrentUser() user: User, @Body() dto: CreateBenchmarkDto) {
    return this.benchmarks.create(user, dto);
  }

  @Get('benchmarks')
  list(@CurrentUser() user: User, @Query() q: ListBenchmarksDto) {
    return this.benchmarks.list(user, q);
  }

  @Get('benchmarks/:id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.benchmarks.get(user, id);
  }

  @Delete('benchmarks/:id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.benchmarks.remove(user, id);
  }
}
