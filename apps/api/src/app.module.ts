import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { CreditsModule } from './credits/credits.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health.controller';
import { JobsModule } from './jobs/jobs.module';
import { MeController } from './me.controller';
import { PrismaModule } from './prisma.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    CreditsModule,
    DocumentsModule,
    JobsModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
  ],
  controllers: [HealthController, MeController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
