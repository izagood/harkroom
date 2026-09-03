import type { Pool } from 'pg';
import type { MessageRow, PinRow } from '@murmur/shared';
import { COLS as MESSAGE_COLS, type MutationRefusal } from './messages.js';

/** 핀 질의가 돌려주는 평평한 행. 메시지 컬럼 옆에 핀 두 컬럼이 붙어 온다. */
type PinnedMessageRow = MessageRow & { pinnedBy: string; pinnedAt: string };

function toPin({ pinnedBy, pinnedAt, ...message }: PinnedMessageRow): PinRow {
  return { messageId: message.id, channelId: message.channelId, pinnedBy, pinnedAt, message };
}

/**
 * 핀 목록 질의. `messageId` 를 주면 그 하나만 본다.
 *
 * **lateral 인 이유**: `MESSAGE_COLS` 는 `channel_id as "channelId"` 처럼 테이블을 붙이지 않은
 * 컬럼을 쓰는데, `message_pin` 에도 `channel_id` 가 있어 같은 FROM 에 두면 모호해진다.
 * 안쪽 서브질의의 스코프에는 `message` 만 들어 있어 그 모호함이 생기지 않고, `MESSAGE_COLS`
 * 안의 `message.` 접두사(리액션·첨부 서브질의)도 그대로 맞는다.
 *
 * **`deleted_at is null` 이 조인 조건 안에 있는 것이 핵심이다**(#218 결정 3): 지워진 메시지의
 * 핀은 행을 남겨 두고 나중에 거르는 것이 아니라, 안쪽이 0 행을 내어 조인 자체에서 사라진다.
 * 삭제 경로에 핀 정리를 얹지 않는 이유가 이것이다 — 그 경로를 늘리고 빠뜨리면 지운 메시지
 * 본문이 핀 목록으로 샌다.
 */
async function selectPins(pool: Pool, channelId: string, messageId: string | null): Promise<PinRow[]> {
  const res = await pool.query(
    `select m.*, p.pinned_by as "pinnedBy", p.pinned_at as "pinnedAt"
     from message_pin p
     join lateral (
       select ${MESSAGE_COLS} from message
       where message.id = p.message_id and message.deleted_at is null
     ) m on true
     where p.channel_id = $1 and ($2::uuid is null or p.message_id = $2::uuid)
     order by p.pinned_at desc`,
    [channelId, messageId],
  );
  return (res.rows as PinnedMessageRow[]).map(toPin);
}

export function listPins(pool: Pool, channelId: string): Promise<PinRow[]> {
  return selectPins(pool, channelId, null);
}

/**
 * 메시지를 고정한다. 없는 메시지(또는 다른 채널의 메시지, 지워진 메시지)면 `'not_found'`.
 *
 * **채널 id 를 메시지 행에서 읽어 넣는다** — 클라이언트가 준 값을 복제하면 `message_pin.channel_id`
 * 가 `message.channel_id` 와 어긋날 수 있고, 그러면 복제해 둔 값이 거짓말을 한다. where 절이
 * 둘이 같은지까지 확인하므로 남의 채널 경로로 남의 메시지를 고정할 수도 없다.
 *
 * 이미 고정된 것을 다시 고정하는 것도 성공이다 — 결과 상태가 같으니 재시도가 안전하다.
 * 그래서 insert 의 rowCount 로 판정하지 않는다: 0 은 '고정할 수 없는 메시지'와 '이미 고정됨'
 * 둘 다이고, 둘을 섞으면 재시도가 404 가 된다.
 */
export async function pinMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string },
): Promise<PinRow | 'not_found'> {
  await pool.query(
    `insert into message_pin (message_id, channel_id, pinned_by)
     select message.id, message.channel_id, $3
     from message
     where message.id = $1 and message.channel_id = $2 and message.deleted_at is null
     on conflict (message_id) do nothing`,
    [args.messageId, args.channelId, args.actorId],
  );
  const pins = await selectPins(pool, args.channelId, args.messageId);
  return pins[0] ?? 'not_found';
}

/**
 * 고정을 해제한다. **고정한 사람 또는 admin 만** 할 수 있다(#218 결정 2).
 *
 * 고정 자체는 글을 쓸 수 있는 사람 누구나 하는 대화 행위인데 해제만 좁히는 이유: 남이 올린
 * 핀을 아무나 내릴 수 있으면 핀이 신호가 되지 못한다. 삭제(`deleteMessage`)가 작성자 또는
 * admin 인 것과 같은 모양이다.
 */
export async function unpinMessage(
  pool: Pool, args: { channelId: string; messageId: string; actorId: string; actorIsAdmin: boolean },
): Promise<'unpinned' | MutationRefusal> {
  const found = await pool.query(
    `select pinned_by from message_pin where message_id = $1 and channel_id = $2`,
    [args.messageId, args.channelId],
  );
  if (!found.rowCount) return 'not_found';
  if (found.rows[0].pinned_by !== args.actorId && !args.actorIsAdmin) return 'forbidden';
  await pool.query(`delete from message_pin where message_id = $1`, [args.messageId]);
  return 'unpinned';
}
