import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { config } from '../config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleController } from './google.controller';
import { GoogleStrategy } from './google.strategy';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';

// Adding a provider (Apple in release 3) = one strategy + one controller registered here.
const google = config.google !== null;

@Module({
  imports: [PassportModule],
  controllers: [AuthController, ...(google ? [GoogleController] : [])],
  providers: [AuthService, MailService, SessionGuard, ...(google ? [GoogleStrategy] : [])],
  exports: [AuthService, MailService, SessionGuard],
})
export class AuthModule {}
