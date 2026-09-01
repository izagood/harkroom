import type { Pool } from 'pg';

/**
 * 한 사람이 한 메시지에 달 수 있는 서로 다른 이모지의 수. 제한이 없으면 한 명이 수백 개를
 * 달아 저장소와 화면을 동시에 망가뜨릴 수 있다.
 */
export const MAX_REACTIONS_PER_ACTOR = 20;

/**
 * 리액션으로 받아들일 문자. 임의 문자열을 허용하면 리액션이 길이 제한도 검열도 없는 두 번째
 * 본문 필드가 된다. 그림문자(그리고 그것을 잇는 ZWJ·variation selector·skin tone)만 통과시킨다.
 */
const EMOJI_ONLY = /^\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|[️\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}])*$/u;

export function isEmoji(value: string): boolean {
  // 복합 이모지도 이 정도면 충분하다. 더 긴 것은 이모지가 아니라 문자열이다.
  return value.length > 0 && value.length <= 32 && EMOJI_ONLY.test(value);
}

export type ReactionResult = 'added' | 'not_found' | 'too_many';

/** 리액션 대상이 이 채널에 실제로 살아 있는지. 삭제된 메시지에 붙으면 되살아난 것처럼 보인다. */
async function messageIsHere(pool: Pool, channelId: string, messageId: string): Promise<boolean> {
  const res = await pool.query(
    `select 1 from message where id = $1 and channel_id = $2 and deleted_at is null`,
    [messageId, channelId],
  );
  return res.rowCount === 1;
}

export async function addReaction(
  pool: Pool, input: { channelId: string; messageId: string; accountId: string; emoji: string },
): Promise<ReactionResult> {
  if (!(await messageIsHere(pool, input.channelId, input.messageId))) return 'not_found';

  // 이미 눌러 둔 것을 다시 누르는 것은 한도에 걸리지 않아야 한다 — 더블클릭이 409 를 받으면
  // 사용자는 자기가 무엇을 잘못했는지 알 수 없다.
  const already = await pool.query(
    `select emoji from message_reaction where message_id = $1 and account_id = $2`,
    [input.messageId, input.accountId],
  );
  const mine = already.rows.map((r) => r.emoji as string);
  if (!mine.includes(input.emoji) && mine.length >= MAX_REACTIONS_PER_ACTOR) return 'too_many';

  await pool.query(
    `insert into message_reaction (message_id, account_id, emoji) values ($1, $2, $3)
     on conflict do nothing`,
    [input.messageId, input.accountId, input.emoji],
  );
  return 'added';
}

/** 없는 것을 떼는 것도 성공이다 — 결과 상태가 같으므로 클라이언트가 재시도해도 안전하다. */
export async function removeReaction(
  pool: Pool, input: { messageId: string; accountId: string; emoji: string },
): Promise<void> {
  await pool.query(
    `delete from message_reaction where message_id = $1 and account_id = $2 and emoji = $3`,
    [input.messageId, input.accountId, input.emoji],
  );
}
