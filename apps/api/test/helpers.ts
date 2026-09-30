import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { invalidateCatalog } from '../src/catalog/catalog.service';
import { PrismaService } from '../src/prisma.service';
import { setupApp } from '../src/setup';

export const ORIGIN = 'http://localhost:5173';

export async function createApp(customize: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b) {
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] })).compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  setupApp(app);
  await app.init();
  return app;
}

export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "CreditLedger", "StripeEvent", "ModelPreset", "LlmProvider", "ProviderKeyStatus", "Job", "Benchmark", "Document", "Session", "AuthAccount", "MagicLinkToken", "User" CASCADE',
  );
  invalidateCatalog(); // the 5 s catalog cache must not outlive the truncated table
}

export async function loginAs(app: INestApplication, email: string) {
  const auth = app.get(AuthService);
  const user = await auth.loginWithProvider('email', email, email, true);
  return { user, cookie: `sid=${await auth.createSession(user.id)}` };
}
