import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { emitEvent } from '../events.js';
import {
  WORK_ITEM_REFUSAL_MESSAGE, WORK_ITEM_SOURCES, WORK_ITEM_STATES,
  listWorkItems, removeWorkItem, resolveWorkItemOwner, upsertWorkItem,
} from '../services/workItems.js';

/** 쓰기 몸통 — MCP `workitem.upsert` 와 같은 모양이다. 주인은 몸통으로 받지 않는다(부른 계정이 정한다). */
export const workItemUpsertSchema = {
  source: z.enum(WORK_ITEM_SOURCES),
  externalKey: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(200),
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'https only').nullable().optional(),
  state: z.enum(WORK_ITEM_STATES).nullable().optional(),
  threadRootId: z.string().uuid().nullable().optional(),
};

/**
 * 작업 항목(110, 협업 통합 설계 ①). 보드 주인 본인 — 또는 그 사람이 주인인 에이전트 — 만 읽고 쓴다.
 * 바뀌면 주인에게 `inbox.updated` 를 보낸다: 「내 작업」 보드가 이미 그 신호로 조용히 다시 읽는다.
 */
export async function registerWorkItemRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/work-items', { preHandler: app.requireAccount }, async (req, reply) => {
    const q = z.object({
      threadRootId: z.string().uuid().optional(),
      source: z.enum(WORK_ITEM_SOURCES).optional(),
    }).parse(req.query);
    const ownerId = await resolveWorkItemOwner(pool, req.account!);
    if (!ownerId) return reply.code(403).send({ error: { code: 'no_owner', message: WORK_ITEM_REFUSAL_MESSAGE.no_owner } });
    return { items: await listWorkItems(pool, ownerId, q) };
  });

  app.put('/work-items', { preHandler: app.requireAccount }, async (req, reply) => {
    const body = z.object(workItemUpsertSchema).parse(req.body);
    const ownerId = await resolveWorkItemOwner(pool, req.account!);
    if (!ownerId) return reply.code(403).send({ error: { code: 'no_owner', message: WORK_ITEM_REFUSAL_MESSAGE.no_owner } });
    const out = await upsertWorkItem(pool, {
      ownerId, actorId: req.account!.id,
      source: body.source, externalKey: body.externalKey, title: body.title,
      url: body.url ?? null, state: body.state ?? null, threadRootId: body.threadRootId ?? null,
    });
    if ('refused' in out) {
      const status = out.refused === 'thread_not_found' ? 404
        : out.refused === 'thread_forbidden' ? 403
        : out.refused === 'too_many' ? 409 : 400;
      return reply.code(status).send({ error: { code: out.refused, message: WORK_ITEM_REFUSAL_MESSAGE[out.refused] } });
    }
    emitEvent({ type: 'inbox.updated', accountId: ownerId });
    return { item: out.item };
  });

  app.delete('/work-items/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const ownerId = await resolveWorkItemOwner(pool, req.account!);
    if (!ownerId) return reply.code(403).send({ error: { code: 'no_owner', message: WORK_ITEM_REFUSAL_MESSAGE.no_owner } });
    if (!(await removeWorkItem(pool, ownerId, { id }))) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such work item' } });
    }
    emitEvent({ type: 'inbox.updated', accountId: ownerId });
    return reply.code(204).send();
  });
}
