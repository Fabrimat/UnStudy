import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { AdminController } from './admin.controller';
import { AdminGuard } from './admin.guard';
import { BenchmarksService } from './benchmarks.service';

@Module({ imports: [AuthModule, StorageModule], controllers: [AdminController], providers: [AdminGuard, BenchmarksService] })
export class AdminModule {}
