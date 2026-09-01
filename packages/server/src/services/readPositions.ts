import type { Pool } from 'pg';

/**
 * 채널 단위 읽음 위치.
 *
 * `inbox` 와 세는 것이 다르다: inbox 는 "나를 부른 것"(멘션·DM·스레드 답글)의 읽음 여부이고,
 * 여기는 "이 채널을 어디까지 봤나"다. 부르지 않은 대화의 미읽음 수와 "여기부터 안 읽음"
 * 구분선이 이 값에서 나온다.
 */
export interface ReadState {
  lastReadSeq: number;
  /** 내 위치보다 뒤에 있는, 내가 쓰지 않은, 살아 있는 메시지 수. */
  unread: number;
}

/**
 * 위치를 전진시킨다. **되돌아가지 않고, 채널 끝을 넘지 않는다.**
 *
 * 단조성: 늦게 도착한 오래된 ack 가 위치를 되돌리면 이미 읽은 대화가 다시 미읽음으로
 * 나타난다. 클라이언트가 여러 기기·여러 요청을 병렬로 보내는 한 순서는 보장되지 않는다.
 *
 * 상한: 미래의 seq 를 그대로 받으면 그 뒤에 도착하는 실제 메시지가 처음부터 읽은 것이 되어
 * **조용히 놓친다.** 그래서 채널의 현재 최대 seq 로 자른다.
 */
export async function markChannelRead(
  pool: Pool, opts: { accountId: string; channelId: string; seq: number },
): Promise<void> {
  await pool.query(
    `insert into channel_read (account_id, channel_id, last_read_seq)
     values ($1, $2, least($3::bigint, coalesce((select max(seq) from message where channel_id = $2), 0)))
     on conflict (account_id, channel_id) do update
       set last_read_seq = greatest(channel_read.last_read_seq, excluded.last_read_seq),
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
 * 가시성은 `listChannels`(standard 전부) + 내가 멤버인 dm 이다 — 여기서 그 경계를 흘리면
 * 채널의 존재 자체가 새어 나간다.
 *
 * 아직 아무것도 읽지 않은 채널도 행을 준다(`lastReadSeq: 0`). 빠뜨리면 클라이언트가
 * "0 이다"와 "모른다"를 구분할 수 없어 배지를 그릴지 말지 판단할 수 없다.
 */
export async function allReadStates(pool: Pool, accountId: string): Promise<ChannelReadState[]> {
  const res = await pool.query(
    `select
       c.id as "channelId",
       coalesce(r.last_read_seq, 0)::int as "lastReadSeq",
       (select count(*) from message m
         where m.channel_id = c.id
           and m.deleted_at is null
           and m.author_id <> $1
           and m.seq > coalesce(r.last_read_seq, 0))::int as unread
     from channel c
     left join channel_read r on r.account_id = $1 and r.channel_id = c.id
     where c.kind = 'standard'
        or exists (select 1 from channel_member cm
                    where cm.channel_id = c.id and cm.account_id = $1)
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
       coalesce(r.last_read_seq, 0)::int as "lastReadSeq",
       (select count(*) from message m
         where m.channel_id = $2
           and m.deleted_at is null            -- 지운 메시지는 미읽음이 아니다
           and m.author_id <> $1               -- 내가 쓴 것도 아니다(발화마다 배지가 뜨면 안 된다)
           and m.seq > coalesce(r.last_read_seq, 0))::int as unread
     from (select 1) one
     left join channel_read r on r.account_id = $1 and r.channel_id = $2`,
    [opts.accountId, opts.channelId],
  );
  return res.rows[0] as ReadState;
}
