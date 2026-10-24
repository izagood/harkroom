// 위임(mandate) W2 — 위임장의 줄 읽기, g1 — 줄 하나 빼기. **소유자 사람 세션만**(에이전트 토큰·사람 PAT·다른 사람은 404 — 남의 위임이 있는지도 말하지 않는다).
// 줄은 `services/mandateLines.ts::listMandateLines` 하나에서 온다(상시 줄 포함). 빼기는 `revokeMandateLine`.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from '../services/channels.js';
import { endMandate } from '../services/mandateEnd.js';
import { listMandateLines, revokeMandateLine } from '../services/mandateLines.js';
import { getMessageById } from '../services/messages.js';

export async function registerMandateRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { code: 'not_found', message: 'no such mandate' } });
  /** 소유자 사람 세션이고 그 위임이 있으면 true. 아니면 404 를 보내고 false. */
  const ownMandate = async (req: FastifyRequest, reply: FastifyReply, id: string): Promise<boolean> => {
    if (req.account!.kind !== 'human' || req.authVia !== 'session') { void notFound(reply); return false; }
    const m = await pool.query(`select 1 from mandate where id = $1 and owner_account_id = $2`, [id, req.account!.id]);
    if (!m.rowCount) { void notFound(reply); return false; }
    return true;
  };

  app.get<{ Params: { id: string } }>('/mandates/:id/lines', { preHandler: app.requireAccount }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return notFound(reply);
    if (!(await ownMandate(req, reply, p.data.id))) return reply;
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
    const p = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return notFound(reply);
    if (!(await ownMandate(req, reply, p.data.id))) return reply;
    const ended = await endMandate(pool, p.data.id, 'owner');
    if (ended) await recordAudit(pool, { action: 'mandate.ended', ...actorOf(req), target: p.data.id, detail: { reason: 'owner' } }, req);
    const row = (await pool.query<{ endedAt: Date; endReason: string }>(
      `select ended_at as "endedAt", end_reason as "endReason" from mandate where id = $1`, [p.data.id])).rows[0];
    return { ended, endedAt: row?.endedAt ? new Date(row.endedAt).toISOString() : null, endReason: row?.endReason ?? null };
  });

  // g1 줄 빼기 — 그 위임의 저장된 줄만. 상시 줄은 409 `standing_line`(설정에서 grant 를 거둔다). 줄을 적은 카드에 `lineRevokedAt` 을 적는다.
  app.delete<{ Params: { id: string; lineId: string } }>('/mandates/:id/lines/:lineId', { preHandler: app.requireAccount }, async (req, reply) => {
    const p = z.object({ id: z.string().uuid(), lineId: z.string().uuid() }).safeParse(req.params);
    if (!p.success) return notFound(reply);
    if (!(await ownMandate(req, reply, p.data.id))) return reply;
    const r = await revokeMandateLine(pool, { mandateId: p.data.id, lineId: p.data.lineId });
    if (!r.ok) {
      if (r.code === 'standing_line') {
        return reply.code(409).send({ error: { code: 'standing_line', message: 'this line comes from a 7-day grant', hint: 'revoke the grant in settings' } });
      }
      if (r.code === 'already_revoked') return reply.code(409).send({ error: { code: 'already_revoked', message: 'line already removed' } });
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such line' } });
    }
    const at = r.revokedAt.toISOString();
    await recordAudit(pool, {
      action: 'mandate.line.revoked', actorId: req.account!.id, target: p.data.id,
      detail: { mandateId: p.data.id, lineId: r.line.id, cap: r.line.cap, scope: r.line.scope, via: r.line.via, requestId: r.line.requestId },
    });
    // 줄을 적은 카드(그 요청의 카드)에 빠졌다고 적는다 — 카드는 「줄을 뺐다 · 시각」을 그린다.
    const cards = (await pool.query<{ id: string }>(
      `update message m set meta = jsonb_set(m.meta, '{permissionRequest}', (m.meta->'permissionRequest') || $2::jsonb)
         from permission_request r
        where r.id = $1 and m.id = r.card_message_id and m.meta ? 'permissionRequest'
        returning m.id`,
      [r.line.requestId, JSON.stringify({ lineRevokedAt: at })])).rows;
    for (const c of cards) {
      const card = await getMessageById(pool, c.id);
      if (card) emitEvent({ type: 'message.updated', message: card, audience: await audienceFor(pool, card.channelId) });
    }
    return { ok: true, lineId: r.line.id, revokedAt: at };
  });
}
