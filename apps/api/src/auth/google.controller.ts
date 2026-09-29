import { Controller, Get, Logger, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from '@summarize/db';
import { Request, Response } from 'express';
import { config } from '../config';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';

@Controller('auth/google')
export class GoogleController {
  private logger = new Logger(GoogleController.name);

  constructor(private auth: AuthService) {}

  @Get()
  @UseGuards(AuthGuard('google'))
  start() {
    // passport redirects to Google
  }

  @Get('callback')
  @UseGuards(AuthGuard('google'))
  async callback(@Req() req: Request, @Res() res: Response) {
    const user = req.user as User;
    res.cookie(SESSION_COOKIE, await this.auth.createSession(user.id), cookieOptions);
    this.logger.log(`Login succeeded (google): user ${user.id}`);
    res.redirect(`${config.webOrigin}/`);
  }
}
