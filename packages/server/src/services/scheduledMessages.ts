import type { Pool, PoolClient } from 'pg';
import type { ScheduledMessageView } from '@murmur/shared';
import { postMessage } from './messages.js';
import { channelPostGate } from './channels.js';

export const SCHEDULE_MAX_DAYS = 30;
export const SWEEP_INTERVAL_MS = 15_000;
export const SWEEP_BATCH_SIZE = 20;

const COLS = `id, channel_id as "channelId", author_id as "authorId",
  thread_root_id as "threadRootId", body, send_at as "sendAt",
  created_at as "createdAt", sent_message_id as "sentMessageId",
  failed_reason as "failedReason", canceled_at as "canceledAt"`;

export interface SweepHost {
  addHook(hook: 'onClose', fn: () => void | Promise<void>): void;
}

export async function scheduleMessage(
  pool: Pool, input: {
    channelId: string;
    authorId: string;
    body: string;
    threadRootId?: string | null;
    sendAt: Date;
  },
): Promise<ScheduledMessageView> {
  const res = await pool.query(
    `insert into scheduled_message (channel_id, author_id, thread_root_id, body, send_at)
     values ($1, $2, $3, $4, $5) returning ${COLS}`,
    [input.channelId, input.authorId, input.threadRootId ?? null, input.body, input.sendAt.toISOString()],
  );
  return res.rows[0];
}

/**
 * 이 채널에서 **요청자 자신이** 건 예약만 돌려준다(#222 결정 2). 다른 사람에게는 존재
 * 자체가 보이지 않는다 — 보이면 초안과 다를 게 없다. `author_id` 조건을 호출부로
 * 올리지 않는 이유가 그것이다: 여기서 빠지면 모든 호출부가 새는 표면이 된다.
 */
export async function listScheduledMessages(
  pool: Pool, channelId: string, authorId: string,
): Promise<ScheduledMessageView[]> {
  const res = await pool.query(
    `select ${COLS} from scheduled_message
     where channel_id = $1 and author_id = $2
     order by send_at`,
    [channelId, authorId],
  );
  return res.rows;
}

/**
 * 취소는 **행을 지우지 않고** `canceled_at` 을 찍는다 — 무엇을 취소했는지 남는다.
 * 이미 나갔거나(`sent_message_id`) 실패한 것은 취소할 것이 없으므로 false 다.
 */
export async function cancelScheduledMessage(
  pool: Pool, id: string, authorId: string,
): Promise<boolean> {
  const res = await pool.query(
    `update scheduled_message set canceled_at = now()
     where id = $1 and author_id = $2 and canceled_at is null
       and sent_message_id is null and failed_reason is null
     returning id`,
    [id, authorId],
  );
  return (res.rowCount ?? 0) > 0;
}

interface DueRow {
  id: string;
  channel_id: string;
  author_id: string;
  thread_root_id: string | null;
  body: string;
}

/**
 * 예약 발송 sweeper(#222 결정 4). `presence.ts` 의 sweep 과 같은 모양이다.
 *
 * **한 건씩 자기 트랜잭션에서** 처리한다. 배치 전체를 한 트랜잭션에 넣으면 (a) 한 건이
 * 터질 때 이미 나간 다른 건의 `sent_message_id` 표시까지 함께 롤백되어 **다음 sweep 이
 * 그것을 다시 보낸다**, (b) 배치가 도는 내내 20건의 행 락을 쥐고 있게 된다.
 *
 * `for update skip locked` 를 쓰는 이유: 서버가 여러 대 떠도 같은 행을 두 프로세스가
 * 동시에 집지 않는다. 앞 프로세스가 잡은 행은 **기다리지 않고 건너뛰어** 다음 것을
 * 집으므로, 중복 발송도 없고 서로 막지도 않는다.
 */
export function createScheduledMessageSweeper(pool: Pool): {
  startSweep(app: SweepHost): void;
  sweep(): Promise<void>;
} {
  let sweepInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * 이 프로세스 안에서 sweep 이 겹치지 않게 한다. `setInterval` 은 앞 tick 이 끝날 때까지
   * 기다려 주지 않으므로, 느린 sweep 이 쌓이면 각 sweep 이 커넥션 두 개(락을 쥔 것 +
   * `postMessage` 것)를 잡은 채 풀을 말린다. 프로세스 사이의 중복은 `skip locked` 가 막고,
   * 프로세스 안의 겹침은 이 깃발이 막는다 — 둘은 다른 문제다.
   */
  let running = false;

  /**
   * 발송 가능한 한 건을 잡아 처리한다. 잡을 것이 없으면 `'none'`.
   * `skip` 은 이번 sweep 에서 이미 건드린 id 들이다 — 실패해 롤백된 행을 곧바로 다시
   * 집어 무한 루프가 되는 것을 막는다.
   */
  async function sendOneDue(skip: string[]): Promise<'done' | 'none'> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('begin');
      const due = await client.query<DueRow>(
        `select id, channel_id, author_id, thread_root_id, body
         from scheduled_message
         where send_at <= now()
           and sent_message_id is null
           and failed_reason is null
           and canceled_at is null
           and not (id = any($1::uuid[]))
         order by send_at
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

      const reason = await refuseReason(client, row);
      if (reason) {
        await client.query(
          `update scheduled_message set failed_reason = $1 where id = $2`,
          [reason, row.id],
        );
        await client.query('commit');
        return 'done';
      }

      // 발송은 **기존 `postMessage` 를 그대로 통과한다**(결정 3). 그래야 멘션 inbox·WS
      // 이벤트·감사가 일반 발송과 똑같이 붙는다. 우회해서 직접 insert 하면 예약 메시지만
      // 조용한 메시지가 된다.
      //
      // `idempotencyKey` 에 예약 행의 id 를 쓴다: `postMessage` 는 자기 커넥션에서 커밋하고
      // 우리는 그 다음에 `sent_message_id` 를 찍는다. 그 사이에 프로세스가 죽으면 행은
      // 발송 대기로 남아 다음 sweep 이 다시 보낸다 — 키가 있으면 그 재시도가 새 메시지를
      // 만들지 않고 이미 만든 것을 돌려준다.
      const result = await postMessage(pool, {
        channelId: row.channel_id,
        authorId: row.author_id,
        body: row.body,
        threadRootId: row.thread_root_id,
        idempotencyKey: row.id,
      });

      if (result.message) {
        await client.query(
          `update scheduled_message set sent_message_id = $1 where id = $2`,
          [result.message.id, row.id],
        );
      } else {
        // `postMessage` 가 거부한 코드를 **그대로** 적는다. 우리가 다시 지어내면
        // 작성자가 보는 사유와 서버가 아는 사유가 갈라진다.
        await client.query(
          `update scheduled_message set failed_reason = $1 where id = $2`,
          [result.failure ?? 'unknown', row.id],
        );
      }
      await client.query('commit');
      return 'done';
    } catch (err) {
      await client.query('rollback').catch(() => {});
      // 한 건의 실패로 나머지를 멈추지 않는다. `failed_reason` 을 찍지 않는 이유: 여기 오는
      // 것은 DB 순간 장애 같은 **일시적** 실패이고, 그것을 영구 실패로 굳히면 사람이 쓴 글이
      // 사라진다. 행은 대기로 남아 다음 sweep 이 다시 시도한다.
      console.error('scheduled message sweep error:', err);
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
      for (let i = 0; i < SWEEP_BATCH_SIZE; i++) {
        if ((await sendOneDue(skip)) === 'none') break;
      }
    } finally {
      running = false;
    }
  };

  return {
    startSweep(app) {
      if (sweepInterval) return;
      sweepInterval = setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS);
      sweepInterval.unref?.();
      // 앱이 닫히면 interval 도 접는다 — 남겨 두면 테스트 프로세스가 끝나지 않고
      // 닫힌 풀에 질의가 날아간다.
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

/**
 * 지금 이 예약을 보내면 안 되는 이유. 보낼 수 있으면 `null`.
 *
 * **왜 sweep 이 직접 묻는가:** `postMessage` 에는 보관 검사가 없다 — 그 가드는 라우트가
 * `channelPostGate` 로 건다(`channelRoutes.ts`·`mcpPlugin.ts` 와 같다). 그래서 "postMessage 가
 * 거부하면 그 코드를 적는다"만으로는 보관된 채널에 예약이 그대로 나간다. 라우트와 **같은
 * 술어**를 여기서도 부르는 것이 답이다 — 조건을 손으로 다시 적으면 한쪽만 고치는 사고가 난다.
 *
 * 질의는 **락을 쥔 그 클라이언트**로 한다. `pool` 로 물으면 커넥션을 하나 더 잡는다.
 */
async function refuseReason(client: PoolClient, row: DueRow): Promise<string | null> {
  // `channelPostGate` 는 **없는 채널에 `'ok'`** 를 준다(그 자리 주석이 이유를 적는다).
  // 메시지 경로에서는 이어지는 단계가 404 로 답하지만 여기엔 답할 사람이 없고, 그대로
  // 두면 insert 가 외래키에서 터져 일시 오류로 오해된다. 그래서 존재를 먼저 본다.
  const exists = await client.query(`select 1 from channel where id = $1`, [row.channel_id]);
  if (!exists.rowCount) return 'channel_deleted';

  const gate = await channelPostGate(client, row.channel_id, row.author_id);
  if (gate === 'archived') return 'channel_archived';
  if (gate === 'forbidden') return 'forbidden';
  return null;
}
