import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { RUNNABLE_HARNESSES } from '@murmur/shared';
import { getAgentDefaults, updateAgentDefaults } from '../services/agentDefaults.js';
import { recordAudit } from '../audit.js';

/**
 * 워크스페이스 설정. 지금은 새 에이전트의 기본값(#171) 하나다.
 *
 * 읽기도 `requireAdmin` 인 이유: 이 저장소의 에이전트 관리 라우트가 전부 그렇다
 * (`accountRoutes.ts` 의 `/accounts/agents*`). 기본값은 그 에이전트들의 **정의에 준하는
 * 상태**이므로 같은 게이트를 쓴다.
 */
export async function registerSettingsRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get('/settings/agent-defaults', { preHandler: app.requireAdmin }, async () => (
    getAgentDefaults(pool)
  ));

  app.put('/settings/agent-defaults', { preHandler: app.requireAdmin }, async (req) => {
    // harness 검증을 `RUNNABLE_HARNESSES` 로 좁히는 것은 에이전트 생성·수정과 같은 규칙이다
    // (#83). 실행할 수 없는 harness 를 기본값으로 두면 그 뒤 만드는 에이전트가 전부 못 돈다.
    //
    // model·effort 는 `.nullable()` 이다 — **지우기는 명시적 null 이다.** 키를 빼는 것으로
    // 지우기를 표현하면 `JSON.stringify` 가 `undefined` 를 버리는 것과 구분되지 않아,
    // 지우려는 조작이 '손대지 않음'으로 조용히 바뀐다.
    const body = z.object({
      harness: z.enum(RUNNABLE_HARNESSES).optional(),
      model: z.string().max(64).nullable().optional(),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().optional(),
    }).parse(req.body);

    const before = await getAgentDefaults(pool);
    const after = await updateAgentDefaults(pool, body);
    // 감사에 값을 그대로 남긴다 — harness·model·effort 는 비밀이 아니고, "누가 다음
    // 에이전트들의 서식을 바꿨나" 가 이 기록의 존재 이유다.
    await recordAudit(pool, {
      action: 'agent.defaults.updated', actorId: req.account!.id, actorHandle: req.account!.handle,
      detail: { before, after },
    }, req);
    return after;
  });
}
