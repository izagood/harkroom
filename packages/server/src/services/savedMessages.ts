import type { Pool } from 'pg';
import type { MessageRow, SavedMessageRow } from '@murmur/shared';
import { COLS as MESSAGE_COLS } from './messages.js';
import { channelVisibleSql } from './channels.js';

/**
 * 나중에 볼 메시지(#219). **개인 전용**이다 — 모든 쿼리가 `account_id = $1` 로 자기 행만
 * 다룬다. 그 필터가 이 파일의 유일한 접근 통제이므로, 어느 쿼리에서든 빠지면 남의 큐가
 * 그대로 보인다.
 */

type SavedMessageWithMetaRow = MessageRow & {
  smState: 'open' | 'done';
  smCreatedAt: string;
  smDoneAt: string | null;
  smDeleted: boolean;
};

function toSavedMessageRow({
  smState,
  smCreatedAt,
  smDoneAt,
  smDeleted,
  ...message
}: SavedMessageWithMetaRow): SavedMessageRow {
  return {
    messageId: message.id,
    channelId: message.channelId,
    state: smState,
    createdAt: smCreatedAt,
    doneAt: smDoneAt,
    deleted: smDeleted,
    // #219 결정 3: 담아 둔 사실은 내 기록이라 행은 남지만, 삭제된 메시지의 **본문은
    // 내주지 않는다** — 그것이 새면 삭제가 삭제가 아니다(핀의 같은 판단, #218).
    // 그래서 옵셔널이 아니라 명시적 null 이다: 키가 사라지면 클라이언트가 '아직 안 받았다'
    // 와 '삭제됐다'를 구분할 수 없다.
    message: smDeleted ? null : message,
  };
}

async function selectSavedMessages(
  pool: Pool,
  accountId: string,
  state: 'open' | 'done',
  messageId: string | null,
): Promise<SavedMessageRow[]> {
  const res = await pool.query(
    // `deleted_at is null` 을 **걸지 않는다** — 삭제된 메시지도 자리가 남아야 한다(결정 3).
    // 대신 삭제 여부를 함께 실어 위 mapper 가 본문을 떼어 낸다.
    `select m.*, sm.state as "smState", sm.created_at as "smCreatedAt", sm.done_at as "smDoneAt"
     from saved_message sm
     join lateral (
       select ${MESSAGE_COLS}, (deleted_at is not null) as "smDeleted"
       from message where message.id = sm.message_id
     ) m on true
     where sm.account_id = $1 and sm.state = $2 and ($3::uuid is null or sm.message_id = $3)
     order by sm.created_at desc`,
    [accountId, state, messageId],
  );
  return (res.rows as SavedMessageWithMetaRow[]).map(toSavedMessageRow);
}

export async function listSavedMessages(
  pool: Pool,
  accountId: string,
  state: 'open' | 'done',
): Promise<SavedMessageRow[]> {
  return selectSavedMessages(pool, accountId, state, null);
}

/**
 * 사이드바 배지와 `⋯` 메뉴 문구가 함께 필요한 것 둘. 한 왕복으로 받는 이유: 개수만 받으면
 * 메뉴가 "담겨 있는가"를 알 수 없어, 이미 담은 메시지에도 "나중에 보기"를 계속 내놓는다.
 * `messageIds` 는 `open`·`done` 을 **둘 다** 담는다 — 완료로 옮긴 메시지도 담긴 상태다.
 */
export async function getSavedSummary(
  pool: Pool,
  accountId: string,
): Promise<{ openCount: number; messageIds: string[] }> {
  const res = await pool.query(
    `select message_id, state from saved_message where account_id = $1`,
    [accountId],
  );
  const rows = res.rows as { message_id: string; state: 'open' | 'done' }[];
  return {
    openCount: rows.filter((r) => r.state === 'open').length,
    messageIds: rows.map((r) => r.message_id),
  };
}

/**
 * 담기. 이미 있으면 `open` 으로 되돌린다 — 두 번 담아도 행은 하나다(결정 1).
 *
 * `'forbidden'` 과 `'not_found'` 를 나누는 이유: 볼 수 없는 채널의 메시지를 404 로 답하면
 * 존재 여부까지 감출 수 있어 그쪽이 더 조심스럽지만, #219 는 403 으로 정했다 — 담기는
 * 언제나 내가 이미 본 메시지에서 시작하므로 "왜 안 되는가"를 말해 주는 편이 맞다.
 */
export async function saveMessage(
  pool: Pool,
  args: { accountId: string; messageId: string },
): Promise<SavedMessageRow | 'not_found' | 'forbidden'> {
  const found = await pool.query(
    // 이미 삭제된 메시지는 애초에 담을 수 없다 — `getMessageById` 와 같은 판정이다.
    `select channel_id from message where id = $1 and deleted_at is null`,
    [args.messageId],
  );
  if (!found.rowCount) return 'not_found';
  const channelId = found.rows[0]!.channel_id as string;

  // 가시성 규칙을 여기서 다시 쓰지 않는다 — `channelVisibleSql` 하나가 그것을 안다.
  // 멤버십을 따로 요구하면 **public 채널의 메시지를 담을 수 없게 된다**(비멤버도 볼 수 있다).
  const visible = await pool.query(
    `select ${channelVisibleSql('c', '$2')} as visible from channel c where c.id = $1`,
    [channelId, args.accountId],
  );
  if (!visible.rowCount || !visible.rows[0]!.visible) return 'forbidden';

  await pool.query(
    `insert into saved_message (account_id, message_id, state)
     values ($1, $2, 'open')
     on conflict (account_id, message_id) do update set state = 'open', done_at = null`,
    [args.accountId, args.messageId],
  );

  const rows = await selectSavedMessages(pool, args.accountId, 'open', args.messageId);
  return rows[0] ?? 'not_found';
}

export async function unsaveMessage(
  pool: Pool,
  args: { accountId: string; messageId: string },
): Promise<'unsaved' | 'not_found'> {
  const res = await pool.query(
    `delete from saved_message where account_id = $1 and message_id = $2 returning 1`,
    [args.accountId, args.messageId],
  );
  return res.rowCount ? 'unsaved' : 'not_found';
}

export async function updateSavedMessageState(
  pool: Pool,
  args: { accountId: string; messageId: string; state: 'open' | 'done' },
): Promise<SavedMessageRow | 'not_found'> {
  const res = await pool.query(
    // `done_at` 은 **DB 의 시계**로 찍는다(테이블의 `created_at` 기본값과 같은 시계다).
    // 앱에서 만든 시각을 실으면 두 컬럼이 서로 다른 시계에서 와 정렬이 어긋난다.
    `update saved_message
     set state = $3, done_at = case when $3 = 'done' then now() else null end
     where account_id = $1 and message_id = $2
     returning account_id`,
    [args.accountId, args.messageId, args.state],
  );
  if (!res.rowCount) return 'not_found';

  const rows = await selectSavedMessages(pool, args.accountId, args.state, args.messageId);
  return rows[0] ?? 'not_found';
}
