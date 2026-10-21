/**
 * 에이전트 화면의 「연동에서 … →」 링크가 연동 › MCP 서버의 **그 줄**을 가리키게 하는 한 칸짜리 우편함(시안 v2 §7).
 *
 * 설정 화면은 섹션을 `onOpenSection` 하나로만 바꾼다 — 섹션 사이에 인자를 실을 길이 없어, 링크가 이름을 여기 두고
 * 섹션을 바꾸면 연동 화면이 그려진 뒤 한 번 꺼내 그 줄로 스크롤하고 잠깐 강조한다. 꺼내면 비운다.
 */
let pending: string | null = null;

export function requestMcpFocus(name: string): void {
  pending = name;
}

export function takeMcpFocus(): string | null {
  const name = pending;
  pending = null;
  return name;
}
