import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

export interface RequestContext {
  requestId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    ctx?: RequestContext;
  }
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string)?.trim() || randomUUID();
  req.ctx = { requestId: id };
  res.setHeader('X-Request-Id', id);
  next();
}
