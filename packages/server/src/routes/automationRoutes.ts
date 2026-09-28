import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_MESSAGE_BODY_CHARS } from '@harkroom/shared';
import { channelPostGate } from '../services/channels.js';
import {
  createAutomation, deleteAutomation, enqueueRun, getAutomation, listAutomations, listRuns,
  timeVars, triggerSchema, updateAutomation,
} from '../services/automations.js';

/**
 * 자동화(마이그레이션 064). 만든 사람만 보고 고친다.
 *
 * **사람만 만든다** — 예약 메시지(#222)의 `agents_cannot_schedule` 과 같은 이유다: 에이전트가
 * "나중에, 반복해서 터뜨린다"를 스스로 고르면 사람이 그 발화를 예측할 수 없다. 에이전트가
 * 제안하고 사람이 승인하는 길은 따로 둔다.
 */
export async function registerAutomationRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const idParam = z.object({ id: z.string().uuid() });
  const agentRefused = { error: { code: 'agents_cannot_automate', message: 'agents cannot create or change automations' } };
  const notFound = { error: { code: 'not_found', message: 'automation not found' } };

  /** 대상 채널에 **지금** 쓸 수 있는지. 만들 때 막아 두면 첫 회차가 거부로 멈추는 일이 없다. */
  async function gateFor(channelId: string, accountId: string): Promise<{ code: number; body: unknown } | null> {
    const exists = await pool.query(`select 1 from channel where id = $1`, [channelId]);
    if (!exists.rowCount) return { code: 404, body: { error: { code: 'channel_not_found', message: 'channel not found' } } };
    const gate = await channelPostGate(pool, channelId, accountId);
    if (gate === 'forbidden') return { code: 403, body: { error: { code: 'forbidden', message: 'not a member of this channel' } } };
    if (gate === 'archived') return { code: 403, body: { error: { code: 'channel_archived', message: 'archived channels are read-only' } } };
    return null;
  }

  app.get('/automations', { preHandler: app.requireAccount }, async (req) => {
    return { automations: await listAutomations(pool, req.account!.id) };
  });

  app.post('/automations', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind === 'agent') return reply.code(403).send(agentRefused);
    const input = z.object({
      name: z.string().trim().min(1).max(100),
      channelId: z.string().uuid(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
      trigger: triggerSchema,
    }).parse(req.body);
    const refused = await gateFor(input.channelId, req.account!.id);
    if (refused) return reply.code(refused.code).send(refused.body);
    const automation = await createAutomation(pool, { ...input, ownerId: req.account!.id });
    return reply.code(201).send({ automation });
  });

  app.get('/automations/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const automation = await getAutomation(pool, id, req.account!.id);
    if (!automation) return reply.code(404).send(notFound);
    return { automation, runs: await listRuns(pool, id) };
  });

  app.patch('/automations/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind === 'agent') return reply.code(403).send(agentRefused);
    const { id } = idParam.parse(req.params);
    const patch = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      channelId: z.string().uuid().optional(),
      body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS).optional(),
      trigger: triggerSchema.optional(),
      enabled: z.boolean().optional(),
    }).strict().parse(req.body);
    if (patch.channelId) {
      const refused = await gateFor(patch.channelId, req.account!.id);
      if (refused) return reply.code(refused.code).send(refused.body);
    }
    const automation = await updateAutomation(pool, id, req.account!.id, patch);
    if (!automation) return reply.code(404).send(notFound);
    return { automation };
  });

  app.delete('/automations/:id', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind === 'agent') return reply.code(403).send(agentRefused);
    const { id } = idParam.parse(req.params);
    if (!(await deleteAutomation(pool, id, req.account!.id))) return reply.code(404).send(notFound);
    return reply.code(204).send();
  });

  /**
   * "지금 한 번 돌리기". 꺼진 자동화도 돌린다 — 켜기 전에 본문이 어떻게 나가는지 보는 것이
   * 이 버튼의 쓸모다. 회차로만 만들고 발송은 sweeper 가 한다(다음 박자, 15초 안쪽).
   */
  app.post('/automations/:id/run', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind === 'agent') return reply.code(403).send(agentRefused);
    const { id } = idParam.parse(req.params);
    const automation = await getAutomation(pool, id, req.account!.id);
    if (!automation) return reply.code(404).send(notFound);
    const vars = automation.trigger.kind === 'schedule' ? timeVars(new Date(), automation.trigger.tz) : {};
    const result = await enqueueRun(pool, {
      automationId: id, eventKey: `manual:${randomUUID()}`, triggerKind: 'manual', vars, ignoreEnabled: true,
    });
    if (result.status === 'rate_limited') {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'too many runs in the last hour; automation paused' } });
    }
    if (result.status !== 'queued') return reply.code(409).send({ error: { code: result.status, message: 'not queued' } });
    return reply.code(202).send({ run: result.run });
  });
}
