// 에이전트 권한 요청(111, 스레드 f61af808). 판정과 쓰기는 `services/permissionRequests.ts` 하나다.
//
// - 승인·거절: **사람 세션만**(에이전트 토큰은 물론 사람 PAT 도 403), 그리고 **그 에이전트의 소유자**만. admin 역할은 여기서
//   힘이 없다(merge-denial 의 C5 와 같다). 요청 본문은 읽지 않는다 — 범위·기한은 요청 줄과 서버 상수다.
// - `GET /agent/tool-allows`: 러너가 턴을 띄울 때 이 채널의 allow 규칙을 읽는다. 오퍼레이터를 거친 에이전트만, 자기 것만.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { decidePermissionRequest, toolAllowsFor } from '../services/permissionRequests.js';

const params = z.object({ id: z.string().uuid(), requestId: z.string().uuid(), decision: z.enum(['approve', 'deny']) });

export async function registerPermissionRequestRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post<{ Params: { id: string; requestId: string; decision: string } }>(
    '/agents/:id/permission-requests/:requestId/:decision', { preHandler: app.requireAccount }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id and request id must be uuids; decision is approve or deny' } });
      if (req.account!.kind !== 'human' || req.authVia !== 'session') {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'only a person signed in to the app can decide a permission request' } });
      }
      const owner = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [p.data.id, req.account!.id]);
      if (!owner.rowCount) return reply.code(403).send({ error: { code: 'forbidden', message: 'only the owner of this agent can decide its permission requests' } });
      const r = await decidePermissionRequest(pool, { agentId: p.data.id, requestId: p.data.requestId, actorId: req.account!.id, decision: p.data.decision });
      if (!r.ok) return reply.code(r.status).send({ error: { code: r.code, message: r.message } });
      return { status: r.status, grantExpiresAt: r.grantExpiresAt, cardMessageId: r.cardMessageId };
    });

  app.get<{ Querystring: { channelId?: string } }>('/agent/tool-allows', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
    }
    const q = z.object({ channelId: z.string().uuid() }).safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId (uuid) is required' } });
    void reply.header('cache-control', 'no-store');
    return { rules: await toolAllowsFor(pool, req.account!.id, q.data.channelId) };
  });
}
