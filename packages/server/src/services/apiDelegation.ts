import type { Pool } from 'pg';
import { connectorScope, type ApiGrantLimits } from '@harkroom/shared';
import { apiGrantFor, parseLimits, pathCovered } from '../auth/apiGrants.js';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { getMessageById, postMessage } from './messages.js';

/**
 * 위임(외부 API 권한 C안 P5, 설계 스레드 07519d86 · jaebin E1·E2). 권한(`api.call`)을 받은 에이전트가 **사람이 정해 둔 단계 안에서**
 * 다른 에이전트에게 다시 준다. 길은 MCP 도구(`grant.delegate`) 하나이고, 판정은 전부 서버가 한다 — 셸·파일이 아니라서
 * auto mode 분류기의 Bypass 판정에 걸리지 않는다.
 *
 * 지키는 것(서버가 하나라도 어긋나면 거절한다):
 * - **준 쪽의 사슬이 지금 살아 있다**(`apiGrantFor` — 만료·정지·소유 변경·`parent.w ⇒ child.w`).
 * - 준 쪽 grant 의 `delegate_depth ≥ 1`, 받는 쪽 depth ≤ 준 쪽 − 1.
 * - 받는 범위 ⊆ 준 범위: 메서드 부분집합, 경로 접두가 준 접두 안(마디 경계).
 * - 만료는 필수: 지금부터 30일 안, 준 쪽 만료보다 늦지 않다.
 * - 「쓰기는 사람 글 턴만」은 물려받는다(준 쪽이 켰으면 받는 쪽도 켠다).
 * - **E1**: 받는 쪽은 사슬을 시작한 사람이 소유한 에이전트만. 자기 자신은 안 된다.
 * - 받는 쪽이 이미 다른 줄(사람이 준 것·다른 부모의 위임)을 가졌으면 덮지 않는다(`already_granted`).
 * - **머지(`repo.merge`) 위임은 v1 에 없다** — 이 서비스는 `api.call` 만 다룬다.
 * - **E2**: 그 턴을 띄운 글이 사람 글이 아니면 줄은 **대기**(`suspended_at` + `pending_approval`)로 들어가고, 루트 사람이 허락해야
 *   쓰인다(`approveDelegation`). 대기 줄은 `apiGrantFor` 가 `suspended` 로 막는다.
 * - 위임마다 감사 줄을 남기고, 그 턴의 스레드에 시스템 줄로 루트 사람을 부른다(알림).
 */

export type DelegateDenial =
  | 'not_agent' | 'no_connector' | 'not_granted' | 'parent_invalid' | 'no_delegate_depth' | 'depth_too_deep'
  | 'bad_limits' | 'wider_than_parent' | 'bad_expiry' | 'no_target' | 'not_root_owner_agent' | 'self' | 'already_granted' | 'rate_limited';

const MAX_DAYS_MS = 30 * 86_400_000 + 60_000;
/** 원인 메시지가 이 에이전트를 깨운 지 이만큼 안이어야 원인으로 친다(automation 의 cause_stale 과 같은 결). */
const CAUSE_FRESH_MS = 60 * 60_000;
/** (위임한 에이전트, 받는 쪽)마다 하루에 새로 남기는 위임 수 상한 — 루트 사람 알림이 쌓이지 않게(security L1). */
const DAILY_PER_PAIR = 5;
export const PENDING_APPROVAL = 'pending_approval';

interface ParentRow {
  id: string; limits: ApiGrantLimits | null; delegateDepth: number; expiresAt: string | null; writeNeedsHumanCause: boolean;
}

export async function delegateApiGrant(pool: Pool, a: {
  fromAgentId: string; to: string; connector: string; methods: string[]; pathPrefix: string;
  expiresAt: string; delegateDepth: number; writeNeedsHumanCause?: boolean; causeMessageId: string | null; now?: Date;
}): Promise<{ ok: true; grantId: string; pending: boolean } | { ok: false; code: DelegateDenial; message?: string }> {
  const now = a.now ?? new Date();
  const deny = async (code: DelegateDenial, message?: string) => {
    await recordAudit(pool, { action: 'grant.delegate.denied', actorId: a.fromAgentId, target: a.connector, detail: { code, to: a.to } });
    return { ok: false as const, code, ...(message ? { message } : {}) };
  };

  const conn = (await pool.query<{ id: string; name: string; methods: string[] }>(
    `select id, name, methods from api_connector where name = $1`, [a.connector])).rows[0];
  if (!conn) return deny('no_connector');
  const scope = connectorScope(conn.id);

  const parent = (await pool.query(
    `select id, limits, delegate_depth as "delegateDepth", expires_at as "expiresAt", write_needs_human_cause as "writeNeedsHumanCause"
       from account_grant where account_id = $1 and capability = 'api.call' and scope = $2`, [a.fromAgentId, scope])).rows[0] as ParentRow | undefined;
  if (!parent || !parent.limits) return deny('not_granted');
  // 준 쪽 사슬이 지금 살아 있는가 — 준 쪽 자신의 범위 끝으로 판정을 한 번 돌린다(만료·정지·소유·사슬 조건 전부).
  const live = await apiGrantFor(pool, { agentId: a.fromAgentId, connectorId: conn.id, method: parent.limits.methods[0]!, path: parent.limits.pathPrefix });
  if (!live.ok) return deny('parent_invalid', live.code);
  if (parent.delegateDepth < 1) return deny('no_delegate_depth');
  if (!Number.isInteger(a.delegateDepth) || a.delegateDepth < 0 || a.delegateDepth > parent.delegateDepth - 1) return deny('depth_too_deep');

  const limits = parseLimits({ methods: a.methods, pathPrefix: a.pathPrefix }, conn.methods);
  if ('error' in limits) return deny('bad_limits', limits.error);
  if (!limits.methods.every((m) => parent.limits!.methods.includes(m)) || !pathCovered(limits.pathPrefix, parent.limits.pathPrefix)) {
    return deny('wider_than_parent');
  }

  const exp = Date.parse(a.expiresAt);
  if (!Number.isFinite(exp) || exp <= now.getTime() || exp > now.getTime() + MAX_DAYS_MS) return deny('bad_expiry', 'expiresAt must be within 30 days');
  if (parent.expiresAt && exp > Date.parse(parent.expiresAt)) return deny('bad_expiry', 'expiresAt must not outlive the grant it comes from');

  const root = live.hit.rootGrantedBy;
  const target = (await pool.query<{ id: string; ownerAccountId: string | null }>(
    `select a.id, c.owner_account_id as "ownerAccountId" from account a join agent_config c on c.account_id = a.id
      where (a.id::text = $1 or a.handle = $1) and a.kind = 'agent' and a.deleted_at is null`, [a.to.replace(/^@/, '')])).rows[0];
  if (!target) return deny('no_target');
  if (target.id === a.fromAgentId) return deny('self');
  if (target.ownerAccountId !== root) return deny('not_root_owner_agent');

  const existing = (await pool.query<{ id: string; parentGrantId: string | null; limits: ApiGrantLimits | null; expiresAt: string | null; delegateDepth: number; w: boolean; suspendReason: string | null }>(
    `select id, parent_grant_id as "parentGrantId", limits, expires_at as "expiresAt", delegate_depth as "delegateDepth",
            write_needs_human_cause as w, suspend_reason as "suspendReason"
       from account_grant where account_id = $1 and capability = 'api.call' and scope = $2`,
    [target.id, scope])).rows[0];
  if (existing && existing.parentGrantId !== parent.id) return deny('already_granted');
  const wanted = parent.writeNeedsHumanCause || a.writeNeedsHumanCause === true;
  // 같은 위임이 다시 오면(범위·단계·칸이 같고 만료가 하루 안쪽으로 같다) 아무것도 하지 않는다 — 줄도 알림도 새로 만들지 않는다(L1).
  if (existing && existing.limits && existing.expiresAt
    && JSON.stringify([...existing.limits.methods].sort()) === JSON.stringify([...limits.methods].sort())
    && existing.limits.pathPrefix === limits.pathPrefix && existing.delegateDepth === a.delegateDepth && existing.w === wanted
    && Math.abs(Date.parse(existing.expiresAt) - exp) < 86_400_000) {
    return { ok: true, grantId: existing.id, pending: existing.suspendReason === PENDING_APPROVAL };
  }
  const recent = (await pool.query<{ n: number }>(
    `select count(*)::int as n from audit_log where action in ('grant.delegated', 'grant.delegate.pending')
      and actor_id = $1 and target = $2 and at > $3`, [a.fromAgentId, target.id, new Date(now.getTime() - 86_400_000)])).rows[0]!.n;
  if (recent >= DAILY_PER_PAIR) return deny('rate_limited');

  // 원인 메시지는 믿기 전에 확인한다(security F1): 그 글이 **이 에이전트를 실제로 깨웠어야**(inbox, 1시간 안) 원인으로 친다.
  // 확인되지 않으면 대기이고, 시스템 줄도 쓰지 않는다 — 에이전트가 속하지 않은 채널에 글이 생기지 않게.
  const cause = a.causeMessageId ? (await pool.query<{ authorId: string; answeredBy: string | null; channelId: string; threadRootId: string }>(
    `select m.author_id as "authorId", m.meta->'ask'->>'answeredBy' as "answeredBy",
            m.channel_id as "channelId", coalesce(m.thread_root_id, m.id) as "threadRootId"
       from message m
      where m.id = $1 and m.deleted_at is null
        and exists (select 1 from inbox i where i.account_id = $2 and i.message_id = m.id and i.created_at > $3)`,
    [a.causeMessageId, a.fromAgentId, new Date(now.getTime() - CAUSE_FRESH_MS)])).rows[0] : undefined;
  // E2(좁힘, security F2): 즉시 유효는 그 턴을 **루트 사람이** 띄웠을 때만 — 글을 쓴 것이 루트 사람이거나, 루트 사람이 답한 선택 카드.
  // 다른 멤버·guest·에이전트 글이면 대기로 들어가 루트 사람이 허락해야 쓰인다.
  const byRoot = !!cause && (cause.authorId === root || cause.answeredBy === root);
  const pending = !byRoot;
  const w = wanted;

  const grantId = ((await pool.query<{ id: string }>(
    `insert into account_grant (account_id, capability, scope, granted_by, expires_at, limits, delegate_depth, write_needs_human_cause,
                                parent_grant_id, suspended_at, suspend_reason)
     values ($1, 'api.call', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (account_id, capability, scope) do update
       set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, limits = excluded.limits,
           delegate_depth = excluded.delegate_depth, write_needs_human_cause = excluded.write_needs_human_cause,
           parent_grant_id = excluded.parent_grant_id, suspended_at = excluded.suspended_at, suspend_reason = excluded.suspend_reason
     returning id`,
    [target.id, scope, a.fromAgentId, new Date(exp).toISOString(), JSON.stringify(limits), a.delegateDepth, w, parent.id,
      pending ? now.toISOString() : null, pending ? PENDING_APPROVAL : null])).rows[0])!.id;

  await recordAudit(pool, {
    action: pending ? 'grant.delegate.pending' : 'grant.delegated', actorId: a.fromAgentId, target: target.id,
    detail: { grantId, parentGrantId: parent.id, scope, limits, expiresAt: new Date(exp).toISOString(), delegateDepth: a.delegateDepth, writeNeedsHumanCause: w, rootAccountId: root, causeMessageId: a.causeMessageId },
  });
  emitEvent({ type: 'grant.changed', accountId: target.id, audience: 'all' });

  if (cause) {
    const names = (await pool.query<{ id: string; handle: string }>(
      `select id, handle from account where id = any($1::uuid[])`, [[a.fromAgentId, target.id, root]])).rows;
    const h = (id: string) => names.find((n) => n.id === id)?.handle ?? '?';
    const scopeText = `${conn.name} ${limits.methods.join('·')} ${limits.pathPrefix}`;
    // 루트 사람을 본문에서 부른다 — 위임마다 그 사람에게 알림이 간다. 에이전트 이름에는 @ 를 붙이지 않는다(부르지 않는다).
    const body = pending
      ? `🔑 ${h(a.fromAgentId)} 가 ${h(target.id)} 에게 ${scopeText} 권한을 다시 주려 한다 · @${h(root)} 의 허락을 기다린다`
      : `🔑 ${h(a.fromAgentId)} 가 ${h(target.id)} 에게 ${scopeText} 권한을 다시 줬다 · 받은 곳: @${h(root)}`;
    await postMessage(pool, {
      channelId: cause.channelId, threadRootId: cause.threadRootId, authorId: a.fromAgentId, body, kind: 'system',
      meta: { delegation: { grantId, pending, rootAccountId: root, fromAgentId: a.fromAgentId, toAgentId: target.id, connectorId: conn.id, connectorName: conn.name, limits, expiresAt: new Date(exp).toISOString(), delegateDepth: a.delegateDepth, writeNeedsHumanCause: w } },
    }).catch(() => null);
  }
  return { ok: true, grantId, pending };
}

/** 사슬의 루트를 사람이 줬는가와 그 사람 — 허락·거절은 루트 사람만 한다. */
async function rootOf(pool: Pool, grantId: string): Promise<{ rootGrantedBy: string; pending: boolean; agentId: string } | null> {
  const rows = (await pool.query<{ id: string; parentGrantId: string | null; grantedBy: string; accountId: string; suspendReason: string | null }>(
    `with recursive up as (
       select id, parent_grant_id, granted_by, account_id, suspend_reason, 0 as d from account_grant where id = $1
       union all
       select p.id, p.parent_grant_id, p.granted_by, p.account_id, p.suspend_reason, up.d + 1 from account_grant p join up on p.id = up.parent_grant_id where up.d < 5)
     select id, parent_grant_id as "parentGrantId", granted_by as "grantedBy", account_id as "accountId", suspend_reason as "suspendReason" from up order by d`,
    [grantId])).rows;
  const leaf = rows[0]; const root = rows[rows.length - 1];
  if (!leaf || !root || root.parentGrantId !== null || !leaf.parentGrantId) return null;
  return { rootGrantedBy: root.grantedBy, pending: leaf.suspendReason === PENDING_APPROVAL, agentId: leaf.accountId };
}

/** E2 대기 줄을 루트 사람이 허락하거나 거절한다. 거절은 줄을 지운다. 그 시스템 카드의 meta 도 맞춘다. */
export async function decideDelegation(pool: Pool, a: { grantId: string; humanId: string; approve: boolean }):
  Promise<{ ok: true } | { ok: false; status: 403 | 404 | 409; code: string }> {
  const r = await rootOf(pool, a.grantId);
  if (!r) return { ok: false, status: 404, code: 'not_found' };
  if (r.rootGrantedBy !== a.humanId) return { ok: false, status: 403, code: 'not_root' };
  if (!r.pending) return { ok: false, status: 409, code: 'not_pending' };
  if (a.approve) {
    await pool.query(`update account_grant set suspended_at = null, suspend_reason = null where id = $1 and suspend_reason = $2`, [a.grantId, PENDING_APPROVAL]);
  } else {
    await pool.query(`delete from account_grant where id = $1`, [a.grantId]);
  }
  await recordAudit(pool, { action: a.approve ? 'grant.delegate.approved' : 'grant.delegate.declined', actorId: a.humanId, target: r.agentId, detail: { grantId: a.grantId } });
  emitEvent({ type: 'grant.changed', accountId: r.agentId, audience: 'all' });
  const msgs = (await pool.query<{ id: string }>(
    `update message set meta = jsonb_set(jsonb_set(meta, '{delegation,pending}', 'false'::jsonb), '{delegation,decision}', to_jsonb($2::text))
      where meta->'delegation'->>'grantId' = $1 and deleted_at is null returning id`, [a.grantId, a.approve ? 'approved' : 'declined'])).rows;
  for (const m of msgs) {
    const row = await getMessageById(pool, m.id);
    if (row) emitEvent({ type: 'message.updated', message: row, audience: await audienceFor(pool, row.channelId) });
  }
  return { ok: true };
}

/** 에이전트가 자기가 다시 준 줄을 거둔다(그 아래도 cascade). 사람은 기존 `DELETE /accounts/:id/grants/…` 로 거둔다. */
export async function revokeDelegation(pool: Pool, a: { agentId: string; grantId: string }): Promise<{ ok: boolean; code?: string }> {
  const r = await pool.query<{ accountId: string }>(
    `delete from account_grant where id = $1 and granted_by = $2 and parent_grant_id is not null returning account_id as "accountId"`,
    [a.grantId, a.agentId]);
  if (!r.rowCount) return { ok: false, code: 'not_found' };
  await recordAudit(pool, { action: 'grant.delegate.revoked', actorId: a.agentId, target: r.rows[0]!.accountId, detail: { grantId: a.grantId } });
  emitEvent({ type: 'grant.changed', accountId: r.rows[0]!.accountId, audience: 'all' });
  return { ok: true };
}

/** 에이전트가 보는 자기 api.call 줄과 자기가 다시 준 줄. 값·키는 없다. */
export async function listDelegations(pool: Pool, agentId: string) {
  const mine = (await pool.query(
    `select g.id, c.name as connector, g.limits, g.delegate_depth as "delegateDepth", g.expires_at as "expiresAt",
            g.write_needs_human_cause as "writeNeedsHumanCause", g.suspend_reason as "suspendReason", g.parent_grant_id is not null as delegated
       from account_grant g join api_connector c on g.scope = 'connector:' || c.id::text
      where g.account_id = $1 and g.capability = 'api.call' order by c.name`, [agentId])).rows;
  const given = (await pool.query(
    `select g.id, a.handle as "to", c.name as connector, g.limits, g.delegate_depth as "delegateDepth", g.expires_at as "expiresAt",
            g.suspend_reason as "suspendReason"
       from account_grant g join api_connector c on g.scope = 'connector:' || c.id::text join account a on a.id = g.account_id
      where g.granted_by = $1 and g.parent_grant_id is not null order by c.name, a.handle`, [agentId])).rows;
  return { mine, given };
}
