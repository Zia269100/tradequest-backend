import { Router } from 'express';
import { getLeaderboardCached } from '../services/leaderboard.service';
import { apiReadRateLimit } from '../middleware/rateLimits';
import { publicCacheHint } from '../middleware/cacheHeaders';

const router = Router();

router.use(apiReadRateLimit);
router.use(publicCacheHint);

router.get('/', async (_req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(_req.query.limit) || 50));
    const rows = await getLeaderboardCached(limit);
    res.json({ ok: true, data: rows });
  } catch (e) {
    next(e);
  }
});

export { router as leaderboardRouter };
