// 위임(mandate) W2 — 위임장의 줄 읽기. **소유자 사람 세션만**(에이전트 토큰·사람 PAT·다른 사람은 404 — 남의 위임이 있는지도 말하지 않는다).
// 쓰기 자리는 아직 없다(그림자 단계). 줄은 `services/mandateLines.ts::listMandateLines` 하나에서 온다(상시 줄 포함).
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { listMandateLines } from '../services/mandateLines.js';
import { endMandate } from '../services/mandateEnd.js';
import { actorOf, recordAudit } from '../audit.js';

export async function registerMandateRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Params: { id: string } }>('/mandates/:id/lines', { preHandler: app.requireAccount }, async (req, reply) => {
    const notFound = () => reply.code(404).send({ error: { code: 'not_found', message: 'no such mandate' } });
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return notFound();
    if (req.account!.kind !== 'human' || req.authVia !== 'session') return notFound();
    const m = await pool.query(`select 1 from mandate where id = $1 and owner_account_id = $2`, [p.data.id, req.account!.id]);
    if (!m.rowCount) return notFound();
    void reply.header('cache-control', 'no-store');
    const lines = await listMandateLines(pool, p.data.id);
    return {
      lines: lines.map((l) => ({
        id: l.id, cap: l.cap, scope: l.scope, limits: l.limits, agentIds: l.agentIds, grantedBy: l.grantedBy, via: l.via,
        requestId: l.requestId, usedCount: l.usedCount, createdAt: new Date(l.createdAt).toISOString(), readOnly: l.readOnly,
      })),
    };
  });

  // 3판: 소유자가 [위임 끝] 을 누른다. 같은 규칙 — 소유자 사람 세션만, 나머지는 404. 이미 끝났으면 그대로 200(멱등, `ended: false`).
  app.post<{ Params: { id: string } }>('/mandates/:id/end', { preHandler: app.requireAccount }, async (req, reply) => {
    const notFound = () => reply.code(404).send({ error: { code: 'not_found', message: 'no such mandate' } });
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return notFound();
    if (req.account!.kind !== 'human' || req.authVia !== 'session') return notFound();
    const m = await pool.query(`select 1 from mandate where id = $1 and owner_account_id = $2`, [p.data.id, req.account!.id]);
    if (!m.rowCount) return notFound();
    const ended = await endMandate(pool, p.data.id, 'owner');
    if (ended) await recordAudit(pool, { action: 'mandate.ended', ...actorOf(req), target: p.data.id, detail: { reason: 'owner' } }, req);
    const row = (await pool.query<{ endedAt: Date; endReason: string }>(
      `select ended_at as "endedAt", end_reason as "endReason" from mandate where id = $1`, [p.data.id])).rows[0];
    return { ended, endedAt: row?.endedAt ? new Date(row.endedAt).toISOString() : null, endReason: row?.endReason ?? null };
  });
}
