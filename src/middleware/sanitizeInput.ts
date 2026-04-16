import type { Request, Response, NextFunction } from 'express';

const MAX_DEPTH = 8;
const MAX_STRING = 12_000;

function sanitizeValue(v: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    let s = v.replace(/\u0000/g, '').trim();
    if (s.length > MAX_STRING) s = s.slice(0, MAX_STRING);
    return s;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, depth + 1)).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      const next = sanitizeValue(val, depth + 1);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return undefined;
}

/** Defense in depth: trim strings, drop prototype pollution keys, cap size (JSON body XSS is client concern; this limits abuse). */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    req.body = sanitizeValue(req.body, 0) as Request['body'];
  }
  next();
}
