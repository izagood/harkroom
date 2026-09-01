import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { newToken } from '../auth/tokens.js';
import { AGENT_HARNESSES, MENTION_PERMISSIONS } from '@murmur/shared';
import { createAgentAccount, getAgent, listAgents, updateAgent } from '../services/agents.js';
import { recordAudit } from '../audit.js';

export async function registerAccountRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post('/invites', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { token, hash } = newToken('muri');
    await pool.query(`insert into invite (token_hash, created_by) values ($1, $2)`, [hash, req.account!.id]);
    await recordAudit(pool, {
      action: 'invite.created', actorId: req.account!.id, actorHandle: req.account!.handle,
    }, req);
    return reply.code(201).send({ token });
  });

  // UI 로 등록·수정하는 '에이전트 정의'. 설정은 서버에 살아야 UI 수정이 러너에 반영된다.
  const configFields = {
    instructions: z.string().max(8000).optional(),
    harness: z.enum(AGENT_HARNESSES).optional(),
    model: z.string().max(64).nullable().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    workingDir: z.string().max(512).nullable().optional(),
    mentionPermission: z.enum(MENTION_PERMISSIONS).optional(),
    ownerAccountId: z.string().uuid().nullable().optional(),
  };

  app.get('/accounts/agents', { preHandler: app.requireAdmin }, async () => ({
    agents: await listAgents(pool),
  }));

  app.post('/accounts/agents', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      handle: z.string().regex(/^[a-z0-9_-]{2,32}$/),
      displayName: z.string().min(1).max(64),
      ...configFields,
    }).parse(req.body);
    const created = await createAgentAccount(pool, body, req.account!.id);
    await recordAudit(pool, {
      action: 'agent.created', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: created.id, detail: { handle: body.handle },
    }, req);
    return reply.code(201).send(created);
  });

  app.patch('/accounts/agents/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      displayName: z.string().min(1).max(64).optional(),
      ...configFields,
    }).parse(req.body);
    const updated = await updateAgent(pool, id, patch);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    return updated;
  });

  // 러너가 자기 정의를 읽는 자리. 이것이 없으면 UI 수정이 도는 러너에 도달하지 않는다.
  app.get('/agent/config', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent') {
      return reply.code(403).send({ error: { code: 'agent_only', message: 'agents only' } });
    }
    const self = await getAgent(pool, req.account!.id);
    if (!self) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    return self;
  });

  app.post('/accounts/:id/pats', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ label: z.string().min(1).max(64) }).parse(req.body);
    const { token, hash } = newToken('murp');
    await pool.query(`insert into pat (token_hash, account_id, label) values ($1, $2, $3)`, [hash, id, body.label]);
    // pat 행은 토큰을 받은 에이전트만 가리킨다 — 누가 그 권한을 줬는지는 어디에도 없었다.
    // 토큰도 해시도 남기지 않는다: 라벨과 대상만으로 추적에 충분하다.
    await recordAudit(pool, {
      action: 'pat.issued', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { label: body.label },
    }, req);
    return reply.code(201).send({ token });
  });

  // 라벨 단위 폐기다. pat.label 에 유일성이 없어 같은 라벨의 토큰이 여러 개면 전부 폐기된다 —
  // 폐기에서는 하나 남기는 것보다 하나 더 끊는 쪽이 안전하다.
  app.delete('/accounts/:id/pats/:label', { preHandler: app.requireAdmin }, async (req) => {
    const { id, label } = z.object({ id: z.string().uuid(), label: z.string().min(1).max(64) }).parse(req.params);
    const res = await pool.query(
      `update pat set revoked_at = now() where account_id = $1 and label = $2 and revoked_at is null`,
      [id, label],
    );
    const revoked = res.rowCount ?? 0;
    await recordAudit(pool, {
      action: 'pat.revoked', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { label, revoked },
    }, req);
    return { revoked };
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
