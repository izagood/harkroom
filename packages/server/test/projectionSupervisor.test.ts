/**
 * 워커를 갈아 끼우는 자리(설계 §1·§2). 이 파일이 가장 신경 쓰는 것은 **정지를 기다리지
 * 않는다** 는 성질이다.
 *
 * `worker.stop()` 은 루프를 await 하고, 루프는 `waitForChange(…, 25_000)` 에 걸려 있으며
 * 실패 사이클이면 백오프가 60_000 까지 간다 — `await stop()` 은 최악 85 초다. 저장 버튼을
 * 누른 사람을 그만큼 기다리게 할 수 없다. 겹침은 `runOnce` 의 커서 락이 막는다.
 *
 * DB 를 쓰지 않는다. supervisor 의 일은 생명주기이고, 가짜 워커로 그것을 전부 잴 수 있다.
 */
import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import type { AvcsServerClient } from '../src/avcs/client.js';
import type { ProjectionDeps, ProjectionWorker } from '../src/avcs/projection.js';
import { ProjectionSupervisor } from '../src/avcs/supervisor.js';

const pool = {} as Pool;
const client = {} as AvcsServerClient;

interface Fake {
  started: boolean;
  stopped: boolean;
  connected: boolean;
  stopCalls: number;
}

/** 가짜 워커 + 만들어진 순서 기록. `stop()` 의 완료 시점을 시험이 쥔다. */
function harness(opts: { stopHangs?: boolean } = {}) {
  const made: Fake[] = [];
  const urls: string[] = [];

  const makeClient = (baseUrl: string): AvcsServerClient => { urls.push(baseUrl); return client; };

  const makeWorker = (_deps: ProjectionDeps): ProjectionWorker => {
    const f: Fake = { started: false, stopped: false, connected: false, stopCalls: 0 };
    made.push(f);
    return {
      start: () => { f.started = true; },
      // 정지는 **동기적으로 표시**하고, 완료 프로미스는 따로 준다 — 기다리는지 아닌지를
      // 이 둘로 가른다.
      stop: () => {
        f.stopped = true;
        f.stopCalls += 1;
        return opts.stopHangs ? new Promise<void>(() => { /* 영원히 안 끝난다 */ }) : Promise.resolve();
      },
      status: () => ({
        configured: true, connected: f.connected, repo: null, lastLogIndex: 0,
        lastPolledAt: null, lastAdvancedAt: null, lastError: null,
      }),
    } as unknown as ProjectionWorker;
  };

  const sup = new ProjectionSupervisor({ pool, makeClient, makeWorker });
  return { sup, made, urls, alive: () => made.filter((f) => !f.stopped) };
}

describe('ProjectionSupervisor', () => {
  it('URL 이 있으면 워커를 세운다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    expect(h.made).toHaveLength(1);
    expect(h.made[0]?.started).toBe(true);
    expect(h.urls).toEqual(['http://a']);
    expect(h.sup.status().configured).toBe(true);
  });

  /** 워커가 없다는 것이 곧 '설정되지 않았다' 다 — 그 답을 supervisor 가 대신한다. */
  it('URL 이 없으면 워커가 없고 DISABLED 를 답한다', async () => {
    const h = harness();
    await h.sup.reconfigure(null);
    expect(h.made).toHaveLength(0);
    expect(h.sup.status()).toMatchObject({ configured: false, connected: false });
  });

  it('reconfigure(null) 이면 워커가 내려간다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    await h.sup.reconfigure(null);
    expect(h.made[0]?.stopped).toBe(true);
    expect(h.sup.status().configured).toBe(false);
  });

  /**
   * 같은 URL 로 저장한 것이 폴링을 끊으면, 아무것도 바꾸지 않은 저장이 화면에서
   * "저장했더니 투영이 잠깐 멈췄다" 로 보인다.
   */
  it('같은 URL 이면 워커를 교체하지 않는다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    await h.sup.reconfigure('http://a');
    expect(h.made).toHaveLength(1);
    expect(h.made[0]?.stopped).toBe(false);
  });

  /**
   * **이 파일의 핵심 회귀선.** `stop()` 이 영원히 안 끝나도 `reconfigure` 는 끝나야 한다.
   * 되돌리기 실험: supervisor 에서 `void old.stop()` 을 `await old.stop()` 으로 바꾸면
   * 이 테스트가 타임아웃으로 죽는다 — 그것이 실제로 PUT 핸들러에서 벌어지는 일이다.
   */
  it('옛 워커의 정지를 기다리지 않는다', async () => {
    const h = harness({ stopHangs: true });
    await h.sup.reconfigure('http://a');

    await h.sup.reconfigure('http://b');

    expect(h.made).toHaveLength(2);
    expect(h.made[1]?.started).toBe(true);
    expect(h.made[0]?.stopped).toBe(true);
  });

  /**
   * `swap` 은 동기 함수라 두 `reconfigure` 호출 사이에 끼어들 틈이 없다 — 그래서 결과는
   * 항상 마지막으로 요청한 URL 로 수렴한다. 이 테스트는 그 수렴을 검증한다: 마지막
   * 워커만 살아 있고 그 전 워커는 정지됐다.
   */
  it('연달아 재설정하면 마지막 워커만 살아남는다', async () => {
    const h = harness();
    const first = h.sup.reconfigure('http://b');
    const second = h.sup.reconfigure('http://c');
    await Promise.all([first, second]);

    expect(h.made).toHaveLength(2);
    expect(h.made[0]?.stopped).toBe(true);
    expect(h.made[1]?.stopped).toBe(false);
    expect(h.alive()).toHaveLength(1);
    expect(h.urls).toEqual(['http://b', 'http://c']);
  });

  /** SIGTERM 경로. 여기서는 기다린다 — 프로세스가 워커를 남기고 죽으면 안 된다. */
  it('stop() 은 정지를 기다리고 워커를 남기지 않는다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');

    await h.sup.stop();

    expect(h.made[0]?.stopped).toBe(true);
    // 한 번만 정지시킨다. 종료 래치를 잘못 놓으면 큐에 남은 swap 이 같은 워커를 또
    // 정지시키는데, 카운트를 보지 않으면 그것이 테스트를 그냥 지나간다.
    expect(h.made[0]?.stopCalls).toBe(1);
    expect(h.sup.status().configured).toBe(false);
  });

  /**
   * `stop()` 에서 `await this.chain` 을 빼면, 아직 마이크로태스크로 남아 있는 `swap` 이
   * `stop()` 이 `this.worker` 를 비운 **뒤**에 실행돼 새 워커를 세운다 — 그 워커는 아무도
   * 정지시키지 않는다. `stop()` 이 체인을 먼저 기다리는 이유가 이것이다.
   */
  it('진행 중인 교체를 마친 뒤 종료한다', async () => {
    const h = harness();
    void h.sup.reconfigure('http://a');
    await h.sup.stop();
    expect(h.alive()).toHaveLength(0);
  });

  /**
   * 종료 뒤에 오는 재설정은 아무도 정지시킬 수 없는 워커를 만든다. `main.ts` 가
   * `beginDrain()` 을 먼저 부르므로 drain 중 남은 PUT 이 이 경로를 실제로 만든다.
   */
  it('종료한 뒤의 재설정은 워커를 세우지 않는다', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    await h.sup.stop();

    await h.sup.reconfigure('http://b');

    expect(h.alive()).toHaveLength(0);
    expect(h.sup.status().configured).toBe(false);
  });
});
