import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import { JobsModule } from '../jobs/jobs.module';
import { StorageModule } from '../storage/storage.module';
import { AdminDataController } from './admin-data.controller';
import { AdminUsersController } from './admin-users.controller';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { BenchmarksService } from './benchmarks.service';
import { DocumentsAdminService } from './documents.admin.service';
import { JobsAdminService } from './jobs.admin.service';
import { ModelsAdminService } from './models.service';
import { StatsService } from './stats.service';
import { UsersAdminService } from './users.service';

@Module({
  imports: [AuthModule, CreditsModule, JobsModule, StorageModule],
  controllers: [AdminController, AdminUsersController, AdminDataController],
  providers: [AdminGuard, BenchmarksService, ModelsAdminService, UsersAdminService, DocumentsAdminService, JobsAdminService, StatsService],
})
export class AdminModule {}
