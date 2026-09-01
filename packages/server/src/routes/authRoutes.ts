import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { newToken, hashToken } from '../auth/tokens.js';

const SESSION_TTL_DAYS = 14;

const credentials = z.object({
  handle: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  displayName: z.string().min(1).max(64),
  password: z.string().min(8).max(128),
});

export async function registerAuthRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/bootstrap', async (req, reply) => {
    const existing = await pool.query(`select 1 from account where kind = 'human' limit 1`);
    if (existing.rowCount) {
      return reply.code(409).send({ error: { code: 'already_bootstrapped', message: 'workspace already has a human account' } });
    }
    const body = credentials.parse(req.body);
    const hash = await argon2.hash(body.password);
    const res = await pool.query(
      `insert into account (handle, display_name, kind, is_admin, password_hash)
       values ($1, $2, 'human', true, $3) returning id`,
      [body.handle, body.displayName, hash],
    );
    return reply.code(201).send({ id: res.rows[0].id });
  });

  app.post('/auth/login', async (req, reply) => {
    const body = z.object({ handle: z.string(), password: z.string() }).parse(req.body);
    const res = await pool.query(
      `select id, password_hash from account where handle = $1 and kind = 'human'`, [body.handle]);
    const row = res.rows[0];
    if (!row?.password_hash || !(await argon2.verify(row.password_hash, body.password))) {
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'wrong handle or password' } });
    }
    const { token, hash } = newToken('murs');
    await pool.query(
      `insert into session (token_hash, account_id, expires_at)
       values ($1, $2, now() + interval '${SESSION_TTL_DAYS} days')`,
      [hash, row.id],
    );
    return { token };
  });

  app.get('/auth/me', { preHandler: app.requireAccount }, async (req) => req.account);

  // 로그아웃은 **이 토큰만** 끊는다. 한 기기에서 나가는 것이 모든 기기에서 쫓겨나는 것과
  // 같으면 놀라움이 크다 — 전체 폐기가 필요하면 별도 표면이어야 한다. 지금까지는 클라이언트가
  // 로컬 토큰만 지웠고 서버 세션은 TTL(14일)을 그대로 살았다.
  app.post('/auth/logout', { preHandler: app.requireAccount }, async (req, reply) => {
    await pool.query(`delete from session where token_hash = $1`, [req.credentialHash]);
    return reply.code(204).send();
  });

  app.post('/auth/register', async (req, reply) => {
    const body = credentials.extend({ inviteToken: z.string() }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const inv = await client.query(
        `select token_hash from invite where token_hash = $1 and used_by is null for update`,
        [hashToken(body.inviteToken)],
      );
      if (!inv.rowCount) {
        await client.query('rollback');
        return reply.code(400).send({ error: { code: 'invalid_invite', message: 'invite invalid or used' } });
      }
      const pw = await argon2.hash(body.password);
      const acc = await client.query(
        `insert into account (handle, display_name, kind, password_hash)
         values ($1, $2, 'human', $3) returning id`,
        [body.handle, body.displayName, pw],
      );
      await client.query(`update invite set used_by = $1 where token_hash = $2`, [acc.rows[0].id, inv.rows[0].token_hash]);
      await client.query('commit');
      return reply.code(201).send({ id: acc.rows[0].id });
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  });
}
