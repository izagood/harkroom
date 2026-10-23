// 에이전트의 머지 계정 줄(D1) — 그 에이전트를 도는 오퍼레이터가 알린 gh 이름·저장소별 계정 줄. 이름뿐이다(토큰·이메일 없음).
//
// **사람 세션만, 그 에이전트의 소유자만** 받는다(머지 카드 grant 와 같은 판정). 소유자가 아니면 그런 에이전트가 있는지도
// 말하지 않는다 — 404.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { mergeAccountsOf } from '../services/operatorGhReport.js';

const params = z.object({ id: z.string().uuid() });

export async function registerMergeAccountRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Params: { id: string } }>('/agents/:id/merge-accounts', { preHandler: app.requireAccount }, async (req, reply) => {
    const p = params.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: { code: 'bad_request', message: 'agent id must be a uuid' } });
    const notFound = () => reply.code(404).send({ error: { code: 'not_found', message: 'agent not found' } });
    if (req.account!.kind !== 'human' || req.authVia !== 'session') return notFound();
    const owner = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [p.data.id, req.account!.id]);
    if (!owner.rowCount) return notFound();
    void reply.header('cache-control', 'no-store');
    return mergeAccountsOf(pool, p.data.id);
  });
}
