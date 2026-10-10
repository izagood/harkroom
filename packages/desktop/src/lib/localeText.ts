import type { Locale } from '../i18n';

/**
 * 날짜·시각·숫자를 **앱 언어로** 적는 자리 하나.
 *
 * ## 왜 따로 두나
 *
 * `toLocaleString()` 을 인자 없이 부르면 **OS 언어**를 따른다. 앱은 사람이 설정 › 모양에서 고른
 * 언어로 말하는데 시각만 OS 를 따르면, 영어로 고른 사람의 화면에 `오후 09:07` 이 섞인다
 * (i18n 검토, 2026-10-10). 그래서 화면은 `toLocale*String()` 을 직접 부르지 않고 여기를 지난다 —
 * 언어 인자를 **빠뜨릴 수 없는 모양**으로 둔 것이 이 파일의 일이다
 * (`test/localeText.test.ts` 가 인자 없는 호출이 다시 생기지 않는지 소스를 잰다).
 *
 * 같은 줄의 다른 함수들: 날짜 구분선·말 옆 도장은 `lib/day.ts`(`dayLabel`·`stampLabel`),
 * 경과(`11분 전`)는 `lib/time.ts`(`agoLabel`). 여기는 그 둘에 안 맞는 **그냥 날짜·시각·수**다.
 */

type When = string | number | Date;

/** 날짜와 시각(`2026. 10. 10. 오후 9:07` · `10/10/2026, 9:07:00 PM`). 툴팁·기록 줄에 쓴다. */
export function dateTimeText(at: When, locale: Locale): string {
  return new Date(at).toLocaleString(locale);
}

/** 날짜만(`2026. 10. 10.` · `10/10/2026`). */
export function dateText(at: When, locale: Locale): string {
  return new Date(at).toLocaleDateString(locale);
}

/** 수(`12,345`). 자리 구분 기호가 언어마다 다르다(`12.345` 를 쓰는 언어가 있다). */
export function numberText(n: number, locale: Locale): string {
  return n.toLocaleString(locale);
}
