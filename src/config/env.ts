import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('tradequest-api'),
  JWT_AUDIENCE: z.string().min(1).default('tradequest-clients'),
  JWT_ACCESS_TTL_SEC: z.coerce.number().default(900),
  JWT_REFRESH_TTL_SEC: z.coerce.number().default(604_800),
  STARTING_BALANCE: z.coerce.number().default(100_000),
  MARKET_TICK_MS: z.coerce.number().default(2000),
  MARKET_SYMBOLS: z.string().default('AAPL,MSFT,GOOG'),
  LEADERBOARD_REFRESH_SEC: z.coerce.number().default(60),
  CACHE_LEADERBOARD_TTL_SEC: z.coerce.number().default(55),
  CACHE_QUOTE_TTL_SEC: z.coerce.number().default(30),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /** Express trust proxy hops (0 = disabled; use 1 behind single reverse proxy) */
  TRUST_PROXY: z.coerce.number().min(0).max(5).default(0),
  /** When true and trust proxy set, require X-Forwarded-Proto=https in production */
  ENFORCE_HTTPS: z.coerce.boolean().default(false),
  BODY_LIMIT_KB: z.coerce.number().min(16).max(2048).default(256),
  /** Public cache hint for safe GET endpoints (seconds) */
  API_CACHE_PUBLIC_SEC: z.coerce.number().min(0).default(15),
  METRICS_ENABLED: z.coerce.boolean().default(false),
  /** Optional: Sentry-compatible DSN (disabled if empty) */
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function marketSymbolList(): string[] {
  return env()
    .MARKET_SYMBOLS.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}
