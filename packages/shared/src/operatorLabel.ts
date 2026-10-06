/**
 * 오퍼레이터 이름(`label`) 정리 — 서버(`PATCH /operators/:id`)와 앱이 **같은 함수**를 쓴다.
 * 한쪽만 정리하면 앱이 "바뀐 것 없음"으로 본 이름을 서버가 다르게 저장하거나 그 반대가 된다.
 *
 * - 줄바꿈·탭·특수 공백은 공백 하나로 접는다(이름은 한 줄이다).
 * - 화면에 보이지 않거나 빈칸처럼 보이는 글자(제어·서식 문자, 기본적으로 무시되는 글자, 점자 빈칸)와
 *   짝 없는 서러게이트는 지운다.
 *   이름은 목록·고르개에서 기계를 가려 보는 표지라 보이는 글자만 남긴다.
 * - 다만 이모지를 이루는 것은 남긴다:
 *   - ZWJ(U+200D)는 그림 글자(피부색 수식 글자·FE0F 뒤 포함)와 그림 글자 **사이에서만** — 👩🏽‍💻
 *   - 변이 선택자 FE0E·FE0F 는 이모지가 될 수 있는 글자 **바로 뒤에서만** — ❤️, 1️⃣
 *   - 태그 글자는 검은 깃발 뒤의 **지역 깃발 줄 안에서만** — 🏴 + 소문자·숫자 태그 3~7개 + 끝 태그
 * - 판정은 원문 기준이다(지운 뒤의 이웃으로 다시 보지 않는다).
 * - 앞뒤 공백을 자르고, 남는 것이 없으면 `null`(= 호스트명으로 돌아간다).
 */
export function normalizeOperatorLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cps = Array.from(raw.replace(/[\s\u0085]+/gu, ' '));
  const flag = flagTagPositions(cps);
  let out = '';
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (!INVISIBLE.test(c) || flag.has(i) || keepJoiner(cps, i) || keepSelector(cps, i)) out += c;
  }
  out = out.trim();
  return out === '' ? null : out;
}

/** 지울 후보 — 제어·서식 문자, 짝 없는 서러게이트, 기본적으로 무시되는 글자, 점자 빈칸(U+2800). */
const INVISIBLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}⠀]$/u;
const PICTO = /^\p{Extended_Pictographic}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const EMOJI = /^\p{Emoji}$/u;
const BLACK_FLAG = '\u{1F3F4}';
/** 지역 깃발 태그 — 소문자 a~z·숫자 0~9 만(ISO 3166-2 꼴). */
const TAG = /^[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]$/u;
const FLAG_TAGS_MIN = 3;
const FLAG_TAGS_MAX = 7;
const CANCEL_TAG = '\u{E007F}';

/** ZWJ 가 (그림 글자 | 피부색 수식 글자) [FE0F] 와 그림 글자 사이에 있나. */
function keepJoiner(cps: string[], i: number): boolean {
  if (cps[i] !== '‍') return false;
  let b = i - 1;
  if (cps[b] === '️') b -= 1;
  const before = cps[b];
  const after = cps[i + 1];
  return !!before && !!after && (PICTO.test(before) || MODIFIER.test(before)) && PICTO.test(after);
}

/** 변이 선택자가 이모지가 될 수 있는 글자 바로 뒤에 있나. */
function keepSelector(cps: string[], i: number): boolean {
  if (cps[i] !== '️' && cps[i] !== '︎') return false;
  const before = cps[i - 1];
  return !!before && EMOJI.test(before);
}

/** 🏴 + 소문자·숫자 태그 3~7개 + 끝 태그 — 지역 깃발 줄에 든 태그 글자의 자리. 그 밖의 태그 줄은 지운다. */
function flagTagPositions(cps: string[]): Set<number> {
  const keep = new Set<number>();
  for (let i = 0; i < cps.length; i++) {
    if (cps[i] !== BLACK_FLAG) continue;
    let j = i + 1;
    while (j < cps.length && j - i <= FLAG_TAGS_MAX && TAG.test(cps[j]!)) j++;
    const count = j - i - 1;
    if (count >= FLAG_TAGS_MIN && count <= FLAG_TAGS_MAX && cps[j] === CANCEL_TAG) {
      for (let k = i + 1; k <= j; k++) keep.add(k);
      i = j;
    }
  }
  return keep;
}

/** 이름 상한 — 서버와 앱이 같다(등록 이름 상한과 같다). 정리한 **뒤의** 길이로 잰다. */
export const OPERATOR_LABEL_MAX = 64;
