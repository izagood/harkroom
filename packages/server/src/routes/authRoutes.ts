import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import argon2 from 'argon2';
import { z } from 'zod';
import { newToken } from '../auth/tokens.js';

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
}
