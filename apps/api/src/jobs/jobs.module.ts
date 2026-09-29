import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { StorageModule } from '../storage/storage.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';

@Module({ imports: [AuthModule, CreditsModule, StorageModule], controllers: [JobsController], providers: [JobsService], exports: [JobsService] })
export class JobsModule {}
