import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { MagicLinkDto, VerifyDto } from './auth.dto';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('magic-link')
  @HttpCode(204)
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
