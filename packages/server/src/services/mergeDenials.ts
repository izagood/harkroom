import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { audienceFor } from './channels.js';
import { getMessageById } from './messages.js';

/**
 * 머지 거절 카드 — 거절된 그 자리에서 소유자가 [7일 주기]를 누른다(스레드 febe9ff8 P3, security C1~C6).
 *
 * 흐름: 래퍼의 판정이 `not_granted` 이고 나머지는 통과하면 `checkMerge` 가 `merge_denial` 한 줄을 남기고 `denialId` 를 돌려준다
 * → 에이전트가 `message.ask` 에 `mergeDenialId` 를 실어 카드를 세운다(이 파일의 `prepareDenialCard` 가 C1·C3 을 본다) →
 * 소유자 사람 세션이 `POST /agents/:id/merge-denials/:denialId/grant` 로 7일 grant 를 만든다(`grantFromDenial`, C4~C6) →
 * 소유자가 같은 카드에서 「다시 머지」를 고르면 #1134 의 F4 경로(소유자가 에이전트 자신의 카드에 답함 = 사람이 띄운 턴)로
 * 새 턴이 뜬다. 서버가 시스템 줄을 세우지 않는 이유가 이 마지막 걸음이다 — 시스템 줄에 답해 뜬 턴은 사람 글이 아니라 F4 에 걸린다.
 *
 * **[7일 주기]는 ask 선택지가 아니다**(C5) — `recordAskAnswer` 는 소유자가 아닌 사람도 답할 수 있다. 버튼은 별도 REST 이고
 * 그 REST 는 사람 **세션**만 받는다(PAT·에이전트 토큰 403).
 *
 * 범위 밖(security, G2 위협 모델과 같다): 같은 uid 로 도는 에이전트가 사람의 세션 토큰을 읽어 이 REST 를 부르는 경우.
 */

/** grant 의 기한 — 카드에서는 7일 고정(security 판정 2). 30일·기한 없음은 설정 화면에서만. */
export const DENIAL_GRANT_TTL_MS = 7 * 86_400_000;

export interface MergeDenialMeta {
  /** 카드 묶음 키 — (에이전트, 저장소, 스레드, UTC 날짜)마다 한 장(C3). */
  key: string;
  /** 지금 이 카드의 버튼이 쓸 거절 기록. 같은 날 다시 막히면 새 기록으로 바뀐다. */
  denialId: string;
  agentId: string;
  ownerAccountId: string | null;
  repo: string;
  number: number;
  count: number;
  firstAt: string;
  lastAt: string;
  granted?: { by: string; at: string; expiresAt: string };
  /**
   * 왜 막혔나 — `not_granted`(권한 없음) · `cause_not_human`(권한은 있는데 사람이 띄운 턴이 아님) · `ci_not_green`(권한은 있는데
   * CI 가 초록이 아님 — 카드는 「CI 실패 무시하고 이번 한 번 머지」 하나뿐). 카드 문구가 가른다.
   */
  reason?: MergeDenialReason;
  /** `ci_not_green` 일 때 래퍼가 보고한 초록 아닌 체크 이름(서버가 거른 값). 데이터로만 그린다. */
  failedChecks?: string[];
  /** 이 거절 기록의 head — 1회 승인은 이 head 하나에 묶인다. */
  headSha?: string;
}

export type MergeDenialReason = 'not_granted' | 'cause_not_human' | 'ci_not_green';

interface DenialRow {
  id: string; agentId: string; scope: string; number: number; headSha: string; channelId: string; threadRootId: string;
  expired: boolean; used: boolean; cardMessageId: string | null; reason: MergeDenialReason; failedChecks: string[];
  /** 그 PR 이 머지되거나 닫혀 카드가 닫혔다(118, Q3) — 7일 허락·1회 승인·새 카드 모두 받지 않는다. */
  obsolete: boolean;
}

async function readDenial(db: Pool | PoolClient, id: string, now: Date, lock = false): Promise<DenialRow | undefined> {
  return (await db.query<DenialRow>(
    `select id, agent_id as "agentId", scope, pr_number as number, head_sha as "headSha", channel_id as "channelId", thread_root_id as "threadRootId",
            expires_at <= $2 as expired, used_at is not null as used, card_message_id as "cardMessageId", reason,
            failed_checks as "failedChecks", obsoleted_at is not null as obsolete
       from merge_denial where id = $1${lock ? ' for update' : ''}`, [id, now])).rows[0];
}

export type DenialCardRefusal = 'denial_not_found' | 'denial_other_agent' | 'denial_other_thread' | 'denial_used' | 'denial_expired' | 'pr_closed';

export const DENIAL_CARD_REFUSAL_MESSAGE: Record<DenialCardRefusal, string> = {
  denial_not_found: 'no such merge denial — use the denialId the merge wrapper returned',
  denial_other_agent: 'that merge denial belongs to another agent',
  denial_other_thread: 'that merge denial happened in another thread; post the card in the thread where the merge was refused',
  denial_used: 'that merge denial was already used to grant permission',
  denial_expired: 'that merge denial expired; ask the wrapper again',
  pr_closed: 'that pull request was already merged or closed — no card is needed',
};

/**
 * `message.ask` 에 실린 `mergeDenialId` 를 잰다(C1) — 거절의 에이전트가 부른 에이전트와 같은지, 스레드가 같은지, 안 썼고
 * 안 만료됐는지. 통과하면 카드 meta(권한 칸은 서버 값뿐 — C3)와, 같은 날 같은 저장소 카드가 이미 있으면 그 id 를 준다.
 */
export async function prepareDenialCard(
  pool: Pool,
  args: { agentId: string; denialId: string; channelId: string; threadRootId: string | null; now?: Date },
): Promise<{ ok: false; code: DenialCardRefusal } | { ok: true; meta: MergeDenialMeta }> {
  const now = args.now ?? new Date();
  const d = await readDenial(pool, args.denialId, now);
  if (!d) return { ok: false, code: 'denial_not_found' };
  if (d.agentId !== args.agentId) return { ok: false, code: 'denial_other_agent' };
  if (d.channelId !== args.channelId || d.threadRootId !== (args.threadRootId ?? '')) return { ok: false, code: 'denial_other_thread' };
  if (d.used) return { ok: false, code: 'denial_used' };
  if (d.expired) return { ok: false, code: 'denial_expired' };
  if (d.obsolete) return { ok: false, code: 'pr_closed' };

  const day = now.toISOString().slice(0, 10);
  const key = `merge:${d.agentId}:${d.scope}:${d.threadRootId}:${day}`;
  const owner = (await pool.query<{ ownerAccountId: string | null }>(
    `select owner_account_id as "ownerAccountId" from agent_config where account_id = $1`, [d.agentId])).rows[0];
  const meta: MergeDenialMeta = {
    key, denialId: d.id, agentId: d.agentId, ownerAccountId: owner?.ownerAccountId ?? null,
    repo: d.scope.slice('repo:'.length), number: d.number,
    count: 1, firstAt: now.toISOString(), lastAt: now.toISOString(), reason: d.reason, headSha: d.headSha,
    ...(d.reason === 'ci_not_green' ? { failedChecks: d.failedChecks } : {}),
  };
  return { ok: true, meta };
}

async function emitCard(pool: Pool, id: string): Promise<void> {
  const row = await getMessageById(pool, id);
  if (row) emitEvent({ type: 'message.updated', message: row, audience: await audienceFor(pool, row.channelId) });
}

export type DenialGrantRefusal = { status: 400 | 403 | 404 | 409; code: string; message: string };

/**
 * [7일 주기] — 거절 기록을 **한 번** 써서 그 저장소 grant 를 7일 준다(C4). 사람 세션·소유자 판정은 라우트가 먼저 한다(C5).
 * scope 와 기한은 요청에서 받지 않는다 — 이 기록과 상수다.
 */
export async function grantFromDenial(
  pool: Pool,
  args: { agentId: string; denialId: string; actorId: string; now?: Date },
): Promise<{ ok: true; scope: string; expiresAt: string; cardMessageId: string | null } | ({ ok: false } & DenialGrantRefusal)> {
  const now = args.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const d = await readDenial(client, args.denialId, now, true);
    // `:id` 가 거절의 에이전트와 다르면 없는 것과 같다 — 남의 거절 id 를 내 에이전트 경로에 꽂는 길을 닫는다(C4).
    if (!d || d.agentId !== args.agentId) { await client.query('rollback'); return { ok: false, status: 404, code: 'not_found', message: 'no such merge denial for this agent' }; }
    if (d.used) { await client.query('rollback'); return { ok: false, status: 409, code: 'denial_used', message: 'this denial was already used' }; }
    if (d.expired) { await client.query('rollback'); return { ok: false, status: 409, code: 'denial_expired', message: 'this denial expired' }; }
    if (d.obsolete) { await client.query('rollback'); return { ok: false, status: 409, code: 'pr_closed', message: PR_CLOSED_MESSAGE }; }
    // CI 거절 카드는 7일 허락을 주지 않는다 — 권한은 이미 있고, 이 카드의 뜻은 「이번 한 번 CI 무시」뿐이다(security D4: 버튼만 숨기지 않고 서버가 막는다).
    if (d.reason === 'ci_not_green') { await client.query('rollback'); return { ok: false, status: 400, code: 'ci_card_once_only', message: CI_CARD_ONCE_ONLY_MESSAGE }; }
    const used = await client.query(
      `update merge_denial set used_at = $2, used_by = $3 where id = $1 and used_at is null returning id`, [d.id, now, args.actorId]);
    if (!used.rowCount) { await client.query('rollback'); return { ok: false, status: 409, code: 'denial_used', message: 'this denial was already used' }; }
    const expiresAt = new Date(now.getTime() + DENIAL_GRANT_TTL_MS);
    // 있던 grant(만료된 것 등)는 덮는다 — `allow_agent_cause` 는 끈다(카드는 좁히기만 한다).
    await client.query(
      `insert into account_grant (account_id, capability, scope, granted_by, expires_at, allow_agent_cause)
       values ($1, 'repo.merge', $2, $3, $4, false)
       on conflict (account_id, capability, scope) do update
         set granted_by = excluded.granted_by, granted_at = now(), expires_at = excluded.expires_at, allow_agent_cause = false`,
      [d.agentId, d.scope, args.actorId, expiresAt]);
    if (d.cardMessageId) {
      await client.query(
        `update message set meta = jsonb_set(meta, '{mergeDenial,granted}', $2::jsonb) where id = $1 and meta ? 'mergeDenial'`,
        [d.cardMessageId, JSON.stringify({ by: args.actorId, at: now.toISOString(), expiresAt: expiresAt.toISOString() })]);
    }
    await client.query('commit');
    await recordAudit(pool, {
      action: 'grant.given', actorId: args.actorId, target: d.agentId,
      detail: { capability: 'repo.merge', scope: d.scope, expiresAt: expiresAt.toISOString(), allowAgentCause: false, via: 'merge_denial', denialId: d.id },
    });
    emitEvent({ type: 'grant.changed', accountId: d.agentId, audience: 'all' });
    if (d.cardMessageId) await emitCard(pool, d.cardMessageId);
    return { ok: true, scope: d.scope, expiresAt: expiresAt.toISOString(), cardMessageId: d.cardMessageId };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const PR_CLOSED_MESSAGE = 'that pull request was already merged or closed — this card is closed';
export const CI_CARD_ONCE_ONLY_MESSAGE = 'a CI-failure card only approves one merge with the CI check skipped — it never grants 7 days';

/** 거절 기록·승인에 담는 체크 이름의 상한(security: 사람이 이 문구를 보고 판단한다). */
export const CHECK_NAME_MAX = 80;
export const CHECK_NAMES_MAX = 20;

/**
 * 래퍼가 보고한 체크 이름을 거른다. 이름은 PR 작성자가 workflow 로 정할 수 있는 문자열이다 — 제어(Cc)·서식(Cf, bidi·zero-width
 * 포함) 문자를 빼고, 앞뒤 공백을 자르고, 이름당 80자·20개까지, 빈 것·겹친 것은 버린다. 문자열이 아닌 항목은 버린다.
 */
/** 두 이름 목록이 같은 집합인가(순서 무관). 한쪽이 없으면 다르다. */
function sameNames(a: string[] | undefined, b: string[]): boolean {
  if (!a) return false;
  const x = [...new Set(a)].sort(); const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * 시스템 줄·카드 **본문**에 끼우는 체크 이름(n2): 이름마다 코드 스팬으로 감싸 마크다운(링크 등)으로 읽히지 않게 하고, 멘션·토큰이 되는
 * 글자는 비슷한 글자로 바꾼다. 번역 표지 인자는 앱이 텍스트로만 그리므로 `checkNamesText` 를 쓴다.
 */
export function checkNamesForBody(names: string[]): string {
  return names.map((n) => `\`${n.replace(/`/g, "'").replace(/@/g, '＠').replace(/</g, '‹').replace(/>/g, '›')}\``).join(', ');
}
export function checkNamesText(names: string[]): string {
  return names.join(', ').replace(/@/g, '＠').replace(/</g, '‹').replace(/>/g, '›');
}

export function sanitizeCheckNames(names: unknown): string[] {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const clean = n.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim().slice(0, CHECK_NAME_MAX).trim();
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= CHECK_NAMES_MAX) break;
  }
  return out;
}

/**
 * PR 이 머지되거나 닫혔다 — 그 (저장소, PR)의 기다리는 머지 카드를 닫는다(118, 스레드 0e30c565 Q3). 닫힌 거절 기록은 7일 허락·1회
 * 승인·새 카드를 받지 않고(409 `pr_closed`), 권한 요청은 `obsolete` 가 되어 결정을 받지 않으며(409), 카드의 선택 카드도 닫혀 답을
 * 받지 않는다. 둘 다 「하루 한 장」·pending 중복 판정에서 빠진다 — 그 PR 이 다시 열리거나 새 PR 이 오면 새 카드가 선다.
 *
 * `onlyAgentId` 가 있으면 그 에이전트의 것만(래퍼의 `closed` 보고, Q3-b), 없으면 모든 에이전트(통과한 판정 뒤의 `merged` 보고, Q3-a).
 * 닫은 줄 수를 돌려준다(0 이면 닫을 것이 없었다). 쓰지 않은 1회 승인(`merge_approval`)은 head 에 묶여 있어 그대로 둔다.
 */
export async function obsoleteMergeCards(
  pool: Pool,
  args: {
    scope: string; number: number; reason: 'merged' | 'closed'; actorId: string; now: Date; onlyAgentId?: string;
    audit?: Record<string, unknown>;
  },
): Promise<number> {
  const client = await pool.connect();
  let denials: { id: string; agentId: string; cardMessageId: string | null }[] = [];
  let requests: { id: string; agentId: string; cardMessageId: string | null }[] = [];
  try {
    await client.query('begin');
    denials = (await client.query<{ id: string; agentId: string; cardMessageId: string | null }>(
      `update merge_denial set obsoleted_at = $3
        where scope = $1 and pr_number = $2 and used_at is null and obsoleted_at is null and ($4::uuid is null or agent_id = $4)
        returning id, agent_id as "agentId", card_message_id as "cardMessageId"`,
      [args.scope, args.number, args.now, args.onlyAgentId ?? null])).rows;
    requests = (await client.query<{ id: string; agentId: string; cardMessageId: string | null }>(
      `update permission_request set status = 'obsolete', decided_at = $3
        where kind = 'merge' and status = 'pending' and target = $1 and ($4::uuid is null or agent_id = $4)
          and denial_id in (select id from merge_denial where scope = $1 and pr_number = $2)
        returning id, agent_id as "agentId", card_message_id as "cardMessageId"`,
      [args.scope, args.number, args.now, args.onlyAgentId ?? null])).rows;
    const at = args.now.toISOString();
    for (const r of requests) {
      if (!r.cardMessageId) continue;
      await client.query(
        `update message set meta = jsonb_set(meta, '{permissionRequest}', (meta->'permissionRequest') || $2::jsonb)
          where id = $1 and meta ? 'permissionRequest'`,
        [r.cardMessageId, JSON.stringify({ status: 'obsolete', obsoleteReason: args.reason, decidedAt: at })]);
    }
    for (const d of denials) {
      if (!d.cardMessageId) continue;
      await client.query(
        `update message set meta = jsonb_set(meta, '{mergeDenial,obsolete}', $2::jsonb) where id = $1 and meta ? 'mergeDenial'`,
        [d.cardMessageId, JSON.stringify({ reason: args.reason, at })]);
    }
    // 카드의 선택 카드도 닫는다 — 열린 카드에 답(「다시 머지」 등)을 보내면 ask-answer 가 닫힌 카드로 거절한다.
    const cardIds = [...new Set([...requests, ...denials].map((x) => x.cardMessageId).filter((x): x is string => !!x))];
    if (cardIds.length) {
      await client.query(
        `update message set meta = jsonb_set(meta, '{ask}', (meta->'ask') || $2::jsonb)
          where id = any($1::uuid[]) and meta ? 'ask' and meta->'ask'->>'closedAt' is null and meta->'ask'->'answeredWith' is null`,
        [cardIds, JSON.stringify({ closedAt: at, closedBy: args.actorId })]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const total = denials.length + requests.length;
  if (!total) return 0;
  await recordAudit(pool, {
    action: 'repo.merge.obsoleted', actorId: args.actorId, target: args.scope,
    detail: {
      number: args.number, reason: args.reason, onlyAgentId: args.onlyAgentId ?? null,
      // 래퍼 보고(`closed`)면 서버가 GitHub 에서 확인한 것이 아니다 — 감사에 그렇게 남긴다.
      source: args.onlyAgentId ? 'wrapper_report' : 'merge_result',
      denialIds: denials.map((d) => d.id), requestIds: requests.map((r) => r.id), ...(args.audit ?? {}),
    },
  });
  for (const id of new Set([...requests, ...denials].map((x) => x.cardMessageId).filter((x): x is string => !!x))) await emitCard(pool, id);
  return total;
}

/** 1회 승인 기록을 쓸 수 있는 시한 — 승인한 뒤 하루 안에 래퍼가 써야 한다. */
export const APPROVAL_TTL_MS = 24 * 3_600_000;

/** GitHub 로그인 이름(영숫자·하이픈 1~39자, 하이픈으로 시작하지 않음). */
export const GH_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * 1회 승인(스레드 1b75d7a0) — 권한 요청 카드의 [이번 한 번 머지] 결정이 부른다(`decidePermissionRequest`, 같은 트랜잭션).
 * 거절 기록을 **한 번** 써서 (그 PR, 그 head, 그 스레드)에 묶인 승인을 만든다. grant 는 주지 않는다.
 * 저장소·PR·head·스레드는 거절 기록이다 — 요청에서 받는 것은 gh 계정과 CI 완화 여부뿐이다. gh 계정이 오퍼레이터에서 그 저장소에
 * 닿는지는 서버가 모른다 — 화면이 #1265 닿음 확인을 통과한 계정만 보이고, 래퍼가 그 계정으로 못 닿으면 머지하지 않는다.
 */
export async function insertApprovalFromDenial(
  client: PoolClient,
  args: {
    agentId: string; denialId: string; actorId: string; ghUser: string | null; relaxChecks: boolean; now: Date;
    /** 카드가 보여 준 PR·head(security F1) — 값의 출처는 거절 기록이고, 이것은 「본 것을 승인한다」 대조에만 쓴다. */
    expect: { number: number; headSha: string; failedChecks?: string[] };
  },
): Promise<{ ok: true; approvalId: string; scope: string; number: number; headSha: string; reason: string; expiresAt: Date } | ({ ok: false } & DenialGrantRefusal)> {
  // null 이면 오퍼레이터가 그 저장소용 계정을 고른다(G1). 값이 있으면 지금처럼 모양을 본다.
  if (args.ghUser !== null && !GH_LOGIN_RE.test(args.ghUser)) return { ok: false, status: 403, code: 'bad_gh_user', message: 'ghUser must be a GitHub login' };
  const d = await readDenial(client, args.denialId, args.now, true);
  if (!d || d.agentId !== args.agentId) return { ok: false, status: 404, code: 'not_found', message: 'no such merge denial for this agent' };
  if (d.expired) return { ok: false, status: 409, code: 'denial_expired', message: 'the merge refusal behind this card expired — the agent has to try again' };
  if (d.obsolete) return { ok: false, status: 409, code: 'pr_closed', message: PR_CLOSED_MESSAGE };
  // 카드가 선 뒤 같은 스레드에서 다른 PR·head 로 다시 거절되면 이 기록이 덮인다 — 소유자가 본 것과 다르면 승인하지 않는다.
  if (d.number !== args.expect.number || d.headSha !== args.expect.headSha) {
    return { ok: false, status: 409, code: 'card_stale', message: 'the card changed since it was shown (a different PR or head) — look at it again' };
  }
  // CI 거절 카드의 뜻은 「CI 무시하고 한 번」 그 자체다 — relax 를 끈 승인은 받지 않는다(security D4).
  const ciOverride = d.reason === 'ci_not_green';
  if (ciOverride && !args.relaxChecks) {
    return { ok: false, status: 400, code: 'relax_required', message: 'a CI-failure card approves the merge with the CI check skipped — relaxChecks must be true' };
  }
  // n1(security #1397): 같은 PR·head 로 다시 거절되면 실패 목록만 바뀔 수 있다 — 사람이 본 목록과 다르면 승인하지 않는다.
  if (ciOverride && !sameNames(args.expect.failedChecks, d.failedChecks)) {
    return { ok: false, status: 409, code: 'card_stale', message: 'the failing checks changed since the card was shown — look at it again' };
  }
  const used = await client.query(
    `update merge_denial set used_at = $2, used_by = $3 where id = $1 and used_at is null returning id`, [d.id, args.now, args.actorId]);
  if (!used.rowCount) return { ok: false, status: 409, code: 'denial_used', message: 'the merge refusal behind this card was already used' };
  const expiresAt = new Date(args.now.getTime() + APPROVAL_TTL_MS);
  const row = (await client.query<{ id: string }>(
    `insert into merge_approval (denial_id, agent_id, scope, pr_number, head_sha, gh_user, relax_checks, channel_id, thread_root_id, approved_by, approved_at, expires_at, ci_override, approved_checks)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    [d.id, d.agentId, d.scope, d.number, d.headSha, args.ghUser, args.relaxChecks, d.channelId, d.threadRootId, args.actorId, args.now, expiresAt,
      ciOverride, ciOverride ? d.failedChecks : []])).rows[0]!;
  return { ok: true, approvalId: row.id, scope: d.scope, number: d.number, headSha: d.headSha, reason: d.reason, expiresAt };
}
