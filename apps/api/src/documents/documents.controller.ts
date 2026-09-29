import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateDocumentDto, ListDocumentsDto, RenameDocumentDto } from './documents.dto';
import { DocumentsService } from './documents.service';

@Controller('documents')
@UseGuards(SessionGuard)
export class DocumentsController {
  constructor(private documents: DocumentsService) {}

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateDocumentDto) {
    return this.documents.create(user, dto.filename, dto.sizeBytes);
  }

  @Post(':id/uploaded')
  confirm(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.confirmUpload(user, id);
  }

  @Get()
  list(@CurrentUser() user: User, @Query() query: ListDocumentsDto) {
    return this.documents.list(user, query);
  }

  @Patch(':id')
  rename(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameDocumentDto) {
    return this.documents.rename(user, id, dto.filename);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.remove(user, id);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(user, id);
  }
}
