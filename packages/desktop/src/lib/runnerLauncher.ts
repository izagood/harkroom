/**
 * 러너 실행기(#250). **앱이 러너를 띄운다** — 서버가 아니다(docs/design.md §1: 에이전트는
 * 외부 접속형이고, 그 '외부'가 이 데스크탑 앱이다).
 *
 * ## 운영자 결정 (다시 정하지 마라)
 *
 * 1. PAT 는 앱이 서버에서 발급받아 **OS 키체인**에 보관하고, 러너에 `MURMUR_PAT` 로 넘긴다.
 *    러너는 PAT 를 저장하지 않는다.
 * 2. **기동마다 재발급하지 않는다.** 앱 재시작·업데이트 뒤에는 키체인의 PAT 를 그대로 다시
 *    쓴다 — 재발급하면 그 PAT 로 돌던 러너가 401 을 받고 물러나며 진행 중인 작업이 날아간다.
 *    앱 업데이트 한 번에 돌던 러너가 전부 죽는 것이 이 결정이 막는 것이다.
 * 3. **회전은 사람이 누를 때만** 한다: 새 PAT 발급 → 옛 PAT 서버에서 폐기 → 자식 종료 →
 *    새 PAT 로 재실행. 옛 PAT 로 돌던 러너(앱이 띄우지 않은 것 포함)는 다음 호출에서 401 을
 *    받고 스스로 **종료 코드 78**(EX_CONFIG)로 물러난다 — 러너↔앱 통신 채널은 만들지 않고,
 *    서버가 진실의 원천이다.
 *
 * ## Tauri 표면을 왜 주입하는가
 *
 * 키체인(`secret_*` invoke)과 러너 소유(`daemon_spawn_runner`/`daemon_kill_runner` invoke)를
 * 이 클래스가 직접 부르면 회귀선을 걸 자리가 없다 — 테스트가 확인할 수 있는 것이
 * "목을 손으로 넘긴 값"뿐이 되고, 앱에서 죽은 배선이 초록으로 통과한다. 두 표면을
 * 인터페이스로 뽑고 기본 구현을 이 파일 아래쪽에 둔다.
 *
 * ## `#431` 1단계 — 프로세스 그룹 분리·사이드카 배포로 바뀐 것
 *
 * 러너는 더 이상 `@tauri-apps/plugin-shell` 의 `Command.create` 로 뜨지 않는다. 그 API 는
 * 프로세스 그룹 제어를 노출하지 않아서 러너가 앱의 프로세스 그룹에 묶인 채로 떴고, 실측
 * (2026-09-05) 결과 `kill -TERM -<앱 PGID>` 한 번에 러너 전부가 죽었다 — 앱이 죽어도 러너가
 * 살아남는 것은 아무도 그 그룹에 시그널을 안 보내서일 뿐이었다. 그래서 spawn 자체를
 * Rust invoke 커맨드(`runner_spawn`)로 옮겼다 — `#425` 가 만든 패턴(웹뷰는 파라미터를 넘기지
 * 않고 실행 대상·인자가 Rust 안에 고정되는 invoke)을 그대로 재사용한다. Rust 쪽이 자식을
 * `setsid`(Unix)로 자기 세션/프로세스 그룹으로 분리한다.
 *
 * 또한 러너는 더 이상 `pnpm --filter @murmur/agent start` 로 소스를 실행하지 않는다 —
 * 단일 번들로 만들어 Tauri sidecar(`externalBin`)로 앱과 함께 배포한다. 그래서
 * `runnerRepoPath`(murmur 소스가 어디 있나) 자체가 사라졌다 — 그 역할은 이미 에이전트별
 * `workingDir`(DB)이 한다. `cwd` 도 이 실행기 표면에서 사라졌다: sidecar 는 자기 위치를
 * 스스로 알고, 러너가 일할 저장소는 `mentionTurn.ts` 가 `workingDir` 로 따로 정한다
 * (`process.cwd()`는 애초에 그 판단에 쓰인 적이 없다).
 *
 * ## `#431` 2단계-b 3/3 — **앱이 러너의 부모가 아니다**
 *
 * 러너는 이제 daemon 이 띄운다. 앱은 daemon 에 소켓으로 붙어 "이 에이전트의 러너를
 * 띄워라"라고 말할 뿐이다(`daemonSpawner`). 그래서 이 파일의 첫 줄 — *"앱이 러너를
 * 띄운다"* — 은 **한 겹 간접이 된다**: 러너를 띄우게 하는 것은 여전히 이 앱이지만,
 * 그 프로세스의 부모는 daemon 이다.
 *
 * 바뀐 것과 바뀌지 않은 것:
 *
 * | | 그대로인가 |
 * |---|---|
 * | `RunnerSpawner` 인터페이스(`spawn → { kill }`) | **그대로** — 호출부가 안 바뀐다 |
 * | `#419` 세대 토큰(`runTokens`) | **그대로** — 재는 것이 앱 안의 세대다 |
 * | PAT 운영자 결정 1·2·3 (위) | **그대로** |
 * | 러너 프로세스의 부모 | 앱 → **daemon** |
 * | 종료 통지 경로 | `runner_wait_exit` → **소켓의 `runnerExit` 이벤트** |
 * | 세대 구분자 | Symbol 하나 → **Symbol + `incarnationId`**(`daemonSpawner` 주석) |
 *
 * **`sessions.json`·`SessionStore` 는 여기서도 안 건드린다**(`#431` D5) — 이 파일이 아는
 * 것은 프로세스와 PAT 뿐이고, 세션 상태의 writer 는 러너 하나여야 한다.
 */
import { Command } from '@tauri-apps/plugin-shell';

export type RunnerStatus = 'stopped' | 'running' | 'external' | 'needs_reissue' | 'failed';

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

/** 키체인에 넣는 것. **라벨을 함께 보관한다** — 회전 때 폐기할 대상이 이 라벨이다. */
export interface StoredRunnerPat {
  label: string;
  token: string;
}

/**
 * 키체인 읽기 결과. **'없다'와 '못 읽었다'를 구분한다.** 못 읽은 것을 '없다'로 삼키면
 * 앱은 새 PAT 를 발급하고 옛 것을 폐기하는데, 그 옛 PAT 로 **지금 일하고 있는 러너**가
 * 다음 호출에서 401 을 받고 죽는다 — 결정 2 가 막으려는 사고를 키체인 한 번의 실패로
 * 재현하는 것이다. 그래서 실패는 실패로 올라간다.
 */
export type SecretRead =
  | { ok: true; value: StoredRunnerPat | null }
  | { ok: false; error: string };

export interface RunnerSecretStore {
  read(agentId: string): Promise<SecretRead>;
  write(agentId: string, value: StoredRunnerPat): Promise<void>;
  clear(agentId: string): Promise<void>;
  /** 이 설치를 가리키는 안정된 id. PAT 라벨에 들어간다(`deviceId()` 주석 참고). */
  deviceId(): Promise<string>;
}

/** 띄운 자식. 종료 통지는 `spawn` 에 넘긴 `onExit` 으로 온다. */
export interface RunnerProcess {
  kill(): Promise<void>;
}

export interface SpawnRequest {
  /**
   * 어느 에이전트의 러너인가(`#431` 2단계-b 3/3에서 추가됐다).
   *
   * **daemon 은 러너를 `agentId` 로 센다** — pid 가 아니다(`daemonProtocol.ts` 의
   * `SpawnRunnerParams`·`KillRunnerParams` 가 전부 `agentId` 를 축으로 한다). 앱이 pid 를
   * 들고 있던 시절에는 이 값이 필요 없었지만, 소유권이 daemon 으로 넘어가면서 "누구의
   * 러너인가"를 소켓 너머로 말해야 한다.
   */
  agentId: string;
  env: Record<string, string>;
  /** 자식이 끝나면 정확히 한 번 불린다. `code` 가 `null` 이면 시그널로 죽은 것이다. */
  onExit(code: number | null): void;
}

export interface RunnerSpawner {
  spawn(req: SpawnRequest): Promise<RunnerProcess>;
}

/**
 * 로그인 셸의 `PATH` 를 읽는 표면(#305). 자식 프로세스와 마찬가지로 **주입한다** —
 * 테스트가 "조회에 실패했다"를 만들 수 없으면 그 경로의 회귀선을 걸 자리가 없다.
 *
 * `null` 은 '얻지 못했다'다(실패했거나 빈 문자열이었다). 그때 조용히 기존 `PATH` 로
 * 넘어가지 않는 것이 이 기능의 요점이다 — 그것이 지금의 실패 모습이다.
 */
export interface LoginPathReader {
  read(): Promise<string | null>;
}

export interface RunnerApi {
  baseUrl: string;
  mintPat(accountId: string, label: string): Promise<string>;
  listPats(accountId: string): Promise<{ label: string; revokedAt: string | null }[]>;
  revokePat(accountId: string, label: string): Promise<{ revoked: number }>;
}

/** 실행기가 대상 판정에 쓰는 에이전트의 사실만. `AgentView` 전체를 요구하지 않는다. */
export interface LaunchableAgent {
  id: string;
  handle: string;
  ownerAccountId: string | null;
  disabled: boolean;
  stopRequestedAt: string | null;
}

export interface StartAllInput {
  agents: LaunchableAgent[];
  /** 나(사람) 계정 id. 소유 판정의 기준이다. */
  myAccountId: string;
  /**
   * **지금 폴을 걸고 있는** 계정 id 들(#124 presence). `null` 은 '모른다'다 — 소켓이
   * 끊겨 있으면 `online` 은 그냥 빈 배열이고, 그것을 '아무도 안 붙어 있다'로 읽으면 잘
   * 돌고 있는 러너 옆에 두 번째 러너를 띄운다(중복 러너 금지가 이것을 막는다).
   *
   * **`runnerVersion` 은 이 신호가 아니다.** 그 값은 "마지막으로 붙었던 러너의 빌드
   * 버전"이고 러너가 죽어도 지워지지 않는다(013_agent_runner_version.sql 이 그렇게 적어
   * 뒀다: "지금 붙어 있나는 이 테이블이 답하지 않는다. #124 의 인메모리 presence 가
   * 답한다"). 그것으로 판정하면 한 번이라도 러너가 붙었던 에이전트는 영원히
   * '외부에서 실행 중'이 되어 앱이 아무것도 띄우지 않는다.
   */
  liveAccountIds: Set<string> | null;
}

/** 방금 만든 에이전트와 발급 순간에만 볼 수 있는 PAT 를 앱 실행기에 넘기는 입력. */
export interface StartCreatedInput {
  agent: LaunchableAgent;
  pat: StoredRunnerPat;
  /** 연결 설정의 자동 기동 토글. 꺼져 있어도 PAT 는 키체인에 보관한다. */
  autoStart: boolean;
  /** 현재 presence 사실. 새 계정이어도 연결이 끊긴 상태에서 무작정 띄우지는 않는다. */
  liveAccountIds: Set<string> | null;
}

/** 살아 있는 PAT 라벨의 접두사. 회전 라벨(`desktop:<id>#<epoch>`)도 이 접두사를 갖는다. */
export const patLabelPrefix = (deviceId: string): string => `desktop:${deviceId}`;

/**
 * 로그인 셸의 `PATH` 를 얻는 스코프 항목(#305). **인자가 배열 리터럴로 못박혀 있다** —
 * `sh` 를 허용하되 `['-lc', 'echo $PATH']` **그 한 줄만** 허용하므로 와일드카드가 아니다.
 * `args: true` 나 정규식 인자로 바꾸는 순간 웹뷰가 임의 명령을 실행할 수 있게 되고, 그것이
 * `#250` 의 보안 회귀선(`runnerShellScope.test.ts`)이 지키는 경계다.
 *
 * 왜 이것이 필요한가: macOS 에서 Dock/Finder 로 띄운 앱은 로그인 셸의 `PATH` 를 물려받지
 * 않는다(`/usr/bin:/bin:/usr/sbin:/sbin` 정도다). `docs/operations.md` §8-1 이 launchd
 * 감독에서 같은 함정을 이미 기록해 뒀다 — 같은 것을 다시 발견하지 마라.
 */
export const LOGIN_PATH_SCOPE_NAME = 'login-path';
export const LOGIN_PATH_ARGS = ['-lc', 'echo $PATH'];

/**
 * 로그인 셸의 `PATH` 를 못 읽었을 때 자식에 넘기는 기본 디렉터리들(#305).
 *
 * **디렉터리 하나만 남기면 안 된다.** 러너(사이드카)가 실행 중에 부르는 `claude`·`codex`·
 * `avcs`·`git` 이 이 `PATH` 안에서 발견돼야 한다 — 하나라도 없으면 턴이 알 수 없는 이유로
 * 실패하는 모습이 된다. 로그인 셸 값을 얻었을 때는 그것이 이 자리를 대신하므로 쓰지 않는다.
 */
export const SYSTEM_PATH_FALLBACK = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export class RunnerLauncher {
  /** 이 앱이 띄운 자식만. 외부 러너는 여기 없다(앱은 그것을 죽일 수도, 죽여서도 안 된다). */
  private runners = new Map<string, RunnerProcess>();
  /**
   * 에이전트별 최신 실행 세대. 종료 콜백은 자식보다 늦게 도착할 수 있으므로, 에이전트 id만
   * 보고 상태를 바꾸면 PAT 재발급 뒤 옛 자식의 종료가 새 자식을 `stopped`로 덮어쓴다(#419).
   */
  private runTokens = new Map<string, symbol>();
  /** `startOne` 의 비동기 구간까지 포함한 에이전트별 잠금. */
  private starting = new Map<string, Promise<void>>();
  /** dispose 뒤 완료된 비동기 준비가 자식을 다시 띄우지 못하게 하는 수명 경계. */
  private disposed = false;
  private states = new Map<string, RunnerState>();
  private onStateChange?: (states: RunnerState[]) => void;

  /**
   * 로그인 셸 `PATH` 조회 결과의 캐시(#305). **프로세스 생애 동안 한 번만 읽는다** —
   * 자식을 띄울 때마다 셸을 부르면 러너 수만큼 셸이 뜨고, 값은 어차피 바뀌지 않는다.
   * 실패도 캐시한다: 실패를 캐시하지 않으면 셸이 없는 환경에서 매번 다시 시도한다.
   */
  private loginPathOnce: Promise<string | null> | null = null;

  constructor(
    private api: RunnerApi,
    private secrets: RunnerSecretStore,
    private spawner: RunnerSpawner,
    /** 로그인 셸의 `PATH` 를 읽는 표면(#305). 테스트가 실패를 만들 수 있게 주입한다. */
    private loginPath: LoginPathReader = tauriLoginPathReader,
    /** 회전 라벨에 들어가는 시각. 테스트가 고정할 수 있게 주입한다. */
    private now: () => number = () => Date.now(),
  ) {}

  setOnStateChange(cb: (states: RunnerState[]) => void): void {
    this.onStateChange = cb;
  }

  getStates(): RunnerState[] {
    return [...this.states.values()];
  }

  private setState(agentId: string, patch: Omit<RunnerState, 'agentId'>): void {
    this.states.set(agentId, { agentId, ...patch });
    this.onStateChange?.(this.getStates());
  }

  /**
   * 대상 전부를 띄운다. **한 에이전트가 못 떠도 나머지는 뜬다** — 하나의 throw 가 루프를
   * 끊으면 목록 뒤쪽 에이전트들은 이유도 없이 안 뜬다.
   */
  async startAll(input: StartAllInput): Promise<void> {
    const targets = input.agents.filter((a) =>
      a.ownerAccountId === input.myAccountId && !a.disabled && !a.stopRequestedAt,
    );

    for (const agent of targets) {
      try {
        await this.startOne(agent, input);
      } catch (err) {
        this.setState(agent.id, {
          status: 'failed',
          exitCode: null,
          message: `기동 실패: ${errText(err)}`,
        });
      }
    }
  }

  /**
   * 설정 화면에서 만든 에이전트를 앱 재시작 없이 바로 실행 가능하게 만든다.
   *
   * 서버는 PAT 원문을 다시 주지 않으므로 생성 API 가 방금 돌려준 **그 PAT** 를 먼저
   * 키체인에 저장한다. 저장에 실패하면 계정 생성 자체를 실패한 척하지 않고 러너 상태에
   * 복구 가능한 이유를 남기며, 원문은 호출자가 생성 결과 화면에 계속 보여줄 수 있다.
   */
  async startCreated(input: StartCreatedInput): Promise<void> {
    try {
      await this.secrets.write(input.agent.id, input.pat);
    } catch (err) {
      this.setState(input.agent.id, {
        status: 'failed',
        exitCode: null,
        message: `에이전트는 생성됐지만 PAT 를 키체인에 저장하지 못해 러너를 띄우지 않았다: ${errText(err)}`,
      });
      return;
    }
    if (!input.autoStart || this.disposed) return;

    await this.startOne(input.agent, {
      agents: [input.agent],
      myAccountId: input.agent.ownerAccountId ?? '',
      liveAccountIds: input.liveAccountIds,
    }).catch((err) => {
      this.setState(input.agent.id, {
        status: 'failed', exitCode: null, message: `기동 실패: ${errText(err)}`,
      });
    });
  }

  private startOne(agent: LaunchableAgent, input: StartAllInput): Promise<void> {
    const pending = this.starting.get(agent.id);
    if (pending) return pending;

    const started = this.doStartOne(agent, input).finally(() => {
      if (this.starting.get(agent.id) === started) this.starting.delete(agent.id);
    });
    this.starting.set(agent.id, started);
    return started;
  }

  private async doStartOne(agent: LaunchableAgent, input: StartAllInput): Promise<void> {
    if (this.disposed) return;
    // 이 앱이 이미 띄웠으면 그대로 둔다.
    if (this.runners.has(agent.id)) return;

    // presence 를 모르면 띄우지 않는다 — 중복 러너보다 안 띄우는 쪽이 복구 가능하다.
    if (input.liveAccountIds === null) {
      this.setState(agent.id, {
        status: 'stopped',
        exitCode: null,
        message: '서버 연결이 끊겨 있어 러너가 붙어 있는지 알 수 없다 — 띄우지 않았다',
      });
      return;
    }
    if (input.liveAccountIds.has(agent.id)) {
      this.setState(agent.id, { status: 'external', exitCode: null, message: null });
      return;
    }

    const pat = await this.ensurePat(agent.id);
    if (!pat || this.disposed) return; // 사유는 ensurePat 이 상태에 남겼다.
    await this.spawnRunner(agent, pat.token);
  }

  /**
   * 키체인의 PAT 를 쓰고, **없을 때만** 발급한다(결정 2). 못 읽었으면 발급하지 않는다 —
   * `SecretRead` 주석에 이유가 있다.
   */
  private async ensurePat(agentId: string): Promise<StoredRunnerPat | null> {
    const read = await this.secrets.read(agentId);
    if (!read.ok) {
      this.setState(agentId, {
        status: 'failed',
        exitCode: null,
        // 여기서 발급으로 넘어가지 않는 것이 요점이라, 그 사실을 사람에게도 말한다.
        message: `키체인을 읽지 못했다 — 돌고 있는 러너를 죽일 수 있어 새로 발급하지 않았다: ${read.error}`,
      });
      return null;
    }
    if (read.value) return read.value;

    const deviceId = await this.secrets.deviceId();
    const label = patLabelPrefix(deviceId);

    // 키체인이 비어 있는데 서버에 이 기기 라벨이 살아 있으면, 그 토큰은 **아무도 가지고
    // 있지 않다**(비밀은 발급 순간에만 보인다). 되찾을 수 없으므로 먼저 폐기한다 — 라벨은
    // 살아 있는 토큰 안에서 유일해서(마이그레이션 010) 폐기하지 않으면 발급이 409 로 막힌다.
    const live = (await this.api.listPats(agentId)).filter(
      (p) => p.revokedAt === null && p.label.startsWith(label),
    );
    for (const p of live) await this.api.revokePat(agentId, p.label);

    const token = await this.api.mintPat(agentId, label);
    const stored = { label, token };
    await this.secrets.write(agentId, stored);
    return stored;
  }

  /**
   * 자식이 쓸 `PATH` 를 정한다(#305, `#431` 1단계에서 `pnpm` 경로 설정이 빠지며 단순해졌다).
   *
   * 1. 로그인 셸의 `PATH` 를 **한 번** 읽어 캐시한다 — 러너(사이드카)가 실행 중에 부르는
   *    `claude`·`codex`·`avcs`·`git` 이 그 안에 있어야 한다.
   * 2. 못 읽었으면 `SYSTEM_PATH_FALLBACK` 으로 물러난다. **여기서는 실패하지 않는다** —
   *    사이드카 자신은 `pnpm`처럼 `PATH` 에서 찾아야 하는 대상이 아니라(Rust 가 그 경로를
   *    직접 알고 있다, `sidecar_path()`), 이 값이 없다고 사이드카 실행 자체가 막히지는
   *    않는다. 다만 그 안에서 도는 하네스 CLI 를 못 찾으면 그 턴이 실패하고, 그 사유는
   *    이 앱이 지어내지 않고 러너 자신의 출력이 그대로 사람에게 보인다(`#368`).
   */
  private async resolveChildPath(): Promise<string> {
    this.loginPathOnce ??= this.loginPath.read()
      .then((p) => (p && p.trim() ? p.trim() : null))
      .catch(() => null);
    const login = await this.loginPathOnce;
    return login ?? SYSTEM_PATH_FALLBACK;
  }

  private async spawnRunner(agent: LaunchableAgent, token: string): Promise<void> {
    if (this.disposed) return;
    const path = await this.resolveChildPath();
    if (this.disposed) return;
    const runToken = Symbol(agent.id);
    this.runTokens.set(agent.id, runToken);
    let child: RunnerProcess;
    try {
      child = await this.spawner.spawn({
        agentId: agent.id,
        env: { MURMUR_PAT: token, MURMUR_URL: this.api.baseUrl, PATH: path },
        onExit: (code) => this.handleExit(agent.id, runToken, code),
      });
    } catch (err) {
      if (this.runTokens.get(agent.id) === runToken) this.runTokens.delete(agent.id);
      throw err;
    }
    // spawn IPC 도 비동기다. 그 사이 앱/세션이 닫혔다면 방금 생긴 자식을 즉시 거둔다.
    // 또는 자식이 spawn 응답보다 먼저 끝났다면 종료 콜백이 이미 이 세대를 지웠다. 그때
    // 뒤늦게 `running`을 쓰면 죽은 자식을 살아 있다고 표시하므로 같은 경계로 막는다.
    if (this.disposed || this.runTokens.get(agent.id) !== runToken) {
      try { await child.kill(); } catch { /* 이미 끝난 자식 */ }
      return;
    }
    this.runners.set(agent.id, child);
    this.setState(agent.id, { status: 'running', exitCode: null, message: null });
  }

  /**
   * 자식이 끝났다. **78 은 다른 종료와 다른 이야기다** — 자격증명이 폐기·회전됐다는 뜻이고
   * 사람이 할 일은 "PAT 재발급"이다. 그 외의 코드는 코드를 그대로 보여 준다: 앱이 원인을
   * 지어내면 사람은 로그를 볼 이유를 잃는다.
   */
  private handleExit(agentId: string, runToken: symbol, code: number | null): void {
    // PAT 재발급으로 대체된 옛 자식의 늦은 종료 통지는 최신 자식의 사실이 아니다.
    if (this.runTokens.get(agentId) !== runToken) return;
    this.runTokens.delete(agentId);
    this.runners.delete(agentId);
    if (code === 78) {
      this.setState(agentId, {
        status: 'needs_reissue',
        exitCode: code,
        message: 'PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다',
      });
      return;
    }
    // 사유를 따로 적지 않는다 — 코드가 곧 사유이고, `runnerStatusLabel` 이 그것을 문장으로
    // 만든다. 여기서 같은 말을 한 번 더 하면 화면에 같은 숫자가 두 번 뜬다.
    this.setState(agentId, { status: 'stopped', exitCode: code, message: null });
  }

  /**
   * PAT 재발급. **새 발급 → 옛 폐기 → 재실행** 순서다(결정 3).
   *
   * 왜 발급이 먼저인가: 폐기가 먼저면 발급이 실패한 순간(서버가 죽었거나 권한이 바뀌었거나)
   * 쓸 수 있는 PAT 가 하나도 없고, 그 사이 돌고 있던 러너는 이미 401 로 물러난다 — 사람은
   * 버튼 하나로 러너를 잃는다. 발급이 먼저면 실패해도 옛 PAT 가 살아 있어 아무것도 잃지 않는다.
   *
   * 라벨을 새로 만드는 이유: 서버는 **살아 있는 토큰 안에서 라벨이 유일**하고 중복을 409 로
   * 거절한다(마이그레이션 010). 같은 라벨로 먼저 발급하는 것은 불가능하므로, 회전 라벨에
   * 시각을 붙여 새 라벨로 발급하고 곧바로 옛 라벨을 폐기한다 — 두 개가 함께 사는 시간은
   * 그 사이뿐이다.
   */
  async reissue(target: { agent: LaunchableAgent }): Promise<void> {
    const agentId = target.agent.id;
    if (this.disposed) return;

    const read = await this.secrets.read(agentId);
    if (!read.ok) {
      this.setState(agentId, {
        status: 'failed', exitCode: null,
        message: `키체인을 읽지 못해 옛 PAT 를 폐기할 수 없다 — 재발급하지 않았다: ${read.error}`,
      });
      return;
    }

    const deviceId = await this.secrets.deviceId();
    const newLabel = `${patLabelPrefix(deviceId)}#${this.now()}`;

    let token: string;
    try {
      token = await this.api.mintPat(agentId, newLabel);
    } catch (err) {
      // 옛 PAT 는 그대로 살아 있다 — 돌고 있는 러너도 그대로다. 아무것도 잃지 않았다.
      this.setState(agentId, {
        status: 'failed', exitCode: null,
        message: `새 PAT 를 발급하지 못했다 — 옛 PAT 는 그대로 살아 있다: ${errText(err)}`,
      });
      return;
    }

    await this.secrets.write(agentId, { label: newLabel, token });

    // 옛 것을 폐기한다. 여기서 실패하면 폐기되지 않은 PAT 가 남으므로 **삼키지 않는다** —
    // 자식은 새 PAT 로 다시 띄우되(새 PAT 는 이미 유효하다) 사람에게 남은 일을 말한다.
    let revokeError: string | null = null;
    if (read.value && read.value.label !== newLabel) {
      try {
        await this.api.revokePat(agentId, read.value.label);
      } catch (err) {
        revokeError = errText(err);
      }
    }

    await this.stop(agentId);
    await this.spawnRunner(target.agent, token);
    if (revokeError) {
      this.setState(agentId, {
        status: 'running', exitCode: null,
        message: `새 PAT 로 다시 띄웠지만 옛 PAT(${read.value?.label}) 폐기에 실패했다 — 설정에서 손으로 폐기해라: ${revokeError}`,
      });
    }
  }

  /**
   * 이 앱이 띄운 자식을 끝낸다. 세대를 먼저 무효화하므로 그 뒤 도착하는 `onExit` 은
   * `handleExit` 첫 줄에서 early-return 한다 — **상태를 갱신하지 않는다.** 호출자가
   * 상태를 책임져야 한다(현재 유일한 호출처인 `reissue` 는 바로 뒤 `spawnRunner` 로 새로 쓴다).
   */
  async stop(agentId: string): Promise<void> {
    const child = this.runners.get(agentId);
    if (!child) return;
    // kill 결과보다 종료 이벤트가 늦을 수 있다. 먼저 세대를 무효화해야 그 콜백이 뒤이어
    // 뜨는 새 자식의 상태를 지우지 못한다.
    this.runTokens.delete(agentId);
    this.runners.delete(agentId);
    try {
      await child.kill();
    } catch { /* 이미 죽었으면 할 일이 없다 */ }
  }

  /** 앱이 닫힌다 — 띄운 자식도 같이 끝낸다. 상태는 지우지 않는다(창이 다시 열리면 보여야 한다). */
  dispose(): void {
    this.disposed = true;
    for (const child of this.runners.values()) void child.kill().catch(() => {});
    this.runners.clear();
    this.runTokens.clear();
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Tauri 기본 구현. 위 클래스는 이것을 몰라도 되고, 테스트는 이것을 쓰지 않는다.
// ---------------------------------------------------------------------------

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function tauriInvoke(): Invoke | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

const PAT_KEY = (agentId: string) => `murmur.runner.pat.${agentId}`;
const DEVICE_KEY = 'murmur.runner.device';

/**
 * 세션 토큰과 **같은 자리**를 쓴다(`lib/session.ts`): Tauri 가 있으면 OS 키체인
 * (`secret_get`/`secret_set`/`secret_delete`), 없으면 `localStorage` 로 물러난다.
 * 폴백의 값이 평문인 것도 session.ts 와 같고, 같은 이유로 받아들인다 — 배포되는 표면이
 * 아니다(브라우저 개발에서는 자식 프로세스 자체를 띄울 수 없다).
 *
 * **키체인 오류는 폴백으로 내려가지 않는다.** session.ts 가 같은 결정을 적어 뒀다: 키체인을
 * 쓰겠다고 해놓고 조용히 평문이 되는 것이 더 나쁘다. 읽기 오류는 `{ ok: false }` 로 올라간다.
 */
export const tauriSecretStore: RunnerSecretStore = {
  async read(agentId) {
    const invoke = tauriInvoke();
    const key = PAT_KEY(agentId);
    if (!invoke) {
      try {
        const raw = localStorage.getItem(key);
        return { ok: true, value: raw ? (JSON.parse(raw) as StoredRunnerPat) : null };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    }
    try {
      const raw = await invoke('secret_get', { key });
      if (typeof raw !== 'string' || !raw) return { ok: true, value: null };
      return { ok: true, value: JSON.parse(raw) as StoredRunnerPat };
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
  },

  async write(agentId, value) {
    const invoke = tauriInvoke();
    const key = PAT_KEY(agentId);
    if (!invoke) { localStorage.setItem(key, JSON.stringify(value)); return; }
    await invoke('secret_set', { key, value: JSON.stringify(value) });
  },

  async clear(agentId) {
    const invoke = tauriInvoke();
    const key = PAT_KEY(agentId);
    if (!invoke) { localStorage.removeItem(key); return; }
    await invoke('secret_delete', { key });
  },

  /**
   * 이 설치를 가리키는 id. 없으면 만들어 키체인에 넣는다.
   *
   * **호스트명을 쓰지 않는다.** 웹뷰의 `location.hostname` 은 Tauri 에서 `tauri.localhost`
   * 로, 어느 머신에서든 같은 값이다. 그것을 라벨에 넣으면 두 대의 맥이 같은 라벨을 쓰고,
   * 라벨이 살아 있는 토큰 안에서 유일하므로(마이그레이션 010) 둘째 머신의 발급이 409 로
   * 막힌다 — 더 나쁘게는, 키체인이 빈 첫 기동의 "같은 라벨 먼저 폐기" 경로가 **다른
   * 머신에서 잘 돌고 있는 러너의 PAT** 를 폐기해 그 러너를 죽인다. 진짜 호스트명은
   * `@tauri-apps/plugin-os` 가 필요한데(lib/platform.ts 가 같은 이유로 그 의존을 거절했다),
   * 라벨에 필요한 것은 사람이 읽을 이름이 아니라 **기기마다 다른 값**이므로 id 로 충분하다.
   */
  async deviceId() {
    const invoke = tauriInvoke();
    const read = async (): Promise<string | null> => {
      if (!invoke) return localStorage.getItem(DEVICE_KEY);
      const raw = await invoke('secret_get', { key: DEVICE_KEY });
      return typeof raw === 'string' && raw ? raw : null;
    };
    const existing = await read();
    if (existing) return existing;
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (invoke) await invoke('secret_set', { key: DEVICE_KEY, value: id });
    else localStorage.setItem(DEVICE_KEY, id);
    return id;
  },
};

/**
 * `runnerExit` 이벤트가 웹뷰로 오는 이름. **Rust 의 `RUNNER_EXIT_EVENT` 와 같아야 한다** —
 * 다르면 exit 통지가 영영 안 와서 죽은 러너가 화면에 계속 `running` 으로 남는다.
 */
export const RUNNER_EXIT_EVENT = 'murmur://runner-exit';

/** daemon 이 보낸 exit 통지. **`incarnationId` 가 이 이벤트의 핵심 필드다.** */
export interface DaemonRunnerExit {
  agentId: string;
  incarnationId: string;
  code: number | null;
  signal: string | null;
}

/**
 * 러너를 **daemon 을 통해** 띄운다(`#431` 2단계-b 3/3).
 *
 * ## 무엇이 바뀌었나 — 앱은 더 이상 러너의 부모가 아니다
 *
 * 1단계·2/3 까지 이 자리는 `runner_spawn` 이었다: 앱이 사이드카를 직접 띄우고 pid 를
 * 들고 있었다. 이제는 daemon 이 띄우고 daemon 이 들고 있다. 앱이 갖는 것은 소켓 하나다.
 *
 * **`RunnerSpawner` 인터페이스는 그대로다** — `spawn(req) → { kill() }`. 그래서
 * `RunnerLauncher` 의 호출부는 `agentId` 한 줄 말고 바뀌지 않았고, `#419` 의 세대 토큰
 * 판정(`handleExit`)도 그대로 선다.
 *
 * ## `incarnationId` 로 세대를 가린다 — **두 겹이다**
 *
 * `#419` 의 `runTokens`(Symbol)는 **앱 안의** 세대를 가린다. 그런데 소켓을 한 겹 더
 * 거치면서 창이 넓어졌다: daemon 이 보낸 exit 이 앱에 닿기 전에 앱이 그 에이전트의
 * 러너를 새로 띄울 수 있다. 그때 Symbol 은 **새 것**을 가리키고 있으므로 옛 exit 이
 * 그대로 통과한다 — Symbol 은 "이 콜백이 지금 세대의 것인가"를 보지만, 소켓 너머에서
 * 온 통지가 어느 세대의 것인지는 모른다.
 *
 * 그래서 이 자리가 **먼저** 거른다: 이벤트의 `incarnationId` 가 이 spawn 이 받은 것과
 * 다르면 `onExit` 을 아예 안 부른다. 그러면 `handleExit` 의 Symbol 판정은 자기가 원래
 * 재던 것(앱 안의 세대)만 재면 된다. 두 판정이 겹치는 것이 아니라 **다른 것을 재는** 것이다.
 *
 * ## 실패는 폴백하지 않는다
 *
 * daemon 기동에 실패하면 이 함수가 그대로 던진다 — `RunnerLauncher.startAll` 이 그것을
 * 잡아 `failed` + `기동 실패: <사유>` 로 화면에 올린다. **앱이 직접 러너를 띄우는 경로는
 * 이제 없다**(`src-tauri/src/main.rs` 에서 `runner_spawn` 자체가 사라졌다). 있으면
 * "daemon 이 도는 줄 알았는데 아니었다"가 되고, 무엇이 러너를 소유하는지 아무도 모른다.
 */
export const daemonSpawner: RunnerSpawner = {
  async spawn(req) {
    const invoke = tauriInvoke();
    if (!invoke) {
      // 브라우저 개발에서는 unix 소켓도 자식 프로세스도 없다(`RunnerSecretStore` 폴백
      // 주석과 같은 사정) — 그 사실을 그대로 실패로 올린다.
      throw new Error('이 환경에서는 러너를 띄울 수 없다 — Tauri invoke 표면이 없다');
    }
    const result = await invoke('daemon_spawn_runner', {
      agentId: req.agentId,
      murmurPat: req.env.MURMUR_PAT,
      murmurUrl: req.env.MURMUR_URL,
      path: req.env.PATH,
    });
    const spawned = result as { agentId?: unknown; pid?: unknown; incarnationId?: unknown };
    if (typeof spawned?.incarnationId !== 'string' || typeof spawned.pid !== 'number') {
      // 지어내지 않는다 — 무엇이 왔는지 그대로 보인다(`#368`).
      throw new Error(`daemon 의 spawnRunner 응답이 계약과 다르다: ${JSON.stringify(result)}`);
    }
    const incarnationId = spawned.incarnationId;

    let notified = false;
    const unlisten = await listenRunnerExit(invoke, (event) => {
      if (notified) return;
      if (event.agentId !== req.agentId) return;
      // **세대가 다르면 버린다** — 위 "두 겹이다" 주석이 이 한 줄의 근거다.
      if (event.incarnationId !== incarnationId) return;
      notified = true;
      void unlistenSafely();
      req.onExit(event.code);
    });
    const unlistenSafely = async (): Promise<void> => {
      try { await unlisten(); } catch { /* 이미 떼였다 */ }
    };

    return {
      kill: async () => {
        // **세대를 실어 보낸다** — 안 실으면 daemon 이 "지금 것"을 죽이고, 그 사이 새로
        // 뜬 러너가 대신 죽을 수 있다(`daemonProtocol.ts::KillRunnerParams` 주석).
        await invoke('daemon_kill_runner', { agentId: req.agentId, incarnationId });
      },
    };
  },
};

/**
 * daemon 의 `runnerExit` 이벤트를 듣는다.
 *
 * `@tauri-apps/api` 를 의존으로 들이지 않고 이벤트 플러그인의 invoke 표면을 직접 쓴다 —
 * 이 파일은 이미 `__TAURI_INTERNALS__.invoke` 하나로 키체인·프로세스 표면을 다루고
 * 있고(`tauriInvoke`), 이벤트 하나 때문에 그 규칙을 깨면 표면이 둘로 갈린다.
 */
async function listenRunnerExit(
  invoke: Invoke,
  handler: (event: DaemonRunnerExit) => void,
): Promise<() => Promise<void>> {
  const internals = (globalThis as {
    __TAURI_INTERNALS__?: { transformCallback?: (cb: (payload: unknown) => void) => number };
  }).__TAURI_INTERNALS__;
  if (typeof internals?.transformCallback !== 'function') {
    throw new Error('이 환경에는 Tauri 이벤트 표면이 없다 — 러너 종료 통지를 들을 수 없다');
  }
  const handlerId = internals.transformCallback((payload) => {
    const message = payload as { payload?: unknown };
    const body = message?.payload as DaemonRunnerExit | undefined;
    if (body && typeof body.agentId === 'string' && typeof body.incarnationId === 'string') {
      handler(body);
    }
  });
  const eventId = await invoke('plugin:event|listen', {
    event: RUNNER_EXIT_EVENT,
    target: { kind: 'Any' },
    handler: handlerId,
  });
  return async () => {
    await invoke('plugin:event|unlisten', { event: RUNNER_EXIT_EVENT, eventId });
  };
}

/**
 * 로그인 셸의 `PATH` 를 한 번 읽는다(#305).
 *
 * `sh -lc 'echo $PATH'` 는 **`PATH` 를 얻기 위해서만** 돈다 — 러너를 이 셸로 띄우는 것이
 * 아니다. 스코프(`capabilities/default.json` 의 `login-path`)가 `sh` 에 그 인자 배열
 * 하나만 허용하므로, 웹뷰가 이 이름으로 부를 수 있는 것은 이 한 줄뿐이다.
 *
 * `execute()` 를 쓰는 이유: 이 명령은 자식으로 살아 있을 필요가 없고 **stdout 한 줄**이
 * 전부다. `spawn` 으로 띄우면 종료를 기다리며 이벤트를 모아야 하는데, 얻는 것이 같다.
 *
 * 실패는 `null` 로 올라간다 — 셸이 없거나(윈도우) 스코프가 막았거나 비어 있으면 호출자가
 * `SYSTEM_PATH_FALLBACK` 으로 넘어간다.
 */
export const tauriLoginPathReader: LoginPathReader = {
  async read() {
    try {
      const out = await Command.create(LOGIN_PATH_SCOPE_NAME, LOGIN_PATH_ARGS).execute();
      if (out.code !== 0) return null;
      const value = out.stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  },
};
