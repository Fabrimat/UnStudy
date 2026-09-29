import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CreditsModule } from './credits/credits.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health.controller';
import { JobsModule } from './jobs/jobs.module';
import { MethodsModule } from './methods/methods.module';
import { MeController } from './me.controller';
import { ModelsController } from './models.controller';
import { PrismaModule } from './prisma.module';

// apps/web/dist only exists after `pnpm --filter @summarize/web build`; served here so production is a single deployable.
const webDist = join(process.cwd(), '../web/dist');

@Module({
  imports: [
    PrismaModule,
    AdminModule,
    AuthModule,
    BillingModule,
    CreditsModule,
    DocumentsModule,
    JobsModule,
    MethodsModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ...(existsSync(webDist) ? [ServeStaticModule.forRoot({ rootPath: webDist, exclude: ['/api/{*path}'] })] : []),
  ],
  controllers: [HealthController, MeController, ModelsController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
