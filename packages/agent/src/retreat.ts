/**
 * 러너가 **물러나는 길 하나**(종료 신호·오퍼레이터의 거절). 두 갈래가 같은 함수를 쓴다.
 *
 * ## 왜 따로 뽑았나 (2026-10-22 실측)
 * 장부에서 빠진 고아 러너에 SIGTERM 을 보냈더니 턴과 MCP 자식은 죽었는데 러너만 살아 1초마다 다시 붙었다.
 * 시그널 핸들러는 폴 루프 플래그만 끄고 끝났다 — 릴레이 재접속은 그대로였고 종료 시한도 없었다. 그 뒤
 * `main.ts` 끝의 `relay.stop()` 까지 가려면 드레인이 끝나야 하는데, 그 사이 무엇이 하나라도 걸려 있으면
 * 재접속 소켓이 이벤트 루프를 계속 붙잡아 프로세스가 **영원히** 살았다.
 *
 * ## 규칙
 * - 신호를 받으면 **다시는 붙지 않는다**(`holdReconnect`). 지금 열린 링크는 둔다 — 오퍼레이터가 보낸 드레인
 *   (교체)은 그 링크 위에서 도는 턴을 마저 끝내야 한다.
 * - 링크가 **없으면**(고아·거절) 기다려 봐야 답을 올릴 길이 없다 → 열린 세션을 중단 경로로 끝내고 짧은 유예 뒤 끝낸다.
 * - 링크가 **있으면** 드레인을 기다리되 시한을 둔다. 시한은 오퍼레이터의 드레인 시한(SIGTERM 뒤 SIGKILL,
 *   `operator/assignments.ts` 의 10분)보다 길게 — 오퍼레이터가 있으면 그쪽이 먼저 정리하고, 없을 때만 이것이 받친다.
 * - 시한 타이머는 `unref` 한다: 드레인이 일찍 끝나면 프로세스가 타이머를 기다리지 않고 바로 끝난다.
 */
export interface RetreatDeps {
  relay: { holdReconnect(): void; cancelSessions(): void; connected(): boolean; stop(): void };
  /** 폴 루프를 멈춘다(플래그·잠 깨우기·인터랙티브 회수). */
  stopLoop(): void;
  exit(code: number): void;
  schedule?(fn: () => void, ms: number): void;
  log?(line: string): void;
  /** 링크 없이 물러날 때의 유예 — 턴의 SIGTERM→SIGKILL 승격(5초)보다 넉넉히. */
  linkDownGraceMs?: number;
  /** 링크가 있을 때 드레인을 기다리는 최대 시간. */
  drainDeadlineMs?: number;
}

export const RETREAT_LINK_DOWN_GRACE_MS = 60_000;
export const RETREAT_DRAIN_DEADLINE_MS = 11 * 60_000;

export interface Retreat {
  /** SIGTERM·SIGINT. */
  onSignal(signal: string): void;
  /** 오퍼레이터가 연달아 받아 주지 않았다 — 릴레이는 이미 멈추고 세션을 중단했다. */
  onLinkRejectedGiveUp(): void;
}

export function createRetreat(deps: RetreatDeps): Retreat {
  const schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const log = deps.log ?? ((line: string) => console.error(line));
  const linkDownGraceMs = deps.linkDownGraceMs ?? RETREAT_LINK_DOWN_GRACE_MS;
  const drainDeadlineMs = deps.drainDeadlineMs ?? RETREAT_DRAIN_DEADLINE_MS;
  let armed: number | null = null;

  const arm = (ms: number): void => {
    // 더 짧은 시한만 새로 건다 — 드레인 시한이 걸린 뒤 링크가 끊겨 고아가 되면 짧은 쪽으로 당긴다.
    if (armed !== null && armed <= ms) return;
    armed = ms;
    schedule(() => {
      if (armed !== ms) return;
      log(`[main] 물러나는 시한(${Math.round(ms / 1000)}초)이 지났다 — 남은 것과 상관없이 끝낸다`);
      deps.relay.stop();
      deps.exit(0);
    }, ms);
  };

  return {
    onSignal(signal) {
      deps.stopLoop();
      deps.relay.holdReconnect();
      if (deps.relay.connected()) {
        log(`[main] ${signal} — 드레인한다(새 접속 없음, 최대 ${Math.round(drainDeadlineMs / 60_000)}분)`);
        arm(drainDeadlineMs);
      } else {
        log(`[main] ${signal} — 오퍼레이터 링크가 없다, 열린 턴을 중단하고 물러난다`);
        deps.relay.cancelSessions();
        arm(linkDownGraceMs);
      }
    },
    onLinkRejectedGiveUp() {
      log('[main] 오퍼레이터가 이 러너를 받아 주지 않는다 — 물러난다');
      deps.stopLoop();
      arm(linkDownGraceMs);
    },
  };
}
