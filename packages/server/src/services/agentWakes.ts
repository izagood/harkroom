import type { Pool, PoolClient } from 'pg';
import type { MessageRow, ReportWakeView, WakeReportTo } from '@harkroom/shared';
import { BAD_THREAD_MESSAGE, getMessageById, postMessage, verifiedCauseLink } from './messages.js';
import { audienceFor, channelVisibleSql } from './channels.js';
import { emitEvent } from '../events.js';

/**
 * 깨움(wake) — 에이전트가 자기를 나중에 깨우는 예약. 마이그레이션 040 의 주석이 왜
 * 별도 테이블인지를 말한다.
 *
 * 이 파일이 갖는 사실은 셋이다: **언제부터 깨울 수 있나**(하한), **몇 번까지
 * 연속으로 걸 수 있나**(상한), **시각이 되면 무엇을 하나**(sweep). 셋 다 정책이라
 * 한 곳에 모아 둔다 — MCP 도구가 각자 판정하면 REST 표면이 생기는 날 갈라진다.
 */

/**
 * 깨움 하한. 이보다 이르게 걸 수 있으면 에이전트가 자기를 몇 초마다 깨워 토큰을 태운다 —
 * 사람이 자리에 없는 동안 조용히 일어나는 일이라 더 위험하다.
 */
export const WAKE_MIN_SEC = 60;

/**
 * 상한. 6시간 뒤를 예약하는 것은 "기다린다"가 아니라 "잊는다"에 가깝고, 그건 사람에게
 * 넘겨야 하는 판단이다(`message.fail(retryable: true)` 이 그 표면이다).
 */
export const WAKE_MAX_SEC = 6 * 60 * 60;

/**
 * **사람의 새 발화 없이** 연속으로 걸 수 있는 깨움의 수.
 *
 * 왜 개수 상한이 하한과 별개로 필요한가: 하한만 있으면 60초짜리 깨움을 무한히 이어
 * 붙일 수 있다. 20 × 60초 = 최소 20분이고, CI 대기 같은 실제 용도는 그 안에 끝난다.
 * 소진되면 스스로 다시 걸지 못하게 하고 사람에게 알리는 쪽이 맞다.
 */
export const MAX_CONSECUTIVE_WAKES = 20;

export type WakeRefusal =
  | { code: 'wake_limit'; message: string }
  /** 내가 넘긴 일이 아니거나 이미 결말이 났다 — 기다릴 것이 없다. */
  | { code: 'bad_delegation'; message: string }
  /** 스레드 머리가 이 채널의 최상위 글이 아니다 — 게시가 거절한 그 사유를 그대로 돌려준다. */
  | { code: 'bad_thread'; message: string };

/**
 * 이 스레드에서 **마지막으로 남이 말한 뒤** 내가 건 깨움의 수.
 *
 * 기준선을 "남의 마지막 발화"로 두는 이유: 사람이 다시 말을 걸면 그건 새 구간이고,
 * 그때까지의 깨움 횟수로 새 대기를 막으면 "어제 스무 번 기다렸으니 오늘은 못 기다린다"가
 * 된다. 리셋을 시간이 아니라 **대화**가 하게 두는 것이 이 시스템의 다른 판정들과 같은 결이다.
 *
 * 스레드 루트는 `thread_root_id` 가 null 이라 아래 두 조건 어디에도 안 걸린다 — 루트를
 * 쓴 사람의 발화는 기준선이 되지 못하고, 대신 그 스레드의 첫 답부터 센다. 루트 하나뿐인
 * 스레드에서 카운트가 0 부터 시작하는 것이 맞는 동작이다(아직 아무도 기다리지 않았다).
 */
export async function consecutiveWakes(
  db: Pool | PoolClient, threadRootId: string, accountId: string,
): Promise<number> {
  const res = await db.query(
    `select count(*)::int as n from message
      where thread_root_id = $1 and author_id = $2 and kind = 'wake'
        and seq > coalesce((
          select max(seq) from message where thread_root_id = $1 and author_id <> $2
        ), 0)`,
    [threadRootId, accountId],
  );
  return res.rows[0].n as number;
}

export interface ScheduleWakeInput {
  accountId: string;
  channelId: string;
  /** 앵커. 러너의 세션 키가 이 값이라 반드시 스레드가 있어야 한다(040 주석). */
  threadRootId: string;
  notBeforeSec: number;
  /** 사람이 읽는 사유. 그대로 wake 메시지의 본문이 된다. */
  reason: string;
  /**
   * 깨어난 턴이 **결과를 보고하기로 약속한 다른 스레드**(2026-10-06, 선택).
   *
   * 왜 필요한가: 스레드마다 세션이 따로라, 깨어난 턴은 자기 앵커 스레드에만 답한다. 다른
   * 스레드(#task 같은 보고처)에서 "13:21 에 확인한다" 고 약속하고 작업 스레드에 깨움을 걸면,
   * 깨어난 턴은 그 약속을 모른다 — 받은 단서가 사유 한 줄뿐이다. 실측(10-06 task_manager):
   * 다른 스레드에도 글을 쓴 깨움 턴 28건 중 깨어나서 그 스레드에 다시 쓴 것은 2건이었다.
   *
   * 앵커와 같은 스레드면 뜻이 없어 싣지 않는다(호출자가 거른다).
   */
  reportTo?: { channelId: string; threadRootId: string };
  /**
   * 이 예약이 이어지는 감시의 한 고리인가(2026-10-31, 선택). true 면 깨움 메시지 meta 에 싣고, 러너는
   * 깨어난 턴이 다음 예약도 끝 보고(message.report)도 없이 끝나면 실패 줄을 남긴다. true 일 때만 싣는다.
   */
  watch?: boolean;
  /** 이 예약이 기다리는 위임(`meta.wake.delegationId`). 내가 넘겼고 결말이 안 난 것만 받는다. */
  delegationId?: string;
  /** 이 예약을 건 턴의 원인(오퍼레이터를 거친 요청만) — 대기 줄의 `cause_message_id`(118)로 남아 머지 사슬을 잇는다. */
  chainCause?: string | null;
  /** 대기 줄을 건 턴의 id(`PostMessageInput.turnId`). */
  turnId?: string | null;
}

const ORIGIN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 감시 사슬을 **시작한 지시**(`meta.wake.origin`, 2026-11-02). 감시 예약(`watch: true`)일 때만 부른다.
 *
 * 왜 필요한가: 깨어난 턴은 새 세션이라(러너 `freshWake`) 사유 한 줄과 그 사이 남의 새 말만 받는다. 실측: "3회 확인하고
 * 3회차에 「감시 끝」을 쓰고 다시 걸지 마라" 는 감시의 3회차 턴이 그 지시를 몰랐고, 자기가 쓴 사유도 애매해서 아무것도
 * 하지 않고 멈췄다. 그래서 첫 지시의 **id 만** 깨움 meta 에 싣고(본문은 싣지 않는다 — 러너가 자기 권한으로 읽는다),
 * 다음 고리는 앞 고리의 값을 물려받아 2·3회차도 언제나 **첫** 지시를 가리킨다.
 *
 * 규칙:
 * - 원인은 이 예약을 건 턴의 `chainCause`(오퍼레이터를 거친 요청의 `CAUSE_HEADER`)다 — 러너 턴은 그 턴을 띄운 inbox 글
 *   (멘션·깨움 메시지)을 싣는다. PAT 로 붙은 클라이언트는 null 이라 싣지 않는다. 그 글이 **실제로 이 계정을 깨웠어야**
 *   한다(`verifiedCauseLink`, 머지 사슬과 같은 판정) — 헤더에 아무 글 id 나 넣어 가리키게 두지 않는다.
 * - 원인이 감시 깨움(`watch: true` + `origin`)이면 그 origin 을 물려받고, 아니면 원인 글 자신이 origin 이다.
 * - 최종 후보는 **이 깨움과 같은 채널·같은 스레드**(머리 또는 답)이고 지워지지 않았고 대기 줄·시스템 줄·진행 설명이
 *   아니어야 한다. 하나라도 어긋나면 싣지 않는다(null) — 다른 스레드의 글을 이 스레드의 감시에 끌어오지 않는다.
 */
export async function watchOriginFor(
  pool: Pick<Pool, 'query'>,
  input: { accountId: string; channelId: string; threadRootId: string; chainCause?: string | null },
): Promise<string | null> {
  if (!input.chainCause) return null;
  const cause = await verifiedCauseLink(pool, input.accountId, input.chainCause);
  if (!cause) return null;
  const row = (await pool.query(
    `select kind, meta->'wake'->>'watch' = 'true' as watch, meta->'wake'->>'origin' as origin from message where id = $1`,
    [cause],
  )).rows[0] as { kind: string; watch: boolean | null; origin: string | null } | undefined;
  if (!row) return null;
  const inherited = row.kind === 'wake' && row.watch === true && typeof row.origin === 'string' && ORIGIN_ID_RE.test(row.origin)
    ? row.origin : null;
  const candidate = inherited ?? cause;
  const ok = await pool.query(
    `select 1 from message
      where id = $1 and channel_id = $2 and (id = $3 or thread_root_id = $3)
        and deleted_at is null and kind not in ('wake', 'system', 'progress')`,
    [candidate, input.channelId, input.threadRootId],
  );
  return ok.rowCount ? candidate : null;
}

/** 새 감시 예약이 대체했거나 끝 보고가 접은 감시 예약 — 건 턴이 사유를 합쳐 다시 걸 수 있게 돌려준다. */
export interface ClosedWatchWake {
  id: string;
  reason: string | null;
  wakeAt: string;
  /** 이 예약의 대기 줄. 호출자가 커밋 뒤에 `announceWakeRows` 로 알린다. */
  messageId: string;
  /** 이 예약이 걸려 있던 스레드 — 보고처가 같아 다른 스레드의 예약이 접힐 수 있어 어디 것인지 말한다. */
  threadRootId: string;
  reportTo?: WakeReportTo;
}

export type ScheduleWakeResult =
  | { wake: { id: string; wakeAt: string; messageId: string }; message: MessageRow; replaced: ClosedWatchWake[]; refusal?: undefined }
  | { refusal: WakeRefusal; wake?: undefined; message?: undefined; replaced?: undefined };

/**
 * 깨움을 건다. **메시지를 먼저 만들고**(그래서 즉시 보인다) 그 메시지를 가리키는 시계를 넣는다.
 *
 * 두 번의 커밋 사이에 프로세스가 죽으면 "보이는 대기 줄은 있는데 깨울 시계가 없는" 상태가
 * 남는다. 그 창을 없애려면 `postMessage` 가 외부 트랜잭션을 받아야 하는데(지금은 자기
 * 커넥션에서 커밋한다), 그 시그니처를 넓히는 값은 이 창을 없애는 것보다 크다 —
 * 예약 발송 sweep(028)이 이미 같은 순서(post → update)를 쓰고 같은 이유로 감수한다.
 * 대신 실패는 **호출자에게 던진다**: 에이전트가 "예약됐다"고 믿고 턴을 끝내는 것이
 * 이 결함의 실제 피해이므로, 조용히 성공으로 만들지 않는다.
 */
export async function scheduleWake(pool: Pool, input: ScheduleWakeInput): Promise<ScheduleWakeResult> {
  // 대체될 감시의 보고처를 물려받는다(`replaceWatchWakes`) — 새 예약이 보고처를 말하지 않았다고 다른 스레드에 한 약속이
  // 사라지면 안 된다. 메시지 meta 에 실어야 해서 게시 전에 읽는다. 동시에 걸린 드문 경합은 `replaced` 가 알려 준다.
  const reportTo = input.reportTo ?? (input.watch === true ? await openWatchReportTo(pool, input) : undefined);
  if (input.delegationId) {
    const held = await pool.query(
      `select 1 from team_delegation where id = $1 and lead_account_id = $2 and notified_at is null`,
      [input.delegationId, input.accountId],
    );
    if (!held.rowCount) {
      return { refusal: { code: 'bad_delegation', message: '내가 넘겼고 아직 결말이 안 난 위임만 적을 수 있다 — 결말이 났으면 예약이 필요 없다' } };
    }
  }
  const already = await consecutiveWakes(pool, input.threadRootId, input.accountId);
  if (already >= MAX_CONSECUTIVE_WAKES) {
    return {
      refusal: {
        code: 'wake_limit',
        message: `이 스레드에서 사람의 새 발화 없이 이미 ${already}번 기다렸다 — 사람에게 알려라(message.fail)`,
      },
    };
  }

  const wakeAt = new Date(Date.now() + input.notBeforeSec * 1_000);
  // 감시면 사슬을 시작한 지시의 id(`watchOriginFor`, 2026-11-02). 감시가 아니면 보지도 않는다.
  const origin = input.watch === true ? await watchOriginFor(pool, input) : null;
  const posted = await postMessage(pool, {
    channelId: input.channelId,
    authorId: input.accountId,
    body: input.reason,
    threadRootId: input.threadRootId,
    kind: 'wake',
    chainCause: input.chainCause ?? null,
    turnId: input.turnId ?? null,
    // 시각은 **사실로** 싣는다. 서버가 "15:20 에 다시 봅니다" 로 구워 버리면 그 문자열은
    // 서버의 시간대에 고정되고, 다른 시간대에서 읽는 사람에게 거짓이 된다.
    meta: {
      kind: 'wake',
      wake: {
        wakeAt: wakeAt.toISOString(), reason: input.reason,
        // 보고처는 **깨움 메시지에** 싣는다 — 러너는 inbox 항목이 가리키는 이 메시지에서 사유와 함께
        // 그대로 되찾는다(앵커를 040 에 두 번 저장하지 않은 것과 같은 규칙). 새 컬럼이 필요 없다.
        ...(reportTo ? { reportTo } : {}),
        ...(input.watch === true ? { watch: true } : {}),
        ...(origin ? { origin } : {}),
        ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      },
    },
  });
  if (posted.failure === 'bad_thread') {
    // 원인을 그대로 전한다 — 예전에는 상한(wake_limit)으로 바꿔 말해서 에이전트가 "너무 많이
    // 기다렸다"로 읽고 사람에게 넘겼다. 실제로는 고칠 수 있는 인자 문제다.
    return { refusal: { code: 'bad_thread', message: BAD_THREAD_MESSAGE } };
  }
  if (posted.failure) {
    // 깨움은 첨부를 받지 않으므로 여기 오는 것은 게시 자체가 거절된 경우다.
    return { refusal: { code: 'wake_limit', message: 'wake 메시지를 게시할 수 없다' } };
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    // 같은 계정의 감시 예약을 앵커 스레드와 보고처 둘 다로 줄 세운다 — 둘이 동시에 걸어도 서로의 행을 보고 하나만 남는다.
    // 정렬해서 잡는다: 한쪽은 A→B, 다른 쪽은 B→A 로 거는 두 트랜잭션이 서로를 기다리지 않게.
    const target = (reportTo?.threadRootId ?? input.threadRootId).toLowerCase();
    if (input.watch === true) {
      for (const thread of [...new Set([input.threadRootId.toLowerCase(), target])].sort()) {
        await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent_wake:watch:${input.accountId}:${thread}`]);
      }
    }
    const res = await client.query(
      // 위임 키(133, W1): 깨움 글이 지금 임대에서 물려받은 위임을 깨움 행에도 둔다 — 깨어난 턴의 임대가 이것을 잇는다.
      `insert into agent_wake (account_id, channel_id, message_id, wake_at, mandate_id)
       values ($1, $2, $3, $4, (select mandate_id from message where id = $3)) returning id`,
      [input.accountId, input.channelId, posted.message.id, wakeAt.toISOString()],
    );
    const id = res.rows[0].id as string;
    const replaced = input.watch === true ? await replaceWatchWakes(client, { ...input, target }, id) : [];
    await client.query('commit');
    await announceWakeRows(pool, replaced.map((w) => w.messageId));
    return {
      wake: { id, wakeAt: wakeAt.toISOString(), messageId: posted.message.id },
      message: posted.message,
      replaced,
    };
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** 이 계정의 열린 예약. `$2` 계정. */
const OPEN_WAKE_BASE_SQL = `m.id = w.message_id
        and w.account_id = $2
        and w.fired_at is null
        and w.canceled_at is null`;
/** 그중 감시 예약. */
const OPEN_WATCH_WAKE_BASE_SQL = `${OPEN_WAKE_BASE_SQL}
        and m.meta->'wake'->>'watch' = 'true'`;
/** 그중 이 스레드에 걸린 것. `$1` 스레드 머리. */
const OPEN_WATCH_WAKE_SQL = `${OPEN_WATCH_WAKE_BASE_SQL}
        and coalesce(m.thread_root_id, m.id) = $1`;
/**
 * 그중 **같은 일을 보는** 것(2026-11-06): 스레드가 `$1` 이거나, 소식을 전할 곳이 `$3` 인 것.
 * 소식을 전할 곳은 `reportTo` 의 스레드이고, 없으면 걸린 스레드 자신이다. `reportTo` 는 meta 의 글자이므로 소문자로 맞춰 견준다.
 */
const SAME_WORK_SQL = `(coalesce(m.thread_root_id, m.id) = $1
          or coalesce(lower(m.meta->'wake'->'reportTo'->>'threadRootId'), coalesce(m.thread_root_id, m.id)::text) = lower($3::text))`;
const SAME_WORK_WATCH_WAKE_SQL = `${OPEN_WATCH_WAKE_BASE_SQL}
        and ${SAME_WORK_SQL}`;
const CLOSED_WATCH_COLUMNS = `w.id, w.wake_at, w.message_id, m.body, m.deleted_at is not null as deleted, m.meta->'wake'->'reportTo' as report_to,
        coalesce(m.thread_root_id, m.id) as thread_root_id`;

interface ClosedWatchRow { id: string; wake_at: Date; message_id: string; body: string | null; deleted: boolean; report_to: unknown; thread_root_id: string }

function closedWatchView(row: ClosedWatchRow): ClosedWatchWake {
  const report = asReportTo(row.report_to);
  return {
    id: row.id,
    reason: row.deleted ? null : row.body,
    wakeAt: new Date(row.wake_at).toISOString(),
    messageId: row.message_id,
    threadRootId: row.thread_root_id,
    ...(report ? { reportTo: report } : {}),
  };
}

/**
 * 대기 줄 meta 에 **닫힌 시각**을 적는다(2026-11-06). 깨어났는지·접혔는지의 정본은 `agent_wake` 인데 메시지만 읽는 화면에는 닿지 않아,
 * 지난 예약이 영영 대기 중으로 보였다. 적은 뒤 커밋이 끝나면 호출자가 `announceWakeRows` 를 부른다.
 *
 * 처음 값을 지킨다 — 줄이 닫히는 일은 한 번뿐이고 뒤늦은 호출이 시각을 고치면 안 된다.
 */
async function stampWakeClosed(
  db: Pick<Pool, 'query'>, messageIds: readonly string[], field: 'firedAt' | 'canceledAt',
): Promise<void> {
  if (!messageIds.length) return;
  await db.query(
    `update message set meta = jsonb_set(meta, array['wake', $3::text], to_jsonb($2::text))
      where id = any($1::uuid[]) and jsonb_typeof(meta->'wake') = 'object' and meta->'wake'->>($3::text) is null`,
    [messageIds, new Date().toISOString(), field],
  );
}

/** 닫힌 대기 줄을 `message.updated` 로 알린다. 커밋 뒤에 부른다. 신호가 실패해도 닫힘은 이미 끝났다 — 다음 읽기가 맞춘다. */
export async function announceWakeRows(pool: Pool, messageIds: readonly string[]): Promise<void> {
  for (const id of new Set(messageIds)) {
    try {
      const message = await getMessageById(pool, id);
      if (message) emitEvent({ type: 'message.updated', message, audience: await audienceFor(pool, message.channelId) });
    } catch (err) {
      console.error('[wake] 닫힌 대기 줄을 알리지 못했다:', err);
    }
  }
}

/** 이 스레드에 열린 내 감시 예약 중 가장 늦게 걸린 것의 보고처. */
async function openWatchReportTo(
  pool: Pick<Pool, 'query'>, input: { accountId: string; threadRootId: string },
): Promise<WakeReportTo | undefined> {
  const res = await pool.query<{ report_to: unknown }>(
    `select m.meta->'wake'->'reportTo' as report_to from agent_wake w, message m
      where ${OPEN_WATCH_WAKE_SQL} and m.meta->'wake' ? 'reportTo'
      order by m.seq desc limit 1`,
    [input.threadRootId, input.accountId],
  );
  return asReportTo(res.rows[0]?.report_to) ?? undefined;
}

/**
 * **같은 일을 보는 감시 예약은 에이전트마다 하나다**(2026-11-05, 보고처 기준 2026-11-06). 새로 걸면 앞 것을 접는다.
 *
 * 왜 필요한가: 깨어나는 턴은 새 세션이라 앞 턴이 건 예약을 모른다. 한 스레드에서 턴 다섯이 같은 일에 각자 감시를 걸었고,
 * 끝 보고가 나간 뒤에도 남은 예약이 차례로 깨어나 같은 보고를 되풀이했다. 그중 하나는 맡긴 글을 다시 받아 같은 답을 또 올렸다.
 *
 * 거절이 아니라 **대체**인 이유: 새 예약이 앞 예약보다 지금 사정을 더 잘 안다 — 실측에서 뒤에 걸린 예약은 새 관심사를 얹거나
 * 다음 단계를 가리켰다. 거절하면 그 새 관심사가 걸 자리를 잃는다. 대신 앞 사유가 사라지므로 결과(`replaced`)로 돌려준다.
 * 감시가 아닌 예약(한 번 깨우기)은 건드리지 않는다 — 시각을 지정한 별개의 약속이다.
 *
 * **스레드만 봐서는 모자랐다**(2026-11-06): 작업 스레드와 요청 스레드에 걸린 감시가 같은 요청 스레드로 보고하면서 같은 보고가 두 번 나갔다.
 * 그래서 소식을 전할 곳이 같아도 같은 일로 본다. 같은 스레드에 걸린 것은 보고처가 달라도 그대로 대체한다(한 스레드에 하나라는 앞 약속).
 */
async function replaceWatchWakes(
  client: PoolClient, input: { accountId: string; threadRootId: string; target: string }, keepId: string,
): Promise<ClosedWatchWake[]> {
  const res = await client.query<ClosedWatchRow>(
    `update agent_wake w set canceled_at = now()
       from message m
      where ${SAME_WORK_WATCH_WAKE_SQL} and w.id <> $4
      returning ${CLOSED_WATCH_COLUMNS}`,
    [input.threadRootId, input.accountId, input.target, keepId],
  );
  await stampWakeClosed(client, res.rows.map((r) => r.message_id), 'canceledAt');
  return res.rows.map(closedWatchView);
}

/**
 * **끝 보고가 남은 예약을 접는다**(2026-11-05, 보고처 기준·종류 무관 2026-11-06). 그 에이전트가 그 스레드에 `message.report` 를 올리면 그 스레드에
 * 걸렸거나 그 스레드로 보고하는 예약을 닫는다 — 끝났다고 말한 뒤에 다시 깨어나 같은 보고를 하거나, 할 말이 없어 「보고 없이 끝났다」 실패 줄을 남기는 것을 막는다.
 * 감시만 접으면 한 번 깨우기가 남는다: 병렬 턴이 이미 끝낸 일에 한 번 깨우기가 깨어나 글 없이 끝나자 보고처에 헛 실패 줄이 섰다(11-05 실측).
 *
 * **같은 턴이 건 예약은 남긴다**: 한 단계를 보고하고 다음 확인을 거는 턴은 흔하고, 호출 순서가 wake → report 일 수도 있다.
 * 같은 보고처에 다른 일을 걸어 둔 예약도 함께 접힌다 — 접은 사유를 결과로 돌려주니 그 턴이 다시 걸 수 있다.
 */
export async function foldWakesOnReport(
  pool: Pick<Pool, 'query'>,
  args: { accountId: string; threadRootId: string; turnId?: string | null },
): Promise<ClosedWatchWake[]> {
  const res = await pool.query<ClosedWatchRow>(
    `update agent_wake w set canceled_at = now()
       from message m
      where ${OPEN_WAKE_BASE_SQL}
        and ${SAME_WORK_SQL}
        and ($4::text is null or m.meta->>'turnId' is distinct from $4::text)
      returning ${CLOSED_WATCH_COLUMNS}`,
    [args.threadRootId, args.accountId, args.threadRootId, args.turnId ?? null],
  );
  await stampWakeClosed(pool, res.rows.map((r) => r.message_id), 'canceledAt');
  return res.rows.map(closedWatchView);
}

/**
 * **위임의 결말이 그 일을 기다리던 예약을 접는다**(2026-11-06). 넘긴 쪽은 결말로 깨어나므로 예약으로 다시 볼 이유가 사라졌다 —
 * 두면 끝난 일을 또 확인해 같은 보고를 되풀이한다.
 *
 * 접는 것: 넘긴 쪽의 열린 예약 중 ① 이 위임을 적은 것, ② 아무 위임도 적지 않았고 소식을 전할 곳이 이 위임의 스레드인 것(`reportTo`, 없으면 걸린 스레드).
 * 다른 위임을 적은 예약은 그 일이 아직 안 끝났을 수 있어 남긴다. 감시 여부는 묻지 않는다 — 한 번 깨우기도 끝난 일을 다시 본다.
 *
 * 접은 까닭으로 위임 글을 남긴다(`canceled_by_message_id`) — 결말로 깨어난 턴의 프롬프트가 그것으로 「접혔다, 필요하면 다시 걸어라」를 말한다.
 */
export async function foldWakesForDelegation(
  client: PoolClient,
  args: {
    delegationId: string; leadAccountId: string; threadRootId: string; messageId: string;
    /** 접은 예약의 보고처·대기 줄. 신호는 커밋 뒤에 호출자가 낸다(`preemptWakesForThread` 와 같은 규약). */
    reportTouched?: WakeReportTo[];
    wakeRowsTouched?: string[];
  },
): Promise<void> {
  const res = await client.query<{ report_to: unknown; message_id: string }>(
    `update agent_wake w set canceled_at = now(), canceled_by_message_id = $4
       from message m
      where m.id = w.message_id
        and w.account_id = $2
        and w.fired_at is null
        and w.canceled_at is null
        and (m.meta->'wake'->>'delegationId' = $1::text
          or (not (m.meta->'wake' ? 'delegationId')
              and coalesce(lower(m.meta->'wake'->'reportTo'->>'threadRootId'), coalesce(m.thread_root_id, m.id)::text) = $3::text))
      returning m.meta->'wake'->'reportTo' as report_to, m.id as message_id`,
    [args.delegationId, args.leadAccountId, args.threadRootId, args.messageId],
  );
  await stampWakeClosed(client, res.rows.map((r) => r.message_id), 'canceledAt');
  for (const row of res.rows) {
    const report = asReportTo(row.report_to);
    if (report) args.reportTouched?.push(report);
    args.wakeRowsTouched?.push(row.message_id);
  }
}

/**
 * 사람이 그 스레드에서 말하면 **기다림은 그 자리에서 끝난다**(2026-09-10).
 *
 * 왜 필요한가: 예약은 "이 시각까지 볼 것이 없다"는 에이전트의 추측이고, 사람의 새 발화는
 * 그 추측을 **무효로 만드는 사실**이다. 실측(2026-09-10 09:01) — 스레드에 `06:01 PM 에
 * 다시 봅니다` 가 서 있는 동안 사람이 "CI 실패했어 수정해" 를 썼다. 서버는 그 발화로
 * 아무것도 하지 않았고, 사람이 본 것은 아무 일도 일어나지 않는 대기 줄이었다.
 * 사용자의 말이 그것이다: *"내가 이야기 하면 바로 일어나서 작업해야하는데 그냥 계속
 * 기다리고 있어"*.
 *
 * **두 갈래인 이유.** 사람의 발화가 이미 그 에이전트를 불렀으면(`notified`) 깨움을 또
 * 넣을 자리가 없다 — 넣으면 inbox 항목이 둘이 되고, 스케줄러는 한 스레드에 턴을 하나만
 * 띄우므로(mentionScheduler) 남은 하나가 **끝난 일에 대한 두 번째 턴**으로 뒤늦게 열린다.
 * 그래서 부름이 있으면 예약을 **접고**(`canceled_at`), 없으면 **지금 깨운다**(`fired_at`).
 * 부름 없이 말한 경우가 이 함수의 값어치다: 사람은 `@handle` 을 다시 적지 않아도 되고,
 * 그 스레드에서 기다리던 에이전트만 깨어난다.
 *
 * **사람의 발화만 이 일을 한다.** 에이전트의 발화까지 예약을 깨우게 하면 서로가 서로를
 * 깨우는 고리가 생긴다(멘션 폭주와 같은 결이다) — 게다가 동료가 한 줄 적었다는 것은
 * 기다리던 조건이 바뀌었다는 뜻이 아니다.
 *
 * 트랜잭션은 **호출자의 것**을 받는다: 발화와 예약 만기가 한 커밋 안에 들어가야 "말은
 * 남았는데 예약은 그대로"가 남지 않는다. 대신 `inbox.updated` 이벤트는 커밋 뒤에 쳐야
 * 하므로(sweep 이 같은 순서를 지킨다) 깨운 계정을 **돌려주고 발화는 호출자가 한다**.
 */
export async function preemptWakesForThread(
  client: PoolClient,
  args: {
    threadRootId: string; authorId: string; notified: Set<string>;
    /** 이 발화 자신. 부름으로 접은 깨움에 남긴다(107) — 그 부름의 턴이 무엇이 접혔는지 안다. */
    messageId: string;
    /**
     * 깨우거나 접은 깨움의 **보고처**를 여기 모은다(2026-10-06). 신호(`thread.reportWakes.changed`)는 커밋 뒤에
     * 쳐야 하므로 호출자가 `announceReportWakes` 로 낸다 — `inbox.updated` 를 호출자가 내는 것과 같은 이유다.
     */
    reportTouched?: WakeReportTo[];
    /** 깨우거나 접은 대기 줄. 호출자가 커밋 뒤에 `announceWakeRows` 로 알린다. */
    wakeRowsTouched?: string[];
  },
): Promise<string[]> {
  // 판정은 계정 종류 하나다. 라우트가 아니라 여기서 보는 이유: 이 파일이 깨움 정책의
  // 자리이고, 표면이 늘 때(REST·MCP·투영) 각자 판정하면 갈라진다(모듈 주석).
  const author = await client.query<{ kind: string }>(
    `select kind from account where id = $1`, [args.authorId],
  );
  if (author.rows[0]?.kind !== 'human') return [];

  // 앵커는 시계 테이블에 없다 — 040 의 규칙(앵커를 두 번 저장하지 않는다) 그대로
  // 깨움 메시지에서 되찾는다. `for update` 는 sweep 과의 경합용이다: 그쪽이 먼저
  // 잡았으면 잠금을 기다린 뒤 술어가 다시 평가돼 이 행은 빠진다(이미 fired 다).
  const due = await client.query<{ id: string; account_id: string; message_id: string; report_to: unknown }>(
    `select w.id, w.account_id, w.message_id, m.meta->'wake'->'reportTo' as report_to from agent_wake w
       join message m on m.id = w.message_id
      where coalesce(m.thread_root_id, m.id) = $1
        and w.account_id <> $2
        and w.fired_at is null
        and w.canceled_at is null
      order by w.wake_at
      for update of w`,
    [args.threadRootId, args.authorId],
  );

  const woke: string[] = [];
  for (const row of due.rows) {
    const report = asReportTo(row.report_to);
    if (report) args.reportTouched?.push(report);
    args.wakeRowsTouched?.push(row.message_id);
    if (args.notified.has(row.account_id)) {
      await client.query(
        `update agent_wake set canceled_at = now(), canceled_by_message_id = $2 where id = $1`,
        [row.id, args.messageId],
      );
      await stampWakeClosed(client, [row.message_id], 'canceledAt');
      continue;
    }
    // sweep 과 **같은 생 insert** 다(`insertInbox` 가 아니다) — 자기가 자기를 부르는
    // 항목이라 남의 화면(숨김 되돌리기)을 건드릴 일이 없다. 그 이유는 sweep 주석에 있다.
    await client.query(
      `insert into inbox (account_id, message_id, reason)
       select w.account_id, w.message_id, 'wake' from agent_wake w where w.id = $1`,
      [row.id],
    );
    await client.query(`update agent_wake set fired_at = now() where id = $1`, [row.id]);
    await stampWakeClosed(client, [row.message_id], 'firedAt');
    woke.push(row.account_id);
  }
  return woke;
}

/**
 * **사람이 멈춘 턴의 예약을 접는다**(2026-10-29, 턴 중단). 중단 경로(`turnCancel.ts`)가 같은 트랜잭션으로 부른다.
 *
 * 왜 필요한가: 중단은 위임 의무만 닫고 예약은 그대로 뒀다. 멈춘 턴이 끊기기 직전에 건 예약은 시각이 되면 그 스레드에서
 * **같은 일을 다시 연다** — 사람이 멈춘 일이 몇 분 뒤 되살아나는 셈이다. 사람 글이 예약을 접는 길(`preemptWakesForThread`)은
 * 이 자리를 덮지 못한다: 멈춤 글이 예약보다 **먼저** 쓰였으면 그 글이 접을 예약이 아직 없었다.
 *
 * 접는 범위는 **그 에이전트의 그 스레드** 하나다 — 다른 스레드에 건 예약은 그 일의 것이라 건드리지 않는다.
 * 접은 글이 없으므로 `canceled_by_message_id` 는 비운다(107 의 「무엇이 접었나」는 글이 접은 경우의 기록이다).
 */
export async function cancelWakesForTurn(
  client: PoolClient,
  args: {
    threadRootId: string; accountId: string;
    /** 접은 예약의 보고처. 신호는 커밋 뒤에 호출자가 낸다(`preemptWakesForThread` 와 같은 규약). */
    reportTouched?: WakeReportTo[];
    /** 접은 대기 줄. 호출자가 커밋 뒤에 `announceWakeRows` 로 알린다. */
    wakeRowsTouched?: string[];
  },
): Promise<number> {
  const res = await client.query<{ report_to: unknown; message_id: string }>(
    `update agent_wake w set canceled_at = now()
       from message m
      where m.id = w.message_id
        and coalesce(m.thread_root_id, m.id) = $1
        and w.account_id = $2
        and w.fired_at is null
        and w.canceled_at is null
      returning m.meta->'wake'->'reportTo' as report_to, m.id as message_id`,
    [args.threadRootId, args.accountId],
  );
  await stampWakeClosed(client, res.rows.map((r) => r.message_id), 'canceledAt');
  for (const row of res.rows) {
    const report = asReportTo(row.report_to);
    if (report) args.reportTouched?.push(report);
    args.wakeRowsTouched?.push(row.message_id);
  }
  return res.rowCount ?? 0;
}

function asReportTo(v: unknown): WakeReportTo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o.channelId === 'string' && typeof o.threadRootId === 'string'
    ? { channelId: o.channelId, threadRootId: o.threadRootId } : null;
}

/**
 * 보고처 스레드들에 "대기가 바뀌었다" 신호를 보낸다(2026-10-06). **값을 싣지 않는다** — 이벤트는 그 채널 청중
 * 전원에게 가는데, 사유·앵커는 앵커 채널을 볼 수 있는 사람에게만 보여야 한다(#1208 security n1). 화면은 이것을
 * 받고 `listReportWakes` 를 다시 불러 자기 권한으로 거른 값을 받는다. 같은 스레드는 한 번만 보낸다.
 *
 * 스레드 상태 감시(`startThreadStatusWatcher`)도 이 신호로 보고처의 머리 ⏳ 를 다시 판정한다.
 */
export async function announceReportWakes(pool: Pool, targets: readonly WakeReportTo[]): Promise<void> {
  const seen = new Set<string>();
  for (const t of targets) {
    const key = `${t.channelId}:${t.threadRootId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    emitEvent({
      type: 'thread.reportWakes.changed', channelId: t.channelId, rootId: t.threadRootId,
      audience: await audienceFor(pool, t.channelId),
    });
  }
}

export type ReportWakesResult =
  | { wakes: ReportWakeView[]; refusal?: undefined }
  | { refusal: 'not_found' | 'forbidden'; wakes?: undefined };

/**
 * 이 스레드를 **보고처로 둔** 아직 안 뜬 깨움(2026-10-06, `GET /threads/:rootId/report-wakes`).
 *
 * 판정 순서가 계약이다(task_manager 10-06): ① 보고처 스레드가 있고 스레드 머리인가(아니면 not_found)
 * ② 보는 사람이 **보고처 채널**을 볼 수 있는가(아니면 forbidden — 줄 수 자체가 그 스레드의 사실이다)
 * ③ 줄마다 **앵커 채널**을 볼 수 있을 때만 사유·앵커를 싣는다(#1208 security n1·n2).
 *
 * `agent_wake` 의 열린 행에서 출발한다(`agent_wake_due` 부분 인덱스) — 열린 깨움은 언제나 적어서, message 의
 * meta 에 식 인덱스를 따로 두지 않는다. 보고처 채널까지 맞아야 한다: meta 는 서버만 쓰지만 판정을 두 값으로 묶는다.
 */
export async function listReportWakes(pool: Pool, rootId: string, viewerId: string): Promise<ReportWakesResult> {
  const head = await pool.query<{ channel_id: string; visible: boolean }>(
    `select m.channel_id, ${channelVisibleSql('c', '$2')} as visible
       from message m join channel c on c.id = m.channel_id
      where m.id = $1 and m.thread_root_id is null and m.deleted_at is null`,
    [rootId, viewerId],
  );
  const h = head.rows[0];
  if (!h) return { refusal: 'not_found' };
  if (!h.visible) return { refusal: 'forbidden' };

  const res = await pool.query<{
    id: string; account_id: string; wake_at: Date; body: string | null; deleted: boolean;
    anchor_channel: string; anchor_root: string; anchor_visible: boolean;
  }>(
    `select w.id, w.account_id, w.wake_at, wm.body, wm.deleted_at is not null as deleted,
            wm.channel_id as anchor_channel, coalesce(wm.thread_root_id, wm.id) as anchor_root,
            ${channelVisibleSql('ac', '$3')} as anchor_visible
       from agent_wake w
       join message wm on wm.id = w.message_id
       join channel ac on ac.id = wm.channel_id
      where w.fired_at is null and w.canceled_at is null
        and wm.meta->'wake'->'reportTo'->>'threadRootId' = $1::text
        and wm.meta->'wake'->'reportTo'->>'channelId' = $2::text
      order by w.wake_at
      limit 50`,
    [rootId, h.channel_id, viewerId],
  );
  return {
    wakes: res.rows.map((r) => ({
      id: r.id,
      agentAccountId: r.account_id,
      wakeAt: new Date(r.wake_at).toISOString(),
      reason: r.anchor_visible && !r.deleted ? r.body : null,
      anchor: r.anchor_visible ? { channelId: r.anchor_channel, threadRootId: r.anchor_root } : null,
    })),
  };
}

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

export const WAKE_SWEEP_INTERVAL_MS = 15_000;
export const WAKE_SWEEP_BATCH_SIZE = 20;

interface DueWake {
  id: string;
  account_id: string;
  message_id: string;
}

/**
 * 깨움 sweeper. `scheduledMessages.ts::createScheduledMessageSweeper` 와 같은 모양이다 —
 * 한 건씩 자기 트랜잭션, `for update skip locked`, 프로세스 안 겹침은 깃발로 막는다.
 * 그 파일의 주석이 왜 그래야 하는지를 상세히 말한다(배치 롤백이 재발송을 만든다 등).
 *
 * 다른 점 하나: 여기서는 메시지를 만들지 않는다. 깨움 메시지는 예약할 때 이미 게시됐고,
 * 시각이 되어 하는 일은 **그 메시지로 자기 inbox 항목을 만드는 것**뿐이다. 그래서 사람이
 * 보는 스레드에는 새 줄이 생기지 않는다 — 깨어난 사실은 그 턴의 결과가 말한다.
 */
export function createAgentWakeSweeper(pool: Pool): {
  startSweep(app: SweepHost): void;
  sweep(): Promise<void>;
} {
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function fireOneDue(skip: string[]): Promise<'done' | 'none'> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('begin');
      const due = await client.query<DueWake>(
        `select id, account_id, message_id from agent_wake
          where wake_at <= now()
            and fired_at is null
            and canceled_at is null
            and not (id = any($1::uuid[]))
          order by wake_at
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

      // `insertInbox`(messages.ts) 를 쓰지 않는 이유: 그 함수는 숨김 되돌리기까지 함께
      // 하는 **사람의 부름** 관문이다. 깨움은 자기 자신을 부르는 것이라 채널을 사이드바에
      // 다시 띄울 일이 없고, 그 함수를 재사용하면 자기 깨움이 남의 화면을 바꾼다.
      await client.query(
        `insert into inbox (account_id, message_id, reason) values ($1, $2, 'wake')`,
        [row.account_id, row.message_id],
      );
      await client.query(`update agent_wake set fired_at = now() where id = $1`, [row.id]);
      await stampWakeClosed(client, [row.message_id], 'firedAt');
      await client.query('commit');
      await announceWakeRows(pool, [row.message_id]);

      // 보고처가 있었으면 그 스레드의 대기 줄·머리 ⏳ 가 풀린다 — 신호만 보낸다(커밋 뒤).
      const meta = await pool.query<{ report_to: unknown }>(
        `select meta->'wake'->'reportTo' as report_to from message where id = $1`, [row.message_id],
      ).catch(() => null);
      const report = asReportTo(meta?.rows[0]?.report_to);
      if (report) await announceReportWakes(pool, [report]).catch(() => undefined);

      // 러너의 `inbox.poll` 은 이 이벤트로 깨어난다. 없어도 다음 폴(최대 25초)에 잡히지만,
      // 그만큼 기다림이 늦어질 이유가 없다.
      emitEvent({ type: 'inbox.updated', accountId: row.account_id });
      return 'done';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      // 한 건의 실패로 나머지를 멈추지 않는다. 행은 대기로 남아 다음 sweep 이 다시 시도한다 —
      // 깨움을 영구 실패로 굳히면 사람이 기다리는 후속이 조용히 사라진다.
      console.error('agent wake sweep error:', err);
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
      for (let i = 0; i < WAKE_SWEEP_BATCH_SIZE; i++) {
        if ((await fireOneDue(skip)) === 'none') break;
      }
    } catch (err) {
      // DB 에 닿지 못한 것(`pool.connect` 는 한 건 처리의 try 밖이다)이 여기로 온다. 던지면
      // `void sweep()` 이 처리 안 된 거절이 되어 프로세스가 죽는다(2026-10-12 PG OOM 때 실제로 죽었다).
      // 로그만 남기고 다음 주기에 다시 한다 — 행은 그대로 대기다.
      console.error('agent wake sweep error:', err);
    } finally {
      running = false;
    }
  };

  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, WAKE_SWEEP_INTERVAL_MS);
      app.addHook('onClose', () => {
        if (sweepInterval) clearInterval(sweepInterval);
        sweepInterval = null;
      });
    },
    sweep,
  };
}
