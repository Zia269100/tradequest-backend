import { pool } from '../db/pool';
import { redis, cacheKeys } from '../redis/client';
import { getQuote } from './market.service';

type BehaviorKind = 'FOMO' | 'panic_sell' | 'disciplined_trade' | 'overtrade';

async function logBehavior(
  userId: number,
  action: BehaviorKind,
  confidence: number
): Promise<void> {
  await pool.query(
    `INSERT INTO behavior_logs (user_id, action_type, confidence_score, event_timestamp)
     VALUES ($1, $2::behavior_action_type, $3, now())`,
    [userId, action, confidence]
  );
}

/** Rolling trade count in Redis (sliding window approx via TTL bucket). */
async function incrTradesWindow(userId: number, windowSec: number): Promise<number> {
  const key = cacheKeys.userTradesWindow(userId, windowSec);
  const r = redis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, windowSec);
  return n;
}

export async function analyzeAfterTrade(
  userId: number,
  ctx: { side: 'buy' | 'sell'; symbol: string; quantity: number; panic?: boolean }
): Promise<void> {
  const quote = await getQuote(ctx.symbol);
  const sym = ctx.symbol.toUpperCase();
  const r = redis();

  const momentumKey = `mkt:${sym}:ret1m`;
  const prev = await r.get(momentumKey);
  let spikeUp = false;
  if (prev) {
    const before = Number(prev);
    if (Number.isFinite(before) && before > 0) {
      spikeUp = quote.price / before - 1 > 0.003;
    }
  }
  await r.set(momentumKey, String(quote.price), 'EX', 120);

  if (ctx.side === 'buy' && spikeUp) {
    await logBehavior(userId, 'FOMO', 0.72);
  }

  const trades1h = await incrTradesWindow(userId, 3600);
  if (trades1h >= 25) {
    await logBehavior(userId, 'overtrade', Math.min(0.95, 0.5 + trades1h / 200));
  }

  if (ctx.side === 'buy') {
    const openNoStop = await pool.query(
      `SELECT count(*)::int AS c FROM trades
       WHERE user_id = $1 AND status = 'open' AND stop_loss IS NULL`,
      [userId]
    );
    const c = Number(openNoStop.rows[0]?.c ?? 0);
    if (c >= 3) {
      await logBehavior(userId, 'FOMO', 0.55);
    }
  }

  if (ctx.side === 'sell' && ctx.panic) {
    await redis().incr(`user:${userId}:panic_window`);
    await redis().expire(`user:${userId}:panic_window`, 300);
    await logBehavior(userId, 'panic_sell', 0.68);
  }

  const disciplinedRoll = await pool.query(
    `SELECT COUNT(*)::int AS c FROM trades
     WHERE user_id = $1 AND status = 'open' AND stop_loss IS NOT NULL`,
    [userId]
  );
  if (Number(disciplinedRoll.rows[0]?.c ?? 0) >= 2 && ctx.side === 'buy') {
    await logBehavior(userId, 'disciplined_trade', 0.6);
  }
}
