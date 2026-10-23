import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { repoScope } from '@harkroom/shared';
import { mergeGrantFor } from '../auth/permissions.js';
import { recordAudit } from '../audit.js';
import { checkNamesForBody, checkNamesText, obsoleteMergeCards, sanitizeCheckNames } from './mergeDenials.js';
import { postMessage } from './messages.js';
import { systemI18n } from './systemI18n.js';
import { consumeLine, findLine, type LineVia } from './mandateLines.js';
import { GH_LOGIN_RE } from './mergeDenials.js';

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
  | 'lease_invalid' | 'bad_repo' | 'not_granted' | 'cause_not_human' | 'no_mandate_line';

export type MergeCheck =
  | { ok: true; leaseId: string; channelId: string; threadRootId: string; scope: string; grantedBy: string; grantedAt: string; causeByHuman: boolean;
      /** 위임 사슬로 통과했으면 그 뿌리(소유자 글) — A안. */
      viaChain?: { rootId: string };
      /** 1회 승인(`merge_approval`)으로 통과했으면 그 기록 — 래퍼는 이 계정만 쓰고, `relaxChecks` 일 때만 CI·CLEAN 판정을 GitHub 에 맡긴다. */
      approval?: { id: string; ghUser: string | null; relaxChecks: boolean; ciOverride: boolean };
      /** 위임 판정(W3, `HARKROOM_MANDATE_ENFORCE=on`)으로 통과했으면 그 줄. `ghUser` 가 있으면 래퍼가 알려 준 계정과 같았다. */
      mandateLine?: { id: string; via: LineVia; ghUser: string | null; ciOverride: boolean } }
  /** `denialId` 는 거절 카드를 세울 수 있는 거절에만 있다(사람이 띄운 턴의 `not_granted`, 그리고 `cause_not_human` — C2·1회 승인). */
  | { ok: false; code: MergeDenial; denialId?: string };

/**
 * 위임 판정 스위치(W3) — `HARKROOM_MANDATE_ENFORCE=on` 이면 머지는 위임장의 merge 줄로 판정한다(사슬·`cause_not_human` 대신).
 * 기본은 꺼짐(지금 판정 그대로, 그림자만). 부를 때마다 읽는다 — 시험이 켜고 끈다.
 */
export function mandateEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HARKROOM_MANDATE_ENFORCE ?? '').trim().toLowerCase() === 'on';
}

/** 거절 기록(`merge_denial`)을 쓸 수 있는 시한 — 카드가 하루 한 장이라 하루. grant 의 기한(7일)과 다르다. */
export const MERGE_DENIAL_TTL_MS = 24 * 3_600_000;

/** 에이전트 하나가 24시간에 새로 만들 수 있는 거절 기록 수(security L2) — 넘으면 거절은 하되 카드용 `denialId` 를 주지 않는다. */
export const MERGE_DENIAL_DAILY_CAP = 20;

export interface LeaseRow {
  id: string; agentId: string; operatorId: string; channelId: string; threadRootId: string;
  expired: boolean; ended: boolean; causeKind: string | null;
  /** 이 턴을 띄운 메시지 — 위임 사슬(`causeChainRoot`)의 출발점. */
  causeMessageId: string;
  /** 위임 키(133, W1) — 발급 때 서버가 적은 값. 판정에는 아직 쓰지 않는다(그림자 기록만). */
  mandateId: string | null;
  /** cause 메시지가 **이 에이전트 자신의 선택 카드**(ask)이고 사람이 답한 경우 — 답한 사람의 id·kind. 아니면 null. */
  causeAskAuthorId: string | null; askAnsweredBy: string | null; askAnswererKind: string | null; askAnswererOwnsAgent: boolean;
}

export async function readLease(pool: Pool, args: { leaseId: string; token: string; now: Date }): Promise<LeaseRow | undefined> {
  return (await pool.query(
    `select l.id, l.agent_id as "agentId", l.operator_id as "operatorId", l.channel_id as "channelId",
            l.thread_root_id as "threadRootId", l.expires_at <= $3 as expired, l.ended_at is not null as ended,
            l.cause_message_id as "causeMessageId", l.mandate_id as "mandateId",
            a.kind as "causeKind",
            case when m.meta ? 'ask' and m.meta->'ask'->>'mirrorOf' is null and m.meta->'ask'->>'answeredVia' is null
                 then m.author_id end as "causeAskAuthorId",
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
 *
 * **일괄로 매긴 답(`answeredVia`)도 cause 로 인정하지 않는다**(security F1, #1280). 묶음 카드의 「추천대로」를 한 번 누르면 최대
 * 20개 원본에 소유자 이름으로 답이 적힌다 — 소유자는 그 줄들을 읽지 않았을 수 있다. 줄 하나를 골라 누른 답은 지금처럼 센다.
 */
export function causeByHuman(lease: Pick<LeaseRow, 'agentId' | 'causeKind' | 'causeAskAuthorId' | 'askAnsweredBy' | 'askAnswererKind' | 'askAnswererOwnsAgent'>): boolean {
  if (lease.causeKind === 'human') return true;
  return lease.causeAskAuthorId === lease.agentId && !!lease.askAnsweredBy
    && lease.askAnswererKind === 'human' && lease.askAnswererOwnsAgent === true;
}

/** 사슬을 거슬러 오르는 칸 수 상한 — wake 를 되풀이하면 한 칸씩 는다. 넘으면 끊긴 것으로 보고 카드가 선다(안전한 쪽). */
export const CAUSE_CHAIN_MAX_HOPS = 8;
/** 사슬 뿌리(소유자 글)의 신선도 — 카드로 주는 grant 기한(7일)과 같다. */
export const CAUSE_CHAIN_ROOT_MAX_AGE_MS = 7 * 86_400_000;

export interface CauseChain { rootId: string; path: string[] }

/**
 * 위임 사슬의 뿌리(A안, 스레드 0e30c565, security C2~C4). 턴을 띄운 메시지에서 `message.cause_message_id`(118)를 거슬러 올라
 * **머지하는 에이전트의 소유자가 시작한 흐름**인지 본다. 읽기 전용 재귀 쿼리 하나다 — 칸 수·순환·삭제·7일을 SQL 안에서 거른다.
 *
 * - 소유자는 **지금** `agent_config` 에서 읽는다(C2) — 글을 쓸 때의 소유자를 믿지 않는다. 소유자가 바뀌면 옛 사슬은 끊긴다.
 *   소유자 계정이 사람이 아니거나 지워졌거나 막혔으면 사슬은 없다.
 * - **올라가는 고리**는 지워지지 않은 에이전트 글이고, 그 에이전트의 소유자가 머지 에이전트의 소유자와 같아야 한다. 사람 글에서는
 *   올라가지 않는다(그 글이 뿌리이거나 사슬이 끝난다).
 * - **답이 달린 ask 에서는 올라가지 않는다**(C3) — 그 턴을 띄운 것은 답한 사람이다. 소유자가 줄 하나를 골라 답했으면(거울·일괄 답
 *   아님) 그 ask 가 뿌리이고, 다른 사람이 답했으면 사슬은 거기서 끝난다.
 * - **뿌리**: (a) 소유자 본인이 쓴 `kind='user'` 글(소유자 이름으로 나간 자동화 글 `meta.automation` 은 아니다) 또는 (b) 같은
 *   소유자의 에이전트가 세운 ask 에 소유자가 직접 답한 것. 7일 안이고 지워지지 않았어야 한다.
 *
 * 증명하는 것은 「소유자가 시작한 흐름」뿐이다 — 글의 내용(이 PR 을 머지하라는 뜻)은 증명하지 않는다.
 */
export async function causeChainRoot(
  pool: Pool, args: { agentId: string; causeMessageId: string; now: Date },
): Promise<CauseChain | null> {
  const row = (await pool.query<{ rootId: string; path: string[] }>(
    `with recursive
       own as (
         select c.owner_account_id as id
           from agent_config c join account o on o.id = c.owner_account_id
          where c.account_id = $1 and o.kind = 'human' and o.deleted_at is null and o.disabled_at is null
       ),
       walk (id, hop, path) as (
         select m.id, 0, array[m.id] from message m where m.id = $2
         union all
         select m.cause_message_id, w.hop + 1, w.path || m.cause_message_id
           from walk w
           join message m on m.id = w.id
           join account a on a.id = m.author_id
           join agent_config c on c.account_id = a.id
          where w.hop < $4
            and m.cause_message_id is not null
            and not (m.cause_message_id = any (w.path))
            and m.deleted_at is null
            and a.kind = 'agent'
            and c.owner_account_id = (select id from own)
            and not (m.meta ? 'ask' and coalesce(m.meta->'ask'->>'answeredBy', '') <> '')
       )
     select w.id as "rootId", w.path as "path"
       from walk w
       join message m on m.id = w.id
       join account a on a.id = m.author_id
      where m.deleted_at is null and m.created_at > $3
        and (
          (a.id = (select id from own) and a.kind = 'human' and m.kind = 'user' and not (m.meta ? 'automation'))
          or (m.meta ? 'ask' and a.kind = 'agent'
              and exists (select 1 from agent_config c2 where c2.account_id = a.id and c2.owner_account_id = (select id from own))
              and m.meta->'ask'->>'mirrorOf' is null and m.meta->'ask'->>'answeredVia' is null
              and m.meta->'ask'->>'answeredBy' = (select id from own)::text)
        )
      order by w.hop asc
      limit 1`,
    [args.agentId, args.causeMessageId, new Date(args.now.getTime() - CAUSE_CHAIN_ROOT_MAX_AGE_MS), CAUSE_CHAIN_MAX_HOPS])).rows[0];
  return row ? { rootId: row.rootId, path: row.path } : null;
}

/**
 * 판정 순서는 "무엇이 빠졌나"를 가장 구체적으로 말하는 쪽이다. F4: 그 턴을 띄운 메시지가 사람 글이
 * 아니면(에이전트의 위임·멘션) grant 에 `allow_agent_cause` 가 켜져 있어야 한다.
 */
export async function checkMerge(
  pool: Pool,
  args: MergeCheckArgs,
): Promise<MergeCheck> {
  const enforce = mandateEnforced();
  const result = await checkMergeByChain(pool, args, enforce);
  // 위임(mandate) 그림자 기록 — 켜든 끄든 남긴다(켜면 어느 판정이 나갔는지도). 실패해도 판정은 그대로 나간다.
  try { await shadowMandate(pool, args, result, enforce); } catch { /* 그림자는 판정을 바꾸지 않는다 */ }
  return result;
}

export interface MergeCheckArgs {
  agentId: string; operatorId: string; leaseId: string; token: string; repo: string; number: number; headSha: string; now?: Date;
  /** 래퍼가 머지에 쓸 gh 계정(알려 줄 때만). 위임 판정에서 줄의 `limits.ghUser` 와 맞춘다 — 없으면 ghUser 가 박힌 줄은 맞지 않는다. */
  ghUser?: string | null;
}

/**
 * 위임 판정을 사슬 판정 옆에서 계산해 감사(`mandate.shadow`)에 남긴다. **결과를 바꾸지 않는다.** 위임 판정: 임대의 위임에
 * 이 저장소를 덮는 merge 줄이 있다(`mandateLines.ts::findLine` — 위임 유효·같은 소유자·H3·회수/until/uses 를 거기서 본다).
 */
async function shadowMandate(
  pool: Pool,
  args: { agentId: string; operatorId: string; leaseId: string; token: string; repo: string; number?: number; headSha?: string; now?: Date; ghUser?: string | null },
  result: MergeCheck,
  enforce: boolean,
): Promise<void> {
  const now = args.now ?? new Date();
  const lease = await readLease(pool, { leaseId: args.leaseId, token: args.token, now });
  if (!lease || lease.agentId !== args.agentId || lease.operatorId !== args.operatorId) return;
  const scope = repoScope(args.repo);
  if (!scope) return;
  // 위임 판정 = 위임장의 merge 줄(W2) — 상시 줄(소유자가 준 머지 grant)도 여기서 펼쳐진다.
  // 켜져 있으면 위임 판정은 이미 줄을 썼다(uses 소모) — 다시 찾지 않고 그 결과를 적는다. 사슬 판정은 돌리지 않는다(거절 카드를 만들므로).
  const line = enforce
    ? (result.ok && result.mandateLine ? { id: result.mandateLine.id, via: result.mandateLine.via } : null)
    : await findLine(pool, { mandateId: lease.mandateId, agentId: args.agentId, cap: 'merge', action: { cap: 'merge', repo: args.repo, pr: args.number, head: args.headSha, ghUser: args.ghUser ?? null }, now });
  const mandateVerdict = enforce ? (result.ok ? 'allowed' : result.code) : (line ? 'allowed' : 'denied');
  await recordAudit(pool, {
    action: 'mandate.shadow', actorId: args.agentId, target: scope,
    detail: {
      enforced: enforce ? 'mandate' : 'chain',
      chainVerdict: enforce ? null : (result.ok ? 'allowed' : result.code), mandateVerdict,
      ...(enforce && result.ok && result.approval ? { viaApproval: result.approval.id } : {}),
      mandateId: lease.mandateId, agentId: args.agentId, repo: scope, leaseId: lease.id,
      lineId: line?.id ?? null, lineVia: line?.via ?? null,
    },
  });
}

async function checkMergeByChain(
  pool: Pool,
  args: MergeCheckArgs,
  enforce = false,
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

  /**
   * 거절 기록(`merge_denial`)을 남기고 카드용 id 를 준다. L2(security, #1158): ① (에이전트, 저장소, 채널, 스레드, **PR, head**)에 안 쓰고
   * 안 만료된 기록이 있으면 그것을 다시 쓴다 — 임대·사유만 지금 것으로 바꾼다. 기록이 가리키는 PR·head 는 바꾸지 않는다(D1): 사람이
   * 카드에서 본 PR 과 승인이 쓰이는 PR 이 어긋나면 안 된다. 같은 PR 의 다른 head 기록은 낡았으니 닫는다(`obsoleteOtherHeads`).
   * ② 새로 만드는 것은 에이전트마다 24시간에 `MERGE_DENIAL_DAILY_CAP` 개까지 — 넘으면 거절은 그대로 하되 카드용 id 는 주지 않는다.
   */
  const denyWithCard = async (code: 'not_granted' | 'cause_not_human' | 'no_mandate_line'): Promise<MergeCheck> => {
    const denied = await deny(code);
    const reused = (await pool.query<{ id: string }>(
      `update merge_denial set lease_id = $7, reason = $9
        where id = (select id from merge_denial
                     where agent_id = $1 and scope = $2 and channel_id = $3 and thread_root_id = $4 and pr_number = $5 and head_sha = $6
                       and used_at is null and obsoleted_at is null and expires_at > $8
                       and reason in ('not_granted', 'cause_not_human', 'no_mandate_line')
                     order by created_at desc limit 1)
        returning id`,
      [args.agentId, scope, lease!.channelId, lease!.threadRootId, args.number, args.headSha, lease!.id, now, code])).rows[0];
    if (reused) return { ok: false, code, denialId: reused.id };
    await obsoleteOtherHeads(pool, { agentId: args.agentId, scope, lease: lease!, number: args.number, headSha: args.headSha, ci: false, now });
    const recent = (await pool.query<{ n: number }>(
      `select count(*)::int as n from merge_denial where agent_id = $1 and created_at > $2`,
      [args.agentId, new Date(now.getTime() - 24 * 3_600_000)])).rows[0]!.n;
    if (recent >= MERGE_DENIAL_DAILY_CAP) return denied;
    const row = (await pool.query<{ id: string }>(
      `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [args.agentId, scope, args.number, args.headSha, lease!.channelId, lease!.threadRootId, lease!.id,
        new Date(now.getTime() + MERGE_DENIAL_TTL_MS), code])).rows[0]!;
    return { ok: false, code, denialId: row.id };
  };


  // 1회 승인(스레드 1b75d7a0): 소유자가 이 (PR, head, 스레드)를 한 번 승인했으면 grant·사람 턴 판정 대신 그것을 인정한다.
  // F1 임대·F2 저장소 모양은 위에서 이미 봤다. 소모는 `used_at is null` 을 단 한 문장 update — 두 래퍼가 동시에 와도 하나만 쓴다.
  // CI 실패 무시 승인(`ci_override`, 스레드 1fccc9a5 D3)은 **쓰는 턴도 사람이 띄운 것**이어야 한다 — wake·에이전트 위임 턴에서는
  // 고르지 않는다(소모되지 않고 남는다). 그 턴은 아래 grant 판정으로 간다.
  const approval = (await pool.query<{ id: string; ghUser: string | null; relaxChecks: boolean; ciOverride: boolean; approvedBy: string; approvedAt: Date }>(
    `update merge_approval set used_at = $8, used_lease_id = $9
      where id = (select id from merge_approval
                   where agent_id = $1 and scope = $2 and pr_number = $3 and head_sha = $4
                     and channel_id = $5 and thread_root_id = $6 and used_at is null and expires_at > $7
                     and (not ci_override or $10::boolean)
                   order by approved_at desc limit 1)
        and used_at is null
      returning id, gh_user as "ghUser", relax_checks as "relaxChecks", ci_override as "ciOverride", approved_by as "approvedBy", approved_at as "approvedAt"`,
    [args.agentId, scope, args.number, args.headSha, lease!.channelId, lease!.threadRootId, now, now, lease!.id, causeByHuman(lease!)])).rows[0];
  if (approval) {
    await recordAudit(pool, {
      action: 'repo.merge.checked', actorId: args.agentId, target: scope,
      detail: { number: args.number, headSha: args.headSha, operatorId: args.operatorId, leaseId: lease!.id, grantedBy: approval.approvedBy, approvalId: approval.id, ghUser: approval.ghUser, ...(approval.ghUser ? {} : { ghUserChosenBy: 'operator' }), relaxChecks: approval.relaxChecks, ciOverride: approval.ciOverride, causeByHuman: causeByHuman(lease!) },
    });
    // 계정을 비운 승인(G1)은 오퍼레이터가 고른다 — 이 줄을 쓰는 지금은 아직 서버가 그 계정을 모른다.
    // 본문(한국어)에는 「(오퍼레이터가 고름)」. 번역 표지는 그 갈래의 키(`…OperatorPick`)로 — 계정 인자 없이 언어마다 그 말을 쓴다(designer n3).
    const ghShown = approval.ghUser ?? '(오퍼레이터가 고름)';
    const ghUser = approval.ghUser;
    const i18nBase = { repo: scope.slice('repo:'.length), number: args.number, head: args.headSha.slice(0, 9) };
    const approver = approval.ciOverride
      ? (await pool.query<{ handle: string }>(`select handle from account where id = $1`, [approval.approvedBy])).rows[0]?.handle ?? null
      : null;
    // 쓴 순간 스레드에 남긴다(무엇을·누구 승인으로·어느 계정으로). 본문은 고정 문구와 서버 값뿐 — 멘션이 풀리지 않게 handle 은 meta 에만.
    await postMessage(pool, {
      channelId: lease!.channelId, threadRootId: lease!.threadRootId, authorId: args.agentId, kind: 'system',
      // CI 실패 무시 승인은 누가 승인했는지 본문에 적는다(handle 은 `@` 없이 — 「권한: handle」 과 같다). 표지는 승인자 id 로 싣는다.
      body: approval.ciOverride
        ? `🔓 ${scope.slice('repo:'.length)}#${args.number} CI 실패 무시 승인으로 머지 시도${approver ? ` · 승인: ${approver}` : ''} · head ${args.headSha.slice(0, 9)} · gh ${ghShown}`
        : `🔓 ${scope.slice('repo:'.length)}#${args.number} 1회 승인으로 머지 시도 · head ${args.headSha.slice(0, 9)} · gh ${ghShown}${approval.relaxChecks ? ' · CI 판정은 GitHub 에 맡김' : ''}`,
      meta: {
        mergeApproval: { id: approval.id, repo: scope.slice('repo:'.length), number: args.number, headSha: args.headSha, ghUser: approval.ghUser, relaxChecks: approval.relaxChecks, ciOverride: approval.ciOverride, approvedBy: approval.approvedBy },
        // 번역 표지(i18n P5) — 본문과 같은 값, 같은 갈래(CI 판정을 GitHub 에 맡겼나).
        ...(approval.ciOverride ? (approver ? {
          i18n: ghUser
            ? systemI18n('system.merge.approvalUsedCiOverride', { ...i18nBase, ghUser, approverId: approval.approvedBy })
            : systemI18n('system.merge.approvalUsedCiOverrideOperatorPick', { ...i18nBase, approverId: approval.approvedBy }),
        } : {}) : {
          i18n: approval.relaxChecks
            ? (ghUser ? systemI18n('system.merge.approvalUsedRelaxed', { ...i18nBase, ghUser }) : systemI18n('system.merge.approvalUsedRelaxedOperatorPick', i18nBase))
            : (ghUser ? systemI18n('system.merge.approvalUsed', { ...i18nBase, ghUser }) : systemI18n('system.merge.approvalUsedOperatorPick', i18nBase)),
        }),
      },
    });
    return {
      ok: true, leaseId: lease!.id, channelId: lease!.channelId, threadRootId: lease!.threadRootId, scope,
      grantedBy: approval.approvedBy, grantedAt: approval.approvedAt.toISOString(), causeByHuman: causeByHuman(lease!),
      approval: { id: approval.id, ghUser: approval.ghUser, relaxChecks: approval.relaxChecks, ciOverride: approval.ciOverride },
    };
  }

  if (enforce) return checkByMandate();

  /*
    위임 판정(W3) — 사슬·`cause_not_human` 대신 임대의 위임장에 이 저장소를 덮는 merge 줄이 있는지 본다. 줄을 찾는 일과 `uses` 소모는
    `consumeLine` 의 한 SQL 문장이다. 우회(bypass) 줄은 쓰지 않는다(W5). 줄이 없으면(위임 없음·만료·남의 위임 포함) `no_mandate_line` 카드.
  */
  async function checkByMandate(): Promise<MergeCheck> {
    const line = await consumeLine(pool, {
      mandateId: lease!.mandateId, agentId: args.agentId, cap: 'merge', now,
      action: { cap: 'merge', repo: args.repo, pr: args.number, head: args.headSha, ghUser: args.ghUser ?? null },
    });
    if (!line) return denyWithCard('no_mandate_line');
    const byHuman = causeByHuman(lease!);
    const ghUser = line.limits?.ghUser ?? null;
    const ciOverride = line.limits?.ciOverride === true;
    await recordAudit(pool, {
      action: 'repo.merge.checked', actorId: args.agentId, target: scope!,
      detail: { number: args.number, headSha: args.headSha, operatorId: args.operatorId, leaseId: lease!.id, grantedBy: line.grantedBy, mandateId: lease!.mandateId, lineId: line.id, lineVia: line.via, ghUser, ciOverride, causeByHuman: byHuman },
    });
    return {
      ok: true, leaseId: lease!.id, channelId: lease!.channelId, threadRootId: lease!.threadRootId, scope: scope!,
      grantedBy: line.grantedBy, grantedAt: new Date(line.createdAt).toISOString(), causeByHuman: byHuman,
      mandateLine: { id: line.id, via: line.via, ghUser, ciOverride },
    };
  }

  const grant = await mergeGrantFor(pool, args.agentId, args.repo);
  const byHuman = causeByHuman(lease!);

  if (!grant) {
    // C2: `not_granted` 카드는 **나머지 판정을 다 통과한** 거절에만 — 사람이 띄우지 않은 턴(에이전트 위임)이 권한 카드를 만들지 못하게.
    // `allow_agent_cause` 는 grant 의 칸이라 grant 가 없으면 사람 턴만 남는다.
    if (!byHuman) return deny('not_granted');
    return denyWithCard('not_granted');
  }
  // grant 는 있는데 사람이 띄운 턴이 아니다(wake·에이전트 위임). A안(스레드 0e30c565): 그 턴의 위임 사슬이 이 에이전트 소유자의 글에서
  // 시작했으면 사람 턴으로 친다 — **유효한 grant 가 있고 직접 판정이 실패했을 때만**(C4). 1회 승인·grant 없음·`allow_agent_cause`
  // 갈래는 사슬을 보지 않는다. 사슬이 끊기면 지금처럼 카드 id 를 준다 — 카드는 승인만 청할 뿐 아무것도 열지 않고, 하루 상한(L2) 안에서만 선다.
  let chain: CauseChain | null = null;
  if (!byHuman && !grant.allowAgentCause) {
    chain = await causeChainRoot(pool, { agentId: args.agentId, causeMessageId: lease!.causeMessageId, now });
    if (!chain) return denyWithCard('cause_not_human');
  }

  await recordAudit(pool, {
    action: 'repo.merge.checked', actorId: args.agentId, target: scope,
    // grantScope: 어느 grant 로 통과했나 — 정확한 이름(`repo:owner/name`)인지 조직 전체(`repo:owner/*`)인지(#1255 security n3).
    // viaChain(C5): 사슬로 통과했으면 뿌리 id 와 고리 id 목록(턴의 원인 → 뿌리 순서).
    detail: { number: args.number, headSha: args.headSha, operatorId: args.operatorId, leaseId: lease!.id, grantedBy: grant.grantedBy, grantScope: grant.scope, causeByHuman: byHuman, viaAskAnswer: byHuman && lease!.causeKind !== 'human', ...(chain ? { viaChain: { rootId: chain.rootId, path: chain.path } } : {}) },
  });
  return {
    ok: true, leaseId: lease!.id, channelId: lease!.channelId, threadRootId: lease!.threadRootId,
    scope, grantedBy: grant.grantedBy, grantedAt: grant.grantedAt, causeByHuman: byHuman || !!chain,
    ...(chain ? { viaChain: { rootId: chain.rootId } } : {}),
  };
}

export type MergeReport = {
  agentId: string; operatorId: string; leaseId: string; token: string;
  repo: string; number: number; headSha: string;
  /** `queued`(10-16): 대상 브랜치가 merge queue 를 써서 래퍼가 큐에 넣었다. 큐가 실제로 머지했는지는 이 보고가 말하지 않는다. */
  result: 'merged' | 'queued' | 'failed'; mergeSha?: string | null; error?: string | null; now?: Date;
  /**
   * `failed` 이고 래퍼가 **CI 때문에** 거절했을 때(스레드 1fccc9a5): 그 판정과 초록 아닌 체크 이름. 서버는 이것으로 `ci_not_green`
   * 거절 기록을 남기고 `denialId` 를 돌려준다(카드용). `ci_not_green` 이거나 `not_mergeable` + UNSTABLE 일 때만 받는다.
   */
  ciRefusal?: { code: string; mergeState?: string | null; checks?: unknown } | null;
  /** `merged`·`queued` 일 때 래퍼가 머지 직전에 다시 읽은 초록 아닌 체크 이름(무시하고 넘어간 것). 시스템 줄·감사에 남긴다. */
  ignoredChecks?: unknown;
  /**
   * 래퍼가 머지에 실제로 쓴 gh 이름(security n6). 계정을 비운 1회 승인(G1)이면 오퍼레이터가 골랐다 — 서버는 이 보고로만 그 이름을
   * 안다. 래퍼 보고라 감사에 `ghUserUsed` 로만 남기고(본문에는 싣지 않는다) gh 이름 모양이 아니면 버린다.
   */
  ghUserUsed?: unknown;
};


/** CI 거절 카드를 세울 수 있는 래퍼 판정인가 — `ci_not_green`, 또는 `not_mergeable` 인데 GitHub 이 UNSTABLE 이라고 한 것. */
export function isCiRefusal(c: MergeReport['ciRefusal']): boolean {
  if (!c) return false;
  return c.code === 'ci_not_green' || (c.code === 'not_mergeable' && c.mergeState === 'UNSTABLE');
}

/**
 * 래퍼의 보고를 스레드에 시스템 줄로 남긴다. **서버가 GitHub 에서 직접 확인한 것이 아니다** — 줄에
 * "래퍼 보고"라고 밝힌다(security 2). 임대가 맞지 않으면 아무것도 쓰지 않는다: 남의 스레드에 줄을
 * 꽂는 길이 되기 때문이다.
 */
export async function reportMerge(pool: Pool, r: MergeReport): Promise<{ ok: true; messageId: string; denialId?: string } | { ok: false; code: 'lease_invalid' | 'bad_repo' | 'not_checked' | 'already_reported' | 'post_failed' }> {
  const now = r.now ?? new Date();
  const lease = await readLease(pool, { leaseId: r.leaseId, token: r.token, now });
  // 보고는 턴이 끝난 뒤 올 수 있으니 `ended` 는 보지 않는다. 만료·소속은 본다.
  if (!lease || lease.agentId !== r.agentId || lease.operatorId !== r.operatorId || lease.expired) return { ok: false, code: 'lease_invalid' };
  const scope = repoScope(r.repo);
  if (!scope) return { ok: false, code: 'bad_repo' };
  const repo = scope.slice('repo:'.length);
  // N1: 같은 (임대, 저장소, PR, head) 로 **통과한 판정**이 있어야 받고, 보고는 한 번뿐이다 — 판정 없이
  // 보고를 받으면 grant 없는 에이전트도 자기 스레드에 "머지됨" 줄을 쓸 수 있어 감사가 거짓이 된다.
  const trail = await pool.query<{ action: string; viaChain: { rootId?: unknown } | null }>(
    `select action, detail->'viaChain' as "viaChain" from audit_log
      where action in ('repo.merge.checked', 'repo.merge.merged', 'repo.merge.queued', 'repo.merge.failed')
        and target = $1 and detail->>'leaseId' = $2 and (detail->>'number')::int = $3 and detail->>'headSha' = $4`,
    [scope, lease.id, r.number, r.headSha]);
  if (trail.rows.some((x) => x.action !== 'repo.merge.checked')) return { ok: false, code: 'already_reported' };
  if (!trail.rowCount) return { ok: false, code: 'not_checked' };
  const chainRootId = trail.rows.find((x) => x.action === 'repo.merge.checked' && x.viaChain)?.viaChain?.rootId;
  const grant = await mergeGrantFor(pool, r.agentId, repo);
  // 1회 승인으로 통과한 판정이면 승인한 사람이 「권한」이다(grant 가 없을 수 있다).
  const usedApproval = (await pool.query<{ id: string; approvedBy: string; ciOverride: boolean; approvedChecks: string[]; ghUser: string | null }>(
    `select id, approved_by as "approvedBy", ci_override as "ciOverride", approved_checks as "approvedChecks", gh_user as "ghUser"
       from merge_approval where used_lease_id = $1 and scope = $2 and pr_number = $3 and head_sha = $4`,
    [lease.id, scope, r.number, r.headSha])).rows[0] ?? null;
  const approvedBy = usedApproval?.approvedBy ?? null;
  // 무시한 체크(#1396 n1·CI 무시 승인): 래퍼가 머지 때 다시 읽은 값이다 — 거절 기록을 복사하지 않는다. 승인 때 본 것보다 늘었으면 표시한다.
  const ignored = r.result !== 'failed' ? sanitizeCheckNames(r.ignoredChecks) : [];
  const ciOverride = usedApproval?.ciOverride === true;
  const grewAfterApproval = ciOverride && ignored.some((n) => !usedApproval!.approvedChecks.includes(n));
  const ignoredTail = (ciOverride ? ' · CI 실패 무시 승인' : '')
    + (ignored.length ? ` · 무시: ${checkNamesForBody(ignored)}` : '') + (grewAfterApproval ? ' (승인 뒤 늘어남)' : '');
  const granterId = approvedBy ?? grant?.grantedBy ?? null;
  // n6: 계정을 비운 승인으로 머지했으면 오퍼레이터가 고른 이름을 감사에 남긴다. 실패 보고에는 의미가 없다(머지에 쓰지 않았다).
  const ghUserUsed = typeof r.ghUserUsed === 'string' && GH_LOGIN_RE.test(r.ghUserUsed) && r.result !== 'failed' ? r.ghUserUsed : null;
  const ghUserUsedDetail = usedApproval && usedApproval.ghUser === null && ghUserUsed ? { ghUserUsed, ghUserChosenBy: 'operator' } : {};
  const granter = granterId
    ? (await pool.query<{ handle: string }>(`select handle from account where id = $1`, [granterId])).rows[0]?.handle ?? null
    : null;
  // N2: 본문은 고정 문구뿐이다. 래퍼가 준 `error` 는 meta 에만 둔다 — `postMessage` 는 kind 와 상관없이
  // 본문의 멘션을 풀기 때문에 gh 의 오류 문구 속 `@…` 가 실제 부름이 된다.
  const body = r.result === 'merged'
    ? `🔀 ${repo}#${r.number} 머지됨 · ${(r.mergeSha ?? r.headSha).slice(0, 9)}` + (granter ? ` · 권한: ${granter}` : '') + ignoredTail + ' (래퍼 보고)'
    : r.result === 'queued'
      ? `📥 ${repo}#${r.number} 머지 큐에 넣음 · head ${r.headSha.slice(0, 9)}` + (granter ? ` · 권한: ${granter}` : '') + ignoredTail + ' (래퍼 보고)'
      : `⛔ ${repo}#${r.number} 머지 실패 · head ${r.headSha.slice(0, 9)} (래퍼 보고)`;
  const tailVariant = ignored.length ? (ciOverride ? (grewAfterApproval ? 'CiOverrideGrew' : 'CiOverride') : 'Ignoring') : null;
  const tailI18n = r.result !== 'failed' && tailVariant && granter && granterId
    ? (r.result === 'merged'
      ? systemI18n(`system.merge.merged${tailVariant}`, { repo, number: r.number, sha: (r.mergeSha ?? r.headSha).slice(0, 9), granterId, checks: checkNamesText(ignored) })
      : systemI18n(`system.merge.queued${tailVariant}`, { repo, number: r.number, head: r.headSha.slice(0, 9), granterId, checks: checkNamesText(ignored) }))
    : null;
  const posted = await postMessage(pool, {
    channelId: lease.channelId, threadRootId: lease.threadRootId, authorId: r.agentId, body, kind: 'system',
    meta: {
      merge: {
        repo, number: r.number, headSha: r.headSha, mergeSha: r.mergeSha ?? null, result: r.result, grantedBy: granterId, viaApproval: approvedBy !== null, error: r.error?.slice(0, 1000) ?? null,
        ...(ciOverride ? { ciOverride: true } : {}),
        ...ghUserUsedDetail,
        ...(ignored.length ? { ignoredChecks: ignored } : {}),
        ...(grewAfterApproval ? { grewAfterApproval: true } : {}),
        // 위임 사슬로 통과했으면 그 뿌리(소유자 글) — **meta 에만** 둔다(C5). 본문은 위의 고정 문구 그대로다(N2).
        ...(typeof chainRootId === 'string' ? { chainRootId } : {}),
      },
      // 번역 표지(i18n P5). 본문의 「권한: handle」 은 granter 의 handle 이 있을 때만 서므로 표지도 같은 조건이다.
      // 무시한 체크·CI 무시 승인이 붙은 줄은 그 갈래의 키로 — 맞는 키가 없는 드문 꼴(권한 이름 없음·무시 0개인 CI 무시 승인)은
      // 표지 없이 본문으로 그린다(본문과 표지가 다른 말을 하지 않게, C8).
      ...(ignoredTail ? (tailI18n ? { i18n: tailI18n } : {}) : { i18n: r.result === 'merged'
        ? (granter && granterId
          ? systemI18n('system.merge.mergedGranted', { repo, number: r.number, sha: (r.mergeSha ?? r.headSha).slice(0, 9), granterId })
          : systemI18n('system.merge.merged', { repo, number: r.number, sha: (r.mergeSha ?? r.headSha).slice(0, 9) }))
        : r.result === 'queued'
          ? (granter && granterId
            ? systemI18n('system.merge.queuedGranted', { repo, number: r.number, head: r.headSha.slice(0, 9), granterId })
            : systemI18n('system.merge.queued', { repo, number: r.number, head: r.headSha.slice(0, 9) }))
          : systemI18n('system.merge.failed', { repo, number: r.number, head: r.headSha.slice(0, 9) }) }),
    },
  });
  if (posted.failure) return { ok: false, code: 'post_failed' };
  const msg = posted.message;
  // CI 거절이면 카드용 거절 기록을 남긴다. 이 자리는 N1 관문(같은 임대로 통과한 그 repo·PR·head 의 판정, 보고 한 번) 뒤라 grant 없는
  // PR·다른 head 로는 오지 못한다. 1회 승인 사전 확인에서 막힌 거절(DIRTY 등)은 판정 전이라 여기 오지 않는다 — 승인도 남고 기록도 없다.
  const ciChecks = r.result === 'failed' && isCiRefusal(r.ciRefusal) ? sanitizeCheckNames(r.ciRefusal!.checks) : null;
  const denialId = ciChecks ? await recordCiDenial(pool, { agentId: r.agentId, scope, lease, number: r.number, headSha: r.headSha, failedChecks: ciChecks, now }) : null;
  await recordAudit(pool, {
    action: r.result === 'merged' ? 'repo.merge.merged' : r.result === 'queued' ? 'repo.merge.queued' : 'repo.merge.failed', actorId: r.agentId, target: scope,
    detail: {
      number: r.number, headSha: r.headSha, mergeSha: r.mergeSha ?? null, operatorId: r.operatorId, leaseId: lease.id, messageId: msg.id,
      ...(usedApproval ? { approvalId: usedApproval.id, approvedBy: usedApproval.approvedBy, ciOverride } : {}),
      ...ghUserUsedDetail,
      ...(ignored.length ? { ignoredChecks: ignored } : {}),
      ...(grewAfterApproval ? { grewAfterApproval: true } : {}),
      ...(ciChecks ? { ciRefusal: { code: r.ciRefusal!.code, mergeState: r.ciRefusal!.mergeState ?? null, checks: ciChecks }, denialId } : {}),
    },
  });
  // Q3-a: 통과한 판정(N1 관문)을 지난 `merged` 보고면 그 PR 의 기다리는 머지 카드를 **모든 에이전트에 걸쳐** 닫는다. 실패해도 보고는 남는다.
  if (r.result === 'merged') {
    await obsoleteMergeCards(pool, { scope, number: r.number, reason: 'merged', actorId: r.agentId, now }).catch(() => null);
  }
  return { ok: true, messageId: msg.id, ...(denialId ? { denialId } : {}) };
}

/**
 * 같은 (에이전트, 저장소, 채널, 스레드, PR)에서 **다른 head** 로 남은 안 쓴 거절 기록을 닫는다(D1) — head 가 바뀌면 그 기록의
 * 1회 승인은 어차피 머지되지 않는다. 닫힌 기록은 승인·새 카드를 받지 않는다. 다른 PR 의 기록은 건드리지 않는다 — PR 마다 카드가 따로다.
 * CI 거절과 그 밖의 거절은 따로 센다(서로의 카드를 닫지 않는다).
 */
async function obsoleteOtherHeads(
  pool: Pool,
  args: { agentId: string; scope: string; lease: LeaseRow; number: number; headSha: string; ci: boolean; now: Date },
): Promise<void> {
  await pool.query(
    `update merge_denial set obsoleted_at = $7
      where agent_id = $1 and scope = $2 and channel_id = $3 and thread_root_id = $4 and pr_number = $5 and head_sha <> $6
        and used_at is null and obsoleted_at is null
        and (reason = 'ci_not_green') = $8`,
    [args.agentId, args.scope, args.lease.channelId, args.lease.threadRootId, args.number, args.headSha, args.now, args.ci]);
}

/**
 * CI 거절 카드의 거절 기록(reason `ci_not_green`). L2(security #1158)는 다른 거절과 같다: 같은 (에이전트, 저장소, 채널, 스레드, PR,
 * head)의 안 쓰고 안 만료된 **CI 거절** 기록이 있으면 그것을 다시 쓰고(임대·체크만 지금 것으로 — PR·head 는 바꾸지 않는다, D1),
 * 새로 만드는 것은 에이전트마다 24시간에 `MERGE_DENIAL_DAILY_CAP` 개까지 — 넘으면 null(거절은 그대로, 카드만 없다). 기록은 아무
 * 권한도 열지 않는다.
 */
export async function recordCiDenial(
  pool: Pool,
  args: { agentId: string; scope: string; lease: LeaseRow; number: number; headSha: string; failedChecks: string[]; now: Date },
): Promise<string | null> {
  const { lease } = args;
  const reused = (await pool.query<{ id: string }>(
    `update merge_denial set lease_id = $7, failed_checks = $9
      where id = (select id from merge_denial
                   where agent_id = $1 and scope = $2 and channel_id = $3 and thread_root_id = $4 and pr_number = $5 and head_sha = $6
                     and used_at is null and obsoleted_at is null and expires_at > $8 and reason = 'ci_not_green'
                   order by created_at desc limit 1)
      returning id`,
    [args.agentId, args.scope, lease.channelId, lease.threadRootId, args.number, args.headSha, lease.id, args.now, args.failedChecks])).rows[0];
  if (reused) return reused.id;
  await obsoleteOtherHeads(pool, { agentId: args.agentId, scope: args.scope, lease, number: args.number, headSha: args.headSha, ci: true, now: args.now });
  const recent = (await pool.query<{ n: number }>(
    `select count(*)::int as n from merge_denial where agent_id = $1 and created_at > $2`,
    [args.agentId, new Date(args.now.getTime() - 24 * 3_600_000)])).rows[0]!.n;
  if (recent >= MERGE_DENIAL_DAILY_CAP) return null;
  return (await pool.query<{ id: string }>(
    `insert into merge_denial (agent_id, scope, pr_number, head_sha, channel_id, thread_root_id, lease_id, expires_at, reason, failed_checks)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'ci_not_green', $9) returning id`,
    [args.agentId, args.scope, args.number, args.headSha, lease.channelId, lease.threadRootId, lease.id,
      new Date(args.now.getTime() + MERGE_DENIAL_TTL_MS), args.failedChecks])).rows[0]!.id;
}

/** 이 에이전트가 머지해도 되는 저장소 목록 — 러너가 턴을 띄울 때 allow/deny 규칙을 고르는 근거(PR 2). */
export async function mergeableRepos(pool: Pool, agentId: string): Promise<string[]> {
  const res = await pool.query<{ scope: string }>(
    `select scope from account_grant where account_id = $1 and capability = 'repo.merge'
        and (expires_at is null or expires_at > now()) order by scope`, [agentId]);
  return res.rows.map((r) => r.scope.slice('repo:'.length));
}

/**
 * 이 에이전트에게 아직 안 쓴 1회 승인이 있는 (저장소, 스레드) — 러너가 그 스레드의 턴에만 래퍼 allow 를 넣는 근거(②).
 * grant 가 하나도 없는 에이전트도 승인이 있으면 래퍼를 부를 수 있어야 한다.
 */
export interface OpenMergeApproval {
  id: string; repo: string; number: number; headSha: string; ghUser: string | null; relaxChecks: boolean;
  channelId: string; threadRootId: string; expiresAt: string;
}

/**
 * 래퍼가 소모하기 **전에** 읽는다(security, 스레드 1b75d7a0): 기록의 head·계정으로 GitHub 읽기 전용 사전 확인을 하고, 실패하면
 * `merge-checks` 를 부르지 않아 승인을 남긴다. 이 목록은 판정이 아니다 — 통과 판정은 언제나 `checkMerge` 의 소모다.
 */
export async function openMergeApprovals(pool: Pool, agentId: string, now = new Date()): Promise<OpenMergeApproval[]> {
  const res = await pool.query<{ id: string; scope: string; number: number; headSha: string; ghUser: string | null; relaxChecks: boolean; channelId: string; threadRootId: string; expiresAt: Date }>(
    `select id, scope, pr_number as number, head_sha as "headSha", gh_user as "ghUser", relax_checks as "relaxChecks",
            channel_id as "channelId", thread_root_id as "threadRootId", expires_at as "expiresAt"
       from merge_approval where agent_id = $1 and used_at is null and expires_at > $2 order by approved_at`, [agentId, now]);
  return res.rows.map((r) => ({
    id: r.id, repo: r.scope.slice('repo:'.length), number: r.number, headSha: r.headSha, ghUser: r.ghUser, relaxChecks: r.relaxChecks,
    channelId: r.channelId, threadRootId: r.threadRootId, expiresAt: r.expiresAt.toISOString(),
  }));
}

/**
 * 래퍼의 사전 확인용(security F2) — 이 임대로 `checkMerge` 를 부르면 **소모될 바로 그 승인**을 소모하지 않고 알려 준다.
 * 같은 조건(에이전트·저장소·PR·head·임대의 채널·스레드·안 씀·안 만료)·같은 순서(최근 것)다. 래퍼는 이 계정·CI 칸으로 GitHub 을 읽고,
 * 판정 뒤 응답의 `approval.id` 가 이것과 같은지 대조한다. 임대가 맞지 않으면 null(승인 없음과 같이 본다 — 판정에서 다시 거절된다).
 */
export async function peekMergeApproval(
  pool: Pool,
  args: { agentId: string; operatorId: string; leaseId: string; token: string; repo: string; number: number; headSha: string; now?: Date },
): Promise<{ id: string; ghUser: string | null; relaxChecks: boolean } | null> {
  const now = args.now ?? new Date();
  const lease = await readLease(pool, { leaseId: args.leaseId, token: args.token, now });
  if (!lease || lease.agentId !== args.agentId || lease.operatorId !== args.operatorId || lease.expired || lease.ended) return null;
  const scope = repoScope(args.repo);
  if (!scope) return null;
  // `checkMerge` 와 같은 조건 — CI 실패 무시 승인은 사람이 띄운 턴에서만 고른다(D3).
  return (await pool.query<{ id: string; ghUser: string | null; relaxChecks: boolean }>(
    `select id, gh_user as "ghUser", relax_checks as "relaxChecks" from merge_approval
      where agent_id = $1 and scope = $2 and pr_number = $3 and head_sha = $4
        and channel_id = $5 and thread_root_id = $6 and used_at is null and expires_at > $7
        and (not ci_override or $8::boolean)
      order by approved_at desc limit 1`,
    [args.agentId, scope, args.number, args.headSha, lease.channelId, lease.threadRootId, now, causeByHuman(lease)])).rows[0] ?? null;
}

/**
 * Q3-b: 래퍼가 `gh pr view` 에서 그 PR 이 이미 MERGED·CLOSED 인 것을 봤다는 보고. 통과한 판정이 없어도 받는 새 길이라 좁다 —
 * 유효한 임대와 **그 에이전트 자신의** 기다리는 카드(그 저장소·PR)가 있어야 받고, 그 에이전트의 카드만 닫는다. 「머지됨」 줄이나
 * `repo.merge.merged` 감사는 만들지 않는다(서버가 GitHub 에서 확인한 것이 아니다) — `repo.merge.obsoleted` 로만 남긴다.
 */
export async function reportMergeClosed(
  pool: Pool,
  r: { agentId: string; operatorId: string; leaseId: string; token: string; repo: string; number: number; state: 'MERGED' | 'CLOSED'; now?: Date },
): Promise<{ ok: true; closed: number } | { ok: false; code: 'lease_invalid' | 'bad_repo' | 'no_card' }> {
  const now = r.now ?? new Date();
  const lease = await readLease(pool, { leaseId: r.leaseId, token: r.token, now });
  if (!lease || lease.agentId !== r.agentId || lease.operatorId !== r.operatorId || lease.expired || lease.ended) return { ok: false, code: 'lease_invalid' };
  const scope = repoScope(r.repo);
  if (!scope) return { ok: false, code: 'bad_repo' };
  const closed = await obsoleteMergeCards(pool, {
    scope, number: r.number, reason: r.state === 'MERGED' ? 'merged' : 'closed', onlyAgentId: r.agentId, actorId: r.agentId, now,
    audit: { operatorId: r.operatorId, leaseId: lease.id, reportedState: r.state },
  });
  if (!closed) return { ok: false, code: 'no_card' };
  return { ok: true, closed };
}
