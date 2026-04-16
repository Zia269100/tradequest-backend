import { pool } from '../db/pool';
import { logger } from '../logger';

const LEVEL_XP_STEP = 1000;

export async function ensureUserMissions(userId: number): Promise<void> {
  await pool.query(
    `INSERT INTO user_missions (user_id, mission_id, progress, completed)
     SELECT $1, m.id, 0, false FROM missions m
     WHERE NOT EXISTS (
       SELECT 1 FROM user_missions um
       WHERE um.user_id = $1 AND um.mission_id = m.id
     )`,
    [userId]
  );
}

export async function listMissionsForUser(userId: number) {
  return pool.query(
    `SELECT m.id, m.title, m.description, m.reward_xp, m.difficulty,
            um.progress, um.completed,
            COALESCE(um.reward_granted, false) AS reward_granted
     FROM missions m
     LEFT JOIN user_missions um ON um.mission_id = m.id AND um.user_id = $1
     ORDER BY m.id ASC`,
    [userId]
  );
}

export async function claimMissionReward(userId: number, missionId: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(
      `SELECT um.completed, um.reward_granted, m.reward_xp
       FROM user_missions um
       JOIN missions m ON m.id = um.mission_id
       WHERE um.user_id = $1 AND um.mission_id = $2 FOR UPDATE`,
      [userId, missionId]
    );
    const row = q.rows[0];
    if (!row) throw new Error('Mission not found');
    if (!row.completed) throw new Error('Mission not completed');
    if (row.reward_granted) {
      await client.query('COMMIT');
      return 0;
    }
    const xp = Number(row.reward_xp);
    await client.query(
      `UPDATE users SET xp = xp + $2, updated_at = now() WHERE id = $1`,
      [userId, xp]
    );
    // Recompute level from updated xp in a single atomic query
    await client.query(
      `UPDATE users
       SET level = GREATEST(1, 1 + (xp / $2)::int), updated_at = now()
       WHERE id = $1`,
      [userId, LEVEL_XP_STEP]
    );
    await client.query(
      `UPDATE user_missions SET reward_granted = true, updated_at = now()
       WHERE user_id = $1 AND mission_id = $2`,
      [userId, missionId]
    );
    await client.query('COMMIT');
    return xp;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function bumpMissionProgress(
  userId: number,
  reason: 'trade' | 'profit'
): Promise<void> {
  if (reason !== 'trade') return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: tc } = await client.query(
      `SELECT count(*)::int AS c FROM trades WHERE user_id = $1`,
      [userId]
    );
    const tradeCount = Number(tc[0]?.c ?? 0);

    const { rows: missions } = await client.query(
      `SELECT um.mission_id, um.progress, um.completed, um.reward_granted,
              m.title, m.reward_xp
       FROM user_missions um
       JOIN missions m ON m.id = um.mission_id
       WHERE um.user_id = $1 FOR UPDATE`,
      [userId]
    );

    for (const m of missions) {
      const title = String(m.title).toLowerCase();
      let progress = Number(m.progress);
      if (title.includes('first')) {
        progress = tradeCount >= 1 ? 100 : 0;
      } else {
        progress = Math.min(100, tradeCount * 10);
      }
      const completed = progress >= 100;
      const wasCompleted = Boolean(m.completed);

      await client.query(
        `UPDATE user_missions
         SET progress = $3, completed = $4, updated_at = now()
         WHERE user_id = $1 AND mission_id = $2`,
        [userId, Number(m.mission_id), progress, completed]
      );

      if (completed && !wasCompleted && !m.reward_granted) {
        const xp = Number(m.reward_xp);
        await client.query(`UPDATE users SET xp = xp + $2, updated_at = now() WHERE id = $1`, [
          userId,
          xp,
        ]);
        await client.query(
          `UPDATE users SET level = GREATEST(1, 1 + (xp / $2)::int), updated_at = now()
           WHERE id = $1`,
          [userId, LEVEL_XP_STEP]
        );
        await client.query(
          `UPDATE user_missions SET reward_granted = true, updated_at = now()
           WHERE user_id = $1 AND mission_id = $2`,
          [userId, Number(m.mission_id)]
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    logger.warn({ err: e }, 'bumpMissionProgress failed');
  } finally {
    client.release();
  }
}
