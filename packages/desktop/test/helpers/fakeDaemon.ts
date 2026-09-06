/**
 * `DaemonObserver` 목 — `#431` 2단계 A 가 만든 표면.
 *
 * ## 왜 목이 필요해졌나
 *
 * `RunnerLauncher` 는 이제 러너를 띄우기 **전에** daemon 에게 "무엇이 돌고 있나"를 묻는다.
 * 그 표면 없이 만든 실행기는 실물 `tauriDaemonObserver` 로 떨어지고, 테스트 환경에는
 * Tauri invoke 표면이 없으니 던진다 — 즉 **목을 안 주면 아무것도 안 뜬다.**
 *
 * 그것이 실수처럼 보이지만 의도한 성질이다: daemon 에 못 닿으면 러너를 안 띄우는 것이
 * 프로덕션 동작이고(`startAll` 의 첫 블록), 테스트가 그 사실을 우회로 넘기면 안 된다.
 *
 * ## 기본값이 "빈 장부"인 이유
 *
 * 대부분의 회귀선이 재는 것은 "띄운다"이고, 그 조건은 **장부에 없다**이다.
 * 장부에 무언가를 넣는 것은 그 사실 자체를 재는 회귀선(중복 금지·`adopted` 표시)뿐이라
 * 그쪽이 명시적으로 넘긴다.
 */
import type { DaemonObservation, DaemonObserver, ObservedRunner } from '../../src/lib/runnerLauncher';

export interface FakeDaemon extends DaemonObserver {
  /** `observe()` 가 몇 번 불렸나. "앱이 뜨면 daemon 이 뜬다"를 재는 축이다. */
  observeCalls: number;
  /** 이 daemon 이 들고 있다고 말할 러너들. 테스트가 갈아 끼운다. */
  runners: ObservedRunner[];
  /** 관측 자체가 실패하는 상황(daemon 이 안 뜬다)을 만든다. */
  error: Error | null;
}

export function fakeDaemon(runners: ObservedRunner[] = []): FakeDaemon {
  const daemon: FakeDaemon = {
    observeCalls: 0,
    runners,
    error: null,
    async observe(): Promise<DaemonObservation> {
      daemon.observeCalls += 1;
      if (daemon.error) throw daemon.error;
      return { daemonPid: 4242, attached: true, runners: daemon.runners };
    },
  };
  return daemon;
}

/** 장부에 올라 있고 **살아 있는** 러너 하나. daemon 이 직접 `kill(pid, 0)` 으로 확인한 것. */
export const liveRunner = (agentId: string, adopted = false): ObservedRunner => ({
  agentId,
  alive: true,
  adopted,
});
