import type { Pool, PoolClient } from 'pg';
import { countsAsReply, TEAM_ROUND_LIMIT, type InboxDelegationOutcome, type MessageRow } from '@harkroom/shared';

/**
 * 위임 왕복(마이그레이션 050) — **팀장이 넘긴 일이 끝나면 팀장이 다시 깬다.**
 *
 * 이 파일이 갖는 사실은 넷이다: **누가 넘길 수 있나**(팀장만) · **몇 번까지**(라운드) ·
 * **무엇이 의무를 닫나**(답·실패·기한) · **언제 팀장을 깨우나**(미결 0 또는 기한, 한 번만).
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

export type DelegateRefusal =
  | { code: 'not_a_lead'; message: string }
  | { code: 'not_team_members'; message: string }
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
 * **사람의 마지막 발화 이후** 이 팀장이 이 스레드에서 만든 위임의 수.
 *
 * `agentWakes.ts::consecutiveWakes` 와 같은 모양·같은 이유다. 사람이 한마디 하면 리셋되므로
 * 상한이 스레드를 영구히 잠그지 않는다 — 043 이 멘션 깊이에 대해 정한 규칙 그대로다.
 */
export async function roundsUsed(
  db: Pick<Pool, 'query'>, args: { threadRootId: string; leadAccountId: string },
): Promise<number> {
  const res = await db.query<{ n: number }>(
    `select count(*)::int as n
       from team_delegation d
      where d.thread_root_id = $1
        and d.lead_account_id = $2
        and d.created_at > coalesce((
          select max(m.created_at) from message m
           join account a on a.id = m.author_id
          where coalesce(m.thread_root_id, m.id) = $1
            and a.kind = 'human'
            and m.deleted_at is null
        ), 'epoch'::timestamptz)`,
    [args.threadRootId, args.leadAccountId],
  );
  return res.rows[0]?.n ?? 0;
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
    teamId: string;
    leadAccountId: string;
    delegateIds: string[];
    deadlineAt: Date;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into team_delegation
       (message_id, team_id, lead_account_id, channel_id, thread_root_id, deadline_at)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [args.messageId, args.teamId, args.leadAccountId, args.channelId, args.threadRootId, args.deadlineAt],
  );
  const delegationId = inserted.rows[0]!.id;

  for (const delegateId of args.delegateIds) {
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
 * 팀원의 발화가 **자기 의무를 닫는다.** `postMessage` 안에서 같은 트랜잭션으로 불린다.
 *
 * ## 무엇이 닫는가
 *
 * `countsAsReply(kind)` 인 발화 하나다 — `progress`·`wake` 는 답이 아니므로 닫지 않는다
 * (#687 이 만들고 시험까지 있는 판정을 그대로 쓴다). **실패도 닫는다**: 실패는 결과이고,
 * 러너는 3회 소진·사용량 한도·세션 충돌에서 이미 `message.fail` 을 올린다 — 그래서 하네스
 * 실패는 이 경로로 **자동으로** 풀린다.
 *
 * ## 왜 첫 발화 하나만인가
 *
 * 팀원이 두 번 말하면 두 번째는 이미 닫힌 의무를 다시 닫지 않는다(`outcome is null` 조건).
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
    isFailure: boolean;
  },
): Promise<string[]> {
  // 닫지 않는 발화(`progress`·`wake`)는 **"살아 있다"** 는 신호다 — 의무는 그대로 두고
  // 기한만 뒤로 민다(2026-09-12). 그 판단의 근거는 `touchDelegationDeadline` 주석에 있다.
  if (!countsAsReply(args.kind)) {
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

    const lead = await notifyIfSettled(client, row.delegation_id);
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
  args: { threadRootId: string; accountId: string },
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
    const lead = await notifyIfSettled(client, row.delegation_id);
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
async function notifyIfSettled(client: PoolClient, delegationId: string): Promise<string | null> {
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

  const marked = await client.query<{ lead_account_id: string; message_id: string }>(
    `update team_delegation set notified_at = now()
      where id = $1 and notified_at is null
      returning lead_account_id, message_id`,
    [delegationId],
  );
  if (!marked.rowCount) return null;

  const row = marked.rows[0]!;
  // 사유가 가리키는 메시지는 **위임 자신**이다(043 의 "물음 자신"과 같은 규약) — 러너는
  // 그것으로 결말 목록을 되찾는다. 새 메시지를 만들지 않는 이유도 같다: 스레드에
  // "결말이 났다"는 줄이 하나 더 생기면 그 대화를 읽는 사람에게 소음이다.
  await client.query(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, 'delegation_done')`,
    [row.lead_account_id, row.message_id],
  );
  return row.lead_account_id;
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

  for (const [messageId, entry] of out) {
    const t = threads.get(messageId)!;
    const used = await roundsUsed(db, { threadRootId: t.threadRootId, leadAccountId: t.leadAccountId });
    entry.roundsLeft = Math.max(0, TEAM_ROUND_LIMIT - used);
  }
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
 * 동시에 잡는다(jaebin 결정: 늦은 답으로는 깨우지 않는다).
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
      const due = await client.query<{ id: string; thread_root_id: string }>(
        `select id, thread_root_id from team_delegation
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

      // 남은 미결을 **무응답**으로 닫는다. 이미 닫힌 것(답·실패)은 그대로 둔다 —
      // 결말을 뒤늦게 덮으면 팀장이 받는 목록이 사실과 달라진다.
      await client.query(
        `update team_delegation_item set outcome = 'timeout', closed_at = now()
          where delegation_id = $1 and outcome is null`,
        [row.id],
      );
      const lead = await notifyIfSettled(client, row.id);
      await client.query('commit');
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

  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const skip: string[] = [];
      for (let i = 0; i < DELEGATION_SWEEP_BATCH; i++) {
        if ((await expireOne(skip)) === 'none') break;
      }
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
