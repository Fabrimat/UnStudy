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
  new Logger('Bootstrap').log(
    `Listening on ${port}, NODE_ENV=${process.env.NODE_ENV ?? 'development'}, mail=${config.resendApiKey ? 'resend' : 'smtp'}, LOG_LEVEL=${config.logLevel}`,
  );
}
bootstrap();
