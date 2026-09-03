import type { Pool, PoolClient } from 'pg';
import { CHANNEL_MENTION_HANDLE, mentionedHandles, mentionedIds, normalizeMentions, type InboxEntry, type MessageRow } from '@murmur/shared';
import { attachToMessage, type AttachFailure } from './attachments.js';
import { channelVisibleSql } from './channels.js';
import { getHandleGroupByHandle, listHandleGroupMembers } from './handleGroups.js';

/**
 * 게시 결과. 첨부 연결이 거절되면 메시지 자체가 만들어지지 않는다(트랜잭션 롤백) —
 * 그래서 성공/실패가 배타적인 합 타입이다. 둘을 optional 필드로 섞으면 호출부가
 * 실패를 확인하지 않고 `message` 를 만질 수 있다.
 */
export type PostMessageResult =
  | { message: MessageRow; notified: string[]; replayed: boolean; failure?: undefined }
  | { failure: AttachFailure; message?: undefined };

export interface PostMessageInput {
  channelId: string;
  authorId: string;
  body: string;
  threadRootId?: string | null;
  /** #144: 'progress' 값은 진행 설명 메시지를 표시 — 결과 발화로 세지 않는다. */
  kind?: 'user' | 'system' | 'progress';
  meta?: Record<string, unknown>;
  idempotencyKey?: string | null;
  /** 이 메시지에 붙일 업로드들. 같은 트랜잭션에서 연결한다 — 따로 하면 첨부 없는 메시지가 보인다. */
  attachmentIds?: string[];
  /** 스레드 답을 채널에도 함께 올린다(#231). threadRootId 가 없으면 무시된다. */
  alsoInChannel?: boolean;
}

// 리액션을 COLS 에 넣는 이유: 메시지를 내주는 경로가 네 갈래(목록·POST·PATCH·idempotency
// 재생)라 조회 뒤에 붙이는 방식은 언젠가 한 갈래를 빼먹고 그 응답에서만 리액션이 사라진다.
// 여기 두면 message 를 읽는 모든 쿼리가 자동으로 맞다.
const REACTIONS = `coalesce((
  select json_agg(json_build_object('emoji', r.emoji, 'accountIds', r."accountIds") order by r."firstAt")
  from (
    select emoji, array_agg(account_id::text order by created_at) as "accountIds",
           min(created_at) as "firstAt"
    from message_reaction where message_id = message.id group by emoji
  ) r
), '[]'::json) as reactions`;

// 첨부도 리액션과 같은 이유로 COLS 에 있다 — 조회 뒤에 붙이면 네 갈래 중 하나를 빼먹는다.
// storage_key 는 **의도적으로 빼 두었다**: 스토리지 키가 응답에 새면 그 자체가 접근 경로다.
const ATTACHMENTS = `coalesce((
  select json_agg(json_build_object(
    'id', a.id, 'filename', a.filename,
    'contentType', a.content_type, 'sizeBytes', a.size_bytes::int
  ) order by a.attached_at, a.created_at)
  from attachment a where a.message_id = message.id
), '[]'::json) as attachments`;

// #218: 핀 목록도 이 컬럼 집합으로 메시지를 내주기 때문에 export 다. 핀 전용으로 컬럼을
// 다시 적으면 위에 적은 "네 갈래" 가 다섯이 되고, 리액션·첨부가 그 응답에서만 빠진다.
export const COLS = `id, seq::int as seq, channel_id as "channelId", thread_root_id as "threadRootId",
  author_id as "authorId", body, kind, meta, created_at as "createdAt",
  edited_at as "editedAt", ${REACTIONS}, ${ATTACHMENTS},
  null::int as "replyCount", null::text as "lastReplyAt", null::text[] as "participantIds",
  also_in_channel as "alsoInChannel"`;

// 스레드 메타데이터: 루트 메시지에만 계산. LATERAL join으로 같은 쿼리에서 계산한다 (N+1 방지).
// 진행 설명(kind='progress')도 답글 수에 포함한다. 사용자가 "답글 3개"를 보고 열었을 때
// 진행 설명도 포함되어 있으면 그 수를 이해할 수 있다. 제외하면 개수가 안 맞는 것처럼 보여서 혼란스러운데.
const THREAD_STATS = `LEFT JOIN LATERAL (
  SELECT COUNT(*)::int as reply_count,
    MAX(created_at)::text as last_reply_at,
    COALESCE(ARRAY_AGG(DISTINCT author_id) FILTER (WHERE author_id IS NOT NULL), '{}'::uuid[]) as participant_ids
  FROM message WHERE thread_root_id = m.id AND deleted_at IS NULL
) thread_stats ON true`;

// listMessages 에서 사용하는 컬럼: 루트면 메타데이터 있음, 답글이면 null.
const LIST_COLS = `m.id, m.seq::int as seq, m.channel_id as "channelId", m.thread_root_id as "threadRootId",
  m.author_id as "authorId", m.body, m.kind, m.meta, m.created_at as "createdAt",
  m.edited_at as "editedAt", ${REACTIONS.replace(/message\./g, 'm.')}, ${ATTACHMENTS.replace(/message\./g, 'm.')},
  case when m.thread_root_id is null then thread_stats.reply_count end as "replyCount",
  case when m.thread_root_id is null then thread_stats.last_reply_at end as "lastReplyAt",
  case when m.thread_root_id is null then thread_stats.participant_ids end as "participantIds",
  m.also_in_channel as "alsoInChannel"`;

async function insertInbox(
  client: PoolClient, accountId: string, messageId: string, reason: InboxEntry['reason'], notified: Set<string>,
): Promise<void> {
  await client.query(
    `insert into inbox (account_id, message_id, reason) values ($1, $2, $3)`,
    [accountId, messageId, reason],
  );
  notified.add(accountId);
}

/**
 * 이름 하나를 여러 사람으로 펼쳐 inbox 에 넣는다. `@channel`(#225)과 집합(#230)이 **같은
 * 함수를 쓴다.**
 *
 * 한 자리로 모아 둔 이유: 확장 지점이 둘이 되면 하나만 고치는 사고가 난다. 여기 묶여 있는
 * 규칙은 셋이고, 어느 하나를 한쪽에서만 빠뜨리면 조용히 새거나 조용히 빠진다.
 *
 * ① **가시성**은 `channelVisibleSql` 이 판정한다 — 멤버십을 여기서 다시 정의하지 않는다.
 *    판정이 갈라지면 private 채널의 비멤버에게 알림이 새거나(채널의 존재 자체가 샌다),
 *    public 채널에서 조용히 빠지는 사람이 생긴다. 술어가 계정 id 를 파라미터가 아니라
 *    컬럼(`a.id`)으로 받는 덕에 방향을 뒤집어 "이 채널을 볼 수 있는 계정 전부"로 쓸 수 있다.
 * ② **부른 사람 자신은 뺀다** — 자기 발화로 자기에게 알림이 오면 안 된다
 *    (`readPositions.ts` 의 `author_id <> $1` 과 같은 규칙).
 * ③ **이미 알린 사람은 다시 넣지 않는다** — 평범한 멘션으로 이미 불린 사람이 집합에도
 *    들어 있으면 inbox 항목이 둘 생긴다.
 *
 * 비활성 계정을 따로 거르지 않는 것은 평범한 멘션과 같은 처지로 두기 위해서다.
 *
 * `candidateIds` 가 `null` 이면 "이 채널을 볼 수 있는 사람 전부"(`@channel`), 배열이면
 * 그중 볼 수 있는 사람(집합의 명단)이다.
 */
async function fanOutMention(
  client: PoolClient,
  input: { channelId: string; authorId: string; messageId: string },
  candidateIds: string[] | null,
  notified: Set<string>,
): Promise<void> {
  if (candidateIds !== null && candidateIds.length === 0) return;
  const audience = await client.query<{ id: string }>(
    `select a.id from account a, channel c
      where c.id = $1 and a.id <> $2
        and ($3::uuid[] is null or a.id = any($3))
        and ${channelVisibleSql('c', 'a.id')}`,
    [input.channelId, input.authorId, candidateIds],
  );
  for (const row of audience.rows) {
    if (!notified.has(row.id)) await insertInbox(client, row.id, input.messageId, 'mention', notified);
  }
}

export async function postMessage(
  pool: Pool, input: PostMessageInput,
): Promise<PostMessageResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');

    if (input.idempotencyKey) {
      // key는 클라이언트가 고르는 값이라 전역 유일하지 않다. 재생은 같은 author가 같은 채널로
      // 보낸 재시도일 때만이며, 그 범위를 벗어난 조회는 남의 메시지를 읽는 경로가 된다.
      const dup = await client.query(
        `select message_id from idempotency_key
         where key = $1 and author_id = $2 and channel_id = $3`,
        [input.idempotencyKey, input.authorId, input.channelId],
      );
      if (dup.rowCount) {
        const existing = await client.query(`select ${COLS} from message where id = $1`, [dup.rows[0].message_id]);
        await client.query('commit');
        return { message: existing.rows[0], notified: [], replayed: true };
      }
    }

    // threadRootId 가 없으면 alsoInChannel 은 의미 없다 — 조용히 false 로 정규화한다.
    // threadRootId 없이 true 를 보내는 것은 이미 채널 메시지이기 때문이다.
    const alsoInChannel = input.threadRootId ? (input.alsoInChannel ?? false) : false;

    const inserted = await client.query(
      `insert into message (channel_id, thread_root_id, author_id, body, kind, meta, also_in_channel)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [input.channelId, input.threadRootId ?? null, input.authorId, input.body,
       input.kind ?? 'user', JSON.stringify(input.meta ?? {}), alsoInChannel],
    );
    const messageId = inserted.rows[0].id as string;

    // 첨부를 **같은 트랜잭션에서** 연결한다. 따로 하면 첨부 없는 메시지가 잠깐 보이고,
    // 연결이 실패하면 본문만 남는다.
    const failure = await attachToMessage(client, {
      messageId, actorId: input.authorId, attachmentIds: input.attachmentIds ?? [],
    });
    if (failure) {
      await client.query('rollback');
      return { failure };
    }

    // 연결 뒤에 읽는다 — COLS 가 첨부를 함께 가져오므로 순서가 뒤바뀌면 빈 배열이 나간다.
    const read = await client.query(`select ${COLS} from message where id = $1`, [messageId]);
    const message: MessageRow = read.rows[0];

    if (input.idempotencyKey) {
      await client.query(
        `insert into idempotency_key (key, message_id, author_id, channel_id) values ($1, $2, $3, $4)`,
        [input.idempotencyKey, message.id, input.authorId, input.channelId],
      );
    }

    const notified = new Set<string>();

    // 멘션 정규화: @handle -> <@id>
    // #230 그룹 멘션(@그룹)은 이 작업 범위 밖 — 호출부가 먼저 그룹 확장을 하고 남은
    // @handle 을 정규화해야 한다. 여기서는 일반 계정 멘션만 처리한다.
    //
    // 먼저 현재 채널의 멤버 목록을 가져온다 — 정규화에 필요한 accountsMap 과 @channel
    // 확장에 필요한 대상자 목록을 한 번에 구한다.
    const channelMembers = await client.query(
      `select a.id, lower(a.handle) as handle from account a
       join channel_member cm on cm.account_id = a.id
       where cm.channel_id = $1 and a.disabled = false`,
      [input.channelId],
    );
    const accountsMap = new Map<string, string>(); // handle(lower) -> id
    const idToHandle = new Map<string, string>(); // id -> handle
    for (const row of channelMembers.rows) {
      accountsMap.set(row.handle, row.id);
      idToHandle.set(row.id, row.handle);
    }

    // @channelMentionHandle (@channel) 은 본문을 손대지 않고 inbox 만 만든다.
    // 원문에 그대로 남겨야 수정할 때 되돌릴 수 있다.
    const hasChannelMention = mentionedHandles(input.body).includes(CHANNEL_MENTION_HANDLE);
    // @channel 이 계정으로 존재하면 일반 멘션으로 처리되고, 여기서는 무시된다.

    // 본문을 정규화: @handle -> <@id>
    const normalizedBody = normalizeMentions(input.body, accountsMap);

    // 알림 판정은 정규화된 본문의 <@id> 토큰에서 한다.
    // mentionedIds 는 Set 을 반환하므로 [...set] 로 배열로 만든 뒤Set 으로 중복 제거.
    const mentionedAccountIds = new Set(mentionedIds(normalizedBody));
    for (const accountId of mentionedAccountIds) {
      if (accountId !== input.authorId) {
        await insertInbox(client, accountId, message.id, 'mention', notified);
      }
    }

    // `@channel`(#225) — 채널 전체 호출. 본문은 손대지 않는다: `@channel` 은 원문에
    // 그대로 남고 서버는 inbox 항목만 펼쳐 넣는다. 본문을 치환하면 원문이 사라져
    // 수정할 때 되돌릴 수 없다.
    //
    // `@channel` 이라는 handle 의 **계정이 실제로 있으면 계정이 이긴다** — 위에서 이미
    // 평범한 멘션으로 처리됐고 여기서는 아무것도 하지 않는다. 사람의 이름이 예약어에
    // 밀리면 그 사람은 영영 불릴 수 없다.
    const accountHandles = new Set(channelMembers.rows.map((r) => r.handle));
    if (hasChannelMention && !accountHandles.has(CHANNEL_MENTION_HANDLE)) {
      // 대상은 **그 채널을 볼 수 있는 사람 전부**다. 규칙은 `fanOutMention` 하나에 있다.
      await fanOutMention(client, { ...input, messageId: message.id }, null, notified);
    }

    // 집합(#230) — 저장된 명단을 펼친다. 본문은 손대지 않는다: `@team` 은 원문에 그대로
    // 남고 서버는 inbox 항목만 펼쳐 넣는다(`@channel` 과 같은 이유다).
    //
    // **계정이 이긴다.** `@foo` 가 계정이면 위에서 이미 평범한 멘션으로 처리됐고 여기서는
    // 건너뛴다. 서버가 양방향 충돌을 막으므로 정상 경로에서는 겹치지 않지만, 026 이전에
    // 만들어진 행이나 동시 생성 경합으로 겹칠 수 있다 — 그때 사람의 이름이 집합에 밀리면
    // 그 사람은 영영 불릴 수 없다.
    //
    // 조회를 `client` 로 하는 이유: 트랜잭션 클라이언트를 쥔 채 `pool` 에서 또 다른 연결을
    // 얻으면 풀이 포화된 순간 자기 자신을 기다리는 교착이 된다. 같은 트랜잭션 스냅샷을
    // 보는 것도 이쪽이 맞다.
    const mentionedHandlesList = mentionedHandles(input.body);
    for (const handle of mentionedHandlesList) {
      if (handle === CHANNEL_MENTION_HANDLE) continue;
      if (accountHandles.has(handle)) continue;

      const group = await getHandleGroupByHandle(client, handle);
      if (!group) continue;

      const members = await listHandleGroupMembers(client, group.id);
      await fanOutMention(
        client, { ...input, messageId: message.id }, members.map((m) => m.accountId), notified,
      );
    }

    // 본문을 정규화된 버전으로 업데이트
    if (normalizedBody !== input.body) {
      await client.query(`update message set body = $1 where id = $2`, [normalizedBody, messageId]);
      message.body = normalizedBody;
    }

    if (input.threadRootId) {
      const root = await client.query(`select author_id from message where id = $1`, [input.threadRootId]);
      const rootAuthor = root.rows[0]?.author_id;
      if (rootAuthor && rootAuthor !== input.authorId && !notified.has(rootAuthor)) {
        await insertInbox(client, rootAuthor, message.id, 'thread_reply', notified);
      }
    }

    const channel = await client.query(`select kind from channel where id = $1`, [input.channelId]);
    if (channel.rows[0]?.kind === 'dm') {
      const members = await client.query(
        `select account_id from channel_member where channel_id = $1 and account_id <> $2`,
        [input.channelId, input.authorId],
      );
      for (const row of members.rows) {
        if (!notified.has(row.account_id)) await insertInbox(client, row.account_id, message.id, 'dm', notified);
      }
    }

    await client.query('commit');
    return { message, notified: [...notified], replayed: false };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

/** 주어진 seq 보다 오래된 메시지가 남아 있는가. 클라이언트의 '더 불러오기' 표시에 쓴다. */
export async function hasOlderMessages(pool: Pool, channelId: string, oldestSeq: number): Promise<boolean> {
  const res = await pool.query(
    `select 1 from message where channel_id = $1 and seq < $2 and deleted_at is null limit 1`,
    [channelId, oldestSeq],
  );
  return (res.rowCount ?? 0) > 0;
}

export type MutationRefusal = 'not_found' | 'forbidden';

/** 수정은 작성자 본인만, user 메시지만. system 메시지는 avcs 투영의 산물이라 사람이 고칠 수 없다. */
export async function editMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; body: string },
): Promise<MessageRow | MutationRefusal> {
  const found = await pool.query(
    `select author_id, kind from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  const row = found.rows[0];
  if (row.author_id !== args.actorId || row.kind !== 'user') return 'forbidden';

  // 멘션 정규화: @handle -> <@id>
  const channelMembers = await pool.query(
    `select a.id, lower(a.handle) as handle from account a
     join channel_member cm on cm.account_id = a.id
     where cm.channel_id = $1 and a.disabled = false`,
    [args.channelId],
  );
  const accountsMap = new Map<string, string>();
  for (const mRow of channelMembers.rows) {
    accountsMap.set(mRow.handle, mRow.id);
  }
  const normalizedBody = normalizeMentions(args.body, accountsMap);

  const updated = await pool.query(
    `update message set body = $2, edited_at = now() where id = $1 returning ${COLS}`,
    [args.messageId, normalizedBody],
  );
  return updated.rows[0];
}

/** 삭제는 작성자 또는 admin. 수정과 달리 원문을 왜곡하지 않고 가리는 일이라 운영자에게 열어둔다. */
export async function deleteMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; actorIsAdmin: boolean },
): Promise<'deleted' | MutationRefusal> {
  const found = await pool.query(
    `select author_id from message
     where id = $1 and channel_id = $2 and deleted_at is null`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  if (found.rows[0].author_id !== args.actorId && !args.actorIsAdmin) return 'forbidden';

  await pool.query(`update message set deleted_at = now() where id = $1`, [args.messageId]);
  return 'deleted';
}

/**
 * 링크 하나(#178)로 여는 경로. **채널을 모른 채 id 만 들고 온다** — 그래서 채널 조건이 없고,
 * 가시성 판정은 이 결과의 `channelId` 로 호출부가 `assertChannelVisible` 을 부른다.
 * 여기서 규칙을 다시 쓰면 같은 계산이 두 곳에 생긴다.
 *
 * `deleted_at is null` 이 조건에 들어 있는 것이 핵심이다: 지워진 메시지는 본문을 담아
 * 돌려준 뒤 걸러 내는 것이 아니라 **애초에 없는 것**이 되어 404 로 떨어진다.
 */
export async function getMessageById(pool: Pool, messageId: string): Promise<MessageRow | null> {
  const res = await pool.query(
    `select ${COLS} from message where id = $1 and deleted_at is null`, [messageId],
  );
  return res.rows[0] ?? null;
}

export async function listMessages(
  pool: Pool, channelId: string,
  opts: { since?: number; before?: number; threadRootId?: string | null; limit?: number },
): Promise<MessageRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  if (opts.threadRootId) {
    // 스레드 조회에서는 루트를 항상 포함한다 — limit 와 관계없이.
    if (opts.since !== undefined && opts.since > 0) {
      const res = await pool.query(
        `select ${LIST_COLS} from message m ${THREAD_STATS}
         where m.channel_id = $1 and (m.id = $2 or m.thread_root_id = $2) and m.seq > $3 and m.deleted_at is null
         order by m.seq limit $4`,
        [channelId, opts.threadRootId, opts.since, limit],
      );
      return res.rows;
    }
    const res = await pool.query(
      `select * from (
        select ${LIST_COLS} from message m ${THREAD_STATS}
        where m.channel_id = $1 and m.id = $2 and m.deleted_at is null
        union all
        select ${LIST_COLS} from message m ${THREAD_STATS}
        where m.channel_id = $1 and m.thread_root_id = $2 and m.deleted_at is null
        order by seq desc limit $3
      ) latest
      order by seq`,
      [channelId, opts.threadRootId, limit],
    );
    return res.rows;
  }
  // 역방향 페이지: before 보다 오래된 것 중 '가장 최신 limit 개'를 잡아 오름차순으로 되돌린다.
  // desc 로 잡지 않으면 채널 맨 앞부터 limit 개를 주게 되어 페이지가 이어지지 않는다.
  if (opts.before !== undefined) {
    const res = await pool.query(
      `select * from (
         select ${LIST_COLS} from message m ${THREAD_STATS}
         where m.channel_id = $1 and m.seq < $2 and m.deleted_at is null
         order by m.seq desc limit $3
       ) older
       order by seq`,
      [channelId, opts.before, limit],
    );
    return res.rows;
  }
  const since = opts.since ?? 0;
  if (since > 0) {
    const res = await pool.query(
      `select ${LIST_COLS} from message m ${THREAD_STATS}
       where m.channel_id = $1 and m.seq > $2 and m.deleted_at is null
       order by m.seq limit $3`,
      [channelId, since, limit],
    );
    return res.rows;
  }
  // since 미지정(0): 오래된 200개가 아니라 최신 N개를 반환한다 (반환 순서는 seq 오름차순 유지)
  const res = await pool.query(
    `select * from (
       select ${LIST_COLS} from message m ${THREAD_STATS}
       where m.channel_id = $1 and m.deleted_at is null
       order by m.seq desc limit $2
     ) latest
     order by seq`,
    [channelId, limit],
  );
  return res.rows;
}

export async function listInbox(
  pool: Pool, accountId: string, opts: { unreadOnly?: boolean },
): Promise<InboxEntry[]> {
  const res = await pool.query(
    `select i.id::int as id, i.message_id as "messageId", i.reason, i.read_at as "readAt",
            m.channel_id as "channelId"
     from inbox i join message m on m.id = i.message_id
     where i.account_id = $1 ${opts.unreadOnly ? 'and i.read_at is null' : ''}
     order by i.id`,
    [accountId],
  );
  return res.rows;
}

/** 읽음 처리된 항목 수를 돌려준다. account_id 스코프이므로 남의 entry id 는 아무 것도 지우지 않는다. */
export async function markInboxRead(pool: Pool, accountId: string, ids: number[]): Promise<number> {
  const res = await pool.query(
    `update inbox set read_at = now() where account_id = $1 and id = any($2) and read_at is null`,
    [accountId, ids],
  );
  return res.rowCount ?? 0;
}

/**
 * `channelId` 를 주면 그 채널 안만 본다. 클라이언트에서 거르지 않는 이유(#221): 전역 검색은
 * seq desc 상위 N 건에서 잘리므로, 다른 채널의 일치가 많으면 이 채널 것이 애초에 응답에
 * 들어오지 않는다 — "이 대화 안에 있는 걸 아는데 못 찾는" 정확히 반대되는 결과가 된다.
 * 그래서 질의 자체를 좁힌다.
 */
export async function searchMessages(
  pool: Pool, requesterId: string, query: string, limit = 50, channelId: string | null = null,
): Promise<MessageRow[]> {
  const res = await pool.query(
    `select m.id, m.seq::int as seq, m.channel_id as "channelId", m.thread_root_id as "threadRootId",
       m.author_id as "authorId", m.body, m.kind, m.meta, m.created_at as "createdAt",
       m.edited_at as "editedAt", '[]'::json as reactions, '[]'::json as attachments,
       null::int as "replyCount", null::text as "lastReplyAt", null::text[] as "participantIds",
       m.also_in_channel as "alsoInChannel"
     from message m
     join channel c on c.id = m.channel_id
     where m.search @@ websearch_to_tsquery('simple', $1) and m.deleted_at is null
       -- 검색은 채널 목록을 우회해 본문에 바로 닿는 표면이다. 여기만 넓으면 목록에도
       -- 배지에도 없는 private 채널의 발언이 검색 결과로 통째로 나온다 — 그래서 목록·배지와
       -- **같은 술어**를 쓴다. admin 예외 없다(결과가 곧 메시지 본문이다).
       and ${channelVisibleSql('c', '$3')}
       -- 스코프는 가시성 **위에** 얹는 별개 조건이다. null 이면 절이 상수로 접혀 전역 검색의
       -- 계획이 그대로 남는다 — 기존 동작을 건드리지 않는다.
       and ($4::uuid is null or m.channel_id = $4)
     order by m.seq desc limit $2`,
    [query, Math.min(limit, 100), requesterId, channelId],
  );
  return res.rows;
}
