import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { originCheck } from './origin.middleware';

export function setupApp(app: INestApplication) {
  app.getHttpAdapter().getInstance().set('trust proxy', 1); // real client IP behind the PaaS proxy (throttling)
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use(originCheck(config.webOrigin));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
}
