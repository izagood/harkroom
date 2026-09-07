import type { Pool } from 'pg';
import { httpAvcsClient, type AvcsServerClient } from './client.js';
import {
  DISABLED_PROJECTION_STATUS, ProjectionWorker,
  type ProjectionDeps, type ProjectionWorkerStatus,
} from './projection.js';

export interface ProjectionSupervisorDeps {
  pool: Pool;
  /** 테스트가 가짜를 주입한다. 기본은 실제 HTTP 클라이언트. */
  makeClient?: (baseUrl: string) => AvcsServerClient;
  /** 테스트가 가짜를 주입한다. 기본은 실제 워커. */
  makeWorker?: (deps: ProjectionDeps) => ProjectionWorker;
}

/**
 * 투영 워커를 **최대 하나** 쥐고 URL 이 바뀌면 갈아 끼운다.
 *
 * ## 왜 `ProjectionWorker` 안이 아니라 여기인가
 *
 * 그 파일은 "워커가 만들어졌다는 것 자체가 URL 이 있었다는 뜻" 이라는 불변식 위에 서 있고
 * `configured: true` 를 그래서 하드코딩한다. 워커를 재설정 가능하게 만들면 그 불변식이
 * 뒤집히고 폴 루프가 '클라이언트 없음 = 유휴' 를 새로 다뤄야 한다. 가변성을 밖으로 빼면
 * 워커는 계속 자기 URL 하나만 아는 물건으로 남는다.
 *
 * ## 왜 `main.ts` 가 아니라 별 모듈인가
 *
 * `main.ts` 는 최상위 await 로 서버를 띄우는 스크립트라 **임포트만으로 포트를 잡는다** —
 * 그 안의 판정은 어떤 테스트도 확인할 수 없다. 같은 이유로 `warnIfProjectionDisabled` 가
 * 이미 `projection.ts` 로 빠져 있다. 생명주기는 그 경고 한 줄보다 훨씬 실수하기 쉽다.
 */
export class ProjectionSupervisor {
  private worker: ProjectionWorker | null = null;
  private url: string | null = null;
  /**
   * 교체를 직렬화한다. 없으면 동시 저장 둘이 각각 워커를 세워 **둘이 살아남고**, 같은 repo 를
   * 영구히 둘이 폴링한다.
   */
  private chain: Promise<void> = Promise.resolve();
  /**
   * `stop()` 이 불린 뒤에 도착하는 `reconfigure` 를 막는 빗장. `stop()` 은 `this.chain` 을
   * 기다린 뒤 워커를 지우지만, 그 사이(또는 그 뒤)에 새 `reconfigure` 가 체인에 올라타면
   * `swap` 은 `this.url` 이 null 이 된 것만 보고 새 워커를 세운다 — SIGTERM 핸들러는 이미
   * 반환했으니 그 워커를 아무도 정지시키지 않는다. `main.ts` 가 `beginDrain()` 을 먼저 불러
   * in-flight 요청을 살려 두므로, drain 중 남은 PUT 이 이 경로를 실제로 밟는다.
   */
  private stopped = false;
  private readonly makeClient: (baseUrl: string) => AvcsServerClient;
  private readonly makeWorker: (deps: ProjectionDeps) => ProjectionWorker;

  constructor(private readonly deps: ProjectionSupervisorDeps) {
    this.makeClient = deps.makeClient ?? httpAvcsClient;
    this.makeWorker = deps.makeWorker ?? ((d) => new ProjectionWorker(d));
  }

  /** 워커가 없으면 '설정되지 않았다' 다 — `main.ts` 의 `?? DISABLED` 가 여기로 들어왔다. */
  status(): ProjectionWorkerStatus {
    return this.worker?.status() ?? DISABLED_PROJECTION_STATUS;
  }

  reconfigure(url: string | null): Promise<void> {
    this.chain = this.chain.then(() => { this.swap(url); });
    return this.chain;
  }

  private swap(url: string | null): void {
    // 종료 뒤에는 어떤 재설정도 워커를 세우지 않는다 — 세워도 그 워커를 정지시킬 자리가
    // 이미 없다(`stop()` 은 반환했다).
    if (this.stopped) return;

    // 같은 URL 로 교체하면 커서와 long-poll 이 다시 걸려, 아무것도 바꾸지 않은 저장이
    // 폴링을 한 번 끊는다. 화면에서는 그것이 "저장했더니 투영이 멈췄다" 로 보인다.
    if (url === this.url) return;

    const old = this.worker;
    this.url = url;
    this.worker = url === null
      ? null
      : this.makeWorker({ pool: this.deps.pool, avcs: this.makeClient(url) });
    this.worker?.start();

    /**
     * **정지를 기다리지 않는다.** `stop()` 은 루프를 await 하고 루프는
     * `waitForChange(…, 25_000)` 에 걸려 있다 — 실패 중이면 백오프까지 더해 최악 85 초다.
     * PUT 핸들러가 그것을 기다리면 저장 버튼이 그만큼 매달린다.
     *
     * 겹쳐도 안전한 근거는 이미 코드에 있다: `runOnce` 가 커서를 `for update` 로 잠그고
     * `currentSince !== since` 면 배치를 폐기한다("다른 실행이 이미 커서를 전진시켰다").
     * 빠지는 워커가 자기 `runtime` 에 쓰는 것도 무해하다 — `status()` 는 새 워커에게 묻는다.
     */
    if (old) void old.stop().catch(() => { /* 빠지는 워커의 실패는 이 자리의 관심이 아니다 */ });
  }

  /**
   * SIGTERM 경로. 여기서는 **기다린다** — 프로세스가 워커를 남기고 죽으면 in-flight
   * long-poll 이 정상 마감되지 않는다.
   *
   * 진행 중인 교체를 먼저 마치게 한다. 안 그러면 그 교체가 세운 워커가 남는다.
   *
   * `stopped` 는 `await this.chain` **전에** 세운다 — 늦게 도착해 체인에 올라타는
   * `reconfigure` 도 `swap` 에서 즉시 되돌아가게 하려는 것이다.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.chain;
    const w = this.worker;
    this.worker = null;
    this.url = null;
    await w?.stop();
  }
}
