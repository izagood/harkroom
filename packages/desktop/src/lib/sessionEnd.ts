/**
 * 세션(컨트롤러 하나)의 번호와 끝 알림 — 의존이 없는 자리다. `controller.ts` 가 `stop()` 에서
 * `endSession(this)` 를 부르고, 세션에 묶인 캐시(`attachmentUrlCache`·`linkPreviewCache`)가 듣는다.
 * 번호는 캐시 키의 머리다(`sessionKey.ts`) — 컨트롤러 객체를 키 문자열에 넣을 수 없어서 번호를 매긴다.
 *
 * `stop()` 을 고른 이유: 로그아웃·세션 잃음·커뮤니티 빼기·기동 실패가 모두 거기를 지난다.
 * 세션이 끝난 뒤에도 그 세션이 받은 blob 이 LRU 에 밀려날 때까지 남으면(최대 96MB) 예전 동작
 * (화면에서 내리면 곧바로 revoke)보다 오래 산다(#1286 security n1).
 */
const numbers = new WeakMap<object, number>();
let next = 1;

export function sessionNumber(controller: object): number {
  let n = numbers.get(controller);
  if (n === undefined) { n = next++; numbers.set(controller, n); }
  return n;
}

type Listener = (sessionNo: number) => void;
const listeners = new Set<Listener>();

export function onSessionEnd(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 번호를 받은 적 없는 세션(캐시를 한 번도 안 쓴 세션)은 알릴 것이 없다. */
export function endSession(controller: object): void {
  const n = numbers.get(controller);
  if (n === undefined) return;
  for (const fn of listeners) fn(n);
}
