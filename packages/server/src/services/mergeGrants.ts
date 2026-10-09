import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { repoScope } from '@harkroom/shared';
import { mergeGrantFor } from '../auth/permissions.js';
import { recordAudit } from '../audit.js';
import { postMessage } from './messages.js';

/**
 * 에이전트 머지 권한 — 서버 쪽 판정과 기록. 설계 스레드 3deac356(채널 a42006a1), security F1~F4.
 *
 * **이것은 실수 방지 장치이지 경계가 아니다.** 머지 권한은 서버 표(`account_grant`)와 오퍼레이터의
 * `merge` 래퍼가 지킨다. 같은 사용자 계정으로 도는 에이전트는 Keychain 의 gh 토큰으로 이 장치를 돌아갈
 * 수 있으므로, 악의적인 에이전트를 막는 경계가 아니다. 경계가 필요해지면 seatbelt 격리나 서버 머지
 * (GitHub App + ruleset)로 간다.
 *
 * 흐름: 래퍼가 `POST /agent/merge-checks` 로 (임대, 저장소, PR) 를 묻는다 → 서버가 **자기 사실로만**
 * 판정한다(임대 → 에이전트·오퍼레이터·그 턴을 띄운 메시지, grant → 정확 일치 저장소) → 통과하면 래퍼가
 * gh 로 머지하고 `POST /agent/merge-results` 로 결과를 알린다 → 서버가 스레드에 시스템 줄을 쓰고 감사에
 * 남긴다. 거절도 전부 감사에 남는다.
 */

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export type MergeDenial =
  | 'lease_invalid' | 'bad_repo' | 'not_granted' | 'cause_not_human';

export type MergeCheck =
  | { ok: true; leaseId: string; channelId: string; threadRootId: string; scope: string; grantedBy: string; grantedAt: string; causeByHuman: boolean }
  /** `denialId` 는 거절 카드를 세울 수 있는 거절에만 있다(`not_granted` 이고 나머지 판정은 통과 — C2). */
  | { ok: false; code: MergeDenial; denialId?: string };

/** 거절 기록(`merge_denial`)을 쓸 수 있는 시한 — 카드가 하루 한 장이라 하루. grant 의 기한(7일)과 다르다. */
export const MERGE_DENIAL_TTL_MS = 24 * 3_600_000;

/** 에이전트 하나가 24시간에 새로 만들 수 있는 거절 기록 수(security L2) — 넘으면 거절은 하되 카드용 `denialId` 를 주지 않는다. */
export const MERGE_DENIAL_DAILY_CAP = 20;

export interface LeaseRow {
  id: string; agentId: string; operatorId: string; channelId: string; threadRootId: string;
  expired: boolean; ended: boolean; causeKind: string | null;
  /** cause 메시지가 **이 에이전트 자신의 선택 카드**(ask)이고 사람이 답한 경우 — 답한 사람의 id·kind. 아니면 null. */
  causeAskAuthorId: string | null; askAnsweredBy: string | null; askAnswererKind: string | null; askAnswererOwnsAgent: boolean;
}

export async function readLease(pool: Pool, args: { leaseId: string; token: string; now: Date }): Promise<LeaseRow | undefined> {
  return (await pool.query(
    `select l.id, l.agent_id as "agentId", l.operator_id as "operatorId", l.channel_id as "channelId",
            l.thread_root_id as "threadRootId", l.expires_at <= $3 as expired, l.ended_at is not null as ended,
            a.kind as "causeKind",
            case when m.meta ? 'ask' and m.meta->'ask'->>'mirrorOf' is null then m.author_id end as "causeAskAuthorId",
            m.meta->'ask'->>'answeredBy' as "askAnsweredBy",
            ans.kind as "askAnswererKind",
            exists (select 1 from agent_config c where c.account_id = l.agent_id and c.owner_account_id = ans.id) as "askAnswererOwnsAgent"
       from secret_turn_lease l
       left join message m on m.id = l.cause_message_id
       left join account a on a.id = m.author_id
       left join account ans on ans.id = nullif(m.meta->'ask'->>'answeredBy', '')::uuid
      where l.id = $1 and l.token_hash = $2`,
    [args.leaseId, sha256(args.token), args.now])).rows[0] as LeaseRow | undefined;
}

/**
 * F4 의 "사람이 띄운 턴" 판정(스레드 3deac356, 10-03 후속 ③).
 *
 * 둘 중 하나면 사람이 띄운 것이다:
 * 1. cause 메시지의 작성자가 사람(멘션·답글).
 * 2. cause 메시지가 **이 에이전트 자신이 세운 선택 카드**(`meta.ask`, 작성자 = 이 에이전트)이고, 그 카드에
 *    **답한 사람**(`meta.ask.answeredBy`)이 사람이면서 **이 에이전트의 소유자**인 경우 — "카드로 머지를 고르면
 *    머지한다"는 흐름. 카드 작성자가 다른 에이전트이거나(남의 카드), 답한 사람이 소유자가 아니거나(채널의 아무
 *    사람), 아직 답이 없으면 아니다. 답한 사람의 신원은 서버가 `recordAskAnswer` 에서 적은 값이라 에이전트가
 *    지어낼 수 없다.
 *
 * **거울 카드(`mirrorOf`)는 cause 로 인정하지 않는다**(security F1, #1134). `syncAskMirrors` 는 원본에 답이 정해지면
 * 열린 거울마다 `answeredBy` 를 그대로 옮겨 적고 거울을 낸 쪽을 거울 id 로 깨운다 — 그래서 에이전트 B 가 남(A)의
 * 사람 카드에 거울을 걸어 두면, 소유자가 A 의 원본에 답한 순간 B 의 턴이 "소유자가 내 카드에 답했다"처럼 보인다.
 * 소유자는 B 의 카드를 본 적도 없다. 자기 카드에 거울을 거는 일은 없으므로 거울은 통째로 뺀다.
 */
export function causeByHuman(lease: Pick<LeaseRow, 'agentId' | 'causeKind' | 'causeAskAuthorId' | 'askAnsweredBy' | 'askAnswererKind' | 'askAnswererOwnsAgent'>): boolean {
  if (lease.causeKind === 'human') return true;
  return lease.causeAskAuthorId === lease.agentId && !!lease.askAnsweredBy
    && lease.askAnswererKind === 'human' && lease.askAnswererOwnsAgent === true;
}

/**
 * 판정 순서는 "무엇이 빠졌나"를 가장 구체적으로 말하는 쪽이다. F4: 그 턴을 띄운 메시지가 사람 글이
 * 아니면(에이전트의 위임·멘션) grant 에 `allow_agent_cause` 가 켜져 있어야 한다.
 */
export async function checkMerge(
  pool: Pool,
  args: { agentId: string; operatorId: string; leaseId: string; token: string; repo: string; number: number; headSha: string; now?: Date },
): Promise<MergeCheck> {
  const now = args.now ?? new Date();
  const lease = await readLease(pool, { leaseId: args.leaseId, token: args.token, now });
  const leaseOk = !!lease && lease.agentId === args.agentId && lease.operatorId === args.operatorId
    && !lease.expired && !lease.ended;
  const scope = repoScope(args.repo);

  const deny = async (code: MergeDenial): Promise<MergeCheck> => {
    await recordAudit(pool, {
      action: 'repo.merge.denied', actorId: args.agentId, target: scope ?? args.repo,
      detail: { code, number: args.number, headSha: args.headSha, operatorId: args.operatorId, leaseId: leaseOk ? lease!.id : null },
    });
    return { ok: false, code };
  };

  if (!leaseOk) return deny('lease_invalid');
  if (!scope) return deny('bad_repo');
  const grant = await mergeGrantFor(pool, args.agentId, args.repo);
  const byHuman = causeByHuman(lease!);
  if (!grant) {
    const denied = await deny('not_granted');
    // C2: 카드는 **나머지 판정을 다 통과한** 거절에만 — 사람이 띄우지 않은 턴(에이전트 위임)이 권한 카드를 만들지 못하게.
    // 임대·저장소 모양은 위에서 이미 걸렀다. `allow_agent_cause` 는 grant 의 칸이라 grant 가 없으면 사람 턴만 남는다.
    if (!byHuman) return denied;
    // L2(security, #1158): 거절 기록은 무한히 늘지 않는다. ① (에이전트, 저장소, 채널, 스레드)에 안 쓰고 안 만료된 기록이 있으면
    // 그것을 다시 쓴다 — PR·head·임대만 지금 것으로 바꾼다(카드는 어차피 그 묶음에 한 장이다). ② 새로 만드는 것은 에이전트마다
    // 24시간에 `MERGE_DENIAL_DAILY_CAP` 개까지 — 넘으면 거절은 그대로 하되 카드용 id 는 주지 않는다(저장소 이름을 바꿔 가며 부르는 경우).
    const reused = (await pool.query<{ id: string }>(
      `update merge_denial set pr_number = $5, head_sha = $6, lease_id = $7
        where id = (select id from merge_denial
                     where agent_id = $1 and scope = $2 and channel_id = $3 and thread_root_id = $4
                       and used_at is null and expires_at > $8
                     order by created_at desc limit 1)
        returning id`,
      [args.agentId, scope, lease!.channelId, lease!.threadRootId, args.number, args.headSha, lease!.id, now])).rows[0];
    if (reused) return { ok: false, code: 'not_granted', denialId: reused.id };
    const recent = (await pool.query<{ n: number }>(
      `select count(*)::int as n from merge_denial where agent_id = $1 and created_at > $2`,
      [args.agentId, new Date(now.getTime() - 24 * 3_600_000)])).rows[0]!.n;
    if (recent >= MERGE_DENIAL_DAILY_CAP) return denied;
    const row = (await pool.query<{ id: string }>(
      `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [args.agentId, scope, args.number, args.headSha, lease!.channelId, lease!.threadRootId, lease!.id,
        new Date(now.getTime() + MERGE_DENIAL_TTL_MS)])).rows[0]!;
    return { ok: false, code: 'not_granted', denialId: row.id };
  }
  if (!byHuman && !grant.allowAgentCause) return deny('cause_not_human');

  await recordAudit(pool, {
    action: 'repo.merge.checked', actorId: args.agentId, target: scope,
    // grantScope: 어느 grant 로 통과했나 — 정확한 이름(`repo:owner/name`)인지 조직 전체(`repo:owner/*`)인지(#1255 security n3).
    detail: { number: args.number, headSha: args.headSha, operatorId: args.operatorId, leaseId: lease!.id, grantedBy: grant.grantedBy, grantScope: grant.scope, causeByHuman: byHuman, viaAskAnswer: byHuman && lease!.causeKind !== 'human' },
  });
  return {
    ok: true, leaseId: lease!.id, channelId: lease!.channelId, threadRootId: lease!.threadRootId,
    scope, grantedBy: grant.grantedBy, grantedAt: grant.grantedAt, causeByHuman: byHuman,
  };
}

export type MergeReport = {
  agentId: string; operatorId: string; leaseId: string; token: string;
  repo: string; number: number; headSha: string;
  result: 'merged' | 'failed'; mergeSha?: string | null; error?: string | null; now?: Date;
};

/**
 * 래퍼의 보고를 스레드에 시스템 줄로 남긴다. **서버가 GitHub 에서 직접 확인한 것이 아니다** — 줄에
 * "래퍼 보고"라고 밝힌다(security 2). 임대가 맞지 않으면 아무것도 쓰지 않는다: 남의 스레드에 줄을
 * 꽂는 길이 되기 때문이다.
 */
export async function reportMerge(pool: Pool, r: MergeReport): Promise<{ ok: true; messageId: string } | { ok: false; code: 'lease_invalid' | 'bad_repo' | 'not_checked' | 'already_reported' | 'post_failed' }> {
  const now = r.now ?? new Date();
  const lease = await readLease(pool, { leaseId: r.leaseId, token: r.token, now });
  // 보고는 턴이 끝난 뒤 올 수 있으니 `ended` 는 보지 않는다. 만료·소속은 본다.
  if (!lease || lease.agentId !== r.agentId || lease.operatorId !== r.operatorId || lease.expired) return { ok: false, code: 'lease_invalid' };
  const scope = repoScope(r.repo);
  if (!scope) return { ok: false, code: 'bad_repo' };
  const repo = scope.slice('repo:'.length);
  // N1: 같은 (임대, 저장소, PR, head) 로 **통과한 판정**이 있어야 받고, 보고는 한 번뿐이다 — 판정 없이
  // 보고를 받으면 grant 없는 에이전트도 자기 스레드에 "머지됨" 줄을 쓸 수 있어 감사가 거짓이 된다.
  const trail = await pool.query<{ action: string }>(
    `select action from audit_log
      where action in ('repo.merge.checked', 'repo.merge.merged', 'repo.merge.failed')
        and target = $1 and detail->>'leaseId' = $2 and (detail->>'number')::int = $3 and detail->>'headSha' = $4`,
    [scope, lease.id, r.number, r.headSha]);
  if (trail.rows.some((x) => x.action !== 'repo.merge.checked')) return { ok: false, code: 'already_reported' };
  if (!trail.rowCount) return { ok: false, code: 'not_checked' };
  const grant = await mergeGrantFor(pool, r.agentId, repo);
  const granter = grant
    ? (await pool.query<{ handle: string }>(`select handle from account where id = $1`, [grant.grantedBy])).rows[0]?.handle ?? null
    : null;
  // N2: 본문은 고정 문구뿐이다. 래퍼가 준 `error` 는 meta 에만 둔다 — `postMessage` 는 kind 와 상관없이
  // 본문의 멘션을 풀기 때문에 gh 의 오류 문구 속 `@…` 가 실제 부름이 된다.
  const body = r.result === 'merged'
    ? `🔀 ${repo}#${r.number} 머지됨 · ${(r.mergeSha ?? r.headSha).slice(0, 9)}` + (granter ? ` · 권한: ${granter}` : '') + ' (래퍼 보고)'
    : `⛔ ${repo}#${r.number} 머지 실패 · head ${r.headSha.slice(0, 9)} (래퍼 보고)`;
  const posted = await postMessage(pool, {
    channelId: lease.channelId, threadRootId: lease.threadRootId, authorId: r.agentId, body, kind: 'system',
    meta: { merge: { repo, number: r.number, headSha: r.headSha, mergeSha: r.mergeSha ?? null, result: r.result, grantedBy: grant?.grantedBy ?? null, error: r.error?.slice(0, 1000) ?? null } },
  });
  if (posted.failure) return { ok: false, code: 'post_failed' };
  const msg = posted.message;
  await recordAudit(pool, {
    action: r.result === 'merged' ? 'repo.merge.merged' : 'repo.merge.failed', actorId: r.agentId, target: scope,
    detail: { number: r.number, headSha: r.headSha, mergeSha: r.mergeSha ?? null, operatorId: r.operatorId, leaseId: lease.id, messageId: msg.id },
  });
  return { ok: true, messageId: msg.id };
}

/** 이 에이전트가 머지해도 되는 저장소 목록 — 러너가 턴을 띄울 때 allow/deny 규칙을 고르는 근거(PR 2). */
export async function mergeableRepos(pool: Pool, agentId: string): Promise<string[]> {
  const res = await pool.query<{ scope: string }>(
    `select scope from account_grant where account_id = $1 and capability = 'repo.merge'
        and (expires_at is null or expires_at > now()) order by scope`, [agentId]);
  return res.rows.map((r) => r.scope.slice('repo:'.length));
}
