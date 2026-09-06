// 한국어 조사 — 화면 문장이 두 자리에서 만들어지므로 규칙도 한 자리에 둔다
// (스레드 패널의 사슬 줄과 채널 요약의 말 슬롯).
/**
 * 받침에 따라 `이/가` 를 고른다. handle 은 영문이 흔하지만 한글 이름도 온다 —
 * `codex 가` 와 `민수가` 가 한 줄에 섞이므로 한쪽으로 고정할 수 없다.
 *
 * 영문·숫자로 끝나면 받침을 알 수 없으므로 `가` 로 둔다: 화면에서 읽히는 대부분이
 * `forge 가`·`codex 가` 이고, 그쪽이 자연스럽다.
 */
export function subjectParticle(word: string): string {
  const last = word.charCodeAt(word.length - 1);
  const isHangul = last >= 0xac00 && last <= 0xd7a3;
  if (!isHangul) return ' 가';
  // 한글 음절은 (초성 × 21 + 중성) × 28 + 종성 구조다 — 종성이 0 이면 받침이 없다.
  return (last - 0xac00) % 28 === 0 ? '가' : '이';
}
