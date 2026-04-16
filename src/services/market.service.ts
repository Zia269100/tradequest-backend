import { env, marketSymbolList } from '../config/env';
import { redis, cacheKeys } from '../redis/client';
import { pool } from '../db/pool';
import { broadcastQuote } from '../websocket/marketHub';
import { logger } from '../logger';

/** In-memory last prices for simulation drift */
const state = new Map<string, { price: number }>();
const cacheInsertTicks = new Map<string, number>();

function initPrice(symbol: string): number {
  const base = 80 + (symbol.charCodeAt(0) % 40) + symbol.length * 3;
  return Math.round(base * 100) / 100;
}

function jitter(symbol: string): number {
  const sigma = 0.002 + (symbol.length % 5) * 0.0004;
  const u = Math.random() - 0.5;
  return u * sigma * 2;
}

export async function ensureMarketState(): Promise<void> {
  const symbols = marketSymbolList();
  for (const s of symbols) {
    if (!state.has(s)) {
      state.set(s, { price: initPrice(s) });
    }
    const price = state.get(s)!.price;
    const r = redis();
    const key = cacheKeys.quote(s);
    const existing = await r.get(key);
    if (!existing) {
      await r.set(
        key,
        JSON.stringify({ symbol: s, price, ts: new Date().toISOString() }),
        'EX',
        env().CACHE_QUOTE_TTL_SEC
      );
    }
  }
}

export async function getQuote(symbol: string): Promise<{
  symbol: string;
  price: number;
  ts: string;
}> {
  const sym = symbol.toUpperCase();
  const r = redis();
  const cached = await r.get(cacheKeys.quote(sym));
  if (cached) {
    try {
      const j = JSON.parse(cached) as { symbol: string; price: number; ts: string };
      return j;
    } catch {
      /* fallthrough */
    }
  }
  if (!state.has(sym)) state.set(sym, { price: initPrice(sym) });
  const price = state.get(sym)!.price;
  const ts = new Date().toISOString();
  return { symbol: sym, price, ts };
}

export async function tickMarket(): Promise<void> {
  const symbols = marketSymbolList();
  const now = new Date();
  const r = redis();

  for (const s of symbols) {
    if (!state.has(s)) state.set(s, { price: initPrice(s) });
    const cur = state.get(s)!;
    const next = Math.max(0.01, cur.price * (1 + jitter(s)));
    cur.price = Math.round(next * 1e6) / 1e6;

    const payload = JSON.stringify({
      symbol: s,
      price: cur.price,
      ts: now.toISOString(),
    });
    await r.set(cacheKeys.quote(s), payload, 'EX', env().CACHE_QUOTE_TTL_SEC);

    const n = (cacheInsertTicks.get(s) ?? 0) + 1;
    cacheInsertTicks.set(s, n);
    if (n % 10 === 0) {
      try {
        await pool.query(
          `INSERT INTO market_data_cache (asset_symbol, price, captured_at)
           VALUES ($1, $2, $3)`,
          [s, cur.price.toFixed(8), now]
        );
      } catch (e) {
        logger.warn({ err: e, symbol: s }, 'market_data_cache insert skipped');
      }
    }

    broadcastQuote(s, cur.price, now);
  }
}

