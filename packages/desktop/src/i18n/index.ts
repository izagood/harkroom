import { en, type Catalog, type MessageKey } from './en';
import { ko } from './ko';
import { formatMessage } from './format';
import type { TransArgs } from './types';

export type { MessageKey, Catalog } from './en';
export type { TransArgs, Message, Plural } from './types';

/**
 * 붙어 있는 언어들. **세 번째 언어를 붙이는 자리가 여기 하나다** — 사전 파일을 만들고
 * (`satisfies Catalog` 로 키가 강제된다) 이 표에 한 줄 더하면 끝이다.
 */
export const CATALOGS = { en, ko } satisfies Record<string, Catalog>;

export type Locale = keyof typeof CATALOGS;

/** 사전이 없는 언어로 떨어졌을 때 돌아갈 곳. **원본이 곧 최후의 보루다.** */
export const FALLBACK_LOCALE: Locale = 'en';

export const LOCALES = Object.keys(CATALOGS) as Locale[];

/** 설정 화면이 언어를 나열할 때 쓸 이름. **각 언어를 그 언어로 적는다** — 영어를 못
 * 읽는 사람이 자기 언어를 찾을 수 있어야 한다(`Korean` 이 아니라 `한국어`). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ko: '한국어',
};

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(CATALOGS, value);
}

/**
 * 번역 함수의 모양. **`lib/` 판정 함수가 인자로 받는 타입이 이것이다.**
 *
 * ## `lib/` 판정 함수를 어떻게 하나 — (b) 주입을 골랐다
 *
 * 후보가 셋이었다.
 *
 * - **(a) 키와 인자만 낸다** — 판정은 순수하지만 **회귀선이 문구 대신 키를 재게 된다.**
 *   지금 회귀선들은 문구를 잰다(`daemonFacts.test.tsx` 가 판정 낱말 7개를 검사하고,
 *   `waitChain.test.tsx` 가 `forge 가 사람의 답을 기다린다` 를 통째로 잰다). 키를 재는
 *   시험은 **그 키가 사람이 읽을 말이 되는지를 안 지킨다** — `waitChain.link` 가 오는
 *   것과 그것이 실제로 읽히는 문장이 되는 것은 다른 사실이고, 후자가 이 저장소 회귀선의
 *   요점이다(제약 2 검사는 문구에 `이상`·`비정상` 이 **없음**을 잰다 — 키로는 잴 수 없다).
 * - **(b) 번역 함수를 인자로 준다** — `waitChainSentences(chain, name, t)`. 순수함이
 *   유지되고(`t` 는 그냥 함수다), 시험이 가짜 `t` 를 넘길 수 있고, **회귀선이 문구를
 *   계속 잰다** — 언어를 골라 넘기면 그 언어의 문구를 잰다. 인자가 하나 는다.
 * - **(c) 판정 함수가 모듈 전역 번역기를 부른다** — 인자가 안 늘지만 **함수가 전역
 *   상태에 묶인다.** 시험이 언어를 바꾸려면 전역을 만져야 하고, 그러면 병렬로 도는
 *   파일들이 서로의 언어를 밟는다(이 저장소는 vitest 파일 병렬이다).
 *
 * (b) 를 골랐다. 결정적인 이유는 **회귀선의 의도**다 — 이 저장소의 판정 시험은 "무슨
 * 키가 나오나"가 아니라 "사람이 무엇을 읽나"를 지킨다. (a) 는 그 의도를 잃는다.
 *
 * 그리고 `t` 는 React 를 모른다. 판정 함수는 **여전히 컨텍스트에 안 묶인다** — 그것이
 * 이 저장소가 `threadState`·`faceState`·`inboxRow` 를 `lib/` 에 둔 이유이기 때문이다.
 */
export interface Translate {
  (key: MessageKey, args?: TransArgs): string;
}

/**
 * 한 언어의 번역기를 만든다. **React 밖에서도 쓸 수 있다** — 판정 함수에 주입하는 것이
 * 그것이고, 시험이 `translator('en')` 으로 직접 만드는 것도 그것이다.
 */
export function translator(locale: Locale): Translate {
  const catalog: Catalog = CATALOGS[locale] ?? CATALOGS[FALLBACK_LOCALE];
  return (key, args) => {
    // 키가 타입으로 강제되므로 여기서 못 찾는 일은 **타입을 우회했을 때만** 생긴다
    // (`as MessageKey` 같은 것). 그때 빈 화면을 내는 대신 키를 그대로 보여 준다 —
    // 화면에 `waitChain.empty` 가 보이면 그날 잡힌다.
    const message = catalog[key] ?? en[key];
    if (message === undefined) return key;
    return formatMessage(message, args, locale);
  };
}

/**
 * 브라우저가 말하는 언어 중 **우리가 가진 것**을 고른다.
 *
 * `ko-KR` 처럼 지역이 붙어 오므로 앞칸으로 자른다. 아무것도 안 맞으면 영어다 —
 * 원본이 최후의 보루라는 것이 그 뜻이다.
 */
export function detectLocale(
  languages: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [],
): Locale {
  for (const tag of languages) {
    const base = tag.toLowerCase().split('-')[0];
    if (base !== undefined && isLocale(base)) return base;
  }
  return FALLBACK_LOCALE;
}
