import { startAvcsServer, type AvcsServerHandle } from '@izagood/avcs-server';

/**
 * murmur 가 **직접 띄우는** avcs 서버(`docs/hub-seat.md` 「층 1 — 쓰기」의 `hosted`).
 *
 * ## 왜 서버 하나가 저장소 여럿을 담는가
 *
 * avcs-server 는 데이터 루트 아래 `<org>/<repo>` 로 스토어를 나눈다 — 저장소마다 서버를 띄울
 * 이유가 없고, 띄우면 포트와 수명을 저장소 수만큼 관리하게 된다. 그래서 이 클래스는 **서버를
 * 최대 하나** 쥔다(`ProjectionSupervisor` 가 워커를 하나만 쥐는 것과 같은 판단).
 *
 * ## 왜 미리 띄우지 않는가
 *
 * `hosted` 저장소가 하나도 없는 워크스페이스가 대다수다(지금 전부가 그렇다). 그런 곳에서
 * 포트를 잡고 디스크에 데이터 루트를 만들면, 쓰지도 않는 상태를 **백업 대상에 올려놓는 일**이
 * 된다(`docs/operations.md` §1 의 표가 늘어난다). 그래서 필요할 때 뜬다 — `ensure()` 를 부르는
 * 쪽은 "지금 hosted 저장소를 읽으려 한다" 는 사실을 이미 알고 있다.
 *
 * ## 주소는 루프백이다
 *
 * 이 서버는 murmur 프로세스 **안**의 것이고 바깥에서 직접 부를 표면이 아니다. 에이전트가
 * push 할 주소는 murmur 가 대신 내주는 것이지(다음 단계) 이 포트가 아니다. `127.0.0.1` 에
 * 묶고 포트는 OS 가 고르게 둔다 — 고정 포트를 박으면 한 머신에서 인스턴스 둘을 못 띄운다.
 */
export class AvcsHost {
  private handle: AvcsServerHandle | null = null;
  /**
   * 기동을 직렬화한다. 없으면 동시 요청 둘이 각각 서버를 세워 **둘 다 살아남고**, 같은 데이터
   * 루트를 두 프로세스가 연다(`ProjectionSupervisor.chain` 과 같은 사고).
   */
  private chain: Promise<void> = Promise.resolve();
  /** `stop()` 뒤에 도착한 `ensure()` 가 새 서버를 세우는 것을 막는 빗장. */
  private stopped = false;
  private error: unknown = null;
  private readonly start: typeof startAvcsServer;

  constructor(private readonly deps: {
    /** 데이터 루트. `<dataDir>/<org>/<repo>` 로 저장소마다 스토어가 생긴다. */
    dataDir: string;
    /** 테스트가 가짜를 주입한다. 기본은 실제 서버. */
    start?: typeof startAvcsServer;
  }) {
    this.start = deps.start ?? startAvcsServer;
  }

  /** 떠 있으면 주소, 아니면 `null`. **띄우지 않는다** — 그 판단은 `ensure()` 가 한다. */
  url(): string | null {
    return this.handle?.url ?? null;
  }

  /**
   * 떠 있으면 그 주소를, 아니면 띄우고 주소를 준다.
   *
   * 띄우지 못하면 **`null` 을 주고 던지지 않는다.** 부르는 쪽은 협업 탭의 읽기 경로이고,
   * 거기서 예외를 던지면 저장소 하나가 못 뜬 것 때문에 목록 전체가 사라진다 — 그 줄만
   * `no-server` 로 세우는 것이 이 표면의 규율이다.
   */
  async ensure(): Promise<string | null> {
    if (this.handle) return this.handle.url;
    this.chain = this.chain.then(async () => {
      if (this.handle || this.stopped) return;
      try {
        this.handle = await this.start({ dataDir: this.deps.dataDir, host: '127.0.0.1' });
        this.error = null;
      } catch (err) {
        // 사유는 **버리지 않고 들고 있는다.** 부르는 쪽이 로그에 적을 수 있어야 하고,
        // 그러지 않으면 "왜 hosted 저장소가 안 보이나" 에 답할 재료가 아무 데도 안 남는다.
        this.error = err;
      }
    });
    await this.chain;
    // `url()` 을 거쳐 읽는다 — 위에서 `this.handle` 이 null 로 좁혀졌고, 그 좁힘은 위 클로저가
    // 넣은 값을 모른다. 메서드 하나를 지나면 타입체커가 다시 읽는다.
    return this.url();
  }

  /** 마지막 기동 실패 사유. 떠 있거나 아직 시도하지 않았으면 `null`. */
  startError(): unknown {
    return this.error;
  }

  /** 기동 중인 것까지 기다린 뒤 닫는다. 두 번 불러도 안전하다. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.chain;
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.close();
  }
}
