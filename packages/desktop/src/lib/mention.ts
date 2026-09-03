import { CHANNEL_MENTION_HANDLE, MENTION_PATTERN, mentionedHandles, stripCodeSpans } from '@murmur/shared';

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
 * @param knownHandles 계정 handle 목록
 * @param groupHandles 집합 handle 목록. 이 목록에 있으면 `isGroup` 플래그가 켜진다.
 */
export function splitMentions(body: string, knownHandles: string[], groupHandles: string[] = []): MessagePart[] {
  // `@channel`(#225)은 그 handle 의 계정이 없어도 칠한다 — 서버가 채널 전체에 알림을
  // 보내기 때문이다. 여기서 빼면 위 주석이 경계하는 바로 그 불일치가 된다: 강조되지 않은
  // 것이 몰래 알림을 보낸다. 계정이 있으면 `knownHandles` 에 이미 들어 있어 중복이 없다.
  const known = new Set([...knownHandles.map((h) => h.toLowerCase()), CHANNEL_MENTION_HANDLE]);
  const groupSet = new Set(groupHandles.map((h) => h.toLowerCase()));
  const parts: MessagePart[] = [];
  let cursor = 0;

  for (const m of body.matchAll(MENTION_IN_TEXT)) {
    const handle = (m[2] ?? '').toLowerCase();
    if (!known.has(handle) && !groupSet.has(handle)) continue;
    // m.index 는 선행 문자를 포함한다 — @ 의 실제 위치를 다시 계산한다.
    const at = m.index + (m[1] ?? '').length;
    if (at > cursor) parts.push({ kind: 'text', text: body.slice(cursor, at) });
    parts.push({ kind: 'mention', text: `@${m[2]}`, handle, isGroup: groupSet.has(handle) });
    cursor = at + 1 + (m[2] ?? '').length;
  }
  if (cursor < body.length) parts.push({ kind: 'text', text: body.slice(cursor) });
  return parts.length ? parts : [{ kind: 'text', text: body }];
}

/** 보내기 전에 보여 줄 한 항목. `kind` 는 표시에만 쓰인다 — 판정은 이미 끝났다. */
export interface BodyRecipient {
  handle: string;
  /** `account` | `group`(집합, #230) | `channel`(채널 전체, #225) */
  kind: 'account' | 'group' | 'channel';
}

/**
 * 지금 본문이 부를 상대(#278). **`splitMentions` 을 그대로 통과시킨다** — 새 정규식을
 * 쓰지 않는 것이 이 함수의 존재 이유다. 보내기 전 목록과 보낸 뒤 강조가 서로 다른 규칙을
 * 쓰면 이 기능이 막으려는 착각을 오히려 만든다: 목록에 없던 사람에게 알림이 가거나,
 * 목록에 있던 사람에게 가지 않는다.
 *
 * 그래서 호출부는 `MessageBody` 와 **같은 인자**를 준다(계정 handle 전부, 집합 handle 전부).
 * `@channel`(#225)은 계정이 없어도 대상이다 — `splitMentions` 가 이미 그렇게 판정하고
 * 서버도 채널 전체에 알림을 넣는다. 여기서 빼면 `@channel` 을 쓴 사람만 자기가 누구를
 * 부르는지 못 보게 된다.
 *
 * 작성자 자신은 뺀다. `splitMentions` 는 자기 멘션도 칠하지만(`data-self`) 서버는 알림에서
 * 작성자를 걸러 낸다(`services/messages.ts`). "부를 상대" 는 알림이 갈 사람의 목록이므로
 * 자기 이름이 남으면 거짓이 된다. **판정이 아니라 표시 단계의 결정**이라 여기서 한다.
 *
 * 코드 블록 안의 `@handle` 은 여기서 **잡히지 않는다**(#298). 이 줄은 알림이 실제로 가는
 * 쪽을 따라야 하고, 이제 서버도 `stripCodeSpans` 로 코드 안을 제외한다 — 그러므로 이
 * 목록도 같은 함수를 쓴다. 앞의 결정("안 갈 사람을 보여 주는 것보다 갈 사람을 숨기는 것이
 * 더 나쁜 거짓말")은 그대로다: 바뀐 것은 **알림이 가는 범위** 자체이지 이 줄의 원칙이
 * 아니다. 여기서 따로 정규식을 쓰면 판정이 다시 두 벌이 된다.
 */
export function bodyRecipients(
  body: string,
  knownHandles: string[],
  groupHandles: string[],
  selfHandle?: string | null,
): BodyRecipient[] {
  const accountSet = new Set(knownHandles.map((h) => h.toLowerCase()));
  const self = selfHandle?.toLowerCase() ?? null;
  const seen = new Set<string>();
  const out: BodyRecipient[] = [];

  for (const part of splitMentions(stripCodeSpans(body), knownHandles, groupHandles)) {
    if (part.kind !== 'mention') continue;
    if (part.handle === self || seen.has(part.handle)) continue;
    seen.add(part.handle);
    // 계정이 이긴다 — 서버(`services/messages.ts`)와 같은 순서다. `@channel` 이라는
    // 이름의 계정이 있으면 그 사람이 대상이고, 채널 전체가 아니다.
    const kind = accountSet.has(part.handle)
      ? 'account'
      : part.isGroup
        ? 'group'
        : 'channel';
    out.push({ handle: part.handle, kind });
  }
  return out;
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
