import { CHANNEL_MENTION_HANDLE, MENTION_PATTERN, MENTION_TOKEN_PATTERN, mentionedHandles, renderMentions } from '@murmur/shared';

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
  | { kind: 'mention'; text: string; handle: string; isGroup?: boolean };

/**
 * 본문을 텍스트와 멘션 조각으로 나눈다. **존재하는 handle 만** 멘션으로 표시한다 —
 * 아무 @단어나 칠하면 오타가 멘션처럼 보이고, 사용자가 알림이 갔다고 착각한다.
 *
 * @param body 입력 본문 (<@id> 또는 @handle 형식)
 * @param knownHandles 알려진 handle 목록
 * @param accountsMap (선택) account ID -> handle 맵. 있으면 <@id> 토큰을 현재 handle 로 렌더링한다.
 * @param groupHandles (선택) 집합 handle 목록. 이 목록에 있으면 `isGroup` 플래그가 켜진다.
 */
export function splitMentions(body: string, knownHandles: string[], accountsMap?: Map<string, string>, groupHandles: string[] = []): MessagePart[] {
  // <@id> 토큰이 있으면 현재 handle 로 렌더링한다(#271)
  let processedBody = body;
  if (accountsMap && accountsMap.size > 0) {
    processedBody = renderMentions(body, accountsMap, '알 수 없음');
  }
  // `@channel`(#225)은 그 handle 의 계정이 없어도 칠한다 — 서버가 채널 전체에 알림을
  // 보내기 때문이다. 여기서 빼면 위 주석이 경계하는 바로 그 불일치가 된다: 강조되지 않은
  // 것이 몰래 알림을 보낸다. 계정이 있으면 `knownHandles` 에 이미 들어 있어 중복이 없다.
  const known = new Set([...knownHandles.map((h) => h.toLowerCase()), CHANNEL_MENTION_HANDLE]);
  const groupSet = new Set(groupHandles.map((h) => h.toLowerCase()));
  const parts: MessagePart[] = [];
  let cursor = 0;

  for (const m of processedBody.matchAll(MENTION_IN_TEXT)) {
    const handle = (m[2] ?? '').toLowerCase();
    if (!known.has(handle) && !groupSet.has(handle)) continue;
    // m.index 는 선행 문자를 포함한다 — @ 의 실제 위치를 다시 계산한다.
    const at = m.index + (m[1] ?? '').length;
    if (at > cursor) parts.push({ kind: 'text', text: processedBody.slice(cursor, at) });
    parts.push({ kind: 'mention', text: `@${m[2]}`, handle, isGroup: groupSet.has(handle) });
    cursor = at + 1 + (m[2] ?? '').length;
  }
  if (cursor < processedBody.length) parts.push({ kind: 'text', text: processedBody.slice(cursor) });
  return parts.length ? parts : [{ kind: 'text', text: processedBody }];
}

/**
 * 고정해 둔 상대를 본문 앞에 붙인다. 이미 본문이 부르고 있는 handle 은 건너뛴다 —
 * 알림은 어차피 한 번이지만, `@fizz @fizz` 는 읽는 사람에게 잡음이다.
 * 고정된 순서를 그대로 쓴다: 부른 순서가 바뀌면 사용자는 목록을 매번 다시 읽어야 한다.
 */
export function withStickyMentions(body: string, sticky: string[]): string {
  const already = new Set(mentionedHandles(body));
  const missing = sticky.filter((h) => !already.has(h.toLowerCase()));
  return missing.length ? `${missing.map((h) => `@${h}`).join(' ')} ${body}` : body;
}

/** 방금 보낸 본문에서 새로 불린 상대를 뒤에 더한다. 이미 고정된 것의 순서는 흔들지 않는다. */
export function keepMentioned(sticky: string[], body: string, known: Set<string>): string[] {
  const kept = new Set(sticky);
  const added = mentionedHandles(body).filter((h) => known.has(h) && !kept.has(h));
  return added.length ? [...sticky, ...added] : sticky;
}
