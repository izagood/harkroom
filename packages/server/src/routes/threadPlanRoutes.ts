// 스레드 계획판(Thread Plan) P1 — 읽기 문. 쓰기는 P2 의 MCP 도구(`thread.plan`·`thread.plan.item`)가, 사람 쓰기는 3차가 연다.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { PLAN_LIMITS, PLAN_STEP_ID_RE, type ThreadPlanView } from '@harkroom/shared';
import { assertChannelVisible, channelPostGate } from '../services/channels.js';
import { threadRootChannel } from '../services/threadNote.js';
import { getThreadPlan, threadPlanView, writeThreadPlan } from '../services/threadPlan.js';
import { applyPlanItem } from '../services/threadPlanItem.js';
import { startPlanSteps } from '../services/threadPlanStart.js';
import { clearPlanAuto } from '../services/threadPlanAuto.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const startBody = z.object({
  steps: z.array(z.object({ id: z.string().regex(PLAN_STEP_ID_RE), assigneeId: z.string().uuid().optional() })).min(1).max(PLAN_LIMITS.steps),
  dryRun: z.boolean().optional(),
  ifRev: z.number().int().min(1).optional(),
  locale: z.enum(['ko', 'en']).optional(),
});
const managerBody = z.object({ managerId: z.string().uuid().nullable() });

const HTTP_BY_CODE: Record<string, number> = {
  not_found: 404, not_root: 404, forbidden: 404, no_plan: 404,
  channel_archived: 403,
  invalid_manager: 400, if_rev_required: 400,
};

export async function registerThreadPlanRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  /**
   * 스레드의 계획. 계획이 없으면 `{ plan: null }`. 루트가 아니거나 없거나 채널을 못 보면 모두 404 —
   * 못 보는 스레드에 계획이 있는지 없는지를 가르지 않는다. admin 예외는 없다(내용 읽기 권한이다).
   * 연결 그룹의 진행률은 보는 사람이 자식 채널을 볼 수 있을 때만 싣는다(`hidden`).
   */
  app.get<{ Params: { rootId: string } }>('/threads/:rootId/plan', { preHandler: app.requireAccount }, async (req, reply) => {
    const { rootId } = req.params;
    if (!UUID_RE.test(rootId)) return reply.code(404).send({ error: 'not_found' });
    const root = await threadRootChannel(pool, rootId);
    if (typeof root === 'string') return reply.code(404).send({ error: 'not_found' });
    if (!(await assertChannelVisible(pool, root.channelId, req.account!.id))) return reply.code(404).send({ error: 'not_found' });
    const row = await getThreadPlan(pool, rootId);
    const plan: ThreadPlanView | null = row ? await threadPlanView(pool, row, req.account!.id) : null;
    return { plan };
  });

  /**
   * 시작 가능한 단계를 시작한다. **사람 세션만** — 에이전트는 `thread.plan.item` 을 쓰고, PAT·오퍼레이터·자동화는 사람의 누름이
   * 아니다. `dryRun` 은 아무것도 바꾸지 않고 누구에게 어떤 글이 갈지 돌려준다(확인 상자 미리보기).
   */
  app.post<{ Params: { rootId: string } }>('/threads/:rootId/plan/start', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'human' || req.authVia !== 'session') return reply.code(403).send({ error: { code: 'human_only' } });
    const { rootId } = req.params;
    if (!UUID_RE.test(rootId)) return reply.code(404).send({ error: { code: 'not_found' } });
    const body = startBody.parse(req.body);
    const seen = new Set<string>();
    const steps = body.steps.filter((s) => !seen.has(s.id) && seen.add(s.id));
    const res = await startPlanSteps(pool, { rootId, actorId: req.account!.id, steps, dryRun: body.dryRun, ifRev: body.ifRev, locale: body.locale });
    if (!res.ok) return reply.code(HTTP_BY_CODE[res.error.code] ?? 409).send({ error: res.error });
    if (!res.dryRun && !res.started.length && res.failed.length) return reply.code(502).send({ error: { code: 'post_failed', failed: res.failed } });
    return res;
  });

  /** 관리 에이전트를 바꾸거나 비운다. 사람 세션만 — 에이전트는 `thread.plan.item` 의 `type: 'plan'` 을 쓴다. */
  app.put<{ Params: { rootId: string } }>('/threads/:rootId/plan/manager', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'human' || req.authVia !== 'session') return reply.code(403).send({ error: { code: 'human_only' } });
    const { rootId } = req.params;
    if (!UUID_RE.test(rootId)) return reply.code(404).send({ error: { code: 'not_found' } });
    const { managerId } = managerBody.parse(req.body);
    const root = await threadRootChannel(pool, rootId);
    if (typeof root === 'string') return reply.code(404).send({ error: { code: root } });
    if ((await channelPostGate(pool, root.channelId, req.account!.id)) === 'archived') return reply.code(403).send({ error: { code: 'channel_archived' } });
    const res = await writeThreadPlan<{ code: string }>(pool, rootId, { accountId: req.account!.id }, (prev) => {
      const r = applyPlanItem(prev, { type: 'plan', managerId });
      return 'error' in r ? r : { doc: r.doc };
    });
    if (!res.ok) return reply.code(HTTP_BY_CODE[res.error.code] ?? 409).send({ error: res.error });
    if ('deleted' in res) return reply.code(404).send({ error: { code: 'no_plan' } });
    return { plan: await threadPlanView(pool, res.row, req.account!.id) };
  });

  /**
   * 자동 진행을 끈다. 그 스레드를 볼 수 있는 사람이면 누구나 끌 수 있다 — 멈추는 쪽은 좁히지 않는다. 사람 세션만.
   * 켜는 길은 여기 없다: 사람 글을 근거로 관리 에이전트가 적는다(`threadPlanAuto.ts`).
   */
  app.delete<{ Params: { rootId: string } }>('/threads/:rootId/plan/auto', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'human' || req.authVia !== 'session') return reply.code(403).send({ error: { code: 'human_only' } });
    const { rootId } = req.params;
    if (!UUID_RE.test(rootId)) return reply.code(404).send({ error: { code: 'not_found' } });
    const root = await threadRootChannel(pool, rootId);
    if (typeof root === 'string') return reply.code(404).send({ error: { code: root } });
    if (!(await assertChannelVisible(pool, root.channelId, req.account!.id))) return reply.code(404).send({ error: { code: 'not_found' } });
    const res = await clearPlanAuto(pool, { rootId, actor: { kind: 'human', accountId: req.account!.id } });
    if (!res.ok) return reply.code(404).send({ error: res.error });
    return { plan: await threadPlanView(pool, res.row, req.account!.id) };
  });
}
