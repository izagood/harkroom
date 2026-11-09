import type { Pool, PoolClient } from 'pg';
import {
  countsAsReply, TEAM_ROUND_LIMIT, type DelegationClosedReason, type DelegationItemState, type DelegationKind,
  type InboxDelegationSummary, type PrWatchUntil, type InboxDelegationOutcome, type MessageRow, type WakeReportTo,
} from '@harkroom/shared';
import { channelVisibleSql } from './channels.js';
import { invokeFactsFor, mayInvoke } from './invokeGate.js';
import { announceReportWakes, announceWakeRows, foldWakesForDelegation } from './agentWakes.js';

/**
 * 위임 왕복(마이그레이션 050) — **팀장이 넘긴 일이 끝나면 팀장이 다시 깬다.**
 *
 * 이 파일이 갖는 사실은 넷이다: **누가 넘길 수 있나**(자기 팀원에게 넘기는 팀장, 또는 호출 게이트를 지나는 에이전트) · **몇 번까지**(라운드) ·
 * **무엇이 의무를 닫나**(완료 보고·실패·기한·중단) · **언제 팀장을 깨우나**(미결 0 또는 기한, 한 번만).
 * 넷 다 정책이라 한 곳에 모아 둔다 — `agentWakes.ts` 가 깨움 정책을 한 곳에 모은 것과 같은
 * 이유다: MCP 도구와 스위퍼가 각자 판정하면 표면이 늘 때 갈라진다.
 */

/**
 * 기한 기본값 — **"이만큼 아무 신호도 없으면 무응답"** 이다.
 *
 * ## 뜻이 바뀌었다 (2026-09-12)
 *
 * 처음에는 *"10분 안에 끝내라"* 로 동작했다. 그런데 한 턴의 예산은 **30분**이다
 * (`AGENT_TURN_TIMEOUT_MS`). 즉 10분 넘게 걸리는 일은 **구조적으로** 거짓 무응답이 됐고,
 * 그때 팀장은 *"살아 있는지 알 수 없다"* 를 받아 직접 하거나 다시 넘겼다 — **같은 일을
 * 둘이 하는 상태**다. 그 뒤 진짜 보고가 와도 의무는 이미 닫혀 있어 팀장은 깨지 않는다.
 *
 * 그래서 기한이 재는 것을 **부재가 아니라 침묵**으로 바꿨다: 팀원이 살아 있다는 신호를
 * 보내면(`touchDelegationDeadline`) 이 시각이 앞으로 밀린다. `harnessStallMs` 가 "답이
 * 없다"가 아니라 "기록이 자라지 않는다"를 재는 것과 같은 판단이다.
 *
 * 그래서 값은 그대로 10분이되 이제 **바닥값**이다 — 10분 동안 아무 신호도 없으면 죽은 것으로
 * 본다. 팀장이 `deadlineSec` 로 늘릴 수 있는 것도 그대로다(첫 신호까지의 여유를 넓힌다).
 */
export const DELEGATION_DEADLINE_DEFAULT_SEC = 10 * 60;

/**
 * 신호 하나가 기한을 **이만큼 뒤로** 민다. 기본 기한과 같은 값인 것이 요점이다 — 둘 다
 * *"이만큼 아무 신호도 없으면 죽은 것"* 이라는 하나의 사실을 말한다.
 */
export const DELEGATION_SILENCE_SEC = 10 * 60;

/**
 * 기한의 경계. 하한은 깨움과 같은 60초다 — 그보다 짧으면 팀원의 턴이 시작되기도 전에
 * 무응답으로 닫힌다(러너의 폴 주기가 최대 25초, 그 뒤 하네스 기동이 더 걸린다).
 * 상한은 6시간(`WAKE_MAX_SEC`)과 같다: 그보다 긴 기다림은 "기다린다"가 아니라 "잊는다"다.
 */
export const DELEGATION_DEADLINE_MIN_SEC = 60;
export const DELEGATION_DEADLINE_MAX_SEC = 6 * 60 * 60;

/**
 * 담당이 **예약을 걸었거나 사람의 답을 기다리는 동안** 기한을 미는 상한(2026-11-06, 위임 시각부터).
 * 끝 보고만 의무를 닫으므로 CI 를 기다리는 일이 턴 사이에 10분을 넘겨도 무응답이 되어서는 안 된다. 다만 사람이 답하지 않는 카드나
 * 되풀이되는 예약이 넘긴 쪽을 영영 재우면 안 되므로 끝을 둔다 — 이 시각이 지나면 전처럼 기한으로 닫는다.
 */
export const DELEGATION_WAIT_MAX_SEC = 24 * 60 * 60;

export type DelegateRefusal =
  | { code: 'not_invokable'; message: string }
  | { code: 'round_limit'; message: string };

export interface LeadTeam {
  teamId: string;
  /** handle → accountId. `to` 해석과 도달 가능 판정에 함께 쓴다. */
  members: Map<string, { accountId: string; disabled: boolean }>;
}

/**
 * 이 계정이 팀장인 팀과 그 명단. 팀장이 아니면 `null`.
 *
 * **한 계정이 여러 팀의 팀장일 수 있다.** 그래서 `to` 를 함께 받아 *"그 팀원 전부를 담은
 * 팀"* 을 고른다 — 팀을 인자로 받지 않는 이유는 팀장이 자기가 어느 팀으로 불렸는지를 다시
 * 적어야 하고, 그 값이 틀리면(다른 팀 id) 서버가 남의 팀에 위임을 만들게 된다. handle 로
 * 좁히면 그 실수가 표현되지 않는다.
 */
export async function leadTeamFor(
  db: Pick<Pool, 'query'>, accountId: string, to: string[],
): Promise<LeadTeam | null> {
  const res = await db.query<{ team_id: string; handle: string; account_id: string; disabled: boolean }>(
    `select t.id as team_id, a.handle, a.id as account_id, a.disabled_at is not null as disabled
       from agent_team t
       join agent_team_member tm on tm.team_id = t.id
       join account a on a.id = tm.agent_account_id
      where t.lead_account_id = $1`,
    [accountId],
  );
  if (!res.rowCount) return null;

  const byTeam = new Map<string, LeadTeam['members']>();
  for (const row of res.rows) {
    let members = byTeam.get(row.team_id);
    if (!members) {
      members = new Map();
      byTeam.set(row.team_id, members);
    }
    members.set(row.handle.toLowerCase(), { accountId: row.account_id, disabled: row.disabled });
  }

  const wanted = to.map((h) => h.toLowerCase());
  for (const [teamId, members] of byTeam) {
    if (wanted.every((h) => members.has(h))) return { teamId, members };
  }
  return null;
}

/**
 * 팀 밖에게 넘길 때의 대상 해석(2026-11-06). **멘션과 같은 호출 게이트**(`mayInvoke`)를 지나는 에이전트만 받는다 —
 * 위임이 부를 수 없는 상대를 부르는 뒷문이 되지 않게. 회신권(084)은 넘기지 않는다: 그것은 결과 한 번을 돌려주는 권리이지 일을 새로 맡기는 권리가 아니다.
 *
 * 없는 이름·사람·막힌 에이전트를 같은 말로 거절한다 — 거절 사유로 계정의 범위 설정을 읽어 낼 수 없게.
 */
export async function openDelegationTargets(
  client: PoolClient, args: { callerId: string; channelId: string; to: string[] },
): Promise<{ members: LeadTeam['members'] } | { refused: string[] }> {
  const wanted = args.to.map((h) => h.toLowerCase());
  const res = await client.query<{ id: string; handle: string; disabled: boolean }>(
    `select id, lower(handle) as handle, disabled_at is not null as disabled from account
      where kind = 'agent' and deleted_at is null and lower(handle) = any($1::text[])`,
    [wanted],
  );
  const byHandle = new Map(res.rows.map((r) => [r.handle, r]));
  const facts = await invokeFactsFor(client, res.rows.map((r) => r.id));
  const members: LeadTeam['members'] = new Map();
  const refused: string[] = [];
  for (const [i, handle] of wanted.entries()) {
    const row = byHandle.get(handle);
    const fact = row ? facts.get(row.id) : undefined;
    if (!row || !fact || !(await mayInvoke(client, fact, { callerId: args.callerId, channelId: args.channelId, via: 'mention' }))) {
      refused.push(args.to[i]!);
      continue;
    }
    members.set(handle, { accountId: row.id, disabled: row.disabled });
  }
  return refused.length ? { refused } : { members };
}

/**
 * **사람의 마지막 발화 이후** 이 팀장이 이 스레드에서 만든 위임의 수.
 *
 * `agentWakes.ts::consecutiveWakes` 와 같은 모양·같은 이유다. 사람이 한마디 하면 리셋되므로
 * 상한이 스레드를 영구히 잠그지 않는다 — 043 이 멘션 깊이에 대해 정한 규칙 그대로다.
 */
export async function roundsUsed(
  db: Pick<Pool, 'query'>, args: { threadRootId: string; leadAccountId: string },
): Promise<number> {
  return (await roundsUsedMany(db, [args]))[0] ?? 0;
}

/**
 * `roundsUsed` 를 여러 (스레드, 팀장) 쌍에 한 번에(2026-10-13 쿼리 개선 Q4). inbox 의 위임 결말 줄마다 따로 부르던
 * N+1 을 없앤다. 돌려주는 순서는 `pairs` 와 같다.
 *
 * 「사람의 마지막 발화」 조회를 `coalesce(thread_root_id, id) = $1` 로 쓰면 색인을 못 타 message 를 통째로 훑는다
 * (로컬 운영 크기 6.6ms/회). 같은 뜻을 `thread_root_id = $1 or (id = $1 and thread_root_id is null)` 로 적어
 * `(thread_root_id, seq)`·pkey 색인을 탄다.
 */
export async function roundsUsedMany(
  db: Pick<Pool, 'query'>, pairs: { threadRootId: string; leadAccountId: string }[],
): Promise<number[]> {
  if (pairs.length === 0) return [];
  const res = await db.query<{ i: number; n: number }>(
    `select p.i::int as i,
            (select count(*)::int
               from team_delegation d
              where d.thread_root_id = p.root
                and d.lead_account_id = p.lead
                and d.kind = 'delegate'
                and d.created_at > coalesce((
                  select max(m.created_at) from message m
                   join account a on a.id = m.author_id
                  where (m.thread_root_id = p.root or (m.id = p.root and m.thread_root_id is null))
                    and a.kind = 'human'
                    and m.deleted_at is null
                ), 'epoch'::timestamptz)) as n
       from unnest($1::uuid[], $2::uuid[]) with ordinality as p(root, lead, i)`,
    [pairs.map((p) => p.threadRootId), pairs.map((p) => p.leadAccountId)],
  );
  const out = new Array<number>(pairs.length).fill(0);
  for (const r of res.rows) out[r.i - 1] = r.n;
  return out;
}

/**
 * 위임을 만든다 — **메시지는 호출부가 이미 게시했고** 여기서는 의무와 부름만 만든다.
 *
 * 그렇게 가른 이유: 발화는 `postMessage` 하나를 통과해야 한다(멘션·이벤트·감사가 그 함수에
 * 붙어 있다). 여기서 다시 insert 하면 위임 메시지만 조용한 메시지가 된다 — 예약 발송이
 * 같은 판단을 적어 뒀다.
 *
 * **팀원의 부름을 `insertInbox` 로 만들지 않는다**(그 함수는 `messages.ts` 안에 있다).
 * 대신 여기서 직접 insert 하는 이유는 `agentWakes` 의 sweep 과 같다: 이 항목은 팀장이
 * 지목한 대상에게 가는 것이고 남의 화면(숨김 되돌리기)을 건드릴 일이 없다. 그리고 사유가
 * `team_delegated` 라 그 관문의 `REVEAL_REASONS` 판정에도 들지 않는다.
 */
export async function createDelegation(
  client: PoolClient,
  args: {
    messageId: string;
    channelId: string;
    threadRootId: string;
    /** 팀장이 자기 팀원에게 넘긴 일일 때만 있다(162). */
    teamId: string | null;
    leadAccountId: string;
    delegateIds: string[];
    deadlineAt: Date;
    /** 어떻게 생겼나(164). 기본 `delegate`(`message.delegate`). `mention` 은 암묵 위임(P4, `implicitDelegation.ts`). */
    kind?: DelegationKind;
    /** 계획판 단계에서 그 담당을 불렀으면 그 단계 id(164). */
    planStepId?: string | null;
  },
): Promise<string> {
  const kind = args.kind ?? 'delegate';
  const inserted = await client.query<{ id: string }>(
    `insert into team_delegation
       (message_id, team_id, lead_account_id, channel_id, thread_root_id, deadline_at, kind, plan_step_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [args.messageId, args.teamId, args.leadAccountId, args.channelId, args.threadRootId, args.deadlineAt,
     kind, args.planStepId ?? null],
  );
  const delegationId = inserted.rows[0]!.id;

  for (const delegateId of args.delegateIds) {
    // v1(P3): 같은 스레드에서 같은 담당에게 새로 넘기면 앞의 열린·보고된 의무는 대체된다. 깨우지 않는다.
    // 암묵 위임(kind=mention)은 앞 위임을 대체하지 않는다 — 맨 앞 멘션 하나로 남(다른 위임자)이 넘긴 일이 깨움 없이 닫히면 안 된다
    // (security P4 #1). 열린 위임이 있으면 `implicitDelegation.ts` 가 애초에 열지 않는다(`existing`).
    if (delegationV2Enabled() && kind === 'delegate') {
      await supersedePrevious(client, { threadRootId: args.threadRootId, delegateId, keep: delegationId });
    }
    await client.query(
      `insert into team_delegation_item (delegation_id, delegate_account_id) values ($1, $2)`,
      [delegationId, delegateId],
    );
    /**
     * **평범한 부름을 위임으로 바꿔 단다.**
     *
     * 팀장이 본문에 `@done1 은 서버, @dtwo 는 화면` 처럼 이름을 적는 것이 자연스럽고, 그러면
     * `postMessage` 의 멘션 스캔이 그 팀원에게 이미 `mention` 항목을 만들어 뒀다. 그 위에
     * `team_delegated` 를 더하면 **한 팀원이 같은 메시지로 두 번 불린다** — 스케줄러는 같은
     * 스레드에 턴 하나만 돌리므로(`inFlightThreads`) 그 팀원의 턴이 순차로 두 번 돌고, 두
     * 번째는 위임인 줄 모르는 평범한 턴이다. 실측으로 그렇게 됐다(시험 1번).
     *
     * 그래서 더하지 않고 **바꾼다.** 같은 메시지에 대한 두 사실 중 위임이 더 구체적이다:
     * 그 팀원이 할 일과 누구에게 보고해야 하는지를 말한다.
     *
     * 바꿀 행이 없으면(본문에 이름을 안 적었다) 새로 만든다. `insertInbox` 를 쓰지 않는
     * 이유는 `agentWakes` 의 sweep 과 같다 — 팀장이 지목한 대상에게 가는 항목이라 남의
     * 화면(숨김 되돌리기)을 건드릴 일이 없고, 사유가 그 관문의 `REVEAL_REASONS` 에도 없다.
     */
    // 암묵 위임은 부름 자체가 위임이다 — 멘션 팬아웃이 이미 깨운 `mention` 항목을 그대로 둔다(담당 턴의 위임 맥락은
    // P3 의 inbox 위임 요약이 싣는다). 바꾸면 옛 러너가 맨 앞 멘션 하나마다 「넘겨받은 일」 지시문을 싣는다.
    if (kind === 'mention') continue;
    const converted = await client.query(
      `update inbox set reason = 'team_delegated', team_id = $3
        where account_id = $1 and message_id = $2 and reason = 'mention'`,
      [delegateId, args.messageId, args.teamId],
    );
    if (!converted.rowCount) {
      await client.query(
        `insert into inbox (account_id, message_id, reason, team_id) values ($1, $2, 'team_delegated', $3)`,
        [delegateId, args.messageId, args.teamId],
      );
    }
  }
  return delegationId;
}

/**
 * **살아 있다는 신호가 기한을 뒤로 민다**(2026-09-12). `postMessage` 안에서 같은 트랜잭션으로
 * 불린다 — 닫지 않는 발화(`progress`·`wake`)가 지나는 자리다.
 *
 * 닫지 않는 발화가 **아무 것도 하지 않으면** 안 되는 이유: 30분짜리 일을 하는 팀원이 진행을
 * 열 줄 올려도 10분에 무응답으로 닫힌다. 그 발화들은 "끝났다"가 아니지만 **"살아 있다"** 이고,
 * 기한이 재는 것이 침묵이므로 그 신호가 시계를 되감는 것이 맞다.
 *
 * `greatest` 로 미는 이유: 팀장이 `deadlineSec` 로 더 먼 기한을 잡아 뒀으면 신호 하나가
 * 그것을 **줄이면 안 된다.** 미는 것은 언제나 앞으로만 간다.
 *
 * 이미 결말이 난 위임(`notified_at`)은 건드리지 않는다 — 닫힌 것을 되살리는 유일한 길이
 * 생기면 "늦게 온 답으로는 깨우지 않는다"는 결정이 뒷문으로 무너진다.
 */
export async function touchDelegationDeadline(
  client: PoolClient,
  args: { threadRootId: string; authorId: string },
): Promise<void> {
  await client.query(
    `update team_delegation d
        set deadline_at = greatest(d.deadline_at, now() + ($3::int * interval '1 second'))
       from team_delegation_item i
      where i.delegation_id = d.id
        and i.delegate_account_id = $1
        and i.outcome is null
        and d.thread_root_id = $2
        and d.notified_at is null`,
    [args.authorId, args.threadRootId, DELEGATION_SILENCE_SEC],
  );
}

/**
 * 팀원의 **완료 보고·실패가 자기 의무를 닫는다.** `postMessage` 안에서 같은 트랜잭션으로 불린다.
 *
 * ## 무엇이 닫는가
 *
 * `message.report` 와 `message.fail` 뿐이다(소유자 결정 2026-11-06). 보통 답글·물음·`progress`·`wake` 는 닫지 않고 기한만 민다 —
 * 첫 답이 닫던 동안에는 「시작한다」 같은 중간 글 하나로 의무가 닫혀 넘긴 쪽이 결과 없이 깨어났다.
 * **실패도 닫는다**: 실패는 결과이고, 러너는 3회 소진·사용량 한도·세션 충돌에서 이미 `message.fail` 을 올린다 — 그래서 하네스
 * 실패는 이 경로로 **자동으로** 풀린다.
 *
 * ## 왜 첫 결말 하나만인가
 *
 * 팀원이 두 번 보고하면 두 번째는 이미 닫힌 의무를 다시 닫지 않는다(`outcome is null` 조건).
 * 결말을 뒤늦게 바꾸면(성공 뒤의 실패, 또는 그 반대) 팀장이 이미 취합한 판단이 흔들린다.
 *
 * ## 정확히 한 번 깨운다
 *
 * 팀원 둘이 동시에 답하면 **둘 다 "내가 마지막"으로 볼 수 있다.** 그래서 위임 행을
 * `for update` 로 잡아 그 위임에 대한 닫힘을 직렬화한다. 그 뒤 `notified_at is null` 로
 * 한 번 더 거른다 — 기한 스위퍼와의 경합에서 진 쪽을 걸러 내는 자리다(043 이
 * `answeredWith is null` 로 한 것과 같은 모양).
 *
 * 돌려주는 것은 **깨운 팀장의 id 들**이다(발화는 호출부가 한다) — `preemptWakesForThread`
 * 와 같은 규약이고, 이유도 같다: `inbox.updated` 이벤트는 커밋 뒤에 쳐야 한다.
 */
export async function closeDelegationsForReply(
  client: PoolClient,
  args: {
    threadRootId: string;
    authorId: string;
    messageId: string;
    /** `MessageRow['kind']` 그대로다 — `countsAsReply` 가 그 갈래만 받는다. */
    kind: MessageRow['kind'];
    isReport: boolean;
    isFailure: boolean;
    /** 결말이 접은 예약의 보고처·대기 줄을 모은다 — 호출부가 커밋 뒤에 알린다. */
    reportTouched?: WakeReportTo[];
    wakeRowsTouched?: string[];
  },
): Promise<string[]> {
  if (delegationV2Enabled()) return closeDelegationsForReplyV2(client, args);
  // 닫지 않는 발화는 **"살아 있다"** 는 신호다 — 의무는 그대로 두고
  // 기한만 뒤로 민다(2026-09-12). 그 판단의 근거는 `touchDelegationDeadline` 주석에 있다.
  if (!countsAsReply(args.kind) || !(args.isReport || args.isFailure)) {
    await touchDelegationDeadline(client, { threadRootId: args.threadRootId, authorId: args.authorId });
    return [];
  }

  const open = await client.query<{ delegation_id: string }>(
    `select i.delegation_id
       from team_delegation_item i
       join team_delegation d on d.id = i.delegation_id
      where i.delegate_account_id = $1
        and i.outcome is null
        and d.thread_root_id = $2
      order by d.created_at
      for update of d`,
    [args.authorId, args.threadRootId],
  );
  if (!open.rowCount) return [];

  const woke: string[] = [];
  for (const row of open.rows) {
    const closed = await client.query(
      `update team_delegation_item
          set outcome = $3, closed_by_message_id = $4, closed_at = now()
        where delegation_id = $1 and delegate_account_id = $2 and outcome is null`,
      [row.delegation_id, args.authorId, args.isFailure ? 'failed' : 'done', args.messageId],
    );
    if (!closed.rowCount) continue;

    const lead = await notifyIfSettled(client, row.delegation_id, args);
    if (lead) woke.push(lead);
  }
  return woke;
}

/**
 * **사람이 중단한 턴의 의무를 닫는다**(051). 중단 라우트가 같은 트랜잭션으로 부른다.
 *
 * 이것이 없으면 중단된 턴의 의무는 **기한이 지나야** `timeout` 으로 닫히고, 팀장은 10분 뒤에
 * *"무응답"* 을 받아 **사람이 일부러 멈춘 일을 다시 하려 든다.** 사람의 중단이 10분 뒤에
 * 되돌려지는 셈이다.
 *
 * ## 두 방향을 갈라 다룬다 — 깨울지가 정반대다
 *
 * **① 중단된 것이 팀원이면** 그 의무만 닫고, 그것이 마지막이었으면 **팀장을 깨운다.** 사람은
 * 그 팀원의 일을 멈춘 것이고 팀 전체를 멈춘 것이 아니므로, 팀장이 다음을 정해야 한다
 * (프롬프트가 *"취소는 다시 시작하지 마라"* 를 말한다).
 *
 * **② 중단된 것이 팀장이면** 그 팀장이 낸 위임을 전부 닫고 **깨우지 않는다.** 깨우면 사람이
 * 멈춘 그 턴이 곧바로 되살아난다 — 중단의 뜻이 사라진다. 그래서 `notified_at` 을 찍되
 * inbox 항목은 만들지 않는다(그 컬럼이 "한 번만 깨운다"를 지키는 자리이므로, 찍어 두면
 * 기한 스위퍼도 나중에 이 위임을 건드리지 않는다).
 *
 * 한 계정이 같은 스레드에서 둘 다일 수 있다(어느 위임의 팀원이면서 다른 위임의 팀장).
 * 그래서 두 방향을 순서대로 모두 본다.
 *
 * 돌려주는 것은 **깨운 팀장의 id 들**이다 — `closeDelegationsForReply` 와 같은 규약이고,
 * 이유도 같다(이벤트는 커밋 뒤에 친다).
 */
export async function cancelDelegationsFor(
  client: PoolClient,
  args: { threadRootId: string; accountId: string; reportTouched?: WakeReportTo[]; wakeRowsTouched?: string[] },
): Promise<string[]> {
  const woke: string[] = [];

  // ① 이 계정이 **팀원**인 미결 의무.
  const asDelegate = await client.query<{ delegation_id: string }>(
    `select i.delegation_id
       from team_delegation_item i
       join team_delegation d on d.id = i.delegation_id
      where i.delegate_account_id = $1 and i.outcome is null and d.thread_root_id = $2
      order by d.created_at
      for update of d`,
    [args.accountId, args.threadRootId],
  );
  for (const row of asDelegate.rows) {
    const closed = await client.query(
      `update team_delegation_item set outcome = 'canceled', closed_at = now()
        where delegation_id = $1 and delegate_account_id = $2 and outcome is null`,
      [row.delegation_id, args.accountId],
    );
    if (!closed.rowCount) continue;
    const lead = await notifyIfSettled(client, row.delegation_id, args);
    if (lead) woke.push(lead);
  }

  // ② 이 계정이 **팀장**인 미결 위임. 깨우지 않는다(위 문단 ②).
  const asLead = await client.query<{ id: string }>(
    `select id from team_delegation
      where lead_account_id = $1 and thread_root_id = $2 and notified_at is null
      for update`,
    [args.accountId, args.threadRootId],
  );
  for (const row of asLead.rows) {
    await client.query(
      `update team_delegation_item set outcome = 'canceled', closed_at = now()
        where delegation_id = $1 and outcome is null`,
      [row.id],
    );
    // `notifyIfSettled` 를 쓰지 않는다 — 그 함수는 깨우는 것이 일이다. 여기서는 meta 를
    // 비우고 깃발만 찍는다(깨움 없이 닫는 유일한 자리다).
    await client.query(
      `update message m set meta = jsonb_set(m.meta::jsonb, '{delegation,open}', '[]'::jsonb)
         from team_delegation d
        where d.id = $1 and m.id = d.message_id and m.meta->>'kind' = 'delegation'`,
      [row.id],
    );
    await client.query(`update team_delegation set notified_at = now() where id = $1`, [row.id]);
  }

  return woke;
}

/**
 * 미결이 0 이면 팀장을 깨운다 — **한 번만.** 깨웠으면 그 팀장의 id, 아니면 `null`.
 *
 * **부분 취합을 하지 않는 이유**가 이 함수의 존재 이유다. 하나 닫힐 때마다 깨우면 스케줄러가
 * 같은 스레드에 턴 하나만 돌리므로(`mentionScheduler` 의 `inFlightThreads`) 팀장 턴이
 * **순차로 여러 번** 돌아 최종 답을 여러 번 쓴다 — 지금 증상보다 나쁘다.
 */
async function notifyIfSettled(
  client: PoolClient, delegationId: string, touched: { reportTouched?: WakeReportTo[]; wakeRowsTouched?: string[] } = {},
): Promise<string | null> {
  /**
   * **남은 미결을 메시지 meta 에 되쓴다**(3-3). 화면은 표를 못 읽는다 — 대기 사슬과 채널
   * 목록의 집계는 둘 다 메시지 meta 를 본다(`ask.answeredWith` 가 그렇게 쓰인다).
   *
   * 통째로 다시 쓰는 것이 안전한 이유: 이 함수를 부르는 두 경로(답으로 닫힘·기한으로 닫힘)는
   * **이미 위임 행을 `for update` 로 잡고 있다.** 그래서 두 닫힘이 서로의 배열을 덮지 않는다.
   * 배열에서 한 원소를 빼는 SQL 대신 **지금 열린 것 전부**를 다시 쓰는 이유도 그것이다:
   * 표가 정본이고 이 값은 그 파생이라, 어긋날 여지를 남기지 않는다.
   */
  const still = await client.query<{ delegate_account_id: string }>(
    `select delegate_account_id from team_delegation_item
      where delegation_id = $1 and outcome is null
      order by delegate_account_id`,
    [delegationId],
  );
  await client.query(
    `update message m
        set meta = jsonb_set(m.meta::jsonb, '{delegation,open}', $2::jsonb)
       from team_delegation d
      where d.id = $1 and m.id = d.message_id and m.meta->>'kind' = 'delegation'`,
    [delegationId, JSON.stringify(still.rows.map((r) => r.delegate_account_id))],
  );
  if (still.rowCount) return null;

  const marked = await client.query<{ lead_account_id: string; message_id: string; thread_root_id: string }>(
    `update team_delegation set notified_at = now()
      where id = $1 and notified_at is null
      returning lead_account_id, message_id, thread_root_id`,
    [delegationId],
  );
  if (!marked.rowCount) return null;

  const row = marked.rows[0]!;
  await foldWakesForDelegation(client, {
    delegationId, leadAccountId: row.lead_account_id, threadRootId: row.thread_root_id, messageId: row.message_id,
    reportTouched: touched.reportTouched, wakeRowsTouched: touched.wakeRowsTouched,
  });
  // 사유가 가리키는 메시지는 **위임 자신**이다(043 의 "물음 자신"과 같은 규약) — 러너는
  // 그것으로 결말 목록을 되찾는다. 새 메시지를 만들지 않는 이유도 같다: 스레드에
  // "결말이 났다"는 줄이 하나 더 생기면 그 대화를 읽는 사람에게 소음이다.
  await client.query(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, 'delegation_done')`,
    [row.lead_account_id, row.message_id],
  );
  return row.lead_account_id;
}

/** 위임을 만든 뒤 이만큼 안에서만 후속 보고가 넘긴 쪽을 깨운다. */
export const DELEGATION_FOLLOWUP_WINDOW_SEC = 6 * 60 * 60;
/** 위임 하나가 후속으로 깨우는 횟수 상한. */
/**
 * 이 위임에 열린 PR 감시가 붙어 있는가(`$1` = 위임 id). 있으면 「외부 대기」라 기한 스위퍼가 닫지도 멈춤을 알리지도 않는다.
 * 기한 스위퍼와 `prWatch.ts::delegationHasOpenWatch` 가 같은 술어를 쓰도록 여기 한 곳에 둔다.
 */
export const OPEN_WATCH_FOR_DELEGATION_SQL =
  `select 1 from pr_watch_subscriber s join pr_watch w on w.id = s.watch_id
    where s.delegation_id = $1 and w.state = 'open' and w.expires_at > now() limit 1`;

export const DELEGATION_FOLLOWUP_LIMIT = 3;

/**
 * 후속 보고로 깨우는 스위치 — 기본 꺼짐. 옛 러너는 모르는 사유를 보통 부름으로 돌려 팀원 글을 할 일로 싣는다. 앱이 다 올라간 뒤에 켠다.
 * 부를 때마다 읽는다(`principalInvokeEnabled` 와 같다).
 */
export function delegationFollowupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.HARKROOM_DELEGATION_FOLLOWUP ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

/**
 * 위임 재설계 v1 스위치 — 기본 꺼짐(164 의 자리만 있고 아직 아무 경로도 이것을 보지 않는다). 켜면 report 가 닫지 않고 담당 글이
 * `delegation_update` 로 넘긴 쪽에 간다(P3 이후). 러너가 새 사유를 알게 된 뒤(P2) 서버를 켠다. 부를 때마다 읽는다.
 */
export function delegationV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.HARKROOM_DELEGATION_V2 ?? '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

export type DelegationFollowup =
  | { woke: string }
  | { skipped: 'chain_limit' | 'followup_limit' }
  | null;

/**
 * **닫힌 위임의 팀원이 올린 후속 `report` 로 넘긴 쪽을 깨운다**(2026-11-06 소유자 결정). 감시 끝 보고처럼 첫 답 뒤의 결과는 의무를
 * 닫지 못하므로 넘긴 쪽이 모른다. 멘션 게이트·회신권은 건드리지 않는다 — 판정은 서버가 위임 행으로만 한다.
 *
 * 끝나지 않은 위임은 건드리지 않는다(`notified_at`): 모두 끝나면 어차피 결말로 깨고, 그 턴이 스레드에서 이 글을 읽는다.
 * 아직 안 집어 간 후속·결말이 있으면 새로 넣지 않는다 — 곧 뜰 턴 하나로 합친다.
 *
 * 깨우는 글은 후속 글 자신이다(`message_id`). 깊이가 그 글에서 이어지게 하려는 것이고, 위임장·principal·머지 사슬은 이 사유에서
 * 끊는다(`secretAccess.ts`·`invokePrincipal.ts`·`mergeGrants.ts`·`verifiedCauseLink`).
 */
export async function wakeLeadOnFollowup(
  client: PoolClient,
  args: {
    threadRootId: string; channelId: string; authorId: string; messageId: string; isReport: boolean;
    /** 이 글로 이미 inbox 가 간 계정 — 멘션으로 불렸으면 두 번 깨우지 않는다. */
    notified: ReadonlySet<string>;
    /** 멘션과 같은 연쇄 상한에 걸리는가(`messages.ts::delegationChainCapped`). */
    chainCapped: () => Promise<boolean>;
  },
): Promise<DelegationFollowup> {
  if (!args.isReport || !delegationFollowupEnabled()) return null;
  const row = (await client.query<{ id: string; lead_account_id: string; followups: number }>(
    `select d.id, d.lead_account_id, d.followups
       from team_delegation d
       join team_delegation_item i on i.delegation_id = d.id
       join account a on a.id = d.lead_account_id
       join channel c on c.id = d.channel_id
      where d.thread_root_id = $1 and d.channel_id = $2 and i.delegate_account_id = $3
        and i.outcome = 'done' and i.closed_by_message_id is distinct from $4
        and d.notified_at is not null and d.lead_account_id <> $3
        and d.created_at > now() - make_interval(secs => $5)
        and a.kind = 'agent' and a.deleted_at is null and a.disabled_at is null
        and ${channelVisibleSql('c', 'd.lead_account_id')}
      order by d.created_at desc
      limit 1
      for update of d`,
    [args.threadRootId, args.channelId, args.authorId, args.messageId, DELEGATION_FOLLOWUP_WINDOW_SEC],
  )).rows[0];
  if (!row || args.notified.has(row.lead_account_id)) return null;
  const pending = await client.query(
    `select 1 from inbox i join message m on m.id = i.message_id
      where i.account_id = $1 and i.read_at is null and i.reason in ('delegation_followup', 'delegation_done')
        and coalesce(m.thread_root_id, m.id) = $2
        -- 이미 턴이 집어 간 항목은 합치지 않는다 — 그 턴은 이 글을 못 볼 수 있어 끝 보고가 묻힌다.
        and not exists (select 1 from secret_turn_lease l
                         where l.agent_id = i.account_id and l.cause_message_id = i.message_id
                           and l.ended_at is null and l.expires_at > now())
      limit 1`,
    [row.lead_account_id, args.threadRootId],
  );
  if (pending.rowCount) return null;
  if (row.followups >= DELEGATION_FOLLOWUP_LIMIT) return { skipped: 'followup_limit' };
  if (await args.chainCapped()) return { skipped: 'chain_limit' };
  await client.query(`update team_delegation set followups = followups + 1 where id = $1`, [row.id]);
  await client.query(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, 'delegation_followup')`,
    [row.lead_account_id, args.messageId],
  );
  return { woke: row.lead_account_id };
}

/**
 * 팀장의 `delegation_done` 항목에 실어 줄 **결말**. `listInbox` 가 부른다.
 *
 * `roundsLeft` 를 함께 세는 이유는 `InboxDelegationOutcome` 주석에 있다 — 다시 넘기는 것은
 * 라운드를 먹으므로 팀장이 그것을 알고 골라야 한다.
 */
export async function outcomesFor(
  db: Pick<Pool, 'query'>, messageIds: string[],
): Promise<Map<string, InboxDelegationOutcome>> {
  if (!messageIds.length) return new Map();
  const res = await db.query<{
    message_id: string; thread_root_id: string; lead_account_id: string;
    handle: string; outcome: 'done' | 'failed' | 'timeout' | null;
  }>(
    `select d.message_id, d.thread_root_id, d.lead_account_id, a.handle, i.outcome
       from team_delegation d
       join team_delegation_item i on i.delegation_id = d.id
       join account a on a.id = i.delegate_account_id
      where d.message_id = any($1)
      order by a.handle`,
    [messageIds],
  );

  const out = new Map<string, InboxDelegationOutcome>();
  const threads = new Map<string, { threadRootId: string; leadAccountId: string }>();
  for (const row of res.rows) {
    // 결말이 아직 없는 항목(`null`)은 목록에 넣지 않는다 — 이 함수는 결말이 난 위임에만
    // 불리지만, 기한 스위퍼가 닫기 **전에** 사람이 인박스를 읽는 순간이 있을 수 있다.
    if (row.outcome === null) continue;
    let entry = out.get(row.message_id);
    if (!entry) {
      entry = { timedOut: false, roundsLeft: 0, items: [] };
      out.set(row.message_id, entry);
      threads.set(row.message_id, {
        threadRootId: row.thread_root_id, leadAccountId: row.lead_account_id,
      });
    }
    entry.items.push({ handle: row.handle, outcome: row.outcome });
    if (row.outcome === 'timeout') entry.timedOut = true;
  }

  // 줄마다 따로 묻지 않는다(Q4) — 결말이 난 위임 전부의 라운드를 한 번에 센다.
  const ids = [...out.keys()];
  const used = await roundsUsedMany(db, ids.map((id) => threads.get(id)!));
  ids.forEach((id, i) => { out.get(id)!.roundsLeft = Math.max(0, TEAM_ROUND_LIMIT - (used[i] ?? 0)); });
  return out;
}

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

export const DELEGATION_SWEEP_INTERVAL_MS = 15_000;
export const DELEGATION_SWEEP_BATCH = 20;

/**
 * 기한 스위퍼 — **아무 신호도 오지 않는 경우의 유일한 출구다.**
 *
 * 팀원이 죽으면(러너 부재·사람이 턴을 중단·통지 없이 물러난 러너) 의무는 열린 채 남고,
 * 팀장은 기다리는 것이 아니라 **없다**(위임하고 턴이 끝나면 프로세스가 죽는다). 깨어 있는
 * 쪽이 아무도 없으므로 되살리는 길은 이 시계 하나다.
 *
 * `agentWakes`·`scheduledMessages`·`staleRequests` 와 같은 모양이다: 한 건씩 자기 트랜잭션,
 * 프로세스 안 겹침은 깃발로, `onClose` 에서 interval 정리.
 *
 * **기한이 지나면 의무를 닫는다**(열어 두지 않는다). 열어 두면 **늦게 도착한 답이 이미 끝난
 * 라운드를 다시 깨운다** — 사람에게 넘긴 일이 되살아나고, 사람과 에이전트가 같은 일을
 * 동시에 잡는다(소유자 결정: 늦은 답으로는 깨우지 않는다).
 */
export function createDelegationDeadlineSweeper(pool: Pool, opts: {
  onWake?: (accountId: string) => void;
  /**
   * 지금 **도는 턴**들(릴레이 허브의 `listSessions('all')`). 기한이 지났어도 그 팀원의 턴이
   * **이 스레드에서** 아직 돌고 있으면 무응답이 아니다 — 일하는 중이다(2026-09-12).
   *
   * 진행 발화보다 강한 신호다: 진행은 모델이 올려 줘야 하지만 이것은 러너가 붙어 있다는
   * 사실 자체다. 그래서 둘 다 본다 — 진행은 턴 **사이**(예약 뒤 다음 턴까지)를 메우고,
   * 이것은 턴 **안**의 긴 침묵을 메운다.
   *
   * 옵셔널인 이유: 시험은 허브 없이 이 스위퍼를 직접 돌린다(다른 스위퍼들과 같은 모양).
   * 없으면 아무 턴도 안 도는 것으로 본다 — 그 방향으로 틀리는 것이 안전하다(닫히긴 하되
   * 팀장이 결말을 받고, 반대 방향은 영원히 안 닫히는 것이다).
   */
  runningTurns?: () => readonly { agentAccountId: string; threadRootId: string | null }[];
} = {}): { startSweep(app: SweepHost): void; sweep(): Promise<void> } {
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function expireOne(skip: string[]): Promise<'done' | 'none'> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('begin');
      const due = await client.query<{ id: string; thread_root_id: string; created_at: Date }>(
        `select id, thread_root_id, created_at from team_delegation
          where notified_at is null and deadline_at < now() and id <> all($1)
          order by deadline_at
          limit 1
          for update skip locked`,
        [skip],
      );
      const row = due.rows[0];
      if (!row) {
        await client.query('commit');
        return 'none';
      }
      skip.push(row.id);

      /**
       * **도는 턴이 있으면 닫지 않는다** — 대신 기한을 뒤로 민다(2026-09-12).
       *
       * 닫아 버리면 팀장이 *"무응답"* 을 받고 같은 일을 다시 시키는데, 그 팀원은 바로 그
       * 일을 하고 있는 중이다(턴 예산은 30분이라 10분 넘는 일이 정상이다). 그때 뒤늦게 온
       * 보고는 이미 닫힌 의무를 열지 못해 아무도 이어받지 않는다.
       *
       * 건너뛰지 않고 **미는** 이유: 건너뛰면 이 행이 매 스윕(15초)마다 다시 잡힌다. 밀면
       * 그 팀원이 조용해진 뒤 10분에 정확히 한 번 다시 온다.
       */
      const running = opts.runningTurns?.() ?? [];
      if (running.length) {
        const openOnes = await client.query<{ delegate_account_id: string }>(
          `select i.delegate_account_id from team_delegation_item i
            where i.delegation_id = $1 and i.outcome is null`,
          [row.id],
        );
        const stillWorking = openOnes.rows.some((o) => running.some(
          (t) => t.agentAccountId === o.delegate_account_id && t.threadRootId === row.thread_root_id,
        ));
        if (stillWorking) {
          await client.query(
            `update team_delegation
                set deadline_at = greatest(deadline_at, now() + ($2::int * interval '1 second'))
              where id = $1`,
            [row.id, DELEGATION_SILENCE_SEC],
          );
          await client.query('commit');
          return 'done';
        }
      }

      // P5: 이 위임에 열린 PR 감시가 붙어 있으면 「외부 대기」다 — 닫지 않고 침묵 시계를 민다(스위치가 켜졌을 때만). 감시는 최대 6시간이라
      // 끝나면(done·gone·expired) 다음 스윕이 평소대로 판정한다. 술어는 `OPEN_WATCH_FOR_DELEGATION_SQL` 하나다(`prWatch.ts::delegationHasOpenWatch` 와 같이 쓴다).
      if (delegationV2Enabled()) {
        const watched = await client.query(OPEN_WATCH_FOR_DELEGATION_SQL, [row.id]);
        if (watched.rowCount) {
          await client.query(
            `update team_delegation set deadline_at = greatest(deadline_at, now() + ($2::int * interval '1 second')) where id = $1`,
            [row.id, DELEGATION_SILENCE_SEC]);
          await client.query('commit');
          return 'done';
        }
      }

      /**
       * **담당이 턴 사이에서 기다리는 중이면 닫지 않는다**(2026-11-06). 끝 보고만 의무를 닫으므로, 예약을 걸고 CI 를 기다리거나
       * 사람의 답을 기다리는 담당이 10분에 무응답이 되면 정작 보고가 닫힌 의무에 닿지 못한다. 상한은 `DELEGATION_WAIT_MAX_SEC`.
       */
      if (Date.now() - new Date(row.created_at).getTime() < DELEGATION_WAIT_MAX_SEC * 1000) {
        const waiting = await client.query<{ wake_at: Date | null; open_ask: boolean }>(
          `with delegate as (
             select delegate_account_id as id from team_delegation_item where delegation_id = $1 and outcome is null
           )
           select (select max(w.wake_at) from agent_wake w join message m on m.id = w.message_id
                    where w.account_id in (select id from delegate)
                      and w.fired_at is null and w.canceled_at is null
                      and (coalesce(m.thread_root_id, m.id) = $2
                        or lower(m.meta->'wake'->'reportTo'->>'threadRootId') = $2::text)) as wake_at,
                  exists (select 1 from message m
                           where m.author_id in (select id from delegate)
                             and m.thread_root_id = $2 and m.created_at >= $3
                             and m.deleted_at is null and m.meta->>'kind' = 'ask'
                             and m.meta->'ask'->>'answeredWith' is null and m.meta->'ask'->>'closedAt' is null) as open_ask`,
          [row.id, row.thread_root_id, row.created_at],
        );
        const wait = waiting.rows[0]!;
        if (wait.wake_at !== null || wait.open_ask) {
          await client.query(
            `update team_delegation
                set deadline_at = greatest(deadline_at, now() + ($2::int * interval '1 second'),
                                           coalesce($3::timestamptz, now()) + ($2::int * interval '1 second'))
              where id = $1`,
            [row.id, DELEGATION_SILENCE_SEC, wait.wake_at],
          );
          await client.query('commit');
          return 'done';
        }
      }

      /**
       * v1(P3): 침묵은 닫지 않는다 — 위임자에게 한 번 알리고(`stalled`) 열어 둔다. 닫힘은 위임자·idle·max_age 가 맡는다.
       * 열린 PR 감시가 붙은 위임은 「외부 대기」라 위에서 먼저 빠진다(알리지도 않는다).
       * TODO(P3 후속): 전용 사유(`stalled`)가 shared 에 생기면 그것으로 바꾼다. 지금은 위임 글을 가리키는 `delegation_update` 다.
       */
      if (delegationV2Enabled()) {
        // 열린 감시가 붙은 위임은 위(P5 「외부 대기」)에서 이미 돌아갔다 — 여기서 다시 보지 않는다.
        const marked = await client.query(
          `update team_delegation_item set stalled_notified_at = now()
            where delegation_id = $1 and outcome is null and stalled_notified_at is null`,
          [row.id],
        );
        let lead: string | null = null;
        if (marked.rowCount) {
          const d = await client.query<{ lead_account_id: string; message_id: string }>(
            `select lead_account_id, message_id from team_delegation where id = $1`, [row.id]);
          const r = d.rows[0]!;
          const exists = await client.query(
            `select 1 from inbox where account_id = $1 and message_id = $2 and reason = 'delegation_update' and read_at is null`,
            [r.lead_account_id, r.message_id]);
          if (!exists.rowCount) {
            await client.query(
              `insert into inbox (account_id, message_id, reason) values ($1, $2, 'delegation_update')`,
              [r.lead_account_id, r.message_id]);
            lead = r.lead_account_id;
          }
        }
        // 다시 잡히지 않게 기한을 최대 수명까지 민다 — max_age 가 닫는다.
        await client.query(
          `update team_delegation set deadline_at = greatest(deadline_at, created_at + ($2::int * interval '1 second'))
            where id = $1`,
          [row.id, DELEGATION_MAX_AGE_SEC],
        );
        await client.query('commit');
        if (lead) opts.onWake?.(lead);
        return 'done';
      }

      // 남은 미결을 **무응답**으로 닫는다. 이미 닫힌 것(답·실패)은 그대로 둔다 —
      // 결말을 뒤늦게 덮으면 팀장이 받는 목록이 사실과 달라진다.
      await client.query(
        `update team_delegation_item set outcome = 'timeout', closed_at = now()
          where delegation_id = $1 and outcome is null`,
        [row.id],
      );
      const reportTouched: WakeReportTo[] = [];
      const wakeRowsTouched: string[] = [];
      const lead = await notifyIfSettled(client, row.id, { reportTouched, wakeRowsTouched });
      await client.query('commit');
      if (reportTouched.length) await announceReportWakes(pool, reportTouched).catch(() => undefined);
      await announceWakeRows(pool, wakeRowsTouched);
      if (lead) opts.onWake?.(lead);
      return 'done';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      // 한 건의 실패로 나머지를 멈추지 않는다. 행은 미결로 남아 다음 스윕이 다시 집는다 —
      // 영구 실패로 굳히면 그 팀장은 영영 깨지 않는다.
      console.error('delegation deadline sweep error:', err);
      return 'done';
    } finally {
      client.release();
    }
  }

  /** v1(P3): 자동 닫힘(idle·max_age)과 턴 끝 update 를 한 트랜잭션으로. */
  async function sweepV2(): Promise<void> {
    const client: PoolClient = await pool.connect();
    let woke: string[] = [];
    const reportTouched: WakeReportTo[] = [];
    const wakeRowsTouched: string[] = [];
    try {
      await client.query('begin');
      await autoCloseDelegations(client);
      woke = await flushDelegationUpdates(client, { reportTouched, wakeRowsTouched });
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    for (const id of new Set(woke)) opts.onWake?.(id);
    // 접은 대기 줄·보고처는 커밋 뒤에 알린다(`closeDelegationsForReply` 호출자와 같은 규약).
    if (wakeRowsTouched.length) await announceWakeRows(pool, wakeRowsTouched).catch(() => undefined);
    if (reportTouched.length) await announceReportWakes(pool, reportTouched).catch(() => undefined);
  }

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const skip: string[] = [];
      for (let i = 0; i < DELEGATION_SWEEP_BATCH; i++) {
        if ((await expireOne(skip)) === 'none') break;
      }
      if (delegationV2Enabled()) await sweepV2();
    } catch (err) {
      // DB 에 닿지 못한 것(`pool.connect` 는 한 건 처리의 try 밖이다)이 여기로 온다. 던지면
      // `void sweep()` 이 처리 안 된 거절이 되어 프로세스가 죽는다(2026-10-12 PG OOM 때 실제로 죽었다).
      // 로그만 남기고 다음 주기에 다시 한다 — 행은 그대로 대기다.
      console.error('delegation deadline sweep error:', err);
    } finally {
      running = false;
    }
  };

  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, DELEGATION_SWEEP_INTERVAL_MS);
      sweepInterval.unref?.();
      app.addHook('onClose', async () => {
        if (sweepInterval) {
          clearInterval(sweepInterval);
          sweepInterval = null;
        }
      });
    },
    sweep,
  };
}

// ───────────────────────── 위임 재설계 v1 — 수명·턴 끝 update (P3) ─────────────────────────
// 모두 `delegationV2Enabled()` 뒤다. 스위치가 꺼진 서버는 아래 함수를 하나도 부르지 않는다.

/** 보고된 뒤 담당이 이만큼 조용하면 `closed/idle`. */
export const DELEGATION_IDLE_SEC = 6 * 60 * 60;
/** 위임의 최대 수명 — 넘으면 `closed/max_age`. */
export const DELEGATION_MAX_AGE_SEC = 24 * 60 * 60;
/** 임대 없는 턴(PTY·bg·옛 러너)의 턴 끝 대용: 담당의 마지막 글에서 이만큼. */
export const DELEGATION_UPDATE_QUIET_SEC = 60;
/** 위임 하나당 update 상한. 넘으면 만들지 않고 글 meta 에 까닭을 남긴다. */
export const DELEGATION_UPDATE_LIMIT = 40;

/**
 * 닫힌 위임 행이 더는 열린 의무를 갖지 않으면 `notified_at` 을 찍어 기한 스위퍼가 다시 잡지 않게 한다.
 * 깨우지 않는다(자동 닫힘·위임자 닫힘은 깨움이 없다).
 */
async function markSettledQuietly(client: PoolClient, delegationIds: string[]): Promise<void> {
  if (!delegationIds.length) return;
  await client.query(
    `update team_delegation d set notified_at = now()
      where d.id = any($1::uuid[]) and d.notified_at is null
        and not exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.outcome is null)`,
    [delegationIds],
  );
}

async function supersedePrevious(
  client: PoolClient, args: { threadRootId: string; delegateId: string; keep: string },
): Promise<void> {
  const r = await client.query<{ delegation_id: string }>(
    `update team_delegation_item i
        set outcome = 'closed', closed_reason = 'superseded', closed_at = now(), update_pending_message_id = null
       from team_delegation d
      where d.id = i.delegation_id and d.thread_root_id = $1 and i.delegate_account_id = $2
        and i.delegation_id <> $3 and (i.outcome is null or i.outcome = 'reported')
      returning i.delegation_id`,
    [args.threadRootId, args.delegateId, args.keep],
  );
  await markSettledQuietly(client, r.rows.map((x) => x.delegation_id));
}

/**
 * v1 의 답 처리. `report` 는 결과 신호일 뿐 닫지 않는다(`reported`), `fail` 은 `failed`. 둘 다 미결이 0 이 되면
 * 지금처럼 `delegation_done` 으로 위임자를 깨운다. 그 밖의 담당 글(또는 이미 보고된 뒤의 글)은 「대기 중 update」로
 * 적어 두고, 턴이 끝나면 스위퍼(`flushDelegationUpdates`)가 위임자에게 하나를 만든다.
 */
async function closeDelegationsForReplyV2(
  client: PoolClient,
  args: {
    threadRootId: string; authorId: string; messageId: string; kind: MessageRow['kind'];
    isReport: boolean; isFailure: boolean; reportTouched?: WakeReportTo[]; wakeRowsTouched?: string[];
  },
): Promise<string[]> {
  await touchDelegationDeadline(client, { threadRootId: args.threadRootId, authorId: args.authorId });
  const woke: string[] = [];
  if (countsAsReply(args.kind) && (args.isReport || args.isFailure)) {
    const open = await client.query<{ delegation_id: string }>(
      `select i.delegation_id
         from team_delegation_item i
         join team_delegation d on d.id = i.delegation_id
        where i.delegate_account_id = $1 and i.outcome is null and d.thread_root_id = $2
        order by d.created_at
        for update of d`,
      [args.authorId, args.threadRootId],
    );
    for (const row of open.rows) {
      const closed = await client.query(
        `update team_delegation_item
            set outcome = $3, closed_by_message_id = $4, closed_at = now(), last_activity_at = now(),
                update_pending_message_id = null, update_pending_at = null
          where delegation_id = $1 and delegate_account_id = $2 and outcome is null`,
        [row.delegation_id, args.authorId, args.isFailure ? 'failed' : 'reported', args.messageId],
      );
      if (!closed.rowCount) continue;
      const lead = await notifyIfSettled(client, row.delegation_id, args);
      if (lead) woke.push(lead);
    }
    if (open.rowCount) return woke;
  }
  // 결과가 아닌 글, 또는 이미 보고된 뒤의 글: 턴 끝에 update 로 간다.
  await client.query(
    `update team_delegation_item i
        set last_activity_at = now(), update_pending_message_id = $3, update_pending_at = now()
       from team_delegation d
      where d.id = i.delegation_id and d.thread_root_id = $2 and i.delegate_account_id = $1
        and (i.outcome is null or i.outcome = 'reported')`,
    [args.authorId, args.threadRootId, args.messageId],
  );
  return woke;
}

/**
 * 턴이 끝난 담당의 대기 중 update 를 위임자 inbox 로 옮긴다. 턴 끝 = 다음 중 먼저:
 * 그 글을 덮는 턴 임대가 끝났다(`endTurnLease` 가 `ended_at` 을 찍는다) · 그 임대의 `expires_at` 이 지났다 ·
 * 마지막 글에서 60초가 지났다(임대 없는 턴). 임대 수명은 건드리지 않는다 — 읽기만 한다.
 *
 * - (위임자, 위임) 당 읽지 않은 update 는 하나: 앞의 것을 지우고 새 글을 가리키는 것 하나만 둔다.
 * - 같은 글이 위임자에게 이미 `mention` 을 만들었으면 그 행을 update 로 바꾼다(`createDelegation` 의 mention→team_delegated 와 같다).
 * - 위임자의 그 스레드 대기 깨움은 접는다(`foldWakesForDelegation`, 사람 글 선점과 같은 모양).
 *
 * 돌려주는 것은 깨운 위임자 id 들이다.
 */
export async function flushDelegationUpdates(
  client: PoolClient, touched: { reportTouched?: WakeReportTo[]; wakeRowsTouched?: string[] } = {}, limit = DELEGATION_SWEEP_BATCH,
): Promise<string[]> {
  const due = await client.query<{
    delegation_id: string; delegate_account_id: string; message_id: string;
    lead_account_id: string; thread_root_id: string; update_count: number;
  }>(
    `select i.delegation_id, i.delegate_account_id, i.update_pending_message_id as message_id,
            d.lead_account_id, d.thread_root_id, i.update_count
       from team_delegation_item i
       join team_delegation d on d.id = i.delegation_id
      where i.update_pending_message_id is not null
        and (i.update_pending_at <= now() - make_interval(secs => $1)
             or exists (
               select 1 from secret_turn_lease l
                where l.agent_id = i.delegate_account_id and l.thread_root_id = d.thread_root_id
                  and l.created_at <= i.update_pending_at
                  and coalesce(l.ended_at, case when l.expires_at <= now() then l.expires_at end) >= i.update_pending_at))
      order by i.update_pending_at
      limit $2
      for update of i skip locked`,
    [DELEGATION_UPDATE_QUIET_SEC, limit],
  );
  const woke: string[] = [];
  for (const row of due.rows) {
    await client.query(
      `update team_delegation_item set update_pending_message_id = null, update_pending_at = null
        where delegation_id = $1 and delegate_account_id = $2`,
      [row.delegation_id, row.delegate_account_id],
    );
    if (row.update_count >= DELEGATION_UPDATE_LIMIT) {
      // TODO(P3 후속): 상한을 넘으면 사람에게 카드를 띄운다. 지금은 글에 까닭만 남기고 만들지 않는다.
      await client.query(
        `update message set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('delegationUpdateSkipped', 'limit')
          where id = $1`,
        [row.message_id],
      );
      continue;
    }
    // 읽지 않은 update 는 (위임자, 위임) 당 하나 — 이 담당이 이 스레드에 쓴 글을 가리키는 앞 행을 지운다.
    await client.query(
      `delete from inbox x using message m
        where x.account_id = $1 and x.reason = 'delegation_update' and x.read_at is null
          and m.id = x.message_id and m.thread_root_id = $2 and m.author_id = $3 and x.message_id <> $4`,
      [row.lead_account_id, row.thread_root_id, row.delegate_account_id, row.message_id],
    );
    const converted = await client.query(
      `update inbox set reason = 'delegation_update'
        where account_id = $1 and message_id = $2 and reason in ('mention', 'delegation_update')`,
      [row.lead_account_id, row.message_id],
    );
    if (!converted.rowCount) {
      await client.query(
        `insert into inbox (account_id, message_id, reason) values ($1, $2, 'delegation_update')`,
        [row.lead_account_id, row.message_id],
      );
    }
    await client.query(
      `update team_delegation_item set update_count = update_count + 1 where delegation_id = $1 and delegate_account_id = $2`,
      [row.delegation_id, row.delegate_account_id],
    );
    await foldWakesForDelegation(client, {
      delegationId: row.delegation_id, leadAccountId: row.lead_account_id,
      threadRootId: row.thread_root_id, messageId: row.message_id,
      reportTouched: touched.reportTouched, wakeRowsTouched: touched.wakeRowsTouched,
    });
    woke.push(row.lead_account_id);
  }
  return woke;
}

/** 보고된 뒤 6시간 조용하면 `idle`, 만든 지 24시간이면 `max_age` 로 닫는다. 깨우지 않는다. 닫은 의무 수. */
export async function autoCloseDelegations(client: PoolClient): Promise<number> {
  const idle = await client.query<{ delegation_id: string }>(
    `update team_delegation_item
        set outcome = 'closed', closed_reason = 'idle', update_pending_message_id = null, update_pending_at = null
      where outcome = 'reported' and coalesce(last_activity_at, closed_at) < now() - make_interval(secs => $1)
      returning delegation_id`,
    [DELEGATION_IDLE_SEC],
  );
  const aged = await client.query<{ delegation_id: string }>(
    `update team_delegation_item i
        set outcome = 'closed', closed_reason = 'max_age', closed_at = coalesce(i.closed_at, now()),
            update_pending_message_id = null, update_pending_at = null
       from team_delegation d
      where d.id = i.delegation_id and (i.outcome is null or i.outcome = 'reported')
        and d.created_at < now() - make_interval(secs => $1)
      returning i.delegation_id`,
    [DELEGATION_MAX_AGE_SEC],
  );
  await markSettledQuietly(client, [...idle.rows, ...aged.rows].map((r) => r.delegation_id));
  return (idle.rowCount ?? 0) + (aged.rowCount ?? 0);
}

/**
 * `delegation.close` — 위임자만 닫는다(`closed/delegator_close`). 깨우지 않는다.
 * `delegationId` 가 없으면 이 스레드에서 호출자가 낸 열린·보고된 의무 전부, `delegateId` 가 있으면 그 담당 것만.
 */
export async function closeDelegationByDelegator(
  client: PoolClient,
  args: { callerId: string; threadRootId: string; delegationId?: string; delegateId?: string },
): Promise<number> {
  const r = await client.query<{ delegation_id: string }>(
    `update team_delegation_item i
        set outcome = 'closed', closed_reason = 'delegator_close', closed_at = coalesce(i.closed_at, now()),
            update_pending_message_id = null, update_pending_at = null
       from team_delegation d
      where d.id = i.delegation_id and d.lead_account_id = $1 and d.thread_root_id = $2
        and ($3::uuid is null or d.id = $3::uuid)
        and ($4::uuid is null or i.delegate_account_id = $4::uuid)
        and (i.outcome is null or i.outcome = 'reported')
      returning i.delegation_id`,
    [args.callerId, args.threadRootId, args.delegationId ?? null, args.delegateId ?? null],
  );
  await markSettledQuietly(client, r.rows.map((x) => x.delegation_id));
  return r.rowCount ?? 0;
}

/** 스레드 하나에 실을 위임 요약의 최대 개수(최근 것부터). */
const DELEGATION_SUMMARY_PER_THREAD = 10;

/**
 * inbox 항목에 실을 스레드별 위임 요약(`InboxEntry.delegations`). 넘긴 쪽은 담당 전원을, **담당 쪽은 자기 한 줄만** 받는다 —
 * 다른 담당의 `lastMessageId` 는 결코 담당에게 가지 않는다(보안 요구). 열린 PR 감시는 `pr_watch_subscriber.delegation_id` 로 붙인다.
 */
export async function delegationSummariesFor(
  pool: Pool | PoolClient, accountId: string, threadRootIds: string[],
): Promise<Map<string, InboxDelegationSummary[]>> {
  const out = new Map<string, InboxDelegationSummary[]>();
  if (!threadRootIds.length) return out;
  const dl = await pool.query<{
    id: string; thread_root_id: string; kind: DelegationKind; delegator_handle: string; message_id: string;
    plan_step_id: string | null; is_lead: boolean;
  }>(
    `select * from (
       select d.id, d.thread_root_id, d.kind, la.handle as delegator_handle, d.message_id, d.plan_step_id,
              d.lead_account_id = $1 as is_lead,
              row_number() over (partition by d.thread_root_id order by d.created_at desc) as rn
         from team_delegation d
         join account la on la.id = d.lead_account_id
        where d.thread_root_id = any($2::uuid[])
          and (d.lead_account_id = $1
               or exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.delegate_account_id = $1))
     ) x where rn <= $3
     order by thread_root_id, rn desc`,
    [accountId, [...new Set(threadRootIds)], DELEGATION_SUMMARY_PER_THREAD],
  );
  if (!dl.rowCount) return out;
  const ids = dl.rows.map((r) => r.id);
  const items = await pool.query<{
    delegation_id: string; delegate_account_id: string; handle: string; outcome: string | null;
    closed_reason: DelegationClosedReason | null; last_activity_at: Date | null; last_message_id: string | null;
  }>(
    `select i.delegation_id, i.delegate_account_id, a.handle, i.outcome, i.closed_reason, i.last_activity_at,
            (select m.id from message m
              where m.thread_root_id = d.thread_root_id and m.author_id = i.delegate_account_id and m.created_at >= d.created_at
              order by m.created_at desc limit 1) as last_message_id
       from team_delegation_item i
       join team_delegation d on d.id = i.delegation_id
       join account a on a.id = i.delegate_account_id
      where i.delegation_id = any($1::uuid[])
      order by a.handle`,
    [ids],
  );
  const watches = await pool.query<{ delegation_id: string; account_id: string; repo: string; number: number; head: string; until: PrWatchUntil; handle: string }>(
    `select s.delegation_id, s.account_id, w.repo, w.number, w.head, w.until, a.handle
       from pr_watch_subscriber s
       join pr_watch w on w.id = s.watch_id and w.state = 'open'
       join account a on a.id = s.account_id
      where s.delegation_id = any($1::uuid[])
      order by w.created_at`,
    [ids],
  );
  for (const d of dl.rows) {
    const summary: InboxDelegationSummary = {
      id: d.id, role: d.is_lead ? 'delegator' : 'delegate', kind: d.kind, delegatorHandle: d.delegator_handle,
      messageId: d.message_id, planStepId: d.plan_step_id,
      items: items.rows
        // 담당 쪽은 자기 한 줄만. 위임자이면서 담당인 경우(자기에게 넘김)는 위임자 쪽으로 본다.
        .filter((i) => i.delegation_id === d.id && (d.is_lead || i.delegate_account_id === accountId))
        .map((i) => ({
          handle: i.handle,
          state: (i.outcome ?? 'open') as DelegationItemState,
          ...(i.outcome === 'closed' && i.closed_reason ? { closedReason: i.closed_reason } : {}),
          lastMessageId: i.last_message_id,
          lastActivityAt: i.last_activity_at ? i.last_activity_at.toISOString() : null,
        })),
      // 담당 쪽은 자기가 건 감시만(items 와 같은 「자기 줄만」 원칙).
      prWatches: watches.rows.filter((w) => w.delegation_id === d.id && (d.is_lead || w.account_id === accountId))
        .map((w) => ({ repo: w.repo, number: w.number, head: w.head, until: w.until, byHandle: w.handle })),
    };
    const list = out.get(d.thread_root_id) ?? [];
    list.push(summary);
    out.set(d.thread_root_id, list);
  }
  return out;
}
