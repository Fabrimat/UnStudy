import 'reflect-metadata';
import './config';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { setupApp } from './setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: config.logLevels, rawBody: true });
  setupApp(app);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  const al = config.stripe?.allowlist;
  const billing = !config.stripe ? 'off' : al ? `staging (${al.size} accounts)` : 'live';
  new Logger('Bootstrap').log(
    `Listening on ${port}, NODE_ENV=${process.env.NODE_ENV ?? 'development'}, mail=${config.resendApiKey ? 'resend' : 'smtp'}, billing=${billing}, LOG_LEVEL=${config.logLevel}`,
  );
}
bootstrap();
