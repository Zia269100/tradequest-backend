import { Router } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import * as missionService from '../services/mission.service';
import { AppError } from '../utils/errors';
import { writeRateLimit, apiReadRateLimit } from '../middleware/rateLimits';

const router = Router();
router.use(requireAuth);
router.get('/', apiReadRateLimit, async (req: AuthRequest, res, next) => {
  try {
    await missionService.ensureUserMissions(req.user!.id);
    const { rows } = await missionService.listMissionsForUser(req.user!.id);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ok: true, data: rows });
  } catch (e) {
    next(e);
  }
});

router.post('/:missionId/claim', writeRateLimit, async (req: AuthRequest, res, next) => {
  try {
    const missionId = Number(req.params.missionId);
    if (!Number.isFinite(missionId)) throw new AppError(400, 'Invalid mission id');
    const xp = await missionService.claimMissionReward(req.user!.id, missionId);
    res.json({ ok: true, data: { xpGranted: xp } });
  } catch (e) {
    if (e instanceof Error && e.message === 'Mission not found') {
      next(new AppError(404, e.message));
      return;
    }
    if (e instanceof Error && e.message === 'Mission not completed') {
      next(new AppError(400, e.message));
      return;
    }
    next(e);
  }
});

export { router as missionsRouter };
