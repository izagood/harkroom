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
  /**
   * 이 워커가 받은 `baseUrl`(`ProjectionDeps.baseUrl`). `swap()` 이 `this.url`(교체 **전**
   * 값)을 실수로 넘기면 A→B 전환에서 새 워커가 옛 URL 아래 커서·리스를 쓰게 된다 —
   * `/leases`·게이지는 새 URL 로 거르므로 ACTIVE WORK 가 영구히 비고 새 URL 행은 생기지도
   * 않는다(방금 고친 결함의 거울상). `_deps` 를 버리던 예전 harness 는 이 배선을 전혀
   * 보지 못했다.
   */
  baseUrl: string;
}

/** 가짜 워커 + 만들어진 순서 기록. `stop()` 의 완료 시점을 시험이 쥔다. */
function harness(opts: { stopHangs?: boolean } = {}) {
  const made: Fake[] = [];
  const urls: string[] = [];

  const makeClient = (baseUrl: string): AvcsServerClient => { urls.push(baseUrl); return client; };

  const makeWorker = (deps: ProjectionDeps): ProjectionWorker => {
    const f: Fake = { started: false, stopped: false, connected: false, stopCalls: 0, baseUrl: deps.baseUrl };
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
    // 워커가 자기 행을 찾으려면 자기가 보고 있는 서버를 알아야 한다(ProjectionDeps.baseUrl).
    expect(h.made[0]?.baseUrl).toBe('http://a');
    expect(h.sup.currentUrl()).toBe('http://a');
  });

  /**
   * **Important A 회귀선.** 되돌리기 실험: `supervisor.ts` 의 `swap()` 에서
   * `baseUrl: url`(교체 **후** 값)을 `baseUrl: this.url`(교체 **전** 값)로 바꾼다 — A→B
   * 전환에서 새 워커가 옛 URL(A) 아래 커서·리스를 쓰게 되는데, `/leases`·커서 게이지는
   * 새 URL(B)로 거르므로 ACTIVE WORK 가 영구히 비고 B 의 커서 행은 생기지도 않는다.
   * 방금 고친 결함의 거울상이 재현되지만, `this.url`(스왑 전)과 인자 `url`(스왑 후)이
   * 같은 값이 되는 단일 URL 시나리오(위 테스트들)는 이 차이를 가르지 못한다 — 반드시
   * A→B 처럼 **둘이 다른** 전환에서 새 워커가 받은 `baseUrl` 이 새 URL 과 같은지 봐야 한다.
   */
  it('교체된 새 워커는 새 URL 을 baseUrl 로 받는다 (옛 URL 이 아니다)', async () => {
    const h = harness();
    await h.sup.reconfigure('http://a');
    await h.sup.reconfigure('http://b');

    expect(h.made).toHaveLength(2);
    expect(h.made[0]?.baseUrl).toBe('http://a');
    expect(h.made[1]?.baseUrl).toBe('http://b'); // this.url(교체 전) 이 아니라 새 URL
    expect(h.sup.currentUrl()).toBe('http://b');

    await h.sup.reconfigure(null);
    expect(h.sup.currentUrl()).toBeNull();

    await h.sup.reconfigure('http://c');
    expect(h.sup.currentUrl()).toBe('http://c');
    await h.sup.stop();
    expect(h.sup.currentUrl()).toBeNull();
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
   * `stopped` 빗장은 `swap` 의 첫 줄에서 검사되므로, stop() 이 시작된 뒤에 도착하는(또는
   * 이미 큐에 있던) 재설정은 워커를 **아예 만들지 않고** 되돌아간다. `alive()`(정지되지
   * 않은 가짜만 센다)로는 이것을 구별할 수 없다 — 빗장이 없어도 `await this.chain` 이
   * 결국 그 워커를 만들고 `stop()` 이 곧바로 멈추므로 `alive()` 는 어느 쪽이든 0 이 된다.
   * 그래서 **만들어진 적 자체가 있는지**(`h.made`)를 본다.
   *
   * 되돌리기 실험: `swap` 의 `if (this.stopped) return;` 을 지우면 이 테스트가 죽는다
   * (`h.made` 가 1 이 된다 — 워커가 만들어졌다가 뒤이어 정지된다).
   */
  it('종료가 시작된 뒤에는 진행 중이던 교체가 워커를 만들지 않는다', async () => {
    const h = harness();
    void h.sup.reconfigure('http://a');
    await h.sup.stop();
    expect(h.made).toHaveLength(0);
    expect(h.sup.status().configured).toBe(false);
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

  /**
   * `swap` 이 던지면(오늘의 실제 팩토리는 던지지 않지만, 언젠가 붙을 수 있다) 그 거절이
   * `this.chain` 에 그대로 남으면 이후 모든 `reconfigure` 가 조용히 no-op 이 된다 —
   * `.then` 은 앞선 프로미스가 거절되면 다시는 불리지 않는다. 되돌리기 실험:
   * `reconfigure` 에서 `this.chain = tail.catch(...)` 을 `this.chain = tail` 로 바꾸면
   * 이 테스트가 두 번째 `reconfigure` 의 거절로 죽는다.
   */
  it('한 번 던진 뒤에도 다음 재설정은 살아 있다', async () => {
    let calls = 0;
    const makeWorker = (): ProjectionWorker => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return {
        start: () => {},
        stop: () => Promise.resolve(),
        status: () => ({
          configured: true, connected: false, repo: null, lastLogIndex: 0,
          lastPolledAt: null, lastAdvancedAt: null, lastError: null,
        }),
      } as unknown as ProjectionWorker;
    };
    const sup = new ProjectionSupervisor({ pool, makeClient: () => client, makeWorker });

    await expect(sup.reconfigure('http://a')).rejects.toThrow('boom');
    // 첫 시도가 던졌으니 워커도, URL 도 반영되지 않는다(Fix 5) — 둘 다 처음 그대로다.
    expect(sup.status().configured).toBe(false);

    await expect(sup.reconfigure('http://b')).resolves.toBeUndefined();
    expect(sup.status().configured).toBe(true);
  });
});
