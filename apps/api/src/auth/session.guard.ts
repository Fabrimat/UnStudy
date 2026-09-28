import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { User } from '@summarize/db';
import { CookieOptions } from 'express';
import { AuthService, SESSION_TTL_MS } from './auth.service';

export const SESSION_COOKIE = 'sid';
export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: SESSION_TTL_MS,
  path: '/',
};

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private auth: AuthService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.auth.userForSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as User);
