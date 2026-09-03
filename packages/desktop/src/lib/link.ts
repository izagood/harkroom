import { parseMessagePermalink } from '@murmur/shared';
import type { MessagePart } from './mention';

/**
 * 본문 안의 링크가 눌렸을 때 **어디로 가는가**. 두 갈래뿐인 이유가 요점이다:
 * `murmur://` 는 OS 가 모르는 스킴이라 셸로 보내면 아무 일도 일어나지 않는다(#178).
 */
export type LinkTarget =
  /** OS 브라우저로 넘긴다. `href` 는 정규화된 절대 URL 이다. */
  | { kind: 'external'; href: string }
  /** 앱 안에서 그 메시지로 이동한다(`controller.openMessage`). */
  | { kind: 'message'; messageId: string };

/**
 * **OS 로 열어도 되는 스킴의 전부.** 허용 목록인 것이 핵심이다 — 금지 목록은 새 스킴이
 * 생길 때마다 뚫리고, 뚫린 줄도 모른다. 사용자와 에이전트가 쓴 글자가 클릭 가능한 동작이
 * 되는 순간부터 이 집합이 신뢰 경계다.
 */
const OPENABLE_SCHEMES = new Set(['http:', 'https:']);

/**
 * URL 후보를 **넓게** 집는다. `://` 를 요구하지 않는 것이 의도다 — 좁게 집으면
 * `javascript:alert(1)` 이 애초에 후보가 되지 못해, 스킴 검사가 없어도 테스트가 초록이
 * 된다. 방어선은 판정(`classifyLink`) 한 곳에만 있어야 실재를 확인할 수 있다.
 *
 * 순수 URL 만 본다 — `owner/repo#123` 같은 참조 문법은 넣지 않는다. 평범한 텍스트가
 * 링크로 오인되면 사람이 무엇이 링크인지 믿지 못한다.
 */
export const URL_CANDIDATE = /[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+/g;

/**
 * 문장 끝에 붙어 온 문장부호는 URL 이 아니다 — `자세히는 https://a.io/b.` 의 마침표까지
 * 링크에 넣으면 열리지 않는 주소가 된다. 짝이 맞는 괄호는 남긴다(위키 주소가 실제로 쓴다).
 */
function trimTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0) {
    const ch = token[end - 1]!;
    if ('.,;:!?\'"'.includes(ch)) { end -= 1; continue; }
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      const slice = token.slice(0, end);
      const balanced = slice.split(open).length <= slice.split(ch).length;
      if (balanced) { end -= 1; continue; }
    }
    break;
  }
  return token.slice(0, end);
}

/**
 * 이 글자를 링크로 만들어도 되는가. 안 되면 **null** 이고, 그러면 그냥 글자로 남는다 —
 * 막는 것이 아니라 애초에 누를 것이 생기지 않는다.
 *
 * `new URL` 로 정규화한 뒤 판정하는 이유: 스킴의 대소문자와 앞뒤 공백을 손으로 다루면
 * `JaVaScRiPt:` 같은 변형에서 갈라진다. 표준 파서가 이미 하는 일을 다시 쓰지 않는다.
 */
export function classifyLink(raw: string): LinkTarget | null {
  const trimmed = raw.trim();
  // 앱 안 좌표가 먼저다 — 이것은 스킴 허용 목록의 대상이 아니라 OS 를 아예 거치지 않는다.
  const messageId = parseMessagePermalink(trimmed);
  if (messageId) return { kind: 'message', messageId };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!OPENABLE_SCHEMES.has(url.protocol)) return null;
  return { kind: 'external', href: url.href };
}

/** 멘션 조각에 링크 조각이 하나 더 붙은 것. 멘션 강조는 그대로 살아 있다. */
export type BodyPart = MessagePart | { kind: 'link'; text: string; target: LinkTarget };

/**
 * 멘션으로 이미 나뉜 조각들의 **텍스트 부분만** 다시 링크로 나눈다. 멘션 조각은 손대지
 * 않는다 — 링크 인식을 얹는다고 기존 강조가 흔들리면 안 된다.
 */
export function splitLinks(parts: MessagePart[]): BodyPart[] {
  const out: BodyPart[] = [];
  for (const part of parts) {
    if (part.kind !== 'text') { out.push(part); continue; }
    let cursor = 0;
    for (const m of part.text.matchAll(URL_CANDIDATE)) {
      const token = trimTrailingPunctuation(m[0]);
      const target = token ? classifyLink(token) : null;
      // 허용되지 않은 스킴은 조각을 만들지 않고 흘려보낸다 — 뒤의 text 조각에 그대로 남는다.
      if (!target) continue;
      if (m.index > cursor) out.push({ kind: 'text', text: part.text.slice(cursor, m.index) });
      out.push({ kind: 'link', text: token, target });
      cursor = m.index + token.length;
    }
    if (cursor < part.text.length) out.push({ kind: 'text', text: part.text.slice(cursor) });
  }
  return out.length ? out : parts;
}
