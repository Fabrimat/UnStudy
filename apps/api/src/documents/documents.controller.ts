import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { User } from '@summarize/db';
import { CurrentUser, SessionGuard } from '../auth/session.guard';
import { CreateDocumentDto } from './documents.dto';
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
  list(@CurrentUser() user: User) {
    return this.documents.list(user);
  }

  @Get(':id')
  get(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(user, id);
  }
}
