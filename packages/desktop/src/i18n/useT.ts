import { useMemo } from 'react';
import { usePrefsStore } from '../state/prefsStore';
import { detectLocale, isLocale, translator, type Locale, type Translate } from './index';
import { agoLabel } from '../lib/time';

/**
 * 화면이 쓰는 번역기.
 *
 * **컨텍스트(`Provider`)를 안 쓴 이유**: 언어는 `prefsStore` 에 이미 있고, 그 스토어가
 * zustand 라 어느 컴포넌트든 구독할 수 있다. Provider 를 하나 더 세우면 **같은 값이 두
 * 곳에 있게** 되고(스토어와 컨텍스트), 앱 루트에 감싸는 것을 빠뜨린 화면이 조용히 옛
 * 언어로 뜬다. 색 모드(`useColorMode`)가 이미 같은 이유로 스토어를 직접 읽는다.
 *
 * `useMemo` 로 언어가 안 바뀌면 같은 함수를 돌려준다 — 이 값이 매 렌더 새 함수면
 * 그것을 의존성에 넣은 `useMemo` 들이 전부 매번 다시 돈다.
 */
export function useT(): Translate {
  const locale = useLocale();
  return useMemo(() => translator(locale), [locale]);
}

/**
 * 지금 언어. `'system'` 이면 브라우저에게 묻는다 — 색 모드의 `'system'` 과 같은 규약이라
 * 사람이 설정 화면에서 같은 것을 기대한다.
 *
 * **저장값을 여기서 좁힌다.** `prefs.ts` 는 언어를 넓은 문자열로 들고 있는데(그 파일의
 * `LocalePref` 주석: 저장본에는 우리가 지운 언어가 남아 있을 수 있다), 모르는 값이면
 * 브라우저에게 묻는 쪽으로 되돌린다 — 사전이 없는 언어에서 빈 화면을 내지 않는다.
 */
export function useLocale(): Locale {
  const pref = usePrefsStore((s) => s.locale);
  return useMemo(() => (isLocale(pref) ? pref : detectLocale()), [pref]);
}

/**
 * **"얼마나 전"을 지금 언어로** 내는 함수(`11분 전` · `11 minutes ago`).
 *
 * 훅으로 두는 이유: 이 값을 쓰는 자리가 셋인데(`ProjectionBanner`·`LeasePanel`·
 * `ConnectionSettings`) 셋 다 그것을 **`projectionBanner()` 에 주입한다**(`(b)` 주입).
 * 세 화면이 각자 `agoLabel(ts, Date.now(), locale, t)` 를 적으면 인자 넷을 세 번 옮겨
 * 적는 것이고, 그중 하나가 `Date.now()` 를 빠뜨리면 그 화면만 조용히 다르게 된다.
 *
 * `Date.now()` 를 여기서 부르는 것이 맞다: 이것은 **화면이 지금을 묻는 자리**이고,
 * 시각을 정해야 하는 회귀선은 `lib/time.ts::agoLabel` 을 직접 부른다(그 함수가 `now` 를
 * 인자로 받는 이유).
 */
export function useAgo(): (timestamp: number) => string {
  const t = useT();
  const locale = useLocale();
  return useMemo(() => (ts: number) => agoLabel(ts, Date.now(), locale, t), [locale, t]);
}
