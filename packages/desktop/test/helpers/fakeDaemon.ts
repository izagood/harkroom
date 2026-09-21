/**
 * `DaemonObserver` 목 — `#431` 2단계 A 가 만든 표면.
 *
 * ## 왜 목이 필요해졌나
 *
 * `RunnerLauncher` 는 이 머신의 오퍼레이터에게 "무엇이 돌고 있나"를 묻는다(단계 2 뒤로는
 * 그것이 이 클래스의 일 전부다). 그 표면 없이 만든 관측기는 실물 `tauriDaemonObserver` 로
 * 떨어지고, 테스트 환경에는 Tauri invoke 표면이 없으니 던진다 — 즉 **목을 안 주면 아무것도
 * 안 보인다.** 그것이 의도한 성질이다: 원격 오퍼레이터만 쓰는 머신에서도 같은 일이 난다.
 */
import type { DaemonObservation, DaemonObserver, ObservedRunner } from '../../src/lib/runnerLauncher';

export interface FakeDaemon extends DaemonObserver {
  /** `observe()` 가 몇 번 불렸나. "앱이 뜨면 daemon 이 뜬다"를 재는 축이다. */
  observeCalls: number;
  /** 이 daemon 이 들고 있다고 말할 러너들. 테스트가 갈아 끼운다. */
  runners: ObservedRunner[];
  /** 관측 자체가 실패하는 상황(daemon 이 안 뜬다)을 만든다. */
  error: Error | null;
  /** 러너가 **실제로 종료했다**고 장부를 갈아 끼운다. */
  died(agentId: string): void;
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
    died(agentId: string): void {
      daemon.runners = daemon.runners.filter((r) => r.agentId !== agentId);
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
