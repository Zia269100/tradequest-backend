import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth.service';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { authRateLimit, apiReadRateLimit } from '../middleware/rateLimits';

const router = Router();

const signupBody = z
  .object({
    username: z.string().min(2).max(40).trim(),
    email: z.string().email().max(320).transform((s) => s.toLowerCase()),
    password: z.string().min(10).max(128),
  })
  .strict();

const loginBody = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(1).max(128),
  })
  .strict();

const refreshBody = z
  .object({
    refreshToken: z.string().min(10).max(8192),
  })
  .strict();

router.post('/signup', authRateLimit, async (req, res, next) => {
  try {
    const body = signupBody.parse(req.body);
    const tokens = await authService.signup(body);
    res.status(201).json({
      ok: true,
      data: {
        userId: tokens.userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/login', authRateLimit, async (req, res, next) => {
  try {
    const body = loginBody.parse(req.body);
    const tokens = await authService.login(body);
    res.json({
      ok: true,
      data: {
        userId: tokens.userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
    });
  } catch (e) {
    next(e);
  }
});

router.post('/refresh', authRateLimit, async (req, res, next) => {
  try {
    const body = refreshBody.parse(req.body);
    const tokens = await authService.refreshToken(body.refreshToken);
    res.json({ ok: true, data: tokens });
  } catch (e) {
    next(e);
  }
});

router.get('/me', requireAuth, apiReadRateLimit, async (req: AuthRequest, res, next) => {
  try {
    const data = await authService.getMe(req.user!.id);
    res.json({ ok: true, data });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', authRateLimit, async (req, res, next) => {
  try {
    const body = z
      .object({ refreshToken: z.string().min(10).max(8192).optional() })
      .strict()
      .parse(req.body);
    if (body.refreshToken) await authService.logout(body.refreshToken);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

export { router as authRouter };
