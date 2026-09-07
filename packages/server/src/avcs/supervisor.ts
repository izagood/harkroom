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

  /**
   * 지금 워커가 보고 있는 avcs 서버. `/leases` 와 커서 메트릭이 이 값으로 행을 거른다 —
   * 리스·커서 행이 그 URL 아래 쓰였기 때문이다.
   *
   * DB 를 다시 resolve 하지 않고 이 값을 쓰는 이유: 저장과 교체 사이의 짧은 순간에 둘이
   * 어긋날 수 있고, 그때 참인 것은 **워커가 실제로 쓰고 있는 URL** 이다.
   */
  currentUrl(): string | null {
    return this.url;
  }

  reconfigure(url: string | null): Promise<void> {
    const tail = this.chain.then(() => { this.swap(url); });
    // 거절이 체인에 남으면 이후 재설정이 조용히 no-op 이 되고(`.then` 이 다시는 안 불린다),
    // `stop()` 이 이 체인을 기다리므로 SIGTERM 핸들러가 던져 `app.close()`·`pool.end()`·
    // `process.exit(0)` 에 닿지 못한다. 호출자에게는 실패를 그대로 주면서(`tail` 반환)
    // 체인 자체는 이행하는 상태로 유지한다. 오늘의 실제 팩토리는 던지지 않지만(Fix 4 참고),
    // 던지는 팩토리를 나중에 붙이거나 시험하는 자리를 여기서 미리 막아 둔다.
    this.chain = tail.catch(() => { /* 체인을 오염시키지 않는다 — 실패는 tail 이 이미 전한다 */ });
    return tail;
  }

  private swap(url: string | null): void {
    // 종료 뒤에는 어떤 재설정도 워커를 세우지 않는다 — 세워도 그 워커를 정지시킬 자리가
    // 이미 없다(`stop()` 은 반환했다).
    if (this.stopped) return;

    // 같은 URL 로 교체하면 커서와 long-poll 이 다시 걸려, 아무것도 바꾸지 않은 저장이
    // 폴링을 한 번 끊는다. 화면에서는 그것이 "저장했더니 투영이 멈췄다" 로 보인다.
    if (url === this.url) return;

    const old = this.worker;
    const worker = url === null
      ? null
      : this.makeWorker({ pool: this.deps.pool, avcs: this.makeClient(url), baseUrl: url });
    worker?.start();
    // 성공적으로 만든 뒤에야 반영한다. 먼저 반영하면 `makeWorker` 가 던졌을 때 `this.url` 은
    // 새 URL 을 가리키는데 `this.worker` 는 옛 워커로 남아, `status()` 가 옛 워커를 새
    // URL 소유인 것처럼 답한다.
    this.url = url;
    this.worker = worker;

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
   * `stopped` 는 `await this.chain` **전에** 세운다 — `swap` 의 첫 줄이 그것을 검사하므로,
   * 이 시점 이후 체인에서 실행되는 어떤 재설정도(이미 큐에 있었든 늦게 올라타든) 워커를
   * **아예 만들지 않고** 되돌아간다. **워커가 새로 생겨 남는 것을 막는 것은 이제 이 빗장이지,
   * 아래 `await this.chain` 이 아니다** — 빗장 없이 그 await 만 있던 시절에는 진행 중이던
   * 교체가 워커를 마저 세우고 그 워커를 곧바로 멈추는 식으로 안전했지만, 지금은 그 교체
   * 자체가 빗장에서 멈춘다.
   *
   * 그런데도 `this.chain` 을 기다리는 이유는 **드레인**이다: 이미 큐에 걸려 아직 실행되지
   * 않은 재설정이 있다면(빗장에 걸려 결국 no-op 이 되더라도) 그 실행이 끝난 뒤에야 반환한다.
   * 안 그러면 `stop()` 이 반환한 뒤에도 큐에 남은 항목이 뒤늦게 처리되어, 그 `reconfigure()`
   * 호출자가 기다리는 프로미스가 그만큼 미뤄진다. 이 체인이 거절될 일은 없다 — `reconfigure`
   * 가 체인에는 항상 이행하는 tail 만 남긴다(위 참고).
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
