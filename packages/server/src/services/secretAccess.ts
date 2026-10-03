import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { SecretKeyring } from './secretKeyring.js';

/**
 * 비밀 보관소 PR 2 — 에이전트가 값을 받는 길. 계획·보안 검토는 스레드 bc98df3a.
 *
 * 흐름: 러너가 멘션을 집으면 `issueTurnLease` → 그 턴의 브릿지가 `revealSecret` 으로 값을 받아
 * 턴 전용 파일에 쓴다(PR 3). 모델은 값을 보지 않는다 — MCP 에는 이름만 나간다(`listGrantedSecrets`).
 *
 * reveal 의 판정은 **전부 서버가 가진 사실로만** 한다(H1). 요청이 주는 것은 임대 id·토큰과 이름뿐이고,
 * 채널은 임대 행에서, 오퍼레이터는 인증에서 온다.
 */

/** 턴 예산 30분 + 여유. 이 뒤에는 임대가 살아 있어도 reveal 이 거절된다. */
export const LEASE_TTL_MS = 35 * 60_000;
/**
 * 이보다 오래된 인박스 항목에는 임대를 주지 않는다(S1). 러너는 멘션을 집는 즉시 받으므로 짧아도 된다 —
 * 길수록 "아직 집지 않은 멘션을 셸이 먼저 받는" 창(H2)이 넓어진다.
 */
export const LEASE_INBOX_FRESH_MS = 10 * 60_000;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export type LeaseIssue =
  | { ok: true; leaseId: string; token: string; channelId: string; threadRootId: string; expiresAt: string }
  | { ok: false; code: 'not_invoked' | 'lease_used' };

/**
 * 이 에이전트가 **실제로 불린** 메시지(최근 인박스 항목)에만 임대를 준다. 채널·스레드는 그 메시지에서
 * 읽는다. 그 멘션에 **한 번이라도** 임대를 줬으면(끝났든 만료됐든) `lease_used` 다(S1) — 충돌은
 * 호출부가 감사에 남긴다.
 */
export async function issueTurnLease(
  pool: Pool, args: { agentId: string; operatorId: string; causeMessageId: string; now?: Date },
): Promise<LeaseIssue> {
  const now = args.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('begin');
    // 같은 (에이전트, 멘션) 의 동시 발급을 줄 세운다 — 둘 다 "살아 있는 임대 없음"을 보면 둘이 생긴다.
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`lease:${args.agentId}:${args.causeMessageId}`]);
    const msg = await client.query(
      `select m.channel_id as "channelId", coalesce(m.thread_root_id, m.id) as "threadRootId"
         from inbox i join message m on m.id = i.message_id
        where i.account_id = $1 and i.message_id = $2 and i.created_at > $3 and m.deleted_at is null
        limit 1`,
      [args.agentId, args.causeMessageId, new Date(now.getTime() - LEASE_INBOX_FRESH_MS)]);
    if (!msg.rowCount) { await client.query('rollback'); return { ok: false, code: 'not_invoked' }; }
    const used = await client.query(
      `select 1 from secret_turn_lease where agent_id = $1 and cause_message_id = $2`,
      [args.agentId, args.causeMessageId]);
    if (used.rowCount) { await client.query('rollback'); return { ok: false, code: 'lease_used' }; }
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
    const { channelId, threadRootId } = msg.rows[0] as { channelId: string; threadRootId: string };
    const ins = await client.query(
      `insert into secret_turn_lease (token_hash, agent_id, operator_id, cause_message_id, channel_id, thread_root_id, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [sha256(token), args.agentId, args.operatorId, args.causeMessageId, channelId, threadRootId, now, expiresAt]);
    await client.query('commit');
    return { ok: true, leaseId: (ins.rows[0] as { id: string }).id, token, channelId, threadRootId, expiresAt: expiresAt.toISOString() };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 턴이 끝났다. 토큰이 맞아야 한다 — 남의 임대를 끝내 러너가 다시 받게 만드는 길을 막는다. */
export async function endTurnLease(pool: Pool, args: { leaseId: string; token: string; agentId: string }): Promise<boolean> {
  const r = await pool.query(
    `update secret_turn_lease set ended_at = now()
      where id = $1 and token_hash = $2 and agent_id = $3 and ended_at is null`,
    [args.leaseId, sha256(args.token), args.agentId]);
  return (r.rowCount ?? 0) > 0;
}

export type RevealDenial =
  | 'lease_invalid' | 'not_found' | 'secret_expired' | 'owner_inactive'
  | 'not_granted' | 'grant_suspended' | 'wrong_channel' | 'wrong_operator'
  | 'no_value' | 'unreadable' | 'rate_limited' | 'not_own_agent';

export type RevealResult =
  | { ok: true; secretId: string; name: string; kind: 'text' | 'file'; filename: string | null; version: number; value: Buffer }
  | { ok: false; code: RevealDenial };

interface LeaseRow { id: string; agentId: string; operatorId: string; channelId: string; threadRootId: string; expired: boolean; ended: boolean }
interface GrantRow { channelId: string | null; operatorId: string | null; suspended: boolean }

/**
 * 판정 순서는 "무엇이 빠졌나"를 가장 구체적으로 말하는 쪽이다. 거절도 전부 `secret_access_log` 에
 * 남는다(비밀을 특정할 수 있을 때). 값도 해시도 남기지 않는다.
 *
 * 보안 검토 L2 의 다섯 검사: 비밀 `expires_at` · grant `suspended_at` · 판 `revoked_at`/`sealed is null`
 * · `grant.operator_id = 요청 오퍼레이터`(null 이면 통과) — 그리고 H1 의 임대 채널.
 */
export async function revealSecret(
  pool: Pool, keyring: SecretKeyring,
  args: { agentId: string; operatorId: string; leaseId: string; token: string; name: string; limiter?: RevealLimiter; now?: Date },
): Promise<RevealResult> {
  const now = args.now ?? new Date();
  const lease = (await pool.query(
    `select id, agent_id as "agentId", operator_id as "operatorId", channel_id as "channelId",
            thread_root_id as "threadRootId", expires_at <= $3 as expired, ended_at is not null as ended
       from secret_turn_lease where id = $1 and token_hash = $2`,
    [args.leaseId, sha256(args.token), now])).rows[0] as LeaseRow | undefined;
  const leaseOk = !!lease && lease.agentId === args.agentId && lease.operatorId === args.operatorId
    && !lease.expired && !lease.ended;

  const secret = (await pool.query(
    `select s.id, s.name, s.kind, s.filename, s.expires_at <= $2 as expired,
            (o.deleted_at is not null or o.disabled_at is not null) as "ownerInactive",
            (select c.owner_account_id = s.owner_account_id from agent_config c where c.account_id = $3) as "ownAgent"
       from secret s join account o on o.id = s.owner_account_id where s.name = $1`,
    [args.name, now, args.agentId])).rows[0] as
    | { id: string; name: string; kind: 'text' | 'file'; filename: string | null; expired: boolean | null; ownerInactive: boolean; ownAgent: boolean | null }
    | undefined;

  const log = async (result: 'granted' | 'denied', reason: RevealDenial | null, version: number | null) => {
    if (!secret) return;
    await pool.query(
      `insert into secret_access_log (secret_id, secret_name, version, agent_id, operator_id, turn_id, channel_id, thread_root_id, result, reason, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [secret.id, secret.name, version, args.agentId, args.operatorId, leaseOk ? lease!.id : null,
        leaseOk ? lease!.channelId : null, leaseOk ? lease!.threadRootId : null, result, reason, now]);
  };
  const deny = async (code: RevealDenial): Promise<RevealResult> => { await log('denied', code, null); return { ok: false, code }; };

  if (!leaseOk) return deny('lease_invalid');
  if (!secret) return { ok: false, code: 'not_found' };
  if (args.limiter && !args.limiter.take(args.agentId, now.getTime())) return deny('rate_limited');
  if (secret.expired) return deny('secret_expired');
  if (secret.ownerInactive) return deny('owner_inactive');

  const grants = (await pool.query(
    `select channel_id as "channelId", operator_id as "operatorId", suspended_at is not null as suspended
       from secret_grant where secret_id = $1 and agent_id = $2`,
    [secret.id, args.agentId])).rows as GrantRow[];
  const inChannel = grants.filter((g) => g.channelId === null || g.channelId === lease!.channelId);
  const onOperator = inChannel.filter((g) => g.operatorId === null || g.operatorId === args.operatorId);
  const live = onOperator.filter((g) => !g.suspended);
  if (!grants.length) return deny('not_granted');
  // 남의 에이전트에게 준 옛 줄(부여 차단 전에 생긴 것)도 막는다 — 소유가 바뀐 에이전트도 같다.
  if (secret.ownAgent !== true) return deny('not_own_agent');
  if (!inChannel.length) return deny('wrong_channel');
  if (!onOperator.length) return deny('wrong_operator');
  if (!live.length) return deny('grant_suspended');

  const v = (await pool.query(
    `select version, sealed from secret_version
      where secret_id = $1 and revoked_at is null and sealed is not null order by version desc limit 1`,
    [secret.id])).rows[0] as { version: number; sealed: string } | undefined;
  if (!v) return deny('no_value');
  const value = keyring.open(v.sealed, { secretId: secret.id, version: v.version, kind: secret.kind });
  if (!value) return deny('unreadable');
  await log('granted', null, v.version);
  return { ok: true, secretId: secret.id, name: secret.name, kind: secret.kind, filename: secret.filename, version: v.version, value };
}

/**
 * 에이전트에게 보여 줄 목록 — **이름·종류·설명·채널 한정**뿐이다. 값·판·소유자는 싣지 않는다.
 * 지금 받을 수 없는 것(만료·정지·소유자 비활성·값 없음)은 뺀다. 채널 한정은 그대로 알려 준다 —
 * 에이전트가 "이 채널에서는 못 쓴다"를 미리 안다.
 */
export async function listGrantedSecrets(pool: Pool, agentId: string): Promise<{
  name: string; kind: 'text' | 'file'; filename: string | null; description: string; channelIds: (string | null)[];
}[]> {
  const r = await pool.query(
    `select s.name, s.kind, s.filename, s.description, array_agg(distinct g.channel_id) as "channelIds"
       from secret_grant g join secret s on s.id = g.secret_id join account o on o.id = s.owner_account_id
       join agent_config ac on ac.account_id = g.agent_id and ac.owner_account_id = s.owner_account_id
      where g.agent_id = $1 and g.suspended_at is null
        and (s.expires_at is null or s.expires_at > now())
        and o.deleted_at is null and o.disabled_at is null
        and exists (select 1 from secret_version v where v.secret_id = s.id and v.revoked_at is null and v.sealed is not null)
      group by s.id order by s.name`, [agentId]);
  return r.rows;
}

export type SuspendReason = 'assignment_changed' | 'definition_changed' | 'agent_disabled' | 'agent_deleted';

/**
 * grant 정지(D3). 지우지 않고 세운다 — 소유자가 바뀐 상황을 보고 다시 주면(`PUT grants`) 풀린다.
 * - 배정이 바뀌면 **다른 오퍼레이터에 묶인 grant** 만 세운다(`exceptOperatorId`). '어느 오퍼레이터든'
 *   (operator_id null)은 소유자가 바로 이 경우를 허락한 것이다.
 * - 지시문·하네스·소유자 변경·비활성·삭제는 그 에이전트의 grant 전부.
 *
 * 비밀 **소유자**가 비활성·삭제되는 경우(L3)는 정지가 아니라 reveal·목록의 판정(`ownerInactive`)이
 * 막는다 — 지금 사람 계정을 끄거나 지우는 경로가 서버에 없어서 걸 자리가 없고, 판정으로 막으면
 * 앞으로 그 경로가 생겨도(또는 DB 에서 직접 꺼도) 빠지지 않는다.
 */
export async function suspendSecretGrants(
  db: Pool | PoolClient,
  target: { agentId: string; exceptOperatorId?: string },
  reason: SuspendReason,
): Promise<number> {
  const r = target.exceptOperatorId !== undefined
    ? await db.query(
      `update secret_grant set suspended_at = now(), suspend_reason = $2
        where agent_id = $1 and suspended_at is null and operator_id is not null and operator_id <> $3`,
      [target.agentId, reason, target.exceptOperatorId])
    : await db.query(
      `update secret_grant set suspended_at = now(), suspend_reason = $2 where agent_id = $1 and suspended_at is null`,
      [target.agentId, reason]);
  return r.rowCount ?? 0;
}

/**
 * reveal 속도 제한(M6). 에이전트마다 창 안의 횟수. 인메모리다 — 서버가 재시작하면 비워지지만,
 * 목적은 프롬프트 주입이 루프로 값을 퍼 가는 것을 늦추는 것이지 정확한 회계가 아니다.
 */
export class RevealLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 30, private readonly windowMs = 10 * 60_000) {}
  take(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }
}
