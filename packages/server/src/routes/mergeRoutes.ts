// 에이전트 머지 권한 — 오퍼레이터의 `merge` 래퍼가 묻고 보고하는 자리. 설계 스레드 3deac356, security F1~F4.
//
// 세 라우트 전부 **오퍼레이터를 거친 에이전트만** 받는다(`secretRoutes` 의 `viaOperator` 와 같은 이유 —
// 임대가 오퍼레이터에 묶인다). 사람 세션·옛 PAT 경로는 403. 판정은 `services/mergeGrants.ts` 하나다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { checkMerge, mergeableRepos, reportMerge } from '../services/mergeGrants.js';

const REPO = z.string().min(3).max(201);
const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const base = {
  leaseId: z.string().uuid(), token: z.string().min(1).max(200),
  repo: REPO, number: z.number().int().positive(), headSha: SHA,
};

export async function registerMergeRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const viaOperator = (req: FastifyRequest, reply: FastifyReply): { agentId: string; operatorId: string } | null => {
    if (req.account!.kind !== 'agent' || !req.operator) {
      void reply.code(403).send({ error: { code: 'forbidden', message: 'only an agent through its operator can do this' } });
      return null;
    }
    return { agentId: req.account!.id, operatorId: req.operator.id };
  };

  /** 러너가 턴을 띄울 때 읽는다 — 어느 저장소에 allow 규칙을 줄지(PR 2). 자기 것만. */
  app.get('/agent/merge-grants', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    void reply.header('cache-control', 'no-store');
    return { repos: await mergeableRepos(pool, who.agentId) };
  });

  app.post('/agent/merge-checks', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    const parsed = z.object(base).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId, token, repo, number and a 40-hex headSha are required' } });
    const r = await checkMerge(pool, { ...who, ...parsed.data });
    void reply.header('cache-control', 'no-store');
    if (!r.ok) {
      // `denialId`(P3): 에이전트가 이것을 `message.ask` 의 `mergeDenialId` 로 실어 소유자에게 [7일 주기] 카드를 세운다.
      return reply.code(r.code === 'bad_repo' ? 400 : 403).send({ error: { code: r.code, message: `merge not allowed: ${r.code}`, ...(r.denialId ? { denialId: r.denialId } : {}) } });
    }
    return { allowed: true, repo: r.scope.slice('repo:'.length), grantedBy: r.grantedBy, grantedAt: r.grantedAt, causeByHuman: r.causeByHuman, channelId: r.channelId, threadRootId: r.threadRootId };
  });

  app.post('/agent/merge-results', { preHandler: app.requireAccount }, async (req, reply) => {
    const who = viaOperator(req, reply);
    if (!who) return reply;
    const parsed = z.object({
      ...base,
      result: z.enum(['merged', 'failed']),
      mergeSha: SHA.nullable().optional(),
      error: z.string().max(1000).nullable().optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'leaseId, token, repo, number, headSha and result are required' } });
    const r = await reportMerge(pool, { ...who, ...parsed.data });
    if (!r.ok) return reply.code(r.code === 'bad_repo' ? 400 : r.code === 'lease_invalid' ? 403 : 409).send({ error: { code: r.code, message: `merge result not recorded: ${r.code}` } });
    return reply.code(201).send({ messageId: r.messageId });
  });
}
