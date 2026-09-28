import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, MailService, SessionGuard],
  exports: [AuthService, MailService, SessionGuard],
})
export class AuthModule {}
