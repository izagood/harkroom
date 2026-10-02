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
import { CAPABILITIES, ROLES, repoScope, type ApiGrantLimits, type GrantRow } from '@harkroom/shared';
import { hasWriteMethod, isConnectorScope, parseLimits } from '../auth/apiGrants.js';
import { actorOf, recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';

const grantBody = z.object({
  capability: z.enum(CAPABILITIES),
  // '' = 전역. 대상 한정은 첫 판에 channel·team·agent 만(스펙 §6 (2)). `repo:` 는 `repo.merge` 전용 — 아래서
  // capability 와 짝을 맞춘다.
  scope: z.string().regex(/^(|channel:[0-9a-f-]{36}|team:[0-9a-f-]{36}|agent:[0-9a-f-]{36}|repo:[^\s]{3,201}|connector:[0-9a-f-]{36})$/).default(''),
  expiresAt: z.string().datetime().nullable().optional(),
  /** `repo.merge` 전용(090, security F4). 다른 capability 에 주면 400. */
  allowAgentCause: z.boolean().optional(),
  /** `api.call` 전용(098): {methods, pathPrefix}. */
  limits: z.unknown().optional(),
  /** `api.call` 전용(098): 받은 쪽이 다시 줄 수 있는 단계. 위임 도구는 P5 다 — 지금은 사람이 정해 두기만 한다. */
  delegateDepth: z.number().int().min(0).max(2).optional(),
});

/**
 * `api.call` grant 의 모양·권한(C안 P2, jaebin D3·E1). `repo.merge` 와 같은 틀이고 다른 점은:
 * - scope 는 `connector:<uuid>` 하나뿐이다. 연결은 **주는 사람의 것**이어야 한다(키는 그 사람의 비밀이다).
 * - limits 가 필수다: 메서드는 연결이 허용한 것의 부분집합, 경로 접두.
 * - **쓰기 메서드가 하나라도 있으면 만료가 필수다**(D3 — 읽기+쓰기의 무기한 금지). 과거 시각도 받지 않는다.
 */
async function checkApiGrant(
  pool: Pool, req: { account?: { id: string; kind: string } | null }, targetId: string, scope: string,
  body: { limits?: unknown; expiresAt?: string | null; allowAgentCause?: boolean },
): Promise<{ ok: true; limits: ApiGrantLimits } | { ok: false; status: 400 | 403 | 404; code: string; message: string }> {
  if (!isConnectorScope(scope)) return { ok: false, status: 400, code: 'bad_scope', message: 'api.call 의 scope 는 connector:<id> 하나다 — 전역은 없다' };
  if (body.allowAgentCause !== undefined) return { ok: false, status: 400, code: 'bad_request', message: 'allowAgentCause 는 repo.merge 전용이다' };
  if (!req.account || req.account.kind !== 'human') return { ok: false, status: 403, code: 'forbidden', message: 'api.call 은 사람만 준다' };
  const agent = await pool.query<{ ownerAccountId: string | null }>(
    `select c.owner_account_id as "ownerAccountId" from agent_config c join account a on a.id = c.account_id
      where c.account_id = $1 and a.kind = 'agent'`, [targetId]);
  if (!agent.rowCount) return { ok: false, status: 404, code: 'not_found', message: 'api.call 은 에이전트에게만 준다' };
  if (agent.rows[0]!.ownerAccountId !== req.account.id) return { ok: false, status: 403, code: 'forbidden', message: 'api.call 은 그 에이전트의 소유자만 준다' };
  const conn = await pool.query<{ ownerAccountId: string; methods: string[] }>(
    `select owner_account_id as "ownerAccountId", methods from api_connector where id = $1`, [scope.slice('connector:'.length)]);
  if (!conn.rowCount) return { ok: false, status: 404, code: 'no_connector', message: '그런 API 연결이 없다' };
  if (conn.rows[0]!.ownerAccountId !== req.account.id) return { ok: false, status: 403, code: 'forbidden', message: '내 API 연결만 줄 수 있다' };
  const limits = parseLimits(body.limits, conn.rows[0]!.methods);
  if ('error' in limits) return { ok: false, status: 400, code: 'bad_limits', message: limits.error };
  if (hasWriteMethod(limits.methods)) {
    if (!body.expiresAt) return { ok: false, status: 400, code: 'write_needs_expiry', message: '쓰기 메서드가 있는 api.call 은 만료가 필수다' };
  }
  if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) return { ok: false, status: 400, code: 'bad_request', message: '만료가 이미 지났다' };
  return { ok: true, limits };
}

/**
 * `repo.merge` grant 의 모양·권한(security F1·F2). 일반 grant 와 다른 점 둘:
 * - scope 는 `repo:<owner>/<name>` 하나뿐이고 소문자로 정규화한다. 빈 scope 는 400 — 전역 머지 권한은 없다.
 * - **주는 사람은 그 에이전트의 소유자인 사람**이다. admin 역할은 여기서 아무 힘이 없다(거두기만 한다).
 *   에이전트 PAT·오퍼레이터 토큰은 사람이 아니므로 403.
 */
async function checkMergeGrant(
  pool: Pool, req: { account?: { id: string; kind: string } | null }, targetId: string, scope: string,
): Promise<{ ok: true; scope: string } | { ok: false; status: 400 | 403 | 404; code: string; message: string }> {
  const normalized = repoScope(scope.replace(/^repo:/i, ''));
  if (!scope || !normalized) {
    return { ok: false, status: 400, code: 'bad_scope', message: 'repo.merge 의 scope 는 repo:<owner>/<name> 하나다 — 전역(빈 scope)은 없다' };
  }
  if (!req.account || req.account.kind !== 'human') {
    return { ok: false, status: 403, code: 'forbidden', message: 'repo.merge 는 사람만 줄 수 있다' };
  }
  const agent = await pool.query<{ ownerAccountId: string | null }>(
    `select c.owner_account_id as "ownerAccountId" from agent_config c join account a on a.id = c.account_id
      where c.account_id = $1 and a.kind = 'agent'`, [targetId]);
  if (!agent.rowCount) return { ok: false, status: 404, code: 'not_found', message: 'repo.merge 는 에이전트에게만 준다' };
  if (agent.rows[0]!.ownerAccountId !== req.account.id) {
    return { ok: false, status: 403, code: 'forbidden', message: 'repo.merge 는 그 에이전트의 소유자만 준다' };
  }
  return { ok: true, scope: normalized };
}
const roleBody = z.object({ role: z.enum(ROLES) });
const idParam = z.object({ id: z.string().uuid() });

async function listGrants(pool: Pool, accountId: string): Promise<GrantRow[]> {
  const res = await pool.query(
    `select account_id as "accountId", capability, scope, granted_by as "grantedBy",
            granted_at as "grantedAt", expires_at as "expiresAt", allow_agent_cause as "allowAgentCause",
            id, parent_grant_id as "parentGrantId", delegate_depth as "delegateDepth", limits,
            suspended_at as "suspendedAt", suspend_reason as "suspendReason"
       from account_grant where account_id = $1 order by capability, scope`, [accountId]);
  return res.rows;
}

export async function registerGrantRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  app.get<{ Params: { id: string } }>('/accounts/:id/grants', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    // 남의 grant 는 admin 만 본다 — 권한 목록은 곧 공격 표면의 지도다. 예외 하나: **자기 에이전트의 소유자**
    // (`repo.merge` 를 주는 사람이 자기가 준 것을 못 보면 거둘 수도 없다 — 스레드 3deac356 PR 3).
    if (id !== req.account!.id && !req.account!.isAdmin) {
      const owns = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [id, req.account!.id]);
      if (!owns.rowCount) return reply.code(403).send({ error: { code: 'forbidden', message: '남의 권한은 admin 과 그 에이전트의 소유자만 본다' } });
    }
    return { grants: await listGrants(pool, id) };
  });

  // 관문이 `requireAccount` 인 이유: `repo.merge` 만은 admin 이 아니라 **소유자**가 준다(F2). 나머지
  // capability 는 아래서 지금처럼 admin 을 요구한다 — 판정을 둘로 나눈 것이지 넓힌 것이 아니다.
  app.put<{ Params: { id: string } }>('/accounts/:id/grants', { preHandler: app.requireAccount }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = grantBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: { code: 'bad_request', message: parsed.error.message } });
    const { capability, expiresAt, allowAgentCause } = parsed.data;
    let { scope } = parsed.data;
    let limits: ApiGrantLimits | null = null;
    const delegateDepth = capability === 'api.call' ? parsed.data.delegateDepth ?? 0 : 0;
    if (capability !== 'api.call' && (parsed.data.limits !== undefined || parsed.data.delegateDepth !== undefined)) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'limits·delegateDepth 는 api.call 전용이다' } });
    }
    if (capability === 'api.call') {
      const check = await checkApiGrant(pool, req, id, scope, parsed.data);
      if (!check.ok) return reply.code(check.status).send({ error: { code: check.code, message: check.message } });
      limits = check.limits;
    } else if (capability === 'repo.merge') {
      const check = await checkMergeGrant(pool, req, id, scope);
      if (!check.ok) return reply.code(check.status).send({ error: { code: check.code, message: check.message } });
      scope = check.scope;
    } else {
      if (!req.account!.isAdmin) return reply.code(403).send({ error: { code: 'forbidden', message: 'grant 는 admin 만 준다' } });
      if (scope.startsWith('repo:') || scope.startsWith('connector:') || allowAgentCause !== undefined) {
        return reply.code(400).send({ error: { code: 'bad_request', message: 'repo: scope 와 allowAgentCause 는 repo.merge 전용이다' } });
      }
    }
    const target = await pool.query(`select 1 from account where id = $1`, [id]);
    if (!target.rowCount) return reply.code(404).send({ error: { code: 'not_found', message: '그런 계정이 없다' } });
    // 같은 (계정, capability, scope) 에 다시 주면 갱신이다 — 준 사람과 만료가 새 값으로 바뀐다. 사람이 다시 주면
    // 그 줄은 루트가 되고(parent 비움) 정지도 풀린다 — 사람이 바뀐 연결을 보고 다시 믿기로 한 것이다.
    await pool.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause, limits, delegate_depth)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (account_id, capability, scope) do update
         set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at,
             allow_agent_cause = excluded.allow_agent_cause, limits = excluded.limits,
             delegate_depth = excluded.delegate_depth, parent_grant_id = null,
             suspended_at = null, suspend_reason = null`,
      [id, capability, scope, req.account!.id, expiresAt ?? null, allowAgentCause ?? false, limits ? JSON.stringify(limits) : null, delegateDepth]);
    await recordAudit(pool, {
      action: 'grant.given', ...actorOf(req), target: id,
      detail: {
        capability, scope, expiresAt: expiresAt ?? null,
        ...(capability === 'repo.merge' ? { allowAgentCause: allowAgentCause ?? false } : {}),
        ...(capability === 'api.call' ? { limits, delegateDepth } : {}),
      },
    }, req);
    emitEvent({ type: 'grant.changed', accountId: id, audience: 'all' });
    return { grants: await listGrants(pool, id) };
  });

  app.delete<{ Params: { id: string; capability: string }; Querystring: { scope?: string } }>(
    '/accounts/:id/grants/:capability', { preHandler: app.requireAccount }, async (req, reply) => {
      const { id } = idParam.parse(req.params);
      let scope = req.query.scope ?? '';
      // 거두기: admin, 그리고 `repo.merge` 는 그 에이전트의 소유자도(F2 — 준 사람이 거둘 수 있어야 한다).
      if (req.params.capability === 'repo.merge' || req.params.capability === 'api.call') {
        if (req.params.capability === 'repo.merge') scope = repoScope(scope.replace(/^repo:/i, '')) ?? scope;
        const owner = await pool.query(`select 1 from agent_config where account_id = $1 and owner_account_id = $2`, [id, req.account!.id]);
        if (!owner.rowCount && !req.account!.isAdmin) return reply.code(403).send({ error: { code: 'forbidden', message: '소유자나 admin 만 거둔다' } });
      } else if (!req.account!.isAdmin) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'grant 는 admin 만 거둔다' } });
      }
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
