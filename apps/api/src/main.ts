import 'reflect-metadata';
import './config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { setupApp } from './setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  setupApp(app);
  await app.listen(Number(process.env.PORT ?? 3000));
}
bootstrap();
