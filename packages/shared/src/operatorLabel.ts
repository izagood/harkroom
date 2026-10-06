/**
 * 오퍼레이터 이름(`label`) 정리 — 서버(`PATCH /operators/:id`)와 앱이 **같은 함수**를 쓴다.
 * 한쪽만 정리하면 앱이 "바뀐 것 없음"으로 본 이름을 서버가 다르게 저장하거나 그 반대가 된다.
 *
 * - 줄바꿈·탭·특수 공백은 공백 하나로 접는다(이름은 한 줄이다).
 * - 화면에 보이지 않는 글자(제어·서식 문자 — 폭 없는 글자, 글자 방향을 바꾸는 글자 등)는 지운다.
 *   이름은 목록·고르개에서 기계를 가려 보는 표지라 보이는 글자만 남긴다.
 *   다만 이모지를 잇는 ZWJ(U+200D)는 **그림 글자 사이에서만** 남긴다 — 👩‍💻 같은 이름이 깨지지 않게.
 * - 앞뒤 공백을 자르고, 남는 것이 없으면 `null`(= 호스트명으로 돌아간다).
 */
export function normalizeOperatorLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const out = raw
    .replace(/[\s\u0085]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, (m: string, at: number, all: string) => (m === '‍' && joinsEmoji(all, at) ? m : ''))
    .trim();
  return out === '' ? null : out;
}

const PICTO = /\p{Extended_Pictographic}/u;

/** `at` 자리의 ZWJ 가 그림 글자(+ 변이 선택자 FE0F)와 그림 글자 사이에 있나. */
function joinsEmoji(all: string, at: number): boolean {
  const before = Array.from(all.slice(0, at).replace(/️$/u, '')).at(-1);
  const after = Array.from(all.slice(at + 1)).at(0);
  return !!before && !!after && PICTO.test(before) && PICTO.test(after);
}

/** 이름 상한 — 서버와 앱이 같다(등록 이름 상한과 같다). 정리한 **뒤의** 길이로 잰다. */
export const OPERATOR_LABEL_MAX = 64;
