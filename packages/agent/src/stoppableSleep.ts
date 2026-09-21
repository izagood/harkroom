/**
 * 종료 신호에 깨는 sleep(실측 2026-09-21). 오퍼레이터가 죽어 링크가 없으면 폴 루프는 backoff
 * (최대 60초)로 쉬는데, 그 사이 SIGTERM 은 `running=false` 만 끄고 sleep 이 끝나길 기다렸다 —
 * 사람 눈에는 "SIGTERM 에 안 내려간다"였다. 여기서 만든 sleep 은 `wake()` 로 즉시 끝난다.
 * 진행 중인 턴을 끝내고 물러나는 계약(#129)은 그대로다 — 깨우는 것은 기다림이지 턴이 아니다.
 */
export function createStoppableSleep(): { sleep(ms: number): Promise<void>; wake(): void } {
  let pending: (() => void) | null = null;
  return {
    sleep(ms) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        pending = done;
        function done(): void { clearTimeout(timer); pending = null; resolve(); }
      });
    },
    wake() { pending?.(); },
  };
}
