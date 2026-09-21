// grant 부여·회수·역할 변경 — 스펙 2026-09-20-operator-and-permissions §6 (1)·(2).
//
// **grant 를 주는 것은 역할의 일이다.** 행위(capability)는 grant 로 열리지만, 그 grant 를
// 누가 줄 수 있는지는 역할만 정한다: owner 는 admin 을 임명하고, admin 은 grant 를 주고,
// member/guest 는 못 준다. 그래서 이 파일의 관문은 `requireCap` 이 아니라 `requireAdmin` 이다
// — capability 로 표현하면 "grant 를 줄 수 있는 grant" 가 생기고, 그 순환이 곧 권한 상승이다.
//
// **전부 감사에 남긴다.** 권한을 준 기록이 없으면 사고를 못 되짚는다. 값(capability·scope)은
// 비밀이 아니므로 그대로 남긴다.
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CAPABILITIES, ROLES, type GrantRow } from '@harkroom/shared';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';

const grantBody = z.object({
  capability: z.enum(CAPABILITIES),
  // '' = 전역. 대상 한정은 첫 판에 channel·team·agent 만(스펙 §6 (2)).
  scope: z.string().regex(/^(|channel:[0-9a-f-]{36}|team:[0-9a-f-]{36}|agent:[0-9a-f-]{36})$/).default(''),
  expiresAt: z.string().datetime().nullable().optional(),
});
const roleBody = z.object({ role: z.enum(ROLES) });
const idParam = z.object({ id: z.string().uuid() });

async function listGrants(pool: Pool, accountId: string): Promise<GrantRow[]> {
  const res = await pool.query(
    `select account_id as "accountId", capability, scope, granted_by as "grantedBy",
            granted_at as "grantedAt", expires_at as "expiresAt"
       from account_grant where account_id = $1 order by capability, scope`, [accountId]);
  return res.rows;
}

export async function registerGrantRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Params: { id: string } }>('/accounts/:id/grants', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    // 남의 grant 는 admin 만 본다 — 권한 목록은 곧 공격 표면의 지도다.
    if (id !== req.account!.id && !req.account!.isAdmin) {
      return reply.code(403).send({ error: { code: 'forbidden', message: '남의 권한은 admin 만 본다' } });
    }
    return { grants: await listGrants(pool, id) };
  });

  app.put<{ Params: { id: string } }>('/accounts/:id/grants', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = grantBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const { capability, scope, expiresAt } = parsed.data;
    const target = await pool.query(`select 1 from account where id = $1`, [id]);
    if (!target.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 계정이 없다' } });
    // 같은 (계정, capability, scope) 에 다시 주면 갱신이다 — 준 사람과 만료가 새 값으로 바뀐다.
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at)
       values ($1, $2, $3, $4, $5)
       on conflict (account_id, capability, scope) do update
         set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at`,
      [id, capability, scope, req.account!.id, expiresAt ?? null]);
    await recordAudit(pool, {
      action: 'grant.given', ...actorOf(req), target: id,
      detail: { capability, scope, expiresAt: expiresAt ?? null },
    }, req);
    emitEvent({ type: 'grant.changed', accountId: id, audience: 'all' });
    return { grants: await listGrants(pool, id) };
  });

  app.delete<{ Params: { id: string; capability: string }; Querystring: { scope?: string } }>(
    '/accounts/:id/grants/:capability', { preHandler: app.requireAdmin }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const scope = req.query.scope ?? '';
      const res = await pool.query(
        `delete from account_grant where account_id = $1 and capability = $2 and scope = $3`,
        [id, req.params.capability, scope]);
      if (!res.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 grant 가 없다' } });
      await recordAudit(pool, {
        action: 'grant.revoked', ...actorOf(req), target: id,
        detail: { capability: req.params.capability, scope },
      }, req);
      emitEvent({ type: 'grant.changed', accountId: id, audience: 'all' });
      return reply.code(204).send();
    });

  /**
   * 역할 변경. owner 는 하나뿐이고 이 라우트로 정하지 않는다(bootstrap·claim 이 정한다).
   * admin 임명·해제는 **owner 만** — admin 이 admin 을 만들 수 있으면 역할 층이 grant 층과
   * 같은 것이 되고, 스펙 §6 (1) 이 둘을 가른 이유가 사라진다.
   */
  app.put<{ Params: { id: string } }>('/accounts/:id/role', { preHandler: app.requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = roleBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const { role } = parsed.data;
    if (role === 'owner') return reply.code(400).send({ error: { code: 'bad_request', message: 'owner 는 이 라우트로 정하지 않는다' } });
    const current = await pool.query<{ role: string }>(`select role from account where id = $1`, [id]);
    if (!current.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 계정이 없다' } });
    if (current.rows[0]!.role === 'owner') return reply.code(400).send({ error: { code: 'bad_request', message: 'owner 의 역할은 바꿀 수 없다' } });
    const touchesAdmin = role === 'admin' || current.rows[0]!.role === 'admin';
    if (touchesAdmin && req.account!.role !== 'owner') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'admin 임명·해제는 owner 만 한다' } });
    }
    // is_admin 을 함께 세운다 — 055 의 check 가 둘의 어긋남을 막는다.
    await pool.query(
      `update account set role = $2, is_admin = ($2 in ('owner','admin')) where id = $1`, [id, role]);
    await recordAudit(pool, {
      action: 'role.changed', ...actorOf(req), target: id,
      detail: { role, previous: current.rows[0]!.role },
    }, req);
    emitEvent({ type: 'grant.changed', accountId: id, audience: 'all' });
    return { role };
  });
}
