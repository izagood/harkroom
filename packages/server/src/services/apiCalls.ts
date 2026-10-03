import type { Pool } from 'pg';
import { connectorScope } from '@harkroom/shared';
import { apiGrantFor, type ApiDenial } from '../auth/apiGrants.js';
import { recordAudit } from '../audit.js';
import type { SecretKeyring } from './secretKeyring.js';
import { causeByHuman, readLease } from './mergeGrants.js';
import { postMessage } from './messages.js';

/**
 * 외부 API 호출 — 서버 쪽 판정·키 건네기·기록(C안 P3, 설계 스레드 07519d86). 흐름은 머지 래퍼와 같다:
 * 오퍼레이터의 `api` 래퍼가 `POST /agent/api-checks` 로 (임대, 연결 이름, 메서드, 경로)를 묻는다 → 서버가 **자기 사실로만**
 * 판정한다(임대 → 에이전트·오퍼레이터·스레드, grant → `apiGrantFor` 사슬) → 통과하면 그 연결의 키를 **오퍼레이터에게만**
 * 건넨다(모델·래퍼 프로세스·MCP 결과에는 실리지 않는다) → 오퍼레이터가 호출하고 `POST /agent/api-results` 로 알린다 →
 * 서버가 스레드에 시스템 줄을 쓴다.
 *
 * **실수 방지 장치이지 경계가 아니다**(`docs/agent-api.md`). 키 건네기는 비밀 보관소 reveal 과 같은 기록
 * (`secret_access_log`)을 남긴다 — 사람이 「접근 기록」에서 본다.
 */

export type ApiCheckDenial = ApiDenial | 'lease_invalid' | 'secret_expired' | 'owner_inactive' | 'no_value' | 'unreadable';

export type ApiCheck =
  | {
    ok: true; leaseId: string; connectorId: string; connectorName: string; baseUrl: string;
    authKind: 'bearer' | 'header' | 'none'; authHeader: string | null; value: Buffer | null; causeByHuman: boolean;
  }
  | { ok: false; code: ApiCheckDenial };

/** 연결 이름은 사람이 붙인 표시용이지만 래퍼 문법의 일부다 — 여기서 id 로 바꾸고 그 뒤로는 id 만 쓴다. */
async function connectorIdByName(pool: Pool, name: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(`select id from api_connector where name = $1`, [name]);
  return r.rows[0]?.id ?? null;
}

export async function checkApiCall(
  pool: Pool, keyring: SecretKeyring | null,
  args: { agentId: string; operatorId: string; leaseId: string; token: string; connector: string; method: string; path: string; now?: Date },
): Promise<ApiCheck> {
  const now = args.now ?? new Date();
  const lease = await readLease(pool, { leaseId: args.leaseId, token: args.token, now });
  const leaseOk = !!lease && lease.agentId === args.agentId && lease.operatorId === args.operatorId && !lease.expired && !lease.ended;
  const connectorId = await connectorIdByName(pool, args.connector);
  const target = connectorId ? connectorScope(connectorId) : `connector-name:${args.connector}`;

  const deny = async (code: ApiCheckDenial): Promise<ApiCheck> => {
    await recordAudit(pool, {
      action: 'api.call.denied', actorId: args.agentId, target,
      detail: { code, method: args.method, path: args.path.slice(0, 300), operatorId: args.operatorId, leaseId: leaseOk ? lease!.id : null },
    });
    return { ok: false, code };
  };

  if (!leaseOk) return deny('lease_invalid');
  if (!connectorId) return deny('no_connector');
  const g = await apiGrantFor(pool, { agentId: args.agentId, connectorId, method: args.method, path: args.path });
  if (!g.ok) return deny(g.code);
  const hit = g.hit;

  let value: Buffer | null = null;
  if (hit.authKind !== 'none') {
    if (!keyring) return deny('no_secret');
    const s = (await pool.query(
      `select s.id, s.name, s.kind, s.expires_at <= $2 as expired,
              (o.deleted_at is not null or o.disabled_at is not null) as "ownerInactive"
         from secret s join account o on o.id = s.owner_account_id where s.id = $1`, [hit.secretId, now])).rows[0] as
      { id: string; name: string; kind: 'text' | 'file'; expired: boolean | null; ownerInactive: boolean } | undefined;
    if (!s) return deny('no_secret');
    const log = async (result: 'granted' | 'denied', reason: string | null, version: number | null) => pool.query(
      `insert into secret_access_log (secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [s.id, s.name, version, args.agentId, args.operatorId, lease!.id, lease!.channelId, lease!.threadRootId, result, reason, now]);
    if (s.expired) { await log('denied', 'secret_expired', null); return deny('secret_expired'); }
    if (s.ownerInactive) { await log('denied', 'owner_inactive', null); return deny('owner_inactive'); }
    const v = (await pool.query(
      `select version, sealed from secret_version where secret_id = $1 and revoked_at is null and sealed is not null order by version desc limit 1`,
      [s.id])).rows[0] as { version: number; sealed: string } | undefined;
    if (!v) { await log('denied', 'no_value', null); return deny('no_value'); }
    value = keyring.open(v.sealed, { secretId: s.id, version: v.version, kind: s.kind });
    if (!value) { await log('denied', 'unreadable', null); return deny('unreadable'); }
    // 「접근 기록」의 「어떻게」 — 어느 연결로 무엇을 불렀는지. 경로는 질의를 떼고 남긴다(질의에 토큰이 붙는 API 가 있다).
    await log('granted', `api:${hit.connectorName} ${args.method} ${(args.path.split('?')[0] ?? '').slice(0, 200)}`, v.version);
  }

  const byHuman = causeByHuman(lease!);
  await recordAudit(pool, {
    action: 'api.call.checked', actorId: args.agentId, target: connectorScope(hit.connectorId),
    detail: { method: args.method, path: (args.path.split('?')[0] ?? '').slice(0, 300), operatorId: args.operatorId, leaseId: lease!.id, grantId: hit.grantId, rootGrantedBy: hit.rootGrantedBy, causeByHuman: byHuman },
  });
  return {
    ok: true, leaseId: lease!.id, connectorId: hit.connectorId, connectorName: hit.connectorName, baseUrl: hit.baseUrl,
    authKind: hit.authKind, authHeader: hit.authHeader, value, causeByHuman: byHuman,
  };
}

export type ApiReport = {
  agentId: string; operatorId: string; leaseId: string; token: string;
  connector: string; method: string; path: string;
  /** HTTP 상태. 0 = 닿지 않음(네트워크·시한). */
  status: number; durationMs: number; bytes: number; error?: string | null; now?: Date;
};

/**
 * 래퍼의 보고를 스레드에 시스템 줄로 남긴다(`🔌 lab GET /api/capacity · 200 · 권한: alice`). 서버가 직접 부른 것이
 * 아니므로 "래퍼 보고"라고 밝힌다. 같은 임대·연결·메서드·경로로 **통과한 판정**이 있어야 받는다 — 판정 없이 받으면 grant
 * 없는 에이전트가 자기 스레드에 거짓 줄을 쓸 수 있다(머지 N1 과 같다). 한 판정에 보고 하나다.
 */
export async function reportApiCall(pool: Pool, r: ApiReport): Promise<{ ok: true; messageId: string } | { ok: false; code: 'lease_invalid' | 'no_connector' | 'not_checked' | 'post_failed' }> {
  const now = r.now ?? new Date();
  const lease = await readLease(pool, { leaseId: r.leaseId, token: r.token, now });
  if (!lease || lease.agentId !== r.agentId || lease.operatorId !== r.operatorId || lease.expired) return { ok: false, code: 'lease_invalid' };
  const connectorId = await connectorIdByName(pool, r.connector);
  if (!connectorId) return { ok: false, code: 'no_connector' };
  const scope = connectorScope(connectorId);
  const path = (r.path.split('?')[0] ?? '').slice(0, 300);
  const trail = await pool.query<{ checked: number; reported: number }>(
    `select count(*) filter (where action = 'api.call.checked')::int as checked,
            count(*) filter (where action = 'api.call.done')::int as reported
       from audit_log
      where action in ('api.call.checked', 'api.call.done') and target = $1 and detail->>'leaseId' = $2
        and detail->>'method' = $3 and detail->>'path' = $4`,
    [scope, lease.id, r.method, path]);
  const t = trail.rows[0] ?? { checked: 0, reported: 0 };
  if (t.checked <= t.reported) return { ok: false, code: 'not_checked' };
  const root = (await pool.query<{ handle: string }>(
    `with recursive up as (
       select id, parent_grant_id, granted_by from account_grant where account_id = $1 and capability = 'api.call' and scope = $2
       union all
       select p.id, p.parent_grant_id, p.granted_by from account_grant p join up on p.id = up.parent_grant_id)
     select a.handle from up join account a on a.id = up.granted_by where up.parent_grant_id is null limit 1`,
    [r.agentId, scope])).rows[0]?.handle ?? null;
  // 본문은 고정 문구와 서버가 아는 값뿐이다. 래퍼가 준 `error` 는 meta 에만 — 본문의 `@…` 는 실제 부름이 된다(머지 N2).
  const name = (await pool.query<{ name: string }>(`select name from api_connector where id = $1`, [connectorId])).rows[0]?.name ?? r.connector;
  const status = r.status > 0 ? String(r.status) : '닿지 않음';
  const body = `🔌 ${name} ${r.method} ${path.replace(/@/g, '＠')} · ${status}` + (root ? ` · 권한: ${root}` : '') + ' (래퍼 보고)';
  const posted = await postMessage(pool, {
    channelId: lease.channelId, threadRootId: lease.threadRootId, authorId: r.agentId, body, kind: 'system',
    meta: { apiCall: { connectorId, method: r.method, path, status: r.status, durationMs: r.durationMs, bytes: r.bytes, error: r.error?.slice(0, 1000) ?? null } },
  });
  if (posted.failure) return { ok: false, code: 'post_failed' };
  await recordAudit(pool, {
    action: 'api.call.done', actorId: r.agentId, target: scope,
    detail: { method: r.method, path, status: r.status, durationMs: r.durationMs, bytes: r.bytes, operatorId: r.operatorId, leaseId: lease.id, messageId: posted.message.id },
  });
  return { ok: true, messageId: posted.message.id };
}

/** 이 에이전트가 쓸 수 있는 연결 이름 — 러너가 allow 규칙과 프롬프트 한 절을 고르는 근거. 판정은 쓰는 순간 다시 한다. */
export async function callableConnectors(pool: Pool, agentId: string): Promise<string[]> {
  const r = await pool.query<{ name: string }>(
    `select distinct c.name from account_grant g join api_connector c on g.scope = 'connector:' || c.id::text
      where g.account_id = $1 and g.capability = 'api.call' and g.suspended_at is null
        and (g.expires_at is null or g.expires_at > now()) order by c.name`, [agentId]);
  return r.rows.map((x) => x.name);
}
