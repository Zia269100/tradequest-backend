import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { registerRoutes } from './routes';
import { errorHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { httpsEnforce } from './middleware/httpsEnforce';
import { sanitizeBody } from './middleware/sanitizeInput';
import { httpMetrics } from './middleware/httpMetrics';
import { metricsHandler } from './monitoring/metrics';
import { logger } from './logger';

export function createApp(): express.Express {
  const app = express();
  const e = env();

  if (e.TRUST_PROXY > 0) {
    app.set('trust proxy', e.TRUST_PROXY);
  }

  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(httpsEnforce);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );
  app.use(compression());
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request & { ctx?: { requestId: string } }).ctx?.requestId ?? '',
      customProps: (req) => ({
        requestId: (req as express.Request & { ctx?: { requestId: string } }).ctx?.requestId,
      }),
      autoLogging: {
        ignore: (req) => {
          const u = req.url ?? '';
          return u === '/health' || u.startsWith('/metrics');
        },
      },
    })
  );
  app.use(httpMetrics);

  app.use(
    cors({
      origin: e.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
      maxAge: 86400,
    })
  );
  app.use(express.json({ limit: `${e.BODY_LIMIT_KB}kb` }));
  app.use(sanitizeBody);

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'trading-sim-api' });
  });

  app.get('/metrics', metricsHandler);

  registerRoutes(app);

  app.use(errorHandler);
  return app;
}
