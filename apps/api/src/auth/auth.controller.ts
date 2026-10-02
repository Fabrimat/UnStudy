import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { config } from '../config';
import { MagicLinkDto, VerifyDto } from './auth.dto';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';

// Fair to shared campus/office IPs (spec §6 asks for a per-email AND per-IP limit; the per-email
// limit of 5/hour already lives in AuthService, this is the IP side of it).
const MAGIC_LINKS_PER_IP_PER_HOUR = 30;

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get('providers')
  providers() {
    return { google: config.google !== null, apple: config.apple !== null };
  }

  @Post('magic-link')
  @HttpCode(204)
  @Throttle({ default: { limit: MAGIC_LINKS_PER_IP_PER_HOUR, ttl: 3_600_000 } })
  async requestLink(@Body() dto: MagicLinkDto) {
    await this.auth.requestMagicLink(dto.email);
  }

  @Post('magic-link/verify')
  @HttpCode(204)
  async verify(@Body() dto: VerifyDto, @Res({ passthrough: true }) res: Response) {
    res.cookie(SESSION_COOKIE, await this.auth.verifyMagicLink(dto.token), cookieOptions);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}
