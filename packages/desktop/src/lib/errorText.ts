import { ApiError } from './api';
import { en } from '../i18n/en';
import { detectLocale, isLocale, translator, type MessageKey, type Translate } from '../i18n';
import { usePrefsStore } from '../state/prefsStore';

/**
 * 서버 오류를 **앱 언어로** 적는다(i18n P5 ②b, jaebin 결정 D5-A, security C7).
 *
 * 서버 오류는 이미 `{ error: { code, message } }` 꼴이다(`ApiError.code`). 뜻이 code 하나로 정해지는
 * 오류(이름이 이미 있다·보관된 채널·너무 잦다·비밀번호가 틀렸다 …)는 사전 `apiError.<code>` 로 옮긴다.
 * **모르는 code 는 서버 원문을 그대로** 보인다 — P1 의 `reason: 'notRestarted'` 와 같은 꼴이다(아는 실패는
 * 사전, 모르는 원문은 그대로). `not_found`·`forbidden`·`bad_request` 처럼 자리마다 뜻이 다른 code 는 사전에
 * 넣지 않는다 — 일반 문장으로 덮으면 서버가 말한 「무엇이」 가 사라진다.
 *
 * - code 는 `[a-z0-9_]` 만 받는다(C7) — 그 밖이면 사전을 찾지 않는다.
 * - 사전 조회는 `Object.hasOwn` 이다 — `apiError.constructor` 같은 키로 프로토타입을 타지 않는다.
 * - 결과는 화면이 **React 텍스트로** 넣는다(지금 `err.message` 를 넣던 자리 그대로).
 *
 * @param fallback 오류에 글이 없을 때(Error 가 아닌 값 등) 쓸 말. 없으면 `apiError.generic`.
 */
export function errorText(err: unknown, t: Translate, fallback?: string): string {
  if (err instanceof ApiError && /^[a-z0-9_]{1,64}$/.test(err.code)) {
    const key = `apiError.${err.code}`;
    if (Object.hasOwn(en, key)) return t(key as MessageKey);
  }
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (raw) return raw;
  return fallback ?? t('apiError.generic');
}

/** React 밖(lib·훅 밖 함수)에서 지금 언어로. `useLocale` 과 같은 규약이다. #1305 의 `nowT()` 가 들어오면 그것으로 바꾼다. */
export function errorTextNow(err: unknown, fallback?: string): string {
  const pref = usePrefsStore.getState().locale;
  return errorText(err, translator(isLocale(pref) ? pref : detectLocale()), fallback);
}
