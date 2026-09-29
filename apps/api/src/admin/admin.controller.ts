import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser } from '../auth/session.guard';
import { AdminGuard } from './admin.guard';
import { CreateBenchmarkDto, CreateModelDto, ListBenchmarksDto, ModelOrderDto, RenameBenchmarkDto, UpdateModelDto } from './admin.dto';
import { BenchmarksService } from './benchmarks.service';
import { ModelsAdminService } from './models.service';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private benchmarks: BenchmarksService, private catalog: ModelsAdminService) {}

  @Get('models')
  models() {
    return this.catalog.list();
  }

  @Post('models')
  createModel(@CurrentUser() user: User, @Body() dto: CreateModelDto) {
    return this.catalog.create(user, dto);
  }

  // before :id so "order" is never read as an id
  @Post('models/order')
  @HttpCode(200)
  orderModels(@CurrentUser() user: User, @Body() dto: ModelOrderDto) {
    return this.catalog.order(user, dto.ids);
  }

  @Patch('models/:id')
  updateModel(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateModelDto) {
    return this.catalog.update(user, id, dto);
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

  @Patch('benchmarks/:id')
  rename(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameBenchmarkDto) {
    return this.benchmarks.rename(user, id, dto.name);
  }

  @Delete('benchmarks/:id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.benchmarks.remove(user, id);
  }
}
