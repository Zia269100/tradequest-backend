import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env } from '../config/env';
import { redis } from '../redis/client';

const isProd = env().NODE_ENV === 'production';

function redisStore(prefix: string): RedisStore {
  return new RedisStore({
    // rate-limit-redis v4 sendCommand signature: (command, ...args) => Promise<unknown>
    sendCommand: (...args: string[]) => {
      const [command, ...commandArgs] = args;
      return redis().call(command, commandArgs) as Promise<number>;
    },
    prefix,
  });
}

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 20 : 80,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:auth:'),
  message: { ok: false, error: { code: 'RATE_LIMIT', message: 'Too many auth attempts' } },
});

export const writeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 45 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:write:'),
  message: { ok: false, error: { code: 'RATE_LIMIT', message: 'Too many write requests' } },
});

export const apiReadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: isProd ? 200 : 400,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:read:'),
  message: { ok: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
});
