import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { newToken } from '../auth/tokens.js';

export async function registerAccountRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/invites', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { token, hash } = newToken('muri');
    await pool.query(`insert into invite (token_hash, created_by) values ($1, $2)`, [hash, req.account!.id]);
    return reply.code(201).send({ token });
  });

  app.post('/accounts/agents', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      handle: z.string().regex(/^[a-z0-9_-]{2,32}$/),
      displayName: z.string().min(1).max(64),
    }).parse(req.body);
    const res = await pool.query(
      `insert into account (handle, display_name, kind) values ($1, $2, 'agent') returning id`,
      [body.handle, body.displayName],
    );
    return reply.code(201).send({ id: res.rows[0].id });
  });

  app.post('/accounts/:id/pats', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ label: z.string().min(1).max(64) }).parse(req.body);
    const { token, hash } = newToken('murp');
    await pool.query(`insert into pat (token_hash, account_id, label) values ($1, $2, $3)`, [hash, id, body.label]);
    return reply.code(201).send({ token });
  });

  // 라벨 단위 폐기다. pat.label 에 유일성이 없으므로 같은 라벨의 토큰이 여러 개면 전부 폐기된다 —
  // 폐기에서는 그 방향이 안전한 쪽이다(하나 남는 것보다 하나 더 끊는 것이 낫다).
  app.delete('/accounts/:id/pats/:label', { preHandler: app.requireAdmin }, async (req) => {
    const { id, label } = z.object({ id: z.string().uuid(), label: z.string().min(1).max(64) }).parse(req.params);
    const res = await pool.query(
      `update pat set revoked_at = now() where account_id = $1 and label = $2 and revoked_at is null`,
      [id, label],
    );
    return { revoked: res.rowCount ?? 0 };
  });

  app.put('/accounts/:id/keys', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!req.account!.isAdmin && req.account!.id !== id) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'not your account' } });
    }
    const body = z.object({
      keyId: z.string().min(1).max(128),
      publicKeyPem: z.string().includes('BEGIN PUBLIC KEY'),
    }).parse(req.body);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(
        `insert into account_key (key_id, account_id, public_key_pem) values ($1, $2, $3)
         on conflict (key_id) do update set public_key_pem = excluded.public_key_pem
         where account_key.account_id = excluded.account_id`,
        [body.keyId, id, body.publicKeyPem],
      );
      if (!result.rowCount) {
        await client.query('rollback');
        return reply.code(409).send({ error: { code: 'key_conflict', message: 'key already registered to another account' } });
      }
      await client.query('commit');
      return reply.code(204).send();
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  });
}
