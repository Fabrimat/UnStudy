import { timingSafeEqual } from 'node:crypto';
import { CookieOptions, Request } from 'express';
import { randomToken } from './tokens';

type StoreCallback = (err: Error | null, state?: string) => void;
type VerifyCallback = (err: Error | null, ok: boolean, info?: { message: string }) => void;

// A stateless (no express-session) CSRF-binding store for passport-oauth2's `store` strategy option.
// passport-oauth2 calls store()/verify() with a varying number of args depending on its own feature
// flags (PKCE, per-call metadata); the callback is always the last one, so we take it positionally
// instead of hard-coding an arity.
export function cookieStateStore(cookieName: string, path: string) {
  const options: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 10 * 60_000,
    path,
  };

  return {
    store(req: Request, ...args: unknown[]) {
      const callback = args[args.length - 1] as StoreCallback;
      const state = randomToken();
      req.res!.cookie(cookieName, state, options);
      callback(null, state);
    },

    verify(req: Request, state: string, ...args: unknown[]) {
      const callback = args[args.length - 1] as VerifyCallback;
      const cookieValue: string | undefined = req.cookies?.[cookieName];
      req.res!.clearCookie(cookieName, { path });

      const a = Buffer.from(cookieValue ?? '');
      const b = Buffer.from(state ?? '');
      if (!cookieValue || a.length !== b.length || !timingSafeEqual(a, b)) {
        return callback(null, false, { message: 'Invalid OAuth state' });
      }
      callback(null, true);
    },
  };
}
