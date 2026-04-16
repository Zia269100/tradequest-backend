import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../logger';
import { ZodError } from 'zod';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req as Request & { ctx?: { requestId: string } }).ctx?.requestId;

  if (err instanceof AppError) {
    res.status(err.status).json({
      ok: false,
      error: {
        code: err.code ?? 'ERROR',
        message: err.message,
        details: err.details,
        requestId,
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: err.flatten(),
        requestId,
      },
    });
    return;
  }

  logger.error({ err, requestId }, 'Unhandled error');
  res.status(500).json({
    ok: false,
    error: { code: 'INTERNAL', message: 'Internal server error', requestId },
  });
}
