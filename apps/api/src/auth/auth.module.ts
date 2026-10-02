import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { config } from '../config';
import { StorageModule } from '../storage/storage.module';
import { AccountService } from './account.service';
import { AppleController } from './apple.controller';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailTemplatesService } from './email-templates.service';
import { GoogleController } from './google.controller';
import { GoogleStrategy } from './google.strategy';
import { LegalController } from './legal.controller';
import { LegalService } from './legal.service';
import { MailService } from './mail.service';
import { SessionGuard } from './session.guard';

// Adding a provider = one strategy + one controller registered here.
const google = config.google !== null;
const apple = config.apple !== null;

@Module({
  imports: [PassportModule, StorageModule],
  controllers: [AuthController, LegalController, ...(google ? [GoogleController] : []), ...(apple ? [AppleController] : [])],
  providers: [AuthService, AccountService, MailService, EmailTemplatesService, LegalService, SessionGuard, ...(google ? [GoogleStrategy] : [])],
  exports: [AuthService, AccountService, MailService, EmailTemplatesService, LegalService, SessionGuard],
})
export class AuthModule {}
