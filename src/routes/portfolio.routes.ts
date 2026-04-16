import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { dec } from '../utils/numeric';
import { getQuote } from '../services/market.service';
import * as trading from '../services/trading.service';
import { apiReadRateLimit } from '../middleware/rateLimits';

const router = Router();
router.use(apiReadRateLimit);
router.use(requireAuth);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const [wallet, positions] = await Promise.all([
      pool.query(`SELECT balance::text, currency_type::text FROM wallets WHERE user_id = $1`, [userId]),
      pool.query(
        `SELECT asset_symbol, quantity::text, avg_price::text, updated_at
         FROM portfolio WHERE user_id = $1 ORDER BY asset_symbol ASC`,
        [userId]
      ),
    ]);

    const balRow = wallet.rows[0];
    const cash = balRow ? dec(balRow.balance as string) : 0;

    const quotes = await Promise.all(
      positions.rows.map((p) => getQuote(String(p.asset_symbol)))
    );

    const enriched = [];
    let marketValue = 0;
    for (let i = 0; i < positions.rows.length; i++) {
      const p = positions.rows[i];
      const sym = String(p.asset_symbol);
      const qty = dec(p.quantity as string);
      const avg = dec(p.avg_price as string);
      const q = quotes[i];
      const mv = qty * q.price;
      marketValue += mv;
      enriched.push({
        assetSymbol: sym,
        quantity: qty,
        avgPrice: avg,
        lastPrice: q.price,
        marketValue: mv,
        unrealized: (q.price - avg) * qty,
      });
    }

    const unrealized = await trading.unrealizedPnL(userId);
    const realized = await trading.realizedPnLFromClosed(userId);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      data: {
        wallet: {
          balance: cash,
          currencyType: balRow?.currency_type ?? 'virtual',
        },
        positions: enriched,
        totals: {
          cash,
          marketValue,
          equity: cash + marketValue,
          unrealizedPnL: unrealized,
          realizedPnL: realized,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

export { router as portfolioRouter };
