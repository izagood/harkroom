/**
 * 서버 알림 줄의 멘션 원칙(architect A안, 소유자 결정 2026-11-03).
 *
 * 서버가 세우는 시스템·알림 줄(`kind: 'system'`·`serverNotice`)의 본문에 **사람·에이전트·외부 도구가 쓴 글**(제목·이유·경로·
 * 규칙 원문·이름 등)이 한 글자라도 들어가면 그 줄은 아무도 부르지 않아야 한다. `postMessage` 는 kind 와 상관없이 본문의
 * 멘션을 푼다 — 남이 쓴 글 속 `@…` 가 서버 이름으로 낸 줄을 통해 실제 부름이 된다.
 *
 * - 일부러 부르는 줄이 **아니면** `postMessage(..., { noMentions: true })` 를 켠다(부름·inbox·mentionRefs 를 만들지 않는다).
 * - 일부러 한 사람을 부르는 줄(소유자 알림의 `@소유자` 등)은 옵션을 켤 수 없다 — 그때는 남이 쓴 조각을 `plainNoticeText` 로
 *   감싸 `@` 를 무력화하고, 부름은 서버가 붙인 `@handle` 하나만 남긴다.
 *
 * 새 호출 자리는 `test/serverNoticeMentions.test.ts` 의 표에 이유와 함께 올려야 시험이 통과한다.
 */
export function plainNoticeText(s: string): string {
  return s.replace(/@/g, '＠');
}
