import type { Message, Plural, TransArgs } from './types';

/**
 * 번역문 하나를 완성한다 — **보간 · 복수형 · 조사** 셋이 전부다.
 *
 * 이 파일이 라이브러리를 대신하는 자리이므로, 무엇을 **안 하는지**부터 적는다:
 * 날짜·숫자 서식(`Intl.DateTimeFormat`·`NumberFormat` 이 이미 한다 — `day.ts` 가
 * 그렇게 쓰고 있다), 언어 지연 로딩(사전 둘이 합쳐 몇 KB 다), 중첩 키 조회
 * (키가 평면 문자열이라 `Map` 조회 한 번이다).
 */

/**
 * 복수형을 고른다. **`Intl.PluralRules` 가 판단하고 우리는 안 판단한다.**
 *
 * `count === 1 ? one : other` 로 손으로 쓰면 영어만 맞는다 — 러시아어는 2~4 가
 * `few` 이고 21 이 다시 `one` 이다. 세 번째 언어를 붙일 때 **이 파일을 안 고치게
 * 하는 것**이 여기서 플랫폼에 맡기는 이유다.
 *
 * 그 언어에 없는 갈래는 `other` 로 떨어진다 — 한국어 사전이 `other` 만 적는 것이
 * 누락이 아닌 것과 같은 사정이다(`ko.ts` 머리말).
 */
function pickPlural(plural: Plural, count: number, locale: string): string {
  let category: Intl.LDMLPluralRule;
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // 알 수 없는 로케일 태그. 사전이 있는데 서식 때문에 화면이 비는 것이 더 나쁘다.
    category = count === 1 ? 'one' : 'other';
  }
  return plural[category] ?? plural.other;
}

/**
 * 한국어 조사 — **`{이름:이가}` 표기를 받침 보고 푼다.**
 *
 * `subjectParticle` 이 하던 일이 여기로 온다. 옮긴 이유: 그 함수는 **화면이** 이름과
 * 조사를 이어 붙이는 것을 전제했는데, 그러면 영어 화면도 그 조립을 지나야 한다.
 * 조립이 번역기 안으로 들어오면 **영어는 이 코드를 안 지난다**(영어 사전에 `:이가`
 * 표기가 없으므로 아래 정규식이 아무것도 안 잡는다).
 *
 * 판정 규칙 자체는 원래 것 그대로다 — 영문·숫자로 끝나면 받침을 알 수 없어 `가` 로
 * 두고(화면에서 읽히는 대부분이 `forge 가`·`codex 가` 다), 한글이면 종성으로 가른다.
 */
const PARTICLES: Record<string, [withFinal: string, withoutFinal: string]> = {
  이가: ['이', '가'],
  은는: ['은', '는'],
  을를: ['을', '를'],
  과와: ['과', '와'],
};

/** 마지막 글자에 받침이 있나. 한글이 아니면 `null` — '모른다'다. */
function hasFinalConsonant(word: string): boolean | null {
  if (word.length === 0) return null;
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return null;
  // 한글 음절은 (초성 × 21 + 중성) × 28 + 종성 구조다 — 종성이 0 이면 받침이 없다.
  return (last - 0xac00) % 28 !== 0;
}

/**
 * 이름 뒤에 조사를 붙인다. 영문으로 끝나면 **띄고** `가` 를 쓴다 — 원래 화면이
 * `forge 가` 로 그리고 있었고 회귀선이 그 모양을 잰다(`waitChain.test.tsx`).
 */
function applyParticle(word: string, spec: string): string {
  const pair = PARTICLES[spec];
  if (!pair) return word;
  const final = hasFinalConsonant(word);
  if (final === null) return `${word} ${pair[1]}`;
  return `${word}${final ? pair[0] : pair[1]}`;
}

/**
 * `{name}` 과 `{name:조사}` 를 채운다.
 *
 * 인자가 없는 자리표시자는 **그대로 남긴다.** 빈 문자열로 지우면 문장이 말이 되는 것처럼
 * 보여서 빠진 인자를 아무도 못 찾는다 — `{count}` 가 화면에 보이면 그날 잡힌다.
 */
/**
 * 자리표시자. 이름은 ASCII 지만 **조사 표기는 그 언어의 글자다**(`{waiter:이가}`) —
 * 조사 칸에 `\w` 를 쓰면 한글이 안 잡혀 `{waiter:이가}` 가 화면에 그대로 나온다
 * (실측으로 잡았다, 2026-09-08). 조사 칸은 공백과 `}` 만 아니면 받는다.
 */
const PLACEHOLDER = /\{(\w+)(?::([^\s}]+))?\}/g;

export function interpolate(template: string, args: TransArgs | undefined): string {
  if (!args) return template;
  return template.replace(PLACEHOLDER, (whole, name: string, particle?: string) => {
    const value = args[name];
    if (value === undefined) return whole;
    const text = String(value);
    return particle ? applyParticle(text, particle) : text;
  });
}

/**
 * 사전에서 꺼낸 값 하나를 문자열로. 복수형이면 `args.count` 로 갈래를 고른다.
 *
 * `count` 가 없는데 복수형이면 `other` 로 간다 — 그것이 어느 언어에나 있는 갈래다.
 */
export function formatMessage(
  message: Message,
  args: TransArgs | undefined,
  locale: string,
): string {
  const template = typeof message === 'string'
    ? message
    : pickPlural(message, typeof args?.count === 'number' ? args.count : 0, locale);
  return interpolate(template, args);
}
