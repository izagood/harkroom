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
 * - 신호를 받아 판정하면 **다시는 붙지 않는다**(`holdReconnect`). 지금 열린 링크는 둔다 — 오퍼레이터가 보낸 드레인
 *   (교체)은 그 링크 위에서 도는 턴을 마저 끝내야 한다. 링크가 없을 때의 판정은 창(`relinkWaitMs`) 끝이다(아래 10-31).
 * - 창이 지나도 링크가 **없으면**(고아·거절) 기다려 봐야 답을 올릴 길이 없다 → 열린 세션을 중단 경로로 끝내고 짧은 유예 뒤 끝낸다.
 * - 링크가 **있으면** 드레인을 기다리되 시한을 둔다. 시한은 오퍼레이터의 드레인 시한(SIGTERM 뒤 SIGKILL,
 *   `operator/assignments.ts` 의 10분)보다 길게 — 오퍼레이터가 있으면 그쪽이 먼저 정리하고, 없을 때만 이것이 받친다.
 * - 시한 타이머는 `unref` 한다: 드레인이 일찍 끝나면 프로세스가 타이머를 기다리지 않고 바로 끝난다.
 *
 * ## 링크가 없을 때 곧바로 중단하지 않는다 (2026-10-31 실측)
 * 앱 업데이트로 오퍼레이터가 바뀌면 새 오퍼레이터가 기동하며 옛 세대 러너를 회수한다(SIGTERM, `operator/run.ts` 의
 * 채택 계획). 그 순간 러너의 링크는 **죽은 옛 오퍼레이터**를 향해 끊겨 재접속 백오프 중이다 — 새 오퍼레이터는 이
 * 러너의 secret 을 받아 두었으니(#838) 다음 dial 이면 붙는다. 그런데 신호를 받자마자 `holdReconnect` 하고 "링크가
 * 없다"로 판정해, 도구 호출 한가운데의 턴이 중단되고 그 일이 사라졌다(마지막 도구 호출 9초 뒤 교체, 로그에 중단
 * 한 줄). 고아와 교체는 신호를 받은 순간에는 구별되지 않는다 — 둘 다 "지금 링크가 없다"이다.
 *
 * 그래서 링크가 없을 때는 **재접속을 막지 않고** `relinkWaitMs` 를 기다린 뒤 판정한다. 그 사이 붙었으면(교체)
 * 드레인으로, 아니면(고아) 예전처럼 중단한다. 판정한 뒤에는 위 규칙대로 다시는 붙지 않는다.
 * - 첫 연결(`whenConnected`)로 판정하지 않는 이유: 오퍼레이터의 거절(`link.rejected`)은 소켓이 **열린 뒤**의 첫
 *   프레임이라, 고아도 매번 잠깐 "붙는다". 그 순간 드레인으로 가서 재접속을 막으면 거절된 고아가 답을 올릴 길
 *   없이 드레인 시한(11분) 내내 산다. 창 끝에 한 번 보면 그 몇 ms 에 걸릴 일이 사실상 없고, 고아는 창 안에서
 *   거절이 쌓여 `onLinkRejectedGiveUp` 로 먼저 물러난다(1+2+4초).
 * - 기다리는 동안 턴은 계속 돈다 — 붙으면 그 링크로 MCP 가 흐르고, 턴이 일찍 끝나면 루프가 빠져나가 그대로 끝난다.
 * - 65초: 릴레이 재접속 백오프의 천장이 60초다(`policy.ts::nextBackoffMs`). 신호는 앞 dial 이 실패한 **뒤**에
 *   오므로 다음 dial 은 늦어도 60초 안에 선다 — 백오프가 얼마나 자랐든 창 안에 시도가 적어도 한 번 들어간다.
 *   여유 5초는 dial·hello 몫. 오퍼레이터의 드레인 시한(10분)보다 한참 짧아 그쪽 SIGKILL 과 다투지 않는다.
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
  /** 신호를 받았을 때 링크가 없으면 다시 붙기를 기다리는 창(머리 주석 2026-10-31). */
  relinkWaitMs?: number;
}

export const RETREAT_LINK_DOWN_GRACE_MS = 60_000;
export const RETREAT_RELINK_WAIT_MS = 65_000;
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
  const relinkWaitMs = deps.relinkWaitMs ?? RETREAT_RELINK_WAIT_MS;
  let armed: number | null = null;
  /** 신호를 한 번 받았다 — 두 번째 신호(SIGTERM 뒤 SIGINT 등)가 판정을 다시 하지 않게. */
  let signaled = false;
  /** 거절로 이미 물러나는 중이다 — 창 끝의 판정이 할 일이 없다(릴레이가 멈췄고 세션을 중단했다). */
  let gaveUp = false;

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

  const drain = (signal: string): void => {
    deps.relay.holdReconnect();
    log(`[main] ${signal} — 드레인한다(새 접속 없음, 최대 ${Math.round(drainDeadlineMs / 60_000)}분)`);
    arm(drainDeadlineMs);
  };

  return {
    onSignal(signal) {
      deps.stopLoop();
      if (signaled) return;
      signaled = true;
      if (deps.relay.connected()) { drain(signal); return; }
      // 링크가 없다 — 교체 중인 오퍼레이터면 곧 다시 붙는다. 재접속을 막지 않고 창 끝에 판정한다(머리 주석 2026-10-31).
      log(`[main] ${signal} — 오퍼레이터 링크가 없다, 최대 ${Math.round(relinkWaitMs / 1000)}초 다시 붙기를 기다린 뒤 판정한다`);
      schedule(() => {
        if (gaveUp) return;
        if (deps.relay.connected()) { drain(signal); return; }
        deps.relay.holdReconnect();
        log(`[main] ${signal} — ${Math.round(relinkWaitMs / 1000)}초 안에 오퍼레이터 링크가 돌아오지 않았다, 열린 턴을 중단하고 물러난다`);
        deps.relay.cancelSessions();
        arm(linkDownGraceMs);
      }, relinkWaitMs);
    },
    onLinkRejectedGiveUp() {
      log('[main] 오퍼레이터가 이 러너를 받아 주지 않는다 — 물러난다');
      gaveUp = true;
      deps.stopLoop();
      arm(linkDownGraceMs);
    },
  };
}
