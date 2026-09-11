import type { Pool, PoolClient } from 'pg';
import type { MessageRow } from '@harkroom/shared';
import { postMessage } from './messages.js';
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
  | { code: 'wake_limit'; message: string };

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
}

export type ScheduleWakeResult =
  | { wake: { id: string; wakeAt: string; messageId: string }; message: MessageRow; refusal?: undefined }
  | { refusal: WakeRefusal; wake?: undefined; message?: undefined };

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
  const posted = await postMessage(pool, {
    channelId: input.channelId,
    authorId: input.accountId,
    body: input.reason,
    threadRootId: input.threadRootId,
    kind: 'wake',
    // 시각은 **사실로** 싣는다. 서버가 "15:20 에 다시 봅니다" 로 구워 버리면 그 문자열은
    // 서버의 시간대에 고정되고, 다른 시간대에서 읽는 사람에게 거짓이 된다.
    meta: { kind: 'wake', wake: { wakeAt: wakeAt.toISOString(), reason: input.reason } },
  });
  if (posted.failure) {
    // 깨움은 첨부를 받지 않으므로 여기 오는 것은 게시 자체가 거절된 경우다.
    return { refusal: { code: 'wake_limit', message: 'wake 메시지를 게시할 수 없다' } };
  }

  const res = await pool.query(
    `insert into agent_wake (account_id, channel_id, message_id, wake_at)
     values ($1, $2, $3, $4) returning id`,
    [input.accountId, input.channelId, posted.message.id, wakeAt.toISOString()],
  );
  return {
    wake: { id: res.rows[0].id as string, wakeAt: wakeAt.toISOString(), messageId: posted.message.id },
    message: posted.message,
  };
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
  args: { threadRootId: string; authorId: string; notified: Set<string> },
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
  const due = await client.query<{ id: string; account_id: string }>(
    `select w.id, w.account_id from agent_wake w
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
    if (args.notified.has(row.account_id)) {
      await client.query(`update agent_wake set canceled_at = now() where id = $1`, [row.id]);
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
    woke.push(row.account_id);
  }
  return woke;
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
      await client.query('commit');

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
