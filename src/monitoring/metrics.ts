import type { Request, Response } from 'express';
import { env } from '../config/env';

type Snapshot = { requests: number; errors: number; sumMs: number };

const snap: Snapshot = { requests: 0, errors: 0, sumMs: 0 };

export function recordRequest(durationMs: number, statusCode: number): void {
  snap.requests += 1;
  snap.sumMs += durationMs;
  if (statusCode >= 500) snap.errors += 1;
}

export function metricsHandler(_req: Request, res: Response): void {
  if (!env().METRICS_ENABLED) {
    res.status(404).json({ ok: false, error: { message: 'Not found' } });
    return;
  }
  const avg = snap.requests ? snap.sumMs / snap.requests : 0;
  res.json({
    ok: true,
    data: {
      requests_total: snap.requests,
      errors_5xx: snap.errors,
      avg_latency_ms: Math.round(avg * 100) / 100,
      uptime_sec: Math.round(process.uptime()),
      memory: process.memoryUsage(),
    },
  });
}
