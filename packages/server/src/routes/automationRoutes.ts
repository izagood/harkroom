import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_MESSAGE_BODY_CHARS } from '@harkroom/shared';
import { channelPostGate } from '../services/channels.js';
import type { SecretBox } from '../services/secretBox.js';
import {
  genericVars, issueIngress, loadIngressTarget, matchGithub, revokeIngress, verifyBearer, verifyGithubSignature,
} from '../services/automationIngress.js';
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
export async function registerAutomationRoutes(
  app: FastifyInstance, pool: Pool, opts: { secretBox: SecretBox | null } = { secretBox: null },
): Promise<void> {
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
      debounceSec: z.number().int().min(0).max(3600).nullable().optional(),
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
      debounceSec: z.number().int().min(0).max(3600).nullable().optional(),
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

  // ── 외부 수신(065) ──────────────────────────────────────────────────────

  /**
   * 수신 켜기 / 키 다시 받기. **키 원문은 이 응답에만 있다** — 서버는 해시(범용)와 암호문
   * (GitHub)만 남긴다. 다시 부르면 옛 키는 곧바로 무효다.
   */
  app.post('/automations/:id/ingress', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind === 'agent') return reply.code(403).send(agentRefused);
    const { id } = idParam.parse(req.params);
    const automation = await getAutomation(pool, id, req.account!.id);
    if (!automation) return reply.code(404).send(notFound);
    const issued = await issueIngress(pool, id, req.account!.id, automation.trigger, opts.secretBox);
    if (issued === 'not_found') return reply.code(404).send(notFound);
    if (issued === 'schedule_has_no_ingress') {
      return reply.code(400).send({ error: { code: issued, message: 'schedule automations do not receive events' } });
    }
    if (issued === 'needs_secret_key') {
      return reply.code(409).send({ error: { code: issued, message: 'HARKROOM_SECRET_KEY is not set on the server; GitHub signatures cannot be verified' } });
    }
    return reply.code(201).send({ ingress: issued });
  });

  app.delete('/automations/:id/ingress', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind === 'agent') return reply.code(403).send(agentRefused);
    const { id } = idParam.parse(req.params);
    if (!(await revokeIngress(pool, id, req.account!.id))) return reply.code(404).send(notFound);
    return reply.code(204).send();
  });

  /**
   * 입구 두 개. 로그인 없이 부르는 **유일한** 자동화 표면이라 판정 순서가 중요하다:
   * (1) 수신이 꺼졌거나 없는 id 는 404 — 인증 실패와 구분되지 않게 해 존재를 드러내지 않는다,
   * (2) 서명·키가 틀리면 401, (3) 필터에 안 맞으면 200 `ignored`(GitHub 이 재전송하지 않게),
   * (4) 맞으면 회차를 만들고 202.
   *
   * GitHub 서명은 **원문 바이트**로 검증해야 하므로 이 범위에서만 JSON 파서를 buffer 로 바꾼다.
   */
  await app.register(async (hooks) => {
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    const hookNotFound = { error: { code: 'not_found', message: 'not found' } };
    const parse = (raw: unknown): unknown => {
      if (!Buffer.isBuffer(raw) || raw.length === 0) return {};
      try { return JSON.parse(raw.toString('utf8')); } catch { return undefined; }
    };

    hooks.post('/hooks/github/:id', async (req, reply) => {
      const parsedId = idParam.safeParse(req.params);
      if (!parsedId.success) return reply.code(404).send(hookNotFound);
      const target = await loadIngressTarget(pool, parsedId.data.id);
      if (!target || target.trigger.kind !== 'github') return reply.code(404).send(hookNotFound);
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = req.headers['x-hub-signature-256'];
      if (!verifyGithubSignature(target, opts.secretBox, raw, typeof sig === 'string' ? sig : undefined)) {
        return reply.code(401).send({ error: { code: 'bad_signature', message: 'signature does not match' } });
      }
      const event = String(req.headers['x-github-event'] ?? '');
      if (event === 'ping') return reply.code(200).send({ status: 'pong' });
      const payload = parse(req.body);
      if (!payload || typeof payload !== 'object') return reply.code(400).send({ error: { code: 'bad_json', message: 'body is not JSON' } });
      const m = matchGithub(target.trigger, event, payload as Record<string, unknown>);
      if (!m.match) return reply.code(200).send({ status: 'ignored', reason: m.reason });
      const delivery = String(req.headers['x-github-delivery'] ?? '') || randomUUID();
      const result = await enqueueRun(pool, {
        automationId: target.id, eventKey: `github:${delivery}`, triggerKind: 'github', vars: m.vars,
      });
      return reply.code(result.status === 'queued' || result.status === 'merged' ? 202 : 200).send({ status: result.status });
    });

    hooks.post('/hooks/generic/:id', async (req, reply) => {
      const parsedId = idParam.safeParse(req.params);
      if (!parsedId.success) return reply.code(404).send(hookNotFound);
      const target = await loadIngressTarget(pool, parsedId.data.id);
      if (!target) return reply.code(404).send(hookNotFound);
      if (!verifyBearer(target, req.headers.authorization)) {
        return reply.code(401).send({ error: { code: 'bad_key', message: 'key does not match' } });
      }
      const payload = parse(req.body);
      if (payload === undefined) return reply.code(400).send({ error: { code: 'bad_json', message: 'body is not JSON' } });
      const idem = req.headers['idempotency-key'];
      const result = await enqueueRun(pool, {
        automationId: target.id,
        eventKey: `generic:${typeof idem === 'string' && idem ? idem.slice(0, 200) : randomUUID()}`,
        triggerKind: target.trigger.kind === 'github' ? 'github' : 'webhook',
        vars: genericVars(payload),
      });
      if (result.status === 'rate_limited') return reply.code(429).send({ status: result.status });
      return reply.code(result.status === 'queued' || result.status === 'merged' ? 202 : 200).send({ status: result.status });
    });
  });
}
