import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import * as trading from '../services/trading.service';
import { pool } from '../db/pool';
import { writeRateLimit, apiReadRateLimit } from '../middleware/rateLimits';

const router = Router();

const orderBody = z
  .object({
    symbol: z.string().min(1).max(16).trim(),
    side: z.enum(['buy', 'sell']),
    kind: z.enum(['market', 'limit', 'stop']),
    quantity: z.number().positive().max(1e12),
    limitPrice: z.number().positive().optional(),
    stopTriggerPrice: z.number().positive().optional(),
    stopLoss: z.number().positive().nullable().optional(),
  })
  .strict();

router.post('/', writeRateLimit, requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const body = orderBody.parse(req.body);
    const userId = req.user!.id;
    const result = await trading.placeOrder({
      userId,
      symbol: body.symbol,
      side: body.side,
      kind: body.kind,
      quantity: body.quantity,
      limitPrice: body.limitPrice,
      stopTriggerPrice: body.stopTriggerPrice,
      stopLoss: body.stopLoss,
    });
    res.json({ ok: true, data: result });
  } catch (e) {
    next(e);
  }
});

router.use(requireAuth);
router.use(apiReadRateLimit);

router.get('/history', async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    const { rows } = await pool.query(
      `SELECT id, asset_symbol, order_type::text, quantity::text, entry_price::text,
              exit_price::text, status::text, trade_timestamp, stop_loss::text
       FROM trades
       WHERE user_id = $1
       ORDER BY trade_timestamp DESC
       LIMIT $2`,
      [req.user!.id, limit]
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, data: rows });
  } catch (e) {
    next(e);
  }
});

router.get('/open', async (req: AuthRequest, res, next) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).slice(0, 16) : undefined;
    const { rows } = await trading.listOpenTrades(req.user!.id, symbol);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, data: rows });
  } catch (e) {
    next(e);
  }
});

router.get('/pnl', async (req: AuthRequest, res, next) => {
  try {
    const u = req.user!.id;
    const unrealized = await trading.unrealizedPnL(u);
    const realized = await trading.realizedPnLFromClosed(u);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      data: { unrealized, realized, total: unrealized + realized },
    });
  } catch (e) {
    next(e);
  }
});

export { router as tradeRouter };
