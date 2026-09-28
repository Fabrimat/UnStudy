import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({ imports: [AuthModule, StorageModule], controllers: [DocumentsController], providers: [DocumentsService] })
export class DocumentsModule {}
