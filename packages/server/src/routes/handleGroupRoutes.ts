import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { HANDLE_PATTERN } from '@murmur/shared';
import { recordAudit } from '../audit.js';
import {
  createHandleGroup, deleteHandleGroup, getHandleGroup, listHandleGroupMembers,
  listHandleGroups, updateHandleGroup, addHandleGroupMembers, removeHandleGroupMembers,
  getHandleGroupByHandle,
} from '../services/handleGroups.js';

/**
 * 사람 집합(#230)의 관리 표면. **admin 전용**이다 — 누가 한 이름으로 불릴 수 있는지를
 * 정하는 조작이라 소유자에게도 열지 않는다.
 *
 * 집합 handle 은 **계정과 같은 네임스페이스**를 쓴다. 그래서 문법도 계정과 같은 것을
 * 봐야 한다 — `HANDLE_PATTERN` 을 쓰는 이유다. 여기 리터럴로 다시 적으면 계정 쪽 문법이
 * 바뀔 때 한쪽만 따라가고, `@foo` 가 어느 쪽으로 갈리는지 알 수 없게 된다.
 */
const handleSchema = z.string().regex(new RegExp(`^${HANDLE_PATTERN}$`));

export async function registerHandleGroupRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/handle-groups', { preHandler: app.requireAdmin }, async () => ({
    groups: await listHandleGroups(pool),
  }));

  app.post('/handle-groups', { preHandler: app.requireAdmin }, async (req, reply) => {
    const body = z.object({
      handle: handleSchema,
      displayName: z.string().min(1).max(64),
    }).parse(req.body);

    // 먼저 읽는 것은 **사유를 구분해 말하기 위해서**다 — 계정과 겹쳤는지 집합과 겹쳤는지
    // 운영자가 알아야 다음 행동이 갈린다. 다만 이 읽기가 판정의 근거는 아니다: 실제
    // 판정은 `createHandleGroup` 의 한 문장(계정 확인 + 삽입)과 unique 제약이 한다.
    const existingGroup = await getHandleGroupByHandle(pool, body.handle);
    if (existingGroup) {
      return reply.code(400).send({
        error: { code: 'handle_taken', message: 'a group with this handle already exists' },
      });
    }

    const created = await createHandleGroup(pool, body);
    if (!created) {
      // 같은 이름의 계정이 있다 — `createHandleGroup` 이 한 문장에서 걸렀다.
      return reply.code(400).send({
        error: { code: 'handle_taken', message: 'an account with this handle already exists' },
      });
    }
    await recordAudit(pool, {
      action: 'handle_group.created', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: created.id, detail: { handle: body.handle },
    }, req);
    return reply.code(201).send(created);
  });

  app.get('/handle-groups/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const group = await getHandleGroup(pool, id);
    if (!group) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }
    const members = await listHandleGroupMembers(pool, id);
    return { group, members: members.map((m) => m.accountId) };
  });

  app.patch('/handle-groups/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const patch = z.object({
      displayName: z.string().min(1).max(64),
    }).parse(req.body);
    const updated = await updateHandleGroup(pool, id, patch);
    if (!updated) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }
    await recordAudit(pool, {
      action: 'handle_group.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { displayName: patch.displayName },
    }, req);
    return updated;
  });

  app.delete('/handle-groups/:id', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const deleted = await deleteHandleGroup(pool, id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }
    await recordAudit(pool, {
      action: 'handle_group.deleted', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id,
    }, req);
    return reply.code(204).send();
  });

  app.post('/handle-groups/:id/members', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      // 빈 배열은 거절한다 — 아무것도 하지 않는 요청이 200 으로 돌아오면 부른 쪽은
      // 넣혔다고 믿는다(docs/design.md 4절).
      accountIds: z.array(z.string().uuid()).min(1),
    }).parse(req.body);

    const group = await getHandleGroup(pool, id);
    if (!group) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }

    /**
     * **에이전트는 집합에 넣지 않는다**(#230 결정 1). 에이전트 셋이 든 집합을 멘션하면
     * 턴 셋이 동시에 시작되고, 그것은 `#172`(에이전트를 팀으로 묶는다)가 반대편에서 묻고
     * 있는 질문이다 — 여기서 답하면 서로 무관한 묶음 개념이 murmur 에 둘 생긴다.
     *
     * 하나라도 에이전트면 **요청 전체를 거절한다.** 사람만 골라 넣고 200 을 주면 운영자는
     * 전부 들어갔다고 믿는다.
     */
    const agents = await pool.query<{ handle: string }>(
      `select handle from account where id = any($1) and kind = 'agent'`,
      [body.accountIds],
    );
    if (agents.rowCount) {
      return reply.code(400).send({
        error: {
          code: 'agent_not_allowed',
          message: `agents cannot be added to groups: ${agents.rows.map((r) => `@${r.handle}`).join(', ')}`,
        },
      });
    }

    const inserted = await addHandleGroupMembers(pool, id, body.accountIds);
    const members = await listHandleGroupMembers(pool, id);
    await recordAudit(pool, {
      action: 'handle_group.members.added', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: group.handle, requested: body.accountIds.length, inserted },
    }, req);
    return { members: members.map((m) => m.accountId) };
  });

  app.delete('/handle-groups/:id/members', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      accountIds: z.array(z.string().uuid()).min(1),
    }).parse(req.body);

    const group = await getHandleGroup(pool, id);
    if (!group) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such group' } });
    }

    const removed = await removeHandleGroupMembers(pool, id, body.accountIds);
    const members = await listHandleGroupMembers(pool, id);
    await recordAudit(pool, {
      action: 'handle_group.members.removed', actorId: req.account!.id, actorHandle: req.account!.handle,
      target: id, detail: { handle: group.handle, requested: body.accountIds.length, removed },
    }, req);
    return { members: members.map((m) => m.accountId) };
  });
}