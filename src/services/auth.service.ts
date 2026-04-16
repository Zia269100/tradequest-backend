import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { redis, cacheKeys } from '../redis/client';
import { ConflictError, UnauthorizedError, ValidationError } from '../utils/errors';
import type { JwtPayload } from '../middleware/auth';
import { logger } from '../logger';

const BCRYPT_ROUNDS = 12;

const signOpts = {
  algorithm: 'HS256' as const,
  issuer: env().JWT_ISSUER,
  audience: env().JWT_AUDIENCE,
};

const verifyRefreshOpts = {
  algorithms: ['HS256'] as jwt.Algorithm[],
  issuer: env().JWT_ISSUER,
  audience: env().JWT_AUDIENCE,
};

function signAccess(userId: number, username: string): string {
  const payload: JwtPayload = { sub: String(userId), username, typ: 'access' };
  return jwt.sign(payload, env().JWT_ACCESS_SECRET, {
    ...signOpts,
    expiresIn: env().JWT_ACCESS_TTL_SEC,
  });
}

function signRefresh(userId: number, username: string, jti: string): string {
  const payload = { sub: String(userId), username, typ: 'refresh' as const, jti };
  return jwt.sign(payload, env().JWT_REFRESH_SECRET, {
    ...signOpts,
    expiresIn: env().JWT_REFRESH_TTL_SEC,
  });
}

async function persistRefreshSession(userId: number, jti: string): Promise<void> {
  const r = redis();
  await r.set(cacheKeys.session(jti), String(userId), 'EX', env().JWT_REFRESH_TTL_SEC);
}

export async function signup(input: {
  username: string;
  email: string;
  password: string;
}): Promise<{ userId: number; accessToken: string; refreshToken: string }> {
  const { username, email, password } = input;
  if (password.length > 128) {
    throw new ValidationError('Password too long');
  }
  if (password.length < 10) {
    throw new ValidationError('Password must be at least 10 characters');
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const starting = env().STARTING_BALANCE;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username`,
      [username.trim(), email.trim().toLowerCase(), password_hash]
    );
    const userId = Number(u.rows[0].id);
    const uname = String(u.rows[0].username);

    await client.query(
      `INSERT INTO wallets (user_id, balance, currency_type)
       VALUES ($1, $2, 'virtual')`,
      [userId, starting.toFixed(8)]
    );

    await client.query(
      `INSERT INTO user_missions (user_id, mission_id, progress, completed)
       SELECT $1, m.id, 0, false FROM missions m
       ON CONFLICT (user_id, mission_id) DO NOTHING`,
      [userId]
    );

    await client.query('COMMIT');

    const jti = uuidv4();
    await persistRefreshSession(userId, jti);
    return {
      userId,
      accessToken: signAccess(userId, uname),
      refreshToken: signRefresh(userId, uname, jti),
    };
  } catch (e: unknown) {
    await client.query('ROLLBACK');
    const err = e as { code?: string };
    if (err.code === '23505') {
      throw new ConflictError('Email or username already registered');
    }
    logger.error({ err: e }, 'signup failed');
    throw e;
  } finally {
    client.release();
  }
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<{ userId: number; accessToken: string; refreshToken: string }> {
  const { email, password } = input;
  const q = await pool.query(
    `SELECT id, username, password_hash FROM users WHERE email = $1 LIMIT 1`,
    [email.trim().toLowerCase()]
  );
  const row = q.rows[0];
  if (!row) throw new UnauthorizedError('Invalid credentials');

  const ok = await bcrypt.compare(password, String(row.password_hash));
  if (!ok) throw new UnauthorizedError('Invalid credentials');

  const userId = Number(row.id);
  const username = String(row.username);
  const jti = uuidv4();
  await persistRefreshSession(userId, jti);

  return {
    userId,
    accessToken: signAccess(userId, username),
    refreshToken: signRefresh(userId, username, jti),
  };
}

export async function refreshToken(
  refreshTokenStr: string
): Promise<{ accessToken: string; refreshToken: string }> {
  let decoded: jwt.JwtPayload & JwtPayload & { jti?: string };
  try {
    decoded = jwt.verify(
      refreshTokenStr,
      env().JWT_REFRESH_SECRET,
      verifyRefreshOpts
    ) as typeof decoded;
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }
  if (decoded.typ !== 'refresh' || !decoded.jti || !decoded.sub) {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const r = redis();
  const uid = await r.get(cacheKeys.session(decoded.jti));
  if (!uid || uid !== decoded.sub) {
    throw new UnauthorizedError('Session expired or revoked');
  }

  await r.del(cacheKeys.session(decoded.jti));
  const userId = Number(decoded.sub);
  const username = String(decoded.username);
  const jti = uuidv4();
  await persistRefreshSession(userId, jti);

  return {
    accessToken: signAccess(userId, username),
    refreshToken: signRefresh(userId, username, jti),
  };
}

export async function getMe(userId: number): Promise<{
  user: {
    id: number;
    username: string;
    email: string;
    avatar: string | null;
    xp: string;
    level: number;
    created_at: string;
  };
  balance: string;
}> {
  const u = await pool.query(
    `SELECT id, username, email::text, avatar, xp::text, level, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  const w = await pool.query(`SELECT balance::text FROM wallets WHERE user_id = $1`, [userId]);
  const row = u.rows[0];
  if (!row) throw new Error('User not found');
  return {
    user: {
      id: Number(row.id),
      username: String(row.username),
      email: String(row.email),
      avatar: row.avatar ? String(row.avatar) : null,
      xp: String(row.xp),
      level: Number(row.level),
      created_at: String(row.created_at),
    },
    balance: w.rows[0] ? String(w.rows[0].balance) : '0',
  };
}

export async function logout(refreshTokenStr: string): Promise<void> {
  try {
    const decoded = jwt.decode(refreshTokenStr) as { jti?: string } | null;
    if (decoded?.jti) await redis().del(cacheKeys.session(decoded.jti));
  } catch {
    /* ignore */
  }
}
