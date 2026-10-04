// 머지 거절 카드의 [7일 주기](스레드 febe9ff8 P3, security C4·C5). 판정과 쓰기는 `services/mergeDenials.ts` 하나다.
//
// **사람 세션만** 받는다(C5) — 에이전트 토큰은 물론 사람 PAT 도 403. PAT 인증 kind 제한이 아직 후속이라 여기서 따로 막는다.
// 그리고 **그 에이전트의 소유자**만(F2 와 같은 판정). admin 역할은 여기서 힘이 없다.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { grantFromDenial } from '../services/mergeDenials.js';

const params = z.object({ id: z.string().uuid(), denialId: z.string().uuid() });

export async function registerMergeDenialRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post<{ Params: { id: string; denialId: string } }>('/agents/:id/merge-denials/:denialId/grant', { preHandler: app.requireAccount }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id and denial id must be uuids' } });
    if (req.account!.kind !== 'human' || req.authVia !== 'session') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only a person signed in to the app can grant from a merge card' } });
    }
    const owner = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [p.data.id, req.account!.id]);
    if (!owner.rowCount) return reply.code(403).send({ error: { code: 'forbidden', message: 'only the owner of this agent can grant merge permission' } });
    // 요청 본문은 읽지 않는다 — scope·기한은 거절 기록과 서버 상수다(C4).
    const r = await grantFromDenial(pool, { agentId: p.data.id, denialId: p.data.denialId, actorId: req.account!.id });
    if (!r.ok) return reply.code(r.status).send({ error: { code: r.code, message: r.message } });
    return { repo: r.scope.slice('repo:'.length), expiresAt: r.expiresAt, cardMessageId: r.cardMessageId };
  });
}
