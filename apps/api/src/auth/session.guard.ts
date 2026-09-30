import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User } from '@summarize/db';
import { CookieOptions } from 'express';
import { AuthService, SESSION_TTL_MS } from './auth.service';
import { LegalService } from './legal.service';

export const SESSION_COOKIE = 'sid';
export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: SESSION_TTL_MS,
  path: '/',
};

// Routes that stay reachable while the user still has legal documents to accept (/me, accept, ...).
export const AllowPendingLegal = () => SetMetadata('allowPendingLegal', true);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private auth: AuthService, private legal: LegalService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.auth.userForSession(req.cookies?.[SESSION_COOKIE]);
    if (!user) throw new UnauthorizedException();
    if (!this.reflector.getAllAndOverride<boolean>('allowPendingLegal', [ctx.getHandler(), ctx.getClass()]) && (await this.legal.pending(user.id)).length) {
      throw new ForbiddenException({ code: 'legal_acceptance_required' });
    }
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user as User);
