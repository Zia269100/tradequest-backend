import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

export function publicCacheHint(_req: Request, res: Response, next: NextFunction): void {
  const sec = env().API_CACHE_PUBLIC_SEC;
  if (sec > 0) {
    res.setHeader('Cache-Control', `public, max-age=${sec}, stale-while-revalidate=${Math.min(sec, 60)}`);
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
