import type { Request, Response, NextFunction } from 'express';
import jwt, { type JwtPayload as LibJwtPayload, type VerifyOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedError } from '../utils/errors';

export type JwtPayload = { sub: string; username: string; typ: 'access' | 'refresh' };

export interface AuthRequest extends Request {
  user?: { id: number; username: string };
}

const verifyOpts: VerifyOptions = {
  algorithms: ['HS256'],
  issuer: env().JWT_ISSUER,
  audience: env().JWT_AUDIENCE,
};

export function requireAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedError('Missing bearer token');

    const decoded = jwt.verify(token, env().JWT_ACCESS_SECRET, verifyOpts) as LibJwtPayload &
      JwtPayload;
    if (decoded.typ !== 'access') throw new UnauthorizedError('Invalid token type');

    const id = Number(decoded.sub);
    if (!Number.isFinite(id)) throw new UnauthorizedError('Invalid subject');

    req.user = { id, username: decoded.username };
    next();
  } catch {
    next(new UnauthorizedError('Invalid or expired token'));
  }
}
