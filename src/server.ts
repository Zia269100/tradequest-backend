import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './logger';
import { marketHubAdd } from './websocket/marketHub';
import { ensureMarketState, tickMarket } from './services/market.service';
import {
  tradingMatchPendingOrders,
  checkStopLossForAllSymbols,
} from './services/trading.service';
import { refreshLeaderboardJob } from './services/leaderboard.service';
import { initSentryIfConfigured } from './monitoring/sentry';

initSentryIfConfigured();

const app = createApp();
const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws/market' });
wss.on('connection', (ws) => {
  marketHubAdd(ws);
});

async function runMarketCycle(): Promise<void> {
  await tickMarket();
  try {
    await tradingMatchPendingOrders();
  } catch (e) {
    logger.error({ err: e }, 'pending order matching failed');
  }
  try {
    await checkStopLossForAllSymbols();
  } catch (e) {
    logger.error({ err: e }, 'stop-loss sweep failed');
  }
}

let marketInterval: NodeJS.Timeout | null = null;
let leaderboardInterval: NodeJS.Timeout | null = null;

async function bootstrap(): Promise<void> {
  await ensureMarketState();
  await runMarketCycle();
  try {
    await refreshLeaderboardJob();
  } catch (e) {
    logger.warn({ err: e }, 'initial leaderboard refresh skipped');
  }

  // Start recurring intervals only AFTER bootstrap is complete
  marketInterval = setInterval(() => {
    void runMarketCycle();
  }, env().MARKET_TICK_MS);

  leaderboardInterval = setInterval(() => {
    void refreshLeaderboardJob().catch((e) =>
      logger.warn({ err: e }, 'leaderboard refresh failed')
    );
  }, env().LEADERBOARD_REFRESH_SEC * 1000);
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received');
  if (marketInterval) clearInterval(marketInterval);
  if (leaderboardInterval) clearInterval(leaderboardInterval);

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 10s
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

const port = env().PORT;
void bootstrap().then(() => {
  server.listen(port, () => {
    logger.info({ port, wsPath: '/ws/market' }, 'HTTP server listening');
  });
});
