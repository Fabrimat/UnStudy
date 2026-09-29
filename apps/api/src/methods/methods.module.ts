import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MethodsController } from './methods.controller';
import { MethodsService } from './methods.service';

@Module({ imports: [AuthModule], controllers: [MethodsController], providers: [MethodsService] })
export class MethodsModule {}
