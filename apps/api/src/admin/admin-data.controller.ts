import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser } from '../auth/session.guard';
import { AdminGuard } from './admin.guard';
import { ListAdminDocumentsDto, CreateLabPresetDto, ListAdminJobsDto, StatsQueryDto } from './admin.dto';
import { DocumentsAdminService } from './documents.admin.service';
import { JobsAdminService } from './jobs.admin.service';
import { LabPresetsService } from './lab-presets.service';
import { StatsService } from './stats.service';

// Read-only views over every user's documents and jobs, plus platform stats; saved Lab presets.
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminDataController {
  constructor(private documents: DocumentsAdminService, private jobs: JobsAdminService, private stats: StatsService, private labPresets: LabPresetsService) {}

  @Get('documents')
  listDocuments(@Query() q: ListAdminDocumentsDto) {
    return this.documents.list(q);
  }

  @Get('documents/:id')
  document(@Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(id);
  }

  @Get('documents/:id/file')
  documentFile(@CurrentUser() admin: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.fileUrl(admin, id);
  }

  @Get('jobs')
  listJobs(@Query() q: ListAdminJobsDto) {
    return this.jobs.list(q);
  }

  @Get('jobs/:id')
  job(@Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.get(id);
  }

  @Get('jobs/:id/content')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  jobContent(@CurrentUser() admin: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.jobs.content(admin, id);
  }

  @Get('jobs/:id/download')
  jobDownload(@CurrentUser() admin: User, @Param('id', ParseUUIDPipe) id: string, @Query('format') format: string) {
    return this.jobs.download(admin, id, format);
  }

  @Get('stats')
  getStats(@Query() q: StatsQueryDto) {
    return this.stats.get(q.days);
  }

  @Get('lab-presets')
  listLabPresets() {
    return this.labPresets.list();
  }

  @Post('lab-presets')
  createLabPreset(@Body() dto: CreateLabPresetDto) {
    return this.labPresets.create(dto);
  }

  @Delete('lab-presets/:id')
  @HttpCode(204)
  deleteLabPreset(@Param('id', ParseUUIDPipe) id: string) {
    return this.labPresets.remove(id);
  }
}
