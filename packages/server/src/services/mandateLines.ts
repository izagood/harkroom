import type { Pool, PoolClient } from 'pg';
import { parseToolScope } from '@harkroom/shared';
import { CAPABILITIES, isCap, lineMatches, type Cap, type CapAction, type LineFacts, type LineLimits } from './capabilities.js';
import { validMandateOwner } from './mandates.js';

/**
 * 위임(mandate) W2 — 위임장의 줄. 저장된 줄(`mandate_line`, 138)과 **상시 줄**(standing)을 한 목록으로 읽는다.
 *
 * - 상시 줄(H2): 위임 소유자의 에이전트가 가진 살아 있는 `account_grant`(소유자가 준 것만)를 **읽을 때 펼친다** — 복사하지 않는다.
 *   grant 가 거둬지거나 끝나면 줄도 바로 사라진다. 읽기 전용(`readOnly`)이고 그 grant 를 받은 에이전트 하나에만 걸린다.
 *   tool grant 는 채널에 묶여 있으므로 위임의 채널 것만 펼친다.
 * - 저장된 줄의 `agent_ids` 가 null 이면 위임 안의 같은 소유자 에이전트 모두(H3).
 * - 같은 소유자 규칙: 줄은 에이전트의 **지금** 소유자가 위임 소유자와 같을 때만 그 에이전트에 걸린다.
 *
 * W2 는 판정을 바꾸지 않는다 — `findLine` 은 그림자(`mergeGrants.ts::shadowMandate`)만 쓴다.
 */

type Q = Pick<PoolClient, 'query'>;
export type LineVia = 'button' | 'chat' | 'mirror' | 'standing' | 'system';

export interface MandateLine extends LineFacts {
  id: string; mandateId: string; agentIds: string[] | null; grantedBy: string; via: LineVia;
  requestId: string | null; createdAt: Date; readOnly: boolean;
}

const LINE_COLS = `id, mandate_id as "mandateId", cap, scope, limits, agent_ids as "agentIds", granted_by as "grantedBy", via,
  request_id as "requestId", used_count as "usedCount", created_at as "createdAt", revoked_at as "revokedAt"`;

export type AddLineResult = { ok: true; line: MandateLine } | { ok: false; code: 'no_mandate' | 'not_owner' | 'bad_cap' | 'bad_via' | 'bad_scope' | 'bad_agent'; detail?: string };

/**
 * 줄 하나를 적는다. 주는 사람은 위임 소유자여야 하고(`system` 은 서버가 소유자 대신 적는 자리라 소유자 이름으로 적는다),
 * `standing` 은 적을 수 없다(grant 에서 펼쳐질 뿐이다). `agentIds` 는 지금 같은 소유자의 에이전트만.
 */
export async function addMandateLine(client: Q, args: {
  mandateId: string; cap: string; scope: string; limits?: LineLimits; agentIds?: string[] | null;
  grantedBy: string; via: LineVia; requestId?: string | null; now?: Date;
}): Promise<AddLineResult> {
  if (!isCap(args.cap)) return { ok: false, code: 'bad_cap' };
  if (args.via === 'standing') return { ok: false, code: 'bad_via' };
  const owner = (await client.query<{ owner: string }>(`select owner_account_id as owner from mandate where id = $1`, [args.mandateId])).rows[0]?.owner;
  if (!owner) return { ok: false, code: 'no_mandate' };
  if (args.grantedBy !== owner) return { ok: false, code: 'not_owner' };
  const v = CAPABILITIES[args.cap].validateScope(args.scope);
  if (!v.ok) return { ok: false, code: 'bad_scope', detail: v.code };
  const agentIds = args.agentIds ?? null;
  if (agentIds) {
    if (!agentIds.length) return { ok: false, code: 'bad_agent' };
    const n = (await client.query(
      `select 1 from agent_config where account_id = any($1::uuid[]) and owner_account_id = $2`, [agentIds, owner])).rowCount ?? 0;
    if (n !== new Set(agentIds).size) return { ok: false, code: 'bad_agent' };
  }
  const row = (await client.query<MandateLine>(
    `insert into mandate_line (mandate_id, cap, scope, limits, agent_ids, granted_by, via, request_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${LINE_COLS}`,
    [args.mandateId, args.cap, v.scope, JSON.stringify(args.limits ?? {}), agentIds, args.grantedBy, args.via,
      args.requestId ?? null, args.now ?? new Date()])).rows[0]!;
  return { ok: true, line: { ...row, readOnly: false } };
}

/** 위임의 줄 — 저장된 줄(회수된 것 제외) + 상시 줄. 위임이 없으면 빈 목록. */
export async function listMandateLines(client: Q, mandateId: string, now = new Date()): Promise<MandateLine[]> {
  const m = (await client.query<{ owner: string; channelId: string }>(
    `select owner_account_id as owner, channel_id as "channelId" from mandate where id = $1`, [mandateId])).rows[0];
  if (!m) return [];
  const stored = (await client.query<MandateLine>(
    `select ${LINE_COLS} from mandate_line where mandate_id = $1 and revoked_at is null order by created_at, id`, [mandateId])).rows
    .map((r) => ({ ...r, readOnly: false }));
  const grants = (await client.query<{ id: string; agentId: string; capability: string; scope: string; grantedBy: string; grantedAt: Date; expiresAt: Date | null }>(
    `select g.id, g.account_id as "agentId", g.capability, g.scope, g.granted_by as "grantedBy", g.granted_at as "grantedAt", g.expires_at as "expiresAt"
       from account_grant g join agent_config c on c.account_id = g.account_id
      where c.owner_account_id = $1 and g.granted_by = $1 and g.capability in ('repo.merge', 'tool.allow')
        and (g.expires_at is null or g.expires_at > $2)
      order by g.granted_at, g.id`, [m.owner, now])).rows;
  const standing: MandateLine[] = [];
  for (const g of grants) {
    let cap: Cap; let scope: string;
    if (g.capability === 'repo.merge') {
      const v = CAPABILITIES.merge.validateScope(g.scope);
      if (!v.ok) continue;
      cap = 'merge'; scope = v.scope;
    } else {
      const t = parseToolScope(g.scope);
      if (!t || t.channelId !== m.channelId) continue;
      const v = CAPABILITIES.tool.validateScope(t.rule);
      if (!v.ok || v.scope !== t.rule) continue;
      cap = 'tool'; scope = v.scope;
    }
    standing.push({
      id: g.id, mandateId, cap, scope, limits: g.expiresAt ? { until: new Date(g.expiresAt).toISOString() } : {},
      agentIds: [g.agentId], grantedBy: g.grantedBy, via: 'standing', requestId: null, usedCount: 0,
      createdAt: g.grantedAt, revokedAt: null, readOnly: true,
    });
  }
  return [...stored, ...standing];
}

/**
 * 이 에이전트의 이 행동을 덮는 줄 — 위임이 유효하고(끝나지 않음·7일 안), 에이전트의 지금 소유자가 위임 소유자이며,
 * 줄이 그 에이전트에 걸리고(H3) 살아 있고(회수·until·uses) 행동과 맞을 때. 없으면 null.
 */
export async function findLine(pool: Pool | Q, args: {
  mandateId: string | null; agentId: string; cap: Cap; action: CapAction; now?: Date;
}): Promise<MandateLine | null> {
  return (await candidateLines(pool, args))[0] ?? null;
}

/** `findLine` 의 후보 전부(순서 그대로). 위임·소유자 조건이 안 맞으면 빈 목록. */
async function candidateLines(pool: Pool | Q, args: {
  mandateId: string | null; agentId: string; cap: Cap; action: CapAction; now?: Date;
}): Promise<MandateLine[]> {
  const now = args.now ?? new Date();
  if (args.action.cap !== args.cap) return [];
  // 우회(bypass) 줄은 W3 판정에 쓰지 않는다 — W5 의 자리(그 명령 한 번, G5). 여기서 막아 두면 어느 판정도 bypass 줄을 집지 못한다.
  if (args.cap === 'bypass') return [];
  const owner = await validMandateOwner(pool, args.mandateId, now);
  if (!owner) return [];
  const agentOwner = (await pool.query<{ owner: string | null }>(
    `select owner_account_id as owner from agent_config where account_id = $1`, [args.agentId])).rows[0]?.owner ?? null;
  if (agentOwner !== owner) return [];
  const lines = await listMandateLines(pool, args.mandateId!, now);
  return lines.filter((l) => l.cap !== 'bypass' && (l.agentIds === null || l.agentIds.includes(args.agentId)) && lineMatches(l, args.action, now));
}

/**
 * 판정용(W3) — 맞는 줄을 찾고 **같은 SQL 문장에서** 한 번 쓴 것으로 센다. 저장된 줄은 `update ... where 회수 안 됨 and until 전 and
 * (uses 없음 or used_count < uses) returning` 한 문장이라, 두 판정이 동시에 와도 `uses` 를 넘겨 쓰지 못한다(읽고-쓰기 경합 없음).
 * 그 문장이 0줄이면(방금 다 썼다) 다음 후보로 간다. 상시 줄(grant 에서 펼친 것)은 `uses` 가 없어 세지 않는다.
 */
export async function consumeLine(pool: Pool | Q, args: {
  mandateId: string | null; agentId: string; cap: Exclude<Cap, 'bypass'>; action: CapAction; now?: Date;
}): Promise<MandateLine | null> {
  const now = args.now ?? new Date();
  for (const l of await candidateLines(pool, { ...args, now })) {
    if (l.readOnly) return l;
    const row = (await pool.query<MandateLine>(
      `update mandate_line set used_count = used_count + 1
        where id = $1 and revoked_at is null
          and (limits->>'until' is null or (limits->>'until')::timestamptz > $2)
          and (limits->>'uses' is null or used_count < (limits->>'uses')::int)
        returning ${LINE_COLS}`,
      [l.id, now])).rows[0];
    if (row) return { ...row, readOnly: false };
  }
  return null;
}

/**
 * 7일 grant(account_grant)를 거둘 때 그 grant 와 함께 적힌 위임 줄도 닫는다(W4) — 설정 화면 거두기·`permission.revoke` 가 부른다.
 * 맞추기: 같은 cap·scope 이고, (그 에이전트가 낸 요청에서 온 줄 — 도구는 같은 채널의 요청만) 이거나 (agent_ids 에 그 에이전트가 있는 줄).
 * 위임 줄이 없는 능력(api.call 등)이면 아무것도 하지 않는다. 닫은 줄 수를 돌려준다.
 */
export async function revokeLinesForGrant(q: Pool | Q, args: {
  agentId: string; capability: string; scope: string; now?: Date;
}): Promise<number> {
  const now = args.now ?? new Date();
  let cap: Cap; let lineScope: string; let channelId: string | null = null;
  if (args.capability === 'tool.allow') {
    const p = parseToolScope(args.scope);
    if (!p) return 0;
    cap = 'tool'; channelId = p.channelId;
    const v = CAPABILITIES.tool.validateScope(p.rule);
    lineScope = v.ok ? v.scope : p.rule;
  } else if (args.capability === 'repo.merge') {
    cap = 'merge';
    const v = CAPABILITIES.merge.validateScope(args.scope);
    lineScope = v.ok ? v.scope : args.scope;
  } else {
    return 0;
  }
  const res = await q.query(
    `update mandate_line l set revoked_at = $5
      where l.revoked_at is null and l.cap = $2 and l.scope = $3
        and ((l.agent_ids is not null and $1::uuid = any(l.agent_ids))
          or exists (select 1 from permission_request r
                      where r.id = l.request_id and r.agent_id = $1 and ($4::text is null or r.channel_id::text = $4)))`,
    [args.agentId, cap, lineScope, channelId, now]);
  return res.rowCount ?? 0;
}
