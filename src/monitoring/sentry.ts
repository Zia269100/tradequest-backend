import { env } from '../config/env';
import { logger } from '../logger';

/**
 * Production error tracking: set SENTRY_DSN and add dependency `@sentry/node`,
 * then call init() from your bootstrap with the Sentry SDK’s recommended Express integration.
 */
export function initSentryIfConfigured(): void {
  if (!env().SENTRY_DSN) return;
  logger.warn(
    'SENTRY_DSN is set — add @sentry/node and wire Express per https://docs.sentry.io/platforms/javascript/guides/node/'
  );
}
