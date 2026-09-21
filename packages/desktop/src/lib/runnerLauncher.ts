/**
 * 러너 관측기 — 스펙 2026-09-20 §2 책임표: **프론트는 러너를 띄우지 않는다.**
 *
 * ## 이 파일이 잃은 것 (단계 2)
 *
 * 앞 판본(`#250`·`#431`·`#443`)은 이 클래스가 러너를 **띄웠다**: PAT 를 서버에서 발급받아
 * 키체인에 두고, daemon 에 소켓으로 "이 에이전트의 러너를 띄워라"를 말하고, 죽으면 다시
 * 띄우고, 사람이 누르면 PAT 를 회전했다. 그 결정 전부가 이 앱 안에 있었기 때문에 **앱이
 * 없으면 에이전트도 없었다** — 서버를 원격지로 옮기자 그 결함이 드러났다(스펙 §1).
 *
 * 그 일은 전부 오퍼레이터로 갔다:
 *
 * | 앞 판본의 자리 | 지금 |
 * |---|---|
 * | `startAll`·`startCreated`(무엇을 띄울까) | 서버의 **배정**(`agent_assignment`)이 오퍼레이터에 내려간다 |
 * | `spawnRunner`(env 조립·PAT) | `packages/operator/src/assignments.ts` |
 * | `pursueRespawn`(죽으면 다시) | 같은 파일 `onRunnerExit` |
 * | `reissue`(PAT 회전) | 사라졌다 — 단계 4 에서 PAT 자체가 사라진다 |
 * | `restart`(새 번들로 갈아 띄우기) | 오퍼레이터 자체를 갱신하면 된다 |
 *
 * ## 남은 것 — 관측
 *
 * 이 머신에 오퍼레이터가 돌고 있으면 그 장부를 읽어 화면에 흘린다. **판정이 아니라
 * 관측이다**(`appStore.ts::daemonRunners` 의 표): 장부에 살아 있는 러너는 `adopted`(이 앱이
 * 띄운 것이 아니다 — 이제 어떤 러너도 그렇다)로, 없으면 아무 상태도 만들지 않는다.
 * 그때 화면은 서버 presence 로 돌아간다(`faceState.ts`) — 다른 머신의 오퍼레이터가 돌리는
 * 러너는 이 장부에 없고, 그것이 정상이다.
 *
 * `RunnerStatus` 의 갈래(`needs_harness`·`needs_login`…)는 남겨 둔다. 지금 이 앱이 만드는
 * 값은 `adopted` 뿐이지만, 그 갈래들이 말하는 사실(하네스가 없다, 로그인이 풀렸다)은
 * 오퍼레이터의 능력(`hello.capabilities.harnesses`)으로 서버에 오르고 화면은 그것을 다시
 * 보게 된다 — 갈래를 지우면 그 문구까지 사전에서 사라진다.
 */

/**
 * 러너의 지금 상태.
 *
 * `adopted` 는 **오퍼레이터가 아는 사실**이다: 이 머신의 장부에 있고 `kill(pid, 0)` 으로
 * 살아 있음을 방금 확인했다. 앞 판본의 `running`(이 앱 세션이 띄웠다)은 더 이상 만들어지지
 * 않는다 — 앱은 아무것도 띄우지 않는다.
 */
export type RunnerStatus =
  | 'stopped'
  | 'running'
  | 'adopted'
  | 'restarting'
  | 'needs_reissue'
  | 'needs_harness'
  | 'needs_login'
  | 'failed';

export interface RunnerState {
  agentId: string;
  status: RunnerStatus;
  /** 자식의 종료 코드. `null` 은 '아직 종료하지 않았다' 또는 '시그널로 죽어 코드가 없다'다. */
  exitCode: number | null;
  /**
   * 사람에게 보일 사유. **`failed` 는 반드시 이유를 갖는다** — 이유 없는 '실패'는 사람이
   * 할 수 있는 일이 없는 신호이고, 그것이 docs/design.md §4 가 금지하는 거짓 신호다.
   */
  message: string | null;
}

/**
 * 이 머신의 오퍼레이터에게 "무엇이 돌고 있나"를 묻는 표면(`#431` 2단계 A).
 *
 * 주입하는 이유: 실물은 Tauri invoke 이고, 테스트 환경에는 그 표면이 없다. 회귀선이
 * "장부에 무엇이 있다"를 만들 수 있어야 한다(`test/helpers/fakeDaemon.ts`).
 */
export interface DaemonObserver {
  /**
   * 오퍼레이터를 확보하고 그 장부를 읽는다. 실패는 **던진다** — 삼키면 "오퍼레이터가 도는
   * 줄 알았는데 아니었다"가 되고, 그 상태가 `#431` 이 없애려는 바로 그것이다.
   */
  observe(): Promise<DaemonObservation>;
}

/**
 * 이 앱 번들의 버전을 읽는 표면. `null` 은 '얻지 못했다'이고, 그때 조용히 아무 값으로
 * 넘어가지 않는다. 화면의 뒤처짐 판정(`runnerVersions.ts::staleRunners`)이 이 값을 기준으로
 * 쓴다 — 러너에 심는 `AGENT_VERSION` 은 이제 오퍼레이터가 자기 버전으로 심는다.
 */
export interface AppVersionReader {
  read(): Promise<string | null>;
}

/** 오퍼레이터가 말한 사실. **관측이지 판단이 아니다**(`daemonProtocol.ts::RunnerInfo`). */
export interface DaemonObservation {
  daemonPid: number;
  /** 이미 서비스 중인 오퍼레이터에 붙었는가(`false` 면 이번에 띄웠다). */
  attached: boolean;
  runners: ObservedRunner[];
}

/**
 * 오퍼레이터가 러너 하나에 대해 **직접 확인한** 것.
 *
 * ## 새 필드가 전부 옵셔널인 이유 (`#443`)
 *
 * 옛 오퍼레이터는 이것을 안 보낼 수 있다. `0` 이나 `-1` 같은 자리표시를 넣지 않는 것이
 * 요점이다 — 그러면 화면이 "pid 0" 같은 거짓을 그리고, 사람은 그것이 진짜 pid 인지
 * '모른다'의 표현인지 구분할 수 없다. `undefined` 이면 화면은 **그 행을 그리지 않는다**
 * (규칙 06: 없는 것을 그리지 않는다).
 */
export interface ObservedRunner {
  agentId: string;
  /** 오퍼레이터가 `kill(pid, 0)` 으로 **직접 확인한** 생사. 서버 추측이 아니다. */
  alive: boolean;
  /** 띄운 것이 아니라 채택한 것인가(`#431` 2-c). */
  adopted: boolean;
  /** 러너 프로세스의 pid. 장부(`runners-v1.json`)에 적힌 그 값이다. */
  pid?: number;
  /** 이 spawn 이 만든 세대(`daemonProtocol.ts::SpawnRunnerResult`). */
  incarnationId?: string;
  /** 오퍼레이터가 이 러너를 띄운(또는 채택한) 시각. epoch ms. */
  startedAtMs?: number;
  /**
   * **오퍼레이터가** SIGTERM 을 보낸 시각. 안 보냈으면 `null`.
   *
   * `null` 과 `undefined` 가 다르다: `null` 은 *"안 보냈다"* 이고 실제로 말한 사실이며,
   * `undefined` 는 *"옛 오퍼레이터라 이 필드를 아예 모른다"* 다. 사람이 UI 에서 한 종료
   * 요청은 서버의 `stopRequestedAt`(`#428`)이 알고 오퍼레이터는 모르므로, 화면은 두 출처를
   * **합쳐** 한 줄로 낸다(`daemonProtocol.ts::RunnerInfo.termSentAtMs`).
   */
  termSentAtMs?: number | null;
}

export class RunnerLauncher {
  private states = new Map<string, RunnerState>();
  private onStateChange?: (states: RunnerState[]) => void;
  /** `setOnObservation` 이 건 구독자. 오퍼레이터가 말한 사실이 화면까지 가는 통로다(`#443`). */
  private onObservation?: (runners: ObservedRunner[]) => void;
  /** 앱 버전을 한 번만 읽어 재사용한다 — 값은 프로세스 생애 동안 안 바뀐다. */
  private appVersionOnce: Promise<string | null> | null = null;
  private disposed = false;

  constructor(
    private daemon: DaemonObserver = tauriDaemonObserver,
    private appVersion: AppVersionReader = tauriAppVersionReader,
  ) {}

  /**
   * **앱이 뜨면 오퍼레이터를 세운다** — 띄울 러너가 하나도 없어도(`#431` 2단계 A).
   * 오퍼레이터는 러너의 부산물이 아니라 상주 프로세스다(사용자 결정: *"daemon 은 그냥
   * 떠 있는 것"*). 이 머신에 오퍼레이터가 있어야 비로소 "무엇이 도는가"를 물을 상대가 생긴다.
   *
   * **실패를 던지지 않는다.** 호출자(`controller.start`)는 기동 경로이고, 여기서 던지면
   * 오퍼레이터가 없다는 이유로 앱 자체가 안 뜬다. 원격 오퍼레이터만 쓰는 머신(핸드폰,
   * 스펙 §2)에서는 이것이 늘 `null` 이고, 그것이 정상이다.
   */
  async ensureOperator(): Promise<DaemonObservation | null> {
    if (this.disposed) return null;
    try {
      return await this.observeAndPublish();
    } catch {
      return null;
    }
  }

  setOnStateChange(cb: (states: RunnerState[]) => void): void {
    this.onStateChange = cb;
  }

  /**
   * 오퍼레이터가 말한 **사실**을 받는 자리(`#443`). `setOnStateChange` 와 **갈라 둔다** —
   * 저쪽은 상태(화면의 다섯 얼굴이 읽는 것)이고 이쪽은 관측(pid·세대·시각)이다
   * (`appStore.ts::daemonRunners` 의 표).
   */
  setOnObservation(cb: (runners: ObservedRunner[]) => void): void {
    this.onObservation = cb;
  }

  /**
   * 장부를 읽고 두 구독자에게 흘린다. 실패는 **그대로 던진다** — 실패했을 때 빈 목록을
   * 보내지 않는 것이 규율이다: "오퍼레이터에 못 닿았다"를 "러너가 없다"로 바꿔 말하면
   * 화면이 방금 전까지 보고 있던 pid 를 잃는다.
   *
   * 상태는 **살아 있는 것만** 만든다. 죽은 러너는 관측에는 남지만(pid 를 사람이 봐야
   * 하는 자리가 있다) 상태로는 세우지 않는다 — 앱은 그것이 왜 죽었는지 모르고, 모르는
   * 채로 `stopped` 를 단정하면 다른 오퍼레이터가 돌리는 러너를 멈춘 것으로 그린다.
   */
  private async observeAndPublish(): Promise<DaemonObservation> {
    const observation = await this.daemon.observe();
    this.onObservation?.(observation.runners);
    this.states = new Map(observation.runners
      .filter((r) => r.alive)
      .map((r) => [r.agentId, { agentId: r.agentId, status: 'adopted' as const, exitCode: null, message: null }]));
    this.onStateChange?.(this.getStates());
    return observation;
  }

  getStates(): RunnerState[] {
    return [...this.states.values()];
  }

  /** 화면이 뒤처짐을 판정할 때 쓰는 기준값. */
  async currentAppVersion(): Promise<string | null> {
    this.appVersionOnce ??= this.appVersion.read()
      .then((v) => (v && v.trim() ? v.trim() : null))
      .catch(() => null);
    return this.appVersionOnce;
  }

  /** 앱이 닫힌다. 상태는 지우지 않는다(창이 다시 열리면 보여야 한다). */
  dispose(): void {
    this.disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Tauri 기본 구현. 위 클래스는 이것을 몰라도 되고, 테스트는 이것을 쓰지 않는다.
// ---------------------------------------------------------------------------

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

/**
 * 응답 형태가 계약과 다르면 그것도 실패다. 지어내지 않고 온 것을 그대로 보인다(`#368`).
 */
export const tauriDaemonObserver: DaemonObserver = {
  async observe() {
    const invoke = tauriInvoke();
    if (!invoke) {
      // 브라우저 개발에는 unix 소켓도 자식 프로세스도 없다.
      throw new Error('이 환경에서는 오퍼레이터를 세울 수 없다 — Tauri invoke 표면이 없다');
    }
    const result = await invoke('daemon_list_runners');
    const body = result as {
      daemonPid?: unknown;
      attached?: unknown;
      runners?: unknown;
    };
    if (typeof body?.daemonPid !== 'number' || typeof body.attached !== 'boolean') {
      throw new Error(`오퍼레이터의 listRunners 응답이 계약과 다르다: ${JSON.stringify(result)}`);
    }
    // `runners` 가 배열이 아닌 것은 목록을 못 만들었다는 뜻이지 "0개"가 아니다.
    if (!Array.isArray(body.runners)) {
      throw new Error(`오퍼레이터가 러너 목록을 주지 않았다: ${JSON.stringify(result)}`);
    }
    const runners: ObservedRunner[] = [];
    for (const raw of body.runners) {
      const r = raw as {
        agentId?: unknown; alive?: unknown; adopted?: unknown;
        pid?: unknown; incarnationId?: unknown; startedAtMs?: unknown; termSentAtMs?: unknown;
      };
      if (typeof r?.agentId !== 'string') continue;
      runners.push({
        agentId: r.agentId,
        // 옛 오퍼레이터는 이 필드를 안 보낼 수 있다. 그때 **살아 있다고 본다** — 장부에
        // 이름이 올라 있다는 것 자체가 소유를 주장하는 것이다.
        alive: r.alive !== false,
        adopted: r.adopted === true,
        // 아래 넷은 상세 화면이 사람에게 보일 사실이다(`#443`). **없으면 없는 대로 둔다** —
        // 기본값을 주면 그것은 곧 화면에 그리는 거짓이 된다(`pid: 0` 은 진짜 pid 로 읽힌다).
        ...(typeof r.pid === 'number' ? { pid: r.pid } : {}),
        ...(typeof r.incarnationId === 'string' ? { incarnationId: r.incarnationId } : {}),
        ...(typeof r.startedAtMs === 'number' ? { startedAtMs: r.startedAtMs } : {}),
        // `termSentAtMs` 만 `null` 을 **받아 담는다** — 보낸 `null` 은 사실이지 결측이 아니다.
        ...(typeof r.termSentAtMs === 'number' || r.termSentAtMs === null
          ? { termSentAtMs: r.termSentAtMs as number | null }
          : {}),
      });
    }
    return { daemonPid: body.daemonPid, attached: body.attached, runners };
  },
};

/**
 * `app_version` invoke — Rust 가 `tauri.conf.json` 의 버전을 돌려준다.
 *
 * 오퍼레이터의 `--app-version` 을 쓰지 않는 이유: 상주 오퍼레이터는 자기를 띄운 옛 앱
 * 세대일 수 있다(실측 2026-09-07: daemon 0.1.6 이 소켓을 쥔 채 0.1.7 에게 물러나지 않았다).
 */
export const tauriAppVersionReader: AppVersionReader = {
  async read() {
    const invoke = tauriInvoke();
    if (!invoke) return null;
    try {
      const value = await invoke('app_version');
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  },
};
