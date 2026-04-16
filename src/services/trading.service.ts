import { pool, type DbClient } from '../db/pool';
import { getQuote } from './market.service';
import { AppError, ValidationError } from '../utils/errors';
import { dec, fmt } from '../utils/numeric';
import { redis, cacheKeys } from '../redis/client';
import { env } from '../config/env';
import { analyzeAfterTrade } from './behavior.service';
import { bumpMissionProgress } from './mission.service';

export type OrderSide = 'buy' | 'sell';
export type ApiOrderKind = 'market' | 'limit' | 'stop';

async function invalidateLeaderboardCache(): Promise<void> {
  await redis().del(cacheKeys.leaderboard);
}

async function getWallet(client: DbClient, userId: number, forUpdate = false): Promise<number> {
  const q = await client.query(
    `SELECT balance::text FROM wallets WHERE user_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId]
  );
  return q.rows[0] ? dec(q.rows[0].balance as string) : 0;
}

async function getPortfolioRow(
  client: DbClient,
  userId: number,
  symbol: string,
  forUpdate = false
) {
  const q = await client.query(
    `SELECT quantity::text, avg_price::text
     FROM portfolio WHERE user_id = $1 AND asset_symbol = $2 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId, symbol]
  );
  return q.rows[0]
    ? {
        quantity: dec(q.rows[0].quantity as string),
        avgPrice: dec(q.rows[0].avg_price as string),
      }
    : null;
}

export async function placeOrder(input: {
  userId: number;
  symbol: string;
  side: OrderSide;
  kind: ApiOrderKind;
  quantity: number;
  limitPrice?: number;
  stopTriggerPrice?: number;
  stopLoss?: number | null;
}): Promise<
  | { mode: 'queued'; orderId: number }
  | { mode: 'executed'; tradeIds: number[]; message: string }
> {
  const { userId, symbol, side, kind, quantity, limitPrice, stopTriggerPrice, stopLoss } = input;

  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new ValidationError('quantity must be positive');
  }
  const sym = symbol.toUpperCase();

  if (kind === 'limit') {
    if (!limitPrice || limitPrice <= 0) {
      throw new ValidationError('limitPrice required for limit orders');
    }
    const r = await pool.query(
      `INSERT INTO pending_orders
        (user_id, asset_symbol, side, class, quantity, limit_price, stop_trigger_price, status)
       VALUES ($1,$2,$3,'limit',$4,$5,NULL,'open')
       RETURNING id`,
      [userId, sym, side, fmt(quantity), fmt(limitPrice)]
    );
    return { mode: 'queued', orderId: Number(r.rows[0].id) };
  }

  if (kind === 'stop') {
    if (!stopTriggerPrice || stopTriggerPrice <= 0) {
      throw new ValidationError('stopTriggerPrice required for stop orders');
    }
    const r = await pool.query(
      `INSERT INTO pending_orders
        (user_id, asset_symbol, side, class, quantity, limit_price, stop_trigger_price, status)
       VALUES ($1,$2,$3,'stop',$4,NULL,$5,'open')
       RETURNING id`,
      [userId, sym, side, fmt(quantity), fmt(stopTriggerPrice)]
    );
    return { mode: 'queued', orderId: Number(r.rows[0].id) };
  }

  // market order — execute immediately
  const ids = await executeMarketOrderInternal({
    userId,
    symbol: sym,
    side,
    quantity,
    stopLoss: stopLoss ?? null,
  });
  await analyzeAfterTrade(userId, { side, symbol: sym, quantity }).catch(() => undefined);
  await bumpMissionProgress(userId, 'trade').catch(() => undefined);
  await invalidateLeaderboardCache();
  return { mode: 'executed', tradeIds: ids, message: 'Market order filled' };
}

export async function executeMarketOrderInternal(input: {
  userId: number;
  symbol: string;
  side: OrderSide;
  quantity: number;
  stopLoss?: number | null;
  exitPriceOverride?: number;
}): Promise<number[]> {
  const { userId, symbol, side, quantity, stopLoss, exitPriceOverride } = input;
  const quote = await getQuote(symbol);
  const price = exitPriceOverride ?? quote.price;
  const sym = symbol.toUpperCase();
  const tradeIds: number[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (side === 'buy') {
      const cost = quantity * price;
      const bal = await getWallet(client, userId, true);
      if (bal + 1e-8 < cost) {
        throw new AppError(400, 'Insufficient balance', 'INSUFFICIENT_FUNDS');
      }

      await client.query(
        `UPDATE wallets SET balance = balance - $2::numeric, last_updated = now()
         WHERE user_id = $1`,
        [userId, fmt(cost)]
      );

      const row = await getPortfolioRow(client, userId, sym, true);
      let newQty: number;
      let newAvg: number;
      if (!row || row.quantity <= 0) {
        newQty = quantity;
        newAvg = price;
      } else {
        newQty = row.quantity + quantity;
        newAvg = (row.avgPrice * row.quantity + price * quantity) / newQty;
      }
      await client.query(
        `INSERT INTO portfolio (user_id, asset_symbol, quantity, avg_price)
         VALUES ($1,$2,$3::numeric,$4::numeric)
         ON CONFLICT (user_id, asset_symbol) DO UPDATE
         SET quantity = EXCLUDED.quantity, avg_price = EXCLUDED.avg_price, updated_at = now()`,
        [userId, sym, fmt(newQty), fmt(newAvg)]
      );

      // Trades table is partitioned on trade_timestamp — INSERT returns id + timestamp
      const ins = await client.query(
        `INSERT INTO trades
          (user_id, asset_symbol, order_type, quantity, entry_price, exit_price, stop_loss, status, trade_timestamp)
         VALUES ($1,$2,'buy',$3::numeric,$4::numeric,NULL,$5,'open', now())
         RETURNING id`,
        [userId, sym, fmt(quantity), fmt(price), stopLoss != null ? fmt(stopLoss) : null]
      );
      tradeIds.push(Number(ins.rows[0].id));
    } else {
      // SELL
      const row = await getPortfolioRow(client, userId, sym, true);
      if (!row || row.quantity + 1e-12 < quantity) {
        throw new AppError(400, 'Insufficient position size', 'INSUFFICIENT_QTY');
      }

      // Fetch open lots ordered FIFO; lock them for this transaction
      // Partitioned table: include trade_timestamp in SELECT to enable partition pruning
      const openTrades = await client.query(
        `SELECT id, quantity::text, entry_price::text, trade_timestamp
         FROM trades
         WHERE user_id = $1 AND asset_symbol = $2 AND status = 'open' AND order_type = 'buy'
         ORDER BY trade_timestamp ASC
         FOR UPDATE`,
        [userId, sym]
      );

      let remaining = quantity;
      let proceeds = 0;

      for (const t of openTrades.rows) {
        if (remaining <= 0) break;
        const tQty = dec(t.quantity as string);
        const entry = dec(t.entry_price as string);
        const closeQty = Math.min(tQty, remaining);
        proceeds += closeQty * price;

        // CRITICAL: Partitioned table updates MUST include the partition key (trade_timestamp)
        // in the WHERE clause for correctness, otherwise Postgres scans all partitions.
        const ts = t.trade_timestamp as Date;

        if (closeQty + 1e-12 >= tQty) {
          // Close entire lot
          await client.query(
            `UPDATE trades SET status = 'closed', exit_price = $3::numeric
             WHERE id = $1 AND trade_timestamp = $2`,
            [t.id, ts, fmt(price)]
          );
        } else {
          // Partial close: shrink the open lot, insert a new closed lot for the portion sold
          await client.query(
            `UPDATE trades SET quantity = $3::numeric
             WHERE id = $1 AND trade_timestamp = $2`,
            [t.id, ts, fmt(tQty - closeQty)]
          );
          // Insert the closed portion as a new trade row
          await client.query(
            `INSERT INTO trades
              (user_id, asset_symbol, order_type, quantity, entry_price, exit_price, stop_loss, status, trade_timestamp)
             VALUES ($1,$2,'buy',$3::numeric,$4::numeric,$5::numeric,NULL,'closed', now())`,
            [userId, sym, fmt(closeQty), fmt(entry), fmt(price)]
          );
        }

        tradeIds.push(Number(t.id));
        remaining -= closeQty;
      }

      if (remaining > 1e-8) {
        throw new AppError(400, 'Open lots do not cover sell size', 'LOT_MISMATCH');
      }

      await client.query(
        `UPDATE wallets SET balance = balance + $2::numeric, last_updated = now()
         WHERE user_id = $1`,
        [userId, fmt(proceeds)]
      );

      const newPosQty = row.quantity - quantity;
      if (newPosQty <= 1e-12) {
        await client.query(
          `DELETE FROM portfolio WHERE user_id = $1 AND asset_symbol = $2`,
          [userId, sym]
        );
      } else {
        await client.query(
          `UPDATE portfolio SET quantity = $1::numeric, updated_at = now()
           WHERE user_id = $2 AND asset_symbol = $3`,
          [fmt(newPosQty), userId, sym]
        );
      }
    }

    await client.query('COMMIT');
    return tradeIds;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function tradingMatchPendingOrders(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, user_id, asset_symbol, side::text as side, class::text as class,
            quantity::text as quantity, limit_price::text, stop_trigger_price::text
     FROM pending_orders WHERE status = 'open'`
  );

  for (const o of rows) {
    const sym = String(o.asset_symbol);
    const q = await getQuote(sym);
    const last = q.price;
    const side = String(o.side) as OrderSide;
    const qty = dec(o.quantity as string);
    const id = Number(o.id);

    let hit = false;
    if (o.class === 'limit' && o.limit_price) {
      const lp = dec(o.limit_price as string);
      if (side === 'buy' && last <= lp) hit = true;
      if (side === 'sell' && last >= lp) hit = true;
    }
    if (o.class === 'stop' && o.stop_trigger_price) {
      const sp = dec(o.stop_trigger_price as string);
      if (side === 'sell' && last <= sp) hit = true;
      if (side === 'buy' && last >= sp) hit = true;
    }

    if (!hit) continue;

    // Try to atomically mark the order as filled
    const client = await pool.connect();
    let filled = false;
    try {
      await client.query('BEGIN');
      const lock = await client.query(
        `SELECT 1 FROM pending_orders WHERE id = $1 AND status = 'open' FOR UPDATE`,
        [id]
      );
      if ((lock.rowCount ?? 0) === 0) {
        await client.query('COMMIT');
        continue;
      }
      await client.query(
        `UPDATE pending_orders SET status = 'filled', updated_at = now() WHERE id = $1`,
        [id]
      );
      await client.query('COMMIT');
      filled = true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    if (!filled) continue;

    try {
      await executeMarketOrderInternal({
        userId: Number(o.user_id),
        symbol: sym,
        side,
        quantity: qty,
        exitPriceOverride: last,
      });
      await analyzeAfterTrade(Number(o.user_id), { side, symbol: sym, quantity: qty }).catch(
        () => undefined
      );
      await bumpMissionProgress(Number(o.user_id), 'trade').catch(() => undefined);
      await invalidateLeaderboardCache();
    } catch (e) {
      // Roll back the status so the order can be retried
      await pool
        .query(`UPDATE pending_orders SET status = 'open', updated_at = now() WHERE id = $1`, [id])
        .catch(() => undefined);
      throw e;
    }
  }
}

export async function checkStopLossForAllSymbols(): Promise<void> {
  const symbols = env()
    .MARKET_SYMBOLS.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  for (const sym of symbols) {
    const quote = await getQuote(sym);
    const px = quote.price;

    for (;;) {
      const { rows } = await pool.query(
        `SELECT id, user_id, quantity::text, stop_loss::text, trade_timestamp
         FROM trades
         WHERE asset_symbol = $1 AND status = 'open' AND order_type = 'buy'
           AND stop_loss IS NOT NULL
           AND $2::numeric <= stop_loss
         ORDER BY trade_timestamp ASC
         LIMIT 1`,
        [sym, fmt(px)]
      );
      const t = rows[0];
      if (!t) break;

      const qty = dec(t.quantity as string);
      try {
        await executeMarketOrderInternal({
          userId: Number(t.user_id),
          symbol: sym,
          side: 'sell',
          quantity: qty,
          exitPriceOverride: px,
        });
        await analyzeAfterTrade(Number(t.user_id), {
          side: 'sell',
          symbol: sym,
          quantity: qty,
          panic: true,
        }).catch(() => undefined);
        await bumpMissionProgress(Number(t.user_id), 'trade').catch(() => undefined);
        await invalidateLeaderboardCache();
      } catch {
        break;
      }
    }
  }
}

export async function listOpenTrades(userId: number, symbol?: string) {
  const args: unknown[] = [userId];
  let sql = `
    SELECT id, asset_symbol, order_type::text, quantity::text, entry_price::text,
           stop_loss::text, status::text, trade_timestamp
    FROM trades WHERE user_id = $1 AND status = 'open'`;
  if (symbol) {
    args.push(symbol.toUpperCase());
    sql += ` AND asset_symbol = $2`;
  }
  sql += ` ORDER BY trade_timestamp DESC`;
  return pool.query(sql, args);
}

export async function unrealizedPnL(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT asset_symbol, quantity::text, avg_price::text FROM portfolio WHERE user_id = $1`,
    [userId]
  );
  let total = 0;
  for (const r of rows) {
    const q = await getQuote(String(r.asset_symbol));
    const qty = dec(r.quantity as string);
    const avg = dec(r.avg_price as string);
    total += (q.price - avg) * qty;
  }
  return Math.round(total * 1e6) / 1e6;
}

export async function realizedPnLFromClosed(userId: number): Promise<number> {
  const { rows } = await pool.query(
    `SELECT quantity::text, entry_price::text, exit_price::text
     FROM trades WHERE user_id = $1 AND status = 'closed' AND order_type = 'buy'`,
    [userId]
  );
  let pnl = 0;
  for (const r of rows) {
    const qty = dec(r.quantity as string);
    const e = dec(r.entry_price as string);
    const x = dec(r.exit_price as string);
    pnl += (x - e) * qty;
  }
  return Math.round(pnl * 1e6) / 1e6;
}
