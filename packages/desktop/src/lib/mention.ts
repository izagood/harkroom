import { MENTION_PATTERN } from '@murmur/shared';

// 멘션 문법은 @murmur/shared 에 있다 — 서버의 알림 발송과 같은 규칙을 봐야 한다. 갈라지면
// 두 방향으로 거짓말을 한다: 강조되지 않은 것이 몰래 알림을 보내거나(me@x.com), 강조된
// 것이 알림을 보내지 않는다(@Fizz).
const MENTION_IN_TEXT = new RegExp(MENTION_PATTERN, 'g');

/** 커서 바로 앞의 미완성 @토큰. 자동완성은 @ 만 쳐도 떠야 하므로 0자를 허용한다. */
const PARTIAL_AT_CARET = new RegExp(`(^|[^a-zA-Z0-9_-])@([a-zA-Z0-9_-]{0,32})$`);

export interface MentionQuery {
  /** @ 뒤에 이미 입력된 부분. 빈 문자열이면 방금 @ 를 쳤다는 뜻이다. */
  query: string;
  /** @ 문자의 위치. 치환할 구간의 시작이다. */
  start: number;
}

/** 지금 커서 자리에서 자동완성을 띄워야 하는가. 아니면 null. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const m = PARTIAL_AT_CARET.exec(before);
  if (!m) return null;
  const query = m[2] ?? '';
  return { query, start: caret - query.length - 1 };
}

/** 미완성 토큰을 고른 handle 로 치환한다. 커서 뒤 글자는 보존한다(중간 삽입). */
export function applyMention(
  text: string, q: MentionQuery, handle: string,
): { text: string; caret: number } {
  const head = text.slice(0, q.start);
  const tail = text.slice(q.start + 1 + q.query.length);
  const inserted = `@${handle} `;
  return { text: `${head}${inserted}${tail}`, caret: head.length + inserted.length };
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; handle: string };

/**
 * 본문을 텍스트와 멘션 조각으로 나눈다. **존재하는 handle 만** 멘션으로 표시한다 —
 * 아무 @단어나 칠하면 오타가 멘션처럼 보이고, 사용자가 알림이 갔다고 착각한다.
 */
export function splitMentions(body: string, knownHandles: string[]): MessagePart[] {
  const known = new Set(knownHandles.map((h) => h.toLowerCase()));
  const parts: MessagePart[] = [];
  let cursor = 0;

  for (const m of body.matchAll(MENTION_IN_TEXT)) {
    const handle = (m[2] ?? '').toLowerCase();
    if (!known.has(handle)) continue;
    // m.index 는 선행 문자를 포함한다 — @ 의 실제 위치를 다시 계산한다.
    const at = m.index + (m[1] ?? '').length;
    if (at > cursor) parts.push({ kind: 'text', text: body.slice(cursor, at) });
    parts.push({ kind: 'mention', text: `@${m[2]}`, handle });
    cursor = at + 1 + (m[2] ?? '').length;
  }
  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) });
  return parts.length ? parts : [{ kind: 'text', text: body }];
}
