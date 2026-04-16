import type { Request, Response, NextFunction } from 'express';
import { recordRequest } from '../monitoring/metrics';

export function httpMetrics(_req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    recordRequest(Date.now() - start, res.statusCode);
  });
  next();
}
