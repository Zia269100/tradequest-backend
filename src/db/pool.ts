import pg from 'pg';
import { env } from '../config/env';
import { logger } from '../logger';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env().DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected PG pool error');
});

export type DbClient = pg.PoolClient;
