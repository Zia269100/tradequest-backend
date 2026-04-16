import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from '../logger';

let client: Redis | null = null;

export function redis(): Redis {
  if (!client) {
    client = new Redis(env().REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    client.on('error', (err) => logger.error({ err }, 'Redis error'));
  }
  return client;
}

export const cacheKeys = {
  quote: (symbol: string) => `quote:${symbol.toUpperCase()}`,
  leaderboard: 'leaderboard:snapshot',
  userTradesWindow: (userId: number, windowSec: number) =>
    `user:${userId}:trades:${windowSec}`,
  session: (jti: string) => `sess:refresh:${jti}`,
  recentBuys: (userId: number) => `user:${userId}:recent_buys`,
};
