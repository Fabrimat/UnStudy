import { Controller, Get, Logger, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { CookieOptions, Request, Response } from 'express';
import { config } from '../config';
import { AppleIdentity, AppleKey, appleClientSecret, APPLE_ISS, verifyAppleIdToken } from './apple';
import { AuthService } from './auth.service';
import { cookieOptions, SESSION_COOKIE } from './session.guard';
import { randomToken } from './tokens';

const PATH = '/api/auth/apple/callback';
const STATE = 'apple_state';
const NONCE = 'apple_nonce';
const JWKS_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
const LIMIT = { default: { limit: 30, ttl: 3_600_000 } };

@Controller('auth/apple')
export class AppleController {
  private logger = new Logger(AppleController.name);
  private jwks: { keys: AppleKey[]; at: number } | null = null;

  constructor(private auth: AuthService) {}

  // Apple POSTs the callback cross-site, so Lax cookies would not be sent back.
  private stateCookie(): CookieOptions {
    const prod = process.env.NODE_ENV === 'production';
    return { httpOnly: true, secure: prod, sameSite: prod ? 'none' : 'lax', maxAge: 10 * 60_000, path: PATH };
  }

  @Get()
  @Throttle(LIMIT)
  start(@Res() res: Response) {
    const state = randomToken();
    const nonce = randomToken();
    res.cookie(STATE, state, this.stateCookie());
    res.cookie(NONCE, nonce, this.stateCookie());
    const q = new URLSearchParams({
      response_type: 'code',
      response_mode: 'form_post',
      scope: 'name email',
      client_id: config.apple!.clientId,
      redirect_uri: config.apple!.callbackUrl,
      state,
      nonce,
    });
    res.redirect(`${APPLE_ISS}/auth/authorize?${q}`);
  }

  @Post('callback')
  @Throttle(LIMIT)
  async callback(@Req() req: Request, @Res() res: Response) {
    const fail = (why: string) => {
      this.logger.warn(`Login failed (apple): ${why}`);
      res.redirect(`${config.webOrigin}/login?error=apple`);
    };
    const cookieState: string | undefined = req.cookies?.[STATE];
    const nonce: string | undefined = req.cookies?.[NONCE];
    res.clearCookie(STATE, { path: PATH });
    res.clearCookie(NONCE, { path: PATH });
    const { state, code } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof state !== 'string' || typeof code !== 'string' || !cookieState || !nonce) return fail('missing state or code');
    const a = Buffer.from(cookieState);
    const b = Buffer.from(state);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return fail('state mismatch');
    try {
      const apple = config.apple!;
      const tokenRes = await fetch(`${APPLE_ISS}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: apple.callbackUrl,
          client_id: apple.clientId,
          client_secret: appleClientSecret(apple),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!tokenRes.ok) return fail(`token exchange ${tokenRes.status}`);
      const idToken = ((await tokenRes.json()) as { id_token?: string }).id_token;
      if (!idToken) return fail('no id_token');
      const expect = { clientId: apple.clientId, nonce };
      let id: AppleIdentity;
      try {
        id = verifyAppleIdToken(idToken, await this.keys(false), expect);
      } catch (e) {
        if ((e as Error).message !== 'unknown kid') throw e;
        id = verifyAppleIdToken(idToken, await this.keys(true), expect);
      }
      const user = await this.auth.loginWithProvider('apple', id.sub, id.email, id.emailVerified);
      res.cookie(SESSION_COOKIE, await this.auth.createSession(user.id), cookieOptions);
      this.logger.log(`Login succeeded (apple): user ${user.id}`);
      res.redirect(`${config.webOrigin}/`);
    } catch (e) {
      fail((e as Error).message);
    }
  }

  private async keys(refresh: boolean): Promise<AppleKey[]> {
    if (!refresh && this.jwks && Date.now() - this.jwks.at < JWKS_TTL_MS) return this.jwks.keys;
    const r = await fetch(`${APPLE_ISS}/auth/keys`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) throw new Error(`jwks ${r.status}`);
    this.jwks = { keys: ((await r.json()) as { keys: AppleKey[] }).keys, at: Date.now() };
    return this.jwks.keys;
  }
}
