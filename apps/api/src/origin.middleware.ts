import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF defence together with SameSite=Lax cookies: state-changing requests must come from our web app.
export function originCheck(allowed: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || req.headers.origin === allowed) return next();
    res.status(403).json({ message: 'Bad origin' });
  };
}
