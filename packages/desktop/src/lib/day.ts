// 날짜 구분선의 날짜 계산(#220). 경계는 **로컬 시간대** 기준이다 — UTC 로 자르면
// 사용자가 보는 "오늘"과 어긋난다(UTC+9 에서는 오전 9시 이전 메시지가 전날로 밀린다).

import type { Locale } from '../i18n';

const pad = (n: number): string => `${n}`.padStart(2, '0');

/** 로컬 달력 하루를 가리키는 키. 같은 키면 같은 날이다. */
const keyOf = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** ISO 타임스탬프가 속한 로컬 하루의 키. */
export function localDayKey(iso: string): string {
  return keyOf(new Date(iso));
}

/**
 * 구분선에 적을 날짜 표기. 가까운 날은 상대어가 더 빨리 읽히고, 먼 날은 상대어가
 * 오히려 세어 봐야 하는 값이 되므로 절대 날짜로 넘어간다.
 *
 * ## 로캘을 비워 두던 것을 **앱 언어로 바꿨다**(`#619` 후속)
 *
 * 원래 주석은 이렇게 적혀 있었다 — *"로캘을 비워(`[]`) 사용자의 것을 따른다 —
 * 하드코딩하면 날짜 순서(Y/M/D)가 남의 관습이 된다."* 그 판단의 **근거는 지금도
 * 맞다**: 날짜 순서를 우리가 정하면 안 된다. 바뀐 것은 *"사용자의 것"이 무엇인가* 다.
 *
 * 그때는 앱에 언어 설정이 없었으므로 사용자의 뜻을 물을 곳이 브라우저뿐이었다. 이제
 * 사용자가 앱 언어를 **직접 고른다.** 그 상태에서 브라우저 로캘을 계속 따르면 화면이
 * 이렇게 갈린다:
 *
 * ```
 * 앱 언어 English · 시스템 ko-KR
 *   구분선:  2026. 9. 8.        ← 브라우저 로캘
 *   그 위:   Waiting on (2)     ← 앱 언어
 * ```
 *
 * 한 화면이 두 언어가 된다. 그리고 `오늘`·`어제` 는 이 함수가 **이미 사전에서** 가져오는
 * 말이라(아래), 그 둘만 영어이고 절대 날짜만 한국식인 화면이 나온다 — 같은 구분선
 * 안에서도 갈린다.
 *
 * **하드코딩이 아니다.** 넘기는 것은 사용자가 고른 값이고, `'system'` 을 고르면
 * `useLocale()` 이 브라우저에게 물어 원래 동작으로 돌아간다(`useT.ts`). 옛 주석이 막으려던
 * 것은 *우리가* 로캘을 정하는 것이었고, 그것은 지금도 안 한다.
 *
 * 남는 어긋남 하나를 적어 둔다: 앱 언어가 `en` 이면 지역이 없어 `M/D/YYYY`(미국식)로
 * 나온다. `en-GB` 사용자에게는 그것이 남의 관습이다. **그것은 사전이 언어까지만 갖고
 * 지역을 안 갖기 때문**이고(`CATALOGS` 가 `en`·`ko` 다), 지역을 나눌 이유가 생기면
 * 그때 사전이 아니라 이 인자가 먼저 지역을 받게 하면 된다.
 *
 * ## `오늘`·`어제` 는 `Intl` 이 낸다 — 사전에 없다
 *
 * `RelativeTimeFormat(locale, { numeric: 'auto' })` 가 `format(0, 'day')` 에 `오늘`,
 * `format(-1, 'day')` 에 `어제` 를 낸다(실측 O — `lib/time.ts` 의 표). 그래서 이 두
 * 말은 사전에서 빠진다: 세 번째 언어가 공짜로 얻는 자리다.
 *
 * `agoLabel` 이 같은 API 를 `numeric: 'always'` 로 부르는 것과 **일부러 다르다.** 저쪽이
 * 재는 것은 길이라 `어제` 가 25시간 전과 47시간 전을 같은 말로 만들면 안 되고, 여기서
 * 재는 것은 **달력의 하루**라 `어제` 가 정확히 그 뜻이다. 같은 함수의 두 뜻이고, 각
 * 부르는 자리가 자기 뜻을 고른다.
 */
export function dayLabel(iso: string, locale: Locale, now: Date = new Date()): string {
  const d = new Date(iso);
  const key = keyOf(d);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (key === keyOf(now)) return relative.format(0, 'day');
  // 로컬 자정 기준으로 하루를 빼야 DST 로 23시간·25시간이 되는 날에도 어제가 어제다.
  if (key === keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) {
    return relative.format(-1, 'day');
  }
  return d.toLocaleDateString(locale);
}
