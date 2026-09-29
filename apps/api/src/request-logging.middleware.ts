import { Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

const logger = new Logger('HTTP');

// One line per request under /api (method, path without query string, status, duration).
// SSE streams (jobs.controller logs those itself) and static web files (outside /api) are excluded.
export function requestLogging(req: Request, res: Response, next: NextFunction) {
  if (!(req.path === '/api' || req.path.startsWith('/api/')) || req.path.endsWith('/events')) return next();
  const start = Date.now();
  res.on('close', () => {
    const level = req.path === '/api/health' ? 'debug' : 'log';
    logger[level](`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
}
