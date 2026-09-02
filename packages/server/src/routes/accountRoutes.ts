import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { newToken } from '../auth/tokens.js';
import { AGENT_HARNESSES, MENTION_PERMISSIONS, RUNNABLE_HARNESSES } from '@murmur/shared';
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
  // harness 검증은 RUNNABLE_HARNESSES 로 제한한다 — 이미 DB에 저장된 값(gemini 등)은
  // 그대로 두고 읽지만, 새로 설정하는 것만 막는다(legacy 데이터 마이그레이션은 별도).
  const configFields = {
    instructions: z.string().max(8000).optional(),
    harness: z.enum(RUNNABLE_HARNESSES).optional(),
    model: z.string().max(64).nullable().optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    workingDir: z.string().max(512).nullable().optional(),
    mentionPermission: z.enum(MENTION_PERMISSIONS).optional(),
    ownerAccountId: z.string().uuid().nullable().optional(),
  };

  /**
   * 감사에 남길 에이전트 설정 필드와, 값을 그대로 남겨도 되는지의 표.
   * `if` 사슬로 두면 `configFields` 에 필드가 늘 때 이쪽에 더하는 것을 잊는다 — 표로 둬야
   * 두 목록을 나란히 놓고 볼 수 있다.
   *
   * - `'value'`: 값 자체가 비밀이 아니므로 before/after 를 그대로 남긴다.
   * - `'changed'`: 자유 텍스트라 원문을 감사 로그에 남기지 않는다. 바뀌었다는 사실만 남긴다.
   *
   * `model`·`effort`·`displayName` 은 빠져 있다 — 권한이나 도달 범위를 바꾸지 않는다.
   * 나머지가 왜 권한 값인가:
   * - `mentionPermission`: `readonly` vs `auto`(bypassPermissions). 무인 에이전트가 파일을
   *   쓰고 명령을 실행할 수 있는지를 가른다(agent/turn.ts 의 `preset.permission[...]`).
   * - `workingDir`: 그 권한이 **어느 코드베이스**에 적용되는지를 가른다. `auto` 와 겹치면
   *   대상을 바꾸는 것만으로 다른 저장소를 쓰게 만들 수 있다(agent/mentionTurn.ts 의
   *   `resolveWorkspaceDir` 주석이 같은 위험을 설명한다).
   * - `ownerAccountId`: 누가 이 에이전트의 진행 중 턴에 터미널로 attach 할 수 있는지의 게이트.
   * - `harness`: 어느 CLI 바이너리가 실제로 실행되는지.
   * - `instructions`: 에이전트가 무엇을 하도록 지시받는지. 원문은 남기지 않는다.
   */
  const AUDITED_FIELDS = {
    mentionPermission: 'value', workingDir: 'value', ownerAccountId: 'value',
    harness: 'value', instructions: 'changed',
  } as const;

  type AuditedField = keyof typeof AUDITED_FIELDS;
  type AgentSnapshot = Awaited<ReturnType<typeof getAgent>>;

  /**
   * `before` 가 null 이어도(=수정 직전에 사라진 경합) 감사 기록을 통째로 건너뛰지 않는다 —
   * 기록이 없는 것보다 before 를 모른 채 남기는 편이 낫다.
   */
  function diffAudited(before: AgentSnapshot, after: NonNullable<AgentSnapshot>) {
    const changes: Record<string, { before?: unknown; after?: unknown; changed?: true }> = {};
    for (const key of Object.keys(AUDITED_FIELDS) as AuditedField[]) {
      const prev = before ? before[key] : undefined;
      const next = after[key];
      if (before && prev === next) continue;
      changes[key] = AUDITED_FIELDS[key] === 'changed'
        ? { changed: true }
        : { before: prev, after: next };
    }
    return changes;
  }

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
    const before = await getAgent(pool, id);
    const updated = await updateAgent(pool, id, patch);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such agent' } });
    }
    // 실제로 값이 바뀐 것만 남긴다 — 같은 값으로 다시 저장한 PATCH 까지 기록하면 감사 로그가
    // "무엇이 바뀌었나"를 답하지 못하는 잡음이 된다.
    const changes = diffAudited(before, updated);
    if (Object.keys(changes).length > 0) {
      await recordAudit(pool, {
        action: 'agent.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
        target: id, detail: changes,
      }, req);
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
