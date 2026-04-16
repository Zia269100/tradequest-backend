import { Router } from 'express';
import { pool } from '../db/pool';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { apiReadRateLimit } from '../middleware/rateLimits';

const router = Router();
router.use(requireAuth);
router.use(apiReadRateLimit);

router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const [trades, behaviors, open, closed] = await Promise.all([
      pool.query(
        `SELECT
           count(*)::int AS total,
           count(*) FILTER (WHERE order_type = 'buy')::int AS buys,
           count(*) FILTER (WHERE order_type = 'sell')::int AS sells
         FROM trades WHERE user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT action_type::text AS action_type,
                count(*)::int AS count,
                avg(confidence_score::float8) AS avg_confidence
         FROM behavior_logs
         WHERE user_id = $1 AND event_timestamp > now() - interval '30 days'
         GROUP BY action_type`,
        [userId]
      ),
      pool.query(
        `SELECT count(*)::int AS c FROM trades WHERE user_id = $1 AND status = 'open'`,
        [userId]
      ),
      pool.query(
        `SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE exit_price > entry_price)::int AS wins
          FROM trades
          WHERE user_id = $1 AND status = 'closed' AND order_type = 'buy'`,
        [userId]
      ),
    ]);

    const tc = trades.rows[0];
    const cc = closed.rows[0];
    const totalClosed = Number(cc?.total ?? 0);
    const wins = Number(cc?.wins ?? 0);

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      ok: true,
      data: {
        trades: {
          total: Number(tc?.total ?? 0),
          buys: Number(tc?.buys ?? 0),
          sells: Number(tc?.sells ?? 0),
          openPositions: Number(open.rows[0]?.c ?? 0),
          closedRoundTrips: totalClosed,
          winRate: totalClosed > 0 ? wins / totalClosed : null,
        },
        behavior30d: behaviors.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

export { router as analyticsRouter };
