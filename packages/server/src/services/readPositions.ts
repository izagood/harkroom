import type { Pool } from 'pg';
import { channelVisibleSql } from './channels.js';

/**
 * 채널 단위 읽음 위치.
 *
 * `inbox` 와 세는 것이 다르다: inbox 는 "나를 부른 것"(멘션·DM·스레드 답글)의 읽음 여부이고,
 * 여기는 "이 채널을 어디까지 봤나"다. 부르지 않은 대화의 미읽음 수와 "여기부터 안 읽음"
 * 구분선이 이 값에서 나온다.
 */
export interface ReadState {
  /**
   * 미읽음 경계(`UNREAD_BOUNDARY`). 저장된 `last_read_seq` 원본이 아니라 미읽음 표시(#154)를
   * 반영한 값이다 — 클라이언트가 이 값으로 구분선을 얼리고 "끝까지 읽었나"를 판단하기 때문에
   * 원본을 주면 표시된 채널을 열어도 이미 최신이라 판단해 ack 를 보내지 않고, 그러면 표시가
   * 영원히 지워지지 않는다.
   */
  lastReadSeq: number;
  /** 내 위치보다 뒤에 있는, 내가 쓰지 않은, 살아 있는 메시지 수. */
  unread: number;
}

/**
 * 미읽음 경계. **이 seq 뒤부터가 미읽음이다.**
 *
 * 한 곳에 모으는 이유는 `channels.ts` 의 `audienceFor` 와 같다: 같은 계산이 `allReadStates`
 * (사이드바 배지)와 `readState`(채널 안 미읽음·구분선)에 각각 있었다. 한쪽만 고치면 두 표면이
 * 서로 다른 말을 한다 — 사이드바는 미읽음이라는데 채널을 열면 아무것도 새것이 없는 식이다.
 * 판정이 갈리는 것 자체가 결함이므로 SQL 조각을 상수 하나로 두고 두 질의가 **같은 것**을
 * 참조하게 한다.
 *
 * 두 입력을 읽는다: 자동으로 전진하는 `last_read_seq` 와 사용자가 지정한 `unread_from_seq`.
 * `least` 인 이유 — 사용자가 "여기부터 안 읽음"이라고 하면 그 앞까지만 읽은 것이 되어야 하고,
 * 표시가 없으면(`null`) 자동 위치를 그대로 쓴다.
 *
 * 질의는 `channel_read` 를 `r` 로 left join 해야 한다(행이 없는 채널도 0 으로 답해야 하므로).
 */
const UNREAD_BOUNDARY = `least(
       coalesce(r.last_read_seq, 0),
       coalesce(r.unread_from_seq - 1, coalesce(r.last_read_seq, 0))
     )`;

/**
 * 위치를 전진시킨다. **되돌아가지 않고, 채널 끝을 넘지 않는다.**
 *
 * 단조성: 늦게 도착한 오래된 ack 가 위치를 되돌리면 이미 읽은 대화가 다시 미읽음으로
 * 나타난다. 클라이언트가 여러 기기·여러 요청을 병렬로 보내는 한 순서는 보장되지 않는다.
 *
 * 상한: 미래의 seq 를 그대로 받으면 그 뒤에 도착하는 실제 메시지가 처음부터 읽은 것이 되어
 * **조용히 놓친다.** 그래서 채널의 현재 최대 seq 로 자른다.
 *
 * 미읽음 표시(#154)는 **끝까지 읽었을 때만** 지운다: 요청의 seq 가 채널의 현재 최대 seq
 * 이상일 때다. 낡은 ack 는 정의상 그보다 작으므로 표시를 지우지 못한다 — 시계도, 기기 식별도
 * 없이 "사람이 정말 끝까지 봤다"와 "늦게 도착한 옛 ack"가 구분된다.
 */
export async function markChannelRead(
  pool: Pool, opts: { accountId: string; channelId: string; seq: number },
): Promise<void> {
  await pool.query(
    `insert into channel_read (account_id, channel_id, last_read_seq)
     values ($1, $2, least($3::bigint, coalesce((select max(seq) from message where channel_id = $2), 0)))
     on conflict (account_id, channel_id) do update
       set last_read_seq = greatest(channel_read.last_read_seq, excluded.last_read_seq),
           unread_from_seq = case
             when $3::bigint >= coalesce((select max(seq) from message where channel_id = $2), 0)
               then null
             else channel_read.unread_from_seq
           end,
           updated_at = now()`,
    [opts.accountId, opts.channelId, opts.seq],
  );
}

/**
 * 사용자가 명시적으로 지정한 미읽음 시작점을 쓴다(#154). `seq: null` 이 표시를 지운다.
 *
 * `markChannelRead` 와 다른 함수·다른 컬럼인 것이 핵심이다. 자동 ack 와 사람의 조작을 같은
 * 값에 쓰면 서버가 둘을 구분할 수 없고, 그 구분이 없으면 단조성을 풀 수밖에 없다.
 *
 * 여기에는 `greatest` 가 없다 — 사람이 방금 누른 것이 최신 의도이므로 그대로 덮는다. 낡은
 * 요청이 뒤늦게 도착하는 문제는 자동 ack 쪽 이야기다(이 라우트는 사람이 한 번 누를 때만 온다).
 */
export async function markChannelUnread(
  pool: Pool, opts: { accountId: string; channelId: string; seq: number | null },
): Promise<void> {
  await pool.query(
    `insert into channel_read (account_id, channel_id, unread_from_seq)
     values ($1, $2, $3::bigint)
     on conflict (account_id, channel_id) do update
       set unread_from_seq = excluded.unread_from_seq,
           updated_at = now()`,
    [opts.accountId, opts.channelId, opts.seq],
  );
}

export interface ChannelReadState extends ReadState {
  channelId: string;
}

/**
 * 내가 볼 수 있는 모든 채널의 읽음 상태. 사이드바 배지가 채널마다 요청하면 N+1 이 되고,
 * 채널이 늘수록 앱을 열 때마다 그만큼 왕복한다.
 *
 * 가시성은 `channelVisibleSql` 하나로 판정한다 — 여기서 그 경계를 흘리면 채널의 존재
 * 자체가 새어 나간다. 배지는 특히 조용한 누출 경로다: 목록에 없는 채널이라도 미읽음 수가
 * 딸려 오면 "내가 모르는 곳에서 대화가 있다"가 새고, 개수는 활동량까지 알려 준다.
 *
 * admin 예외를 **넣지 않는다**. `listChannels` 는 운영을 위해 admin 에게 private 채널의
 * 이름을 주지만, 미읽음 수는 대화 내용의 대리 지표다 — 읽기 게이트와 같은 편에 선다.
 *
 * 아직 아무것도 읽지 않은 채널도 행을 준다(`lastReadSeq: 0`). 빠뜨리면 클라이언트가
 * "0 이다"와 "모른다"를 구분할 수 없어 배지를 그릴지 말지 판단할 수 없다.
 */
export async function allReadStates(pool: Pool, accountId: string): Promise<ChannelReadState[]> {
  const res = await pool.query(
    `select
       c.id as "channelId",
       (${UNREAD_BOUNDARY})::int as "lastReadSeq",
       (select count(*) from message m
         where m.channel_id = c.id
           and m.deleted_at is null
           and m.author_id <> $1
           and m.seq > (${UNREAD_BOUNDARY}))::int as unread
     from channel c
     left join channel_read r on r.account_id = $1 and r.channel_id = c.id
     where ${channelVisibleSql('c', '$1')}
     order by c.id`,
    [accountId],
  );
  return res.rows;
}

export async function readState(
  pool: Pool, opts: { accountId: string; channelId: string },
): Promise<ReadState> {
  const res = await pool.query(
    `select
       (${UNREAD_BOUNDARY})::int as "lastReadSeq",
       (select count(*) from message m
         where m.channel_id = $2
           and m.deleted_at is null            -- 지운 메시지는 미읽음이 아니다
           and m.author_id <> $1               -- 내가 쓴 것도 아니다(발화마다 배지가 뜨면 안 된다)
           and m.seq > (${UNREAD_BOUNDARY}))::int as unread
     from (select 1) one
     left join channel_read r on r.account_id = $1 and r.channel_id = $2`,
    [opts.accountId, opts.channelId],
  );
  return res.rows[0] as ReadState;
}
