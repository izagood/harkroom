import { useSyncExternalStore } from 'react';

/**
 * 도는 진행의 「N분」을 **1분마다 다시 그린다**(#1188 후속 n1).
 *
 * 그전에는 `ProgressRow` 와 접힌 줄 칩이 그릴 때의 `Date.now()` 로 경과를 재고 멈췄다 —
 * 다른 이유로 다시 그려지기 전까지 「작업 중 3분」이 10분이 지나도 3분이었다.
 *
 * **타이머는 앱 전체에 하나다.** 도는 진행 줄이 스레드에 스무 개 있어도 줄마다 타이머를 걸지
 * 않는다 — 구독자 집합 하나에 `setInterval` 하나를 걸고, 마지막 구독자가 떠나면 멈춘다. 그래서
 * 도는 진행이 하나도 없으면 아무것도 돌지 않는다.
 *
 * 값은 `Date.now()` 가 아니라 **틱 횟수**다. 경과는 부르는 쪽이 지금처럼 `Date.now()` 로 재고,
 * 이 훅은 다시 그릴 때를 알려 주기만 한다 — 시각을 두 군데서 들고 있으면 둘이 어긋난다.
 */
export const MINUTE_TICK_MS = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let tick = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      tick += 1;
      for (const l of listeners) l();
    }, MINUTE_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const noSubscribe = (): (() => void) => () => {};
const getTick = (): number => tick;

/** `enabled` 가 거짓이면(끝난 진행·도는 것 없음) 구독하지 않는다 — 타이머를 붙잡지 않는다. */
export function useMinuteTick(enabled: boolean): void {
  useSyncExternalStore(enabled ? subscribe : noSubscribe, getTick);
}
