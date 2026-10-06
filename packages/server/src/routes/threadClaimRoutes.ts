// (에이전트, 스레드) 턴 임대 — 러너가 멘션 턴을 띄우기 전에 잡고, 턴 동안 밀고, 끝나면 놓는다.
// 왜 서버에 두는지는 마이그레이션 095 머리 주석, 판정은 `services/threadClaims.ts`.
//
// 에이전트 계정만 받는다. 대상 에이전트 id 를 받지 않는다 — 자격의 주인 몫만 잡고 놓는다(`/agent/activity`
// 와 같은 규칙). 사람 계정에는 뜻이 없는 요청이라 403 이다.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  claimThread, releaseThread,
  THREAD_CLAIM_DEFAULT_TTL_SEC, THREAD_CLAIM_MAX_TTL_SEC, THREAD_CLAIM_MIN_TTL_SEC,
} from '../services/threadClaims.js';

const key = {
  channelId: z.string().uuid(),
  threadRootId: z.string().uuid(),
  holder: z.string().min(1).max(100),
};

export async function registerThreadClaimRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const agentOnly = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (req.account!.kind !== 'agent') {
      void reply.code(403).send({ error: { code: 'agent_only', message: 'thread claims are only for agent accounts' } });
      return null;
    }
    return req.account!.id;
  };

  /** 잡기와 하트비트가 같은 호출이다(같은 holder 면 민다). 남이 살아 있는 임대를 쥐었으면 409. */
  app.post('/agent/thread-claims', { preHandler: app.requireAccount }, async (req, reply) => {
    const agentId = agentOnly(req, reply);
    if (!agentId) return reply;
    const parsed = z.object({
      ...key,
      ttlSec: z.number().int().min(THREAD_CLAIM_MIN_TTL_SEC).max(THREAD_CLAIM_MAX_TTL_SEC).optional(),
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId, threadRootId (uuid) and holder are required' } });
    }
    const { ttlSec, ...rest } = parsed.data;
    const r = await claimThread(pool, { agentId, ...rest }, ttlSec ?? THREAD_CLAIM_DEFAULT_TTL_SEC);
    void reply.header('cache-control', 'no-store');
    if (!r.ok) {
      return reply.code(409).send({
        error: { code: 'thread_claimed', message: 'another runner of this agent holds this thread' },
        expiresAt: r.expiresAt,
      });
    }
    return { claimed: true, expiresAt: r.expiresAt };
  });

  /** 놓기. 멱등이다 — 이미 없거나 남에게 넘어갔어도 204(옛 holder 가 남의 임대를 지우지는 않는다). */
  app.post('/agent/thread-claims/release', { preHandler: app.requireAccount }, async (req, reply) => {
    const agentId = agentOnly(req, reply);
    if (!agentId) return reply;
    const parsed = z.object(key).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'channelId, threadRootId (uuid) and holder are required' } });
    }
    await releaseThread(pool, { agentId, ...parsed.data });
    return reply.code(204).send();
  });
}
