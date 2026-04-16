import { pool } from '../db/pool';
import { redis, cacheKeys } from '../redis/client';
import { env } from '../config/env';
import { getQuote } from './market.service';
import { dec, fmt } from '../utils/numeric';

export type LeaderboardRow = {
  userId: number;
  username: string;
  rank: number;
  roi: number;
  winRate: number;
  consistency: number;
  equity: number;
};

async function portfolioMarkToMarket(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT asset_symbol, quantity::text FROM portfolio WHERE user_id = $1`,
    [userId]
  );
  let v = 0;
  for (const r of rows) {
    const q = await getQuote(String(r.asset_symbol));
    v += dec(r.quantity as string) * q.price;
  }
  return v;
}

export async function computeLeaderboard(): Promise<LeaderboardRow[]> {
  // equity_baseline is not in the schema — use STARTING_BALANCE from config as baseline
  const baseline = env().STARTING_BALANCE;

  const { rows: users } = await pool.query(
    `SELECT id, username FROM users`
  );

  const stats: Omit<LeaderboardRow, 'rank'>[] = [];

  for (const u of users) {
    const userId = Number(u.id);
    const w = await pool.query(
      `SELECT balance::text FROM wallets WHERE user_id = $1`,
      [userId]
    );
    const cash = w.rows[0] ? dec(w.rows[0].balance as string) : 0;
    const posVal = await portfolioMarkToMarket(userId);
    const equity = cash + posVal;
    const roi = baseline > 0 ? (equity - baseline) / baseline : 0;

    const wrq = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE exit_price > entry_price)::int AS wins
       FROM trades
       WHERE user_id = $1 AND status = 'closed' AND order_type = 'buy'`,
      [userId]
    );
    const total = Number(wrq.rows[0]?.total ?? 0);
    const wins = Number(wrq.rows[0]?.wins ?? 0);
    const winRate = total > 0 ? wins / total : 0;

    const cr = await pool.query(
      `SELECT stddev_pop(x) AS s FROM (
         SELECT (exit_price::float8 / entry_price::float8 - 1) AS x
         FROM trades
         WHERE user_id = $1 AND status = 'closed' AND order_type = 'buy'
         ORDER BY trade_timestamp DESC
         LIMIT 50
       ) t`,
      [userId]
    );
    const sd = Number(cr.rows[0]?.s ?? 0);
    const consistency = Math.max(0, Math.min(1, 1 - Math.min(1, sd * 4)));

    stats.push({
      userId,
      username: String(u.username),
      roi,
      winRate,
      consistency,
      equity,
    });
  }

  stats.sort((a, b) => b.roi - a.roi);
  return stats.map((s, i) => ({ ...s, rank: i + 1 }));
}

export async function persistLeaderboard(rows: LeaderboardRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM leaderboard`);
    for (const r of rows) {
      // Clamp values to schema CHECK constraints: win_rate and consistency_score BETWEEN 0 AND 1
      const winRate = Math.max(0, Math.min(1, r.winRate));
      const consistency = Math.max(0, Math.min(1, r.consistency));
      await client.query(
        `INSERT INTO leaderboard (user_id, rank, roi, win_rate, consistency_score, computed_at)
         VALUES ($1,$2,$3::numeric,$4::numeric,$5::numeric, now())`,
        [r.userId, r.rank, fmt(r.roi), fmt(winRate), fmt(consistency)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getLeaderboardCached(limit = 100): Promise<LeaderboardRow[]> {
  const r = redis();
  const raw = await r.get(cacheKeys.leaderboard);
  if (raw) {
    try {
      return (JSON.parse(raw) as LeaderboardRow[]).slice(0, limit);
    } catch {
      /* fallthrough */
    }
  }

  const { rows } = await pool.query(
    `SELECT l.user_id, u.username, l.rank, l.roi::float8, l.win_rate::float8,
            l.consistency_score::float8,
            w.balance::text
     FROM leaderboard l
     JOIN users u ON u.id = l.user_id
     JOIN wallets w ON w.user_id = l.user_id
     ORDER BY l.rank ASC
     LIMIT $1`,
    [limit]
  );

  if (rows.length === 0) {
    const computed = await computeLeaderboard();
    await persistLeaderboard(computed);
    const slice = computed.slice(0, limit);
    await r.set(cacheKeys.leaderboard, JSON.stringify(slice), 'EX', env().CACHE_LEADERBOARD_TTL_SEC);
    return slice;
  }

  const mapped: LeaderboardRow[] = [];
  for (const row of rows) {
    const userId = Number(row.user_id);
    const posVal = await portfolioMarkToMarket(userId);
    const cash = dec(row.balance as string);
    mapped.push({
      userId,
      username: String(row.username),
      rank: Number(row.rank),
      roi: Number(row.roi),
      winRate: Number(row.win_rate),
      consistency: Number(row.consistency_score),
      equity: cash + posVal,
    });
  }
  await r.set(cacheKeys.leaderboard, JSON.stringify(mapped), 'EX', env().CACHE_LEADERBOARD_TTL_SEC);
  return mapped;
}

export async function refreshLeaderboardJob(): Promise<void> {
  const rows = await computeLeaderboard();
  await persistLeaderboard(rows);
  const top = rows.slice(0, 100);
  await redis().set(
    cacheKeys.leaderboard,
    JSON.stringify(top),
    'EX',
    env().CACHE_LEADERBOARD_TTL_SEC
  );
}
