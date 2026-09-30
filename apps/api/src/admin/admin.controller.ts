import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import type { Response } from 'express';
import { CurrentUser } from '../auth/session.guard';
import { AdminGuard } from './admin.guard';
import { CreateBenchmarkDto, CreateModelDto, CreateProviderDto, ListBenchmarksDto, ModelOrderDto, RenameBenchmarkDto, UpdateModelDto, UpdateProviderDto } from './admin.dto';
import { BenchmarksService } from './benchmarks.service';
import { ModelsAdminService } from './models.service';
import { ProvidersAdminService } from './providers.service';

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private benchmarks: BenchmarksService, private catalog: ModelsAdminService, private providers: ProvidersAdminService) {}

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

  @Get('providers')
  listProviders() {
    return this.providers.list();
  }

  @Post('providers')
  createProvider(@CurrentUser() user: User, @Body() dto: CreateProviderDto) {
    return this.providers.create(user, dto);
  }

  @Patch('providers/:id')
  updateProvider(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateProviderDto) {
    return this.providers.update(user, id, dto);
  }

  @Delete('providers/:id')
  @HttpCode(204)
  removeProvider(@CurrentUser() user: User, @Param('id') id: string) {
    return this.providers.remove(user, id);
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

  @Get('benchmarks/:id/zip')
  async zip(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { filename, data } = await this.benchmarks.zip(user, id);
    res.type('application/zip').attachment(filename).send(data);
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
