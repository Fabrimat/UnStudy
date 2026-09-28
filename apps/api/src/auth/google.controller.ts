import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { User } from '@summarize/db';
import { Request, Response } from 'express';
import { config } from '../config';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';

@Controller('auth/google')
export class GoogleController {
  constructor(private auth: AuthService) {}

  @Get()
  @UseGuards(AuthGuard('google'))
  start() {
    // passport redirects to Google
  }

  @Get('callback')
  @UseGuards(AuthGuard('google'))
  async callback(@Req() req: Request, @Res() res: Response) {
    res.cookie(SESSION_COOKIE, await this.auth.createSession((req.user as User).id), cookieOptions);
    res.redirect(`${config.webOrigin}/`);
  }
}
