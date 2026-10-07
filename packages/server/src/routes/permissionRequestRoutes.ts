// 에이전트 권한 요청(111, 스레드 f61af808). 판정과 쓰기는 `services/permissionRequests.ts` 하나다.
//
// - 승인·거절·1회 승인(approve-once, 머지 거절에서 온 카드만): **사람 세션만**(에이전트 토큰은 물론 사람 PAT 도 403), 그리고 **그 에이전트의 소유자**만. admin 역할은 여기서
//   힘이 없다(merge-denial 의 C5 와 같다). 요청 본문은 읽지 않는다 — 범위·기한은 요청 줄과 서버 상수다.
// - `GET /agent/tool-allows`: 러너가 턴을 띄울 때 이 채널의 allow 규칙을 읽는다. 오퍼레이터를 거친 에이전트만, 자기 것만.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { commandGrantsFor, decidePermissionRequest, matchCommandGrant, toolAllowsFor } from '../services/permissionRequests.js';

const params = z.object({ id: z.string().uuid(), requestId: z.string().uuid(), decision: z.enum(['approve', 'deny', 'approve-once', 'approve_once', 'approve_hour']) });
/** [이번 한 번 머지](스레드 1b75d7a0) — 받는 것은 gh 계정·CI 완화 둘뿐. 저장소·PR·head 는 요청에 묶인 거절 기록이다. */
// number·headSha 는 카드가 보여 준 값 — 대조에만 쓴다(security F1). 저장소·PR·head 의 출처는 여전히 거절 기록이다.
const onceBody = z.object({
  ghUser: z.string().min(1).max(39), relaxChecks: z.boolean().optional(),
  number: z.number().int().positive(), headSha: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();

export async function registerPermissionRequestRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.post<{ Params: { id: string; requestId: string; decision: string } }>(
    '/agents/:id/permission-requests/:requestId/:decision', { preHandler: app.requireAccount }, async (req, reply) => {
      const p = params.safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id and request id must be uuids; decision is approve, approve-once (a merge refusal card), approve_once, approve_hour (an exact command) or deny' } });
      if (req.account!.kind !== 'human' || req.authVia !== 'session') {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'only a person signed in to the app can decide a permission request' } });
      }
      const owner = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [p.data.id, req.account!.id]);
      if (!owner.rowCount) return reply.code(403).send({ error: { code: 'forbidden', message: 'only the owner of this agent can decide its permission requests' } });
      let once: { ghUser: string; relaxChecks: boolean; number: number; headSha: string } | undefined;
      if (p.data.decision === 'approve-once') {
        const b = onceBody.safeParse(req.body ?? {});
        if (!b.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'ghUser, number and a 40-hex headSha are required; relaxChecks is a boolean; nothing else' } });
        once = { ghUser: b.data.ghUser, relaxChecks: b.data.relaxChecks ?? false, number: b.data.number, headSha: b.data.headSha };
      }
      const decision = p.data.decision === 'approve-once' ? 'approve_once' : p.data.decision;
      const r = await decidePermissionRequest(pool, { agentId: p.data.id, requestId: p.data.requestId, actorId: req.account!.id, decision, ...(once ? { once } : {}) });
      if (!r.ok) return reply.code(r.status).send({ error: { code: r.code, message: r.message } });
      return { status: r.status, grantExpiresAt: r.grantExpiresAt, ...(r.approvalExpiresAt ? { approvalExpiresAt: r.approvalExpiresAt } : {}), cardMessageId: r.cardMessageId, ...(r.grantMode ? { grantMode: r.grantMode } : {}) };
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

  // 정확한 명령 grant(H②, 112). 오퍼레이터를 거친 에이전트만, 자기 것만. 목록은 읽기만, match 는 맞으면 그 grant 하나를 쓴다.
  const threadQuery = z.object({ channelId: z.string().uuid(), threadRootId: z.string().uuid() });
  app.get<{ Querystring: { channelId?: string; threadRootId?: string } }>('/agent/command-grants', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
    }
    const q = threadQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId and threadRootId (uuids) are required' } });
    void reply.header('cache-control', 'no-store');
    return { grants: await commandGrantsFor(pool, req.account!.id, q.data.channelId, q.data.threadRootId) };
  });

  const matchBody = threadQuery.extend({ command: z.string().min(1).max(2000), toolUseId: z.string().max(200).optional() });
  app.post<{ Body: unknown }>('/agent/command-grants/match', { preHandler: app.requireAccount }, async (req, reply) => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
    }
    const b = matchBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId, threadRootId (uuids) and command are required' } });
    void reply.header('cache-control', 'no-store');
    return matchCommandGrant(pool, { agentId: req.account!.id, ...b.data });
  });
}

