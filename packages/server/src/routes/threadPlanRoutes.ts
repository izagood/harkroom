// 스레드 계획판(Thread Plan) P1 — 읽기 문. 쓰기는 P2 의 MCP 도구(`thread.plan`·`thread.plan.item`)가, 사람 쓰기는 3차가 연다.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { ThreadPlanView } from '@harkroom/shared';
import { assertChannelVisible } from '../services/channels.js';
import { threadRootChannel } from '../services/threadNote.js';
import { getThreadPlan, threadPlanView } from '../services/threadPlan.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}
