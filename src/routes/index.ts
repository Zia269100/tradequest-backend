import type { Express } from 'express';
import { authRouter } from './auth.routes';
import { tradeRouter } from './trade.routes';
import { portfolioRouter } from './portfolio.routes';
import { leaderboardRouter } from './leaderboard.routes';
import { missionsRouter } from './missions.routes';
import { analyticsRouter } from './analytics.routes';

export function registerRoutes(app: Express): void {
  app.use('/api/auth', authRouter);
  app.use('/api/trade', tradeRouter);
  app.use('/api/portfolio', portfolioRouter);
  app.use('/api/leaderboard', leaderboardRouter);
  app.use('/api/missions', missionsRouter);
  app.use('/api/analytics', analyticsRouter);
}
