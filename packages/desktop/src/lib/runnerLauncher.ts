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
 * 키체인(`secret_*` invoke)과 자식 프로세스(`@tauri-apps/plugin-shell`)를 이 클래스가 직접
 * 부르면 회귀선을 걸 자리가 없다 — 테스트가 확인할 수 있는 것이 "목을 손으로 넘긴 값"뿐이
 * 되고, 앱에서 죽은 배선이 초록으로 통과한다. 두 표면을 인터페이스로 뽑고 기본 구현을 이
 * 파일 아래쪽에 둔다.
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
  cwd: string;
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
  /** 러너를 돌릴 murmur 저장소 경로. 비어 있으면 띄우지 않고 사람에게 설정하라고 말한다. */
  repoPath: string;
  /**
   * 설정이 지정한 `pnpm` 실행 파일의 **절대 경로**(#305). 빈 문자열은 '정하지 않았다'다.
   * `validateRunnerCommand` 를 통과한 값만 여기 들어온다.
   */
  runnerCommand: string;
}

/** 방금 만든 에이전트와 발급 순간에만 볼 수 있는 PAT 를 앱 실행기에 넘기는 입력. */
export interface StartCreatedInput {
  agent: LaunchableAgent;
  pat: StoredRunnerPat;
  /** 연결 설정의 자동 기동 토글. 꺼져 있어도 PAT 는 키체인에 보관한다. */
  autoStart: boolean;
  /** 현재 presence 사실. 새 계정이어도 연결이 끊긴 상태에서 무작정 띄우지는 않는다. */
  liveAccountIds: Set<string> | null;
  repoPath: string;
  runnerCommand: string;
}

/** 살아 있는 PAT 라벨의 접두사. 회전 라벨(`desktop:<id>#<epoch>`)도 이 접두사를 갖는다. */
export const patLabelPrefix = (deviceId: string): string => `desktop:${deviceId}`;

/**
 * `MURMUR_PAT=... pnpm --filter @murmur/agent start` 를 그대로 옮긴 것. **명령은 설정에서
 * 읽지 않는다** — 사람이 편집할 수 있는 명령은 곧 `src-tauri/capabilities` 의 shell 스코프를
 * 와일드카드로 열어야 한다는 뜻이고(임의 명령 실행 표면), 그것이 이 기능에서 가장 큰 위험이다.
 * 대신 **cwd(저장소 경로)만** 설정에서 받는다: cwd 는 스코프 검사 대상이 아니라 그 명령이
 * 어디서 도는지만 바꾼다. 명령을 바꿔야 할 사람은 지금까지처럼 손으로 러너를 띄우면 되고
 * (설정 → 에이전트의 "러너 실행" 명령 틀, #177), 그 러너는 presence 로 '외부에서 실행 중'
 * 으로 보인다.
 */
export const RUNNER_SCOPE_NAME = 'murmur-runner';
export const RUNNER_ARGS = ['--filter', '@murmur/agent', 'start'];

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

/** 설정이 받는 값의 끝. 이것으로 끝나지 않으면 저장을 거절한다. */
export const RUNNER_COMMAND_SUFFIX = '/pnpm';

/**
 * 로그인 셸의 `PATH` 를 못 읽었을 때 설정 경로 뒤에 붙이는 기본 디렉터리들(#305).
 *
 * **디렉터리 하나만 남기면 안 된다.** 자식 `PATH` 는 앱의 것을 덮어쓰므로, 설정이 준
 * `/opt/homebrew/bin` 만 넘기면 `pnpm` 은 떠도 그것이 부르는 `node`·`git`·`sh` 가
 * `PATH` 에 없는 기기가 생긴다 — 러너가 뜬 직후 알 수 없는 이유로 죽는 모습이 된다.
 * 로그인 셸 값을 얻었을 때는 그것이 이 자리를 대신하므로 붙이지 않는다.
 */
export const SYSTEM_PATH_FALLBACK = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export const REPO_PATH_MISSING =
  '러너를 돌릴 murmur 저장소 경로가 설정되지 않았다 — 설정 → 연결에서 지정한다';

/**
 * `PATH` 를 얻지도 못했고 설정도 비어 있을 때 사람이 보는 문장(#305).
 *
 * **무엇을 하라는 말이 들어 있어야 한다.** '기동 실패' 만 남기면 사람이 할 수 있는 일이
 * 없고, 그것이 `docs/design.md` §4 가 금지하는 거짓 신호다. 이 문장은 화면의 보이는
 * 자리에 붙는다(`RunnerStatusLine`) — `sr-only` 나 콘솔이 아니다.
 */
export const RUNNER_COMMAND_MISSING =
  '러너 명령을 찾을 수 없다 — 로그인 셸의 PATH 를 읽지 못했다. 설정 → 연결에서 pnpm 의 절대 경로를 지정하라';

/**
 * 설정이 받는 러너 명령을 검사한다(#305). 문제가 없으면 `null`, 있으면 사람이 읽는 사유.
 *
 * **`pnpm` 실행 파일의 절대 경로만 받는다.** 명령 전체(프로그램 + 인자)를 사용자가 정하게
 * 하면 그것이 곧 임의 실행 표면이다 — `#250` 이 명령을 설정에서 받지 않기로 한 이유가
 * 그것이고, 여기서도 인자는 앱이 고정한다(`RUNNER_ARGS`).
 *
 * 이 경로는 **프로그램으로 넘어가지 않는다**: Tauri 의 shell 스코프에서 `cmd` 는 설정
 * 파일이 정하고 JS 는 항목 **이름**만 고를 수 있다(`Command.create` 의 첫 인자). 그래서
 * 이 값은 디렉터리로 쪼개져 자식 `PATH` 에 들어가고, 스코프의 `cmd: "pnpm"` 이 그것으로
 * 해석된다 — 스코프는 한 글자도 넓어지지 않는다.
 */
export function validateRunnerCommand(value: string): string | null {
  const v = value.trim();
  if (!v) return null; // 비어 있음은 '정하지 않았다'다 — 오류가 아니다.
  if (!v.startsWith('/')) {
    return '절대 경로여야 한다 — `/` 로 시작해야 한다';
  }
  // `..` 를 막는 이유: `/opt/homebrew/bin/../../../usr/bin/pnpm` 처럼 끝만 맞춘 경로가
  // 실제로 가리키는 디렉터리를 사람이 읽어서 알 수 없게 된다.
  if (v.split('/').includes('..')) {
    return '`..` 가 들어간 경로는 받지 않는다 — 실제로 가리키는 곳이 보이지 않는다';
  }
  if (!v.endsWith(RUNNER_COMMAND_SUFFIX)) {
    return `pnpm 실행 파일의 절대 경로여야 한다 — \`...${RUNNER_COMMAND_SUFFIX}\` 로 끝나야 한다`;
  }
  return null;
}

/** 설정의 절대 경로에서 자식 `PATH` 에 넣을 디렉터리를 뽑는다. 값이 없거나 틀렸으면 `null`. */
export function runnerCommandDir(value: string): string | null {
  const v = value.trim();
  if (!v || validateRunnerCommand(v) !== null) return null;
  return v.slice(0, v.length - RUNNER_COMMAND_SUFFIX.length) || '/';
}

export class RunnerLauncher {
  /** 이 앱이 띄운 자식만. 외부 러너는 여기 없다(앱은 그것을 죽일 수도, 죽여서도 안 된다). */
  private runners = new Map<string, RunnerProcess>();
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
   * 옛 "저장소 경로가 설정되지 않았다" 실패를 지운다(#373).
   *
   * 경로가 채워진 순간 그 사유는 **이미 거짓**이다. 재시도가 성공하면 상태가 덮이므로
   * 저절로 사라지지만, 재시도가 그 에이전트에 닿지 못하면(목록 조회 실패, 대상에서 빠짐)
   * 사람은 경로를 채운 뒤에도 "설정되지 않았다"를 계속 읽는다 — 그것이 #373 의 증상
   * 전부다. 그래서 재시도를 **시작하는 자리에서** 먼저 지운다.
   *
   * `failed` 를 남기고 문구만 비우지 않는다: 이유 없는 '실패'는 사람이 할 수 있는 일이
   * 없는 신호다(`RunnerState.message` 주석). 새 사유는 곧 재시도가 채운다.
   */
  clearRepoPathFailures(): void {
    let cleared = false;
    for (const [agentId, state] of this.states) {
      if (state.status !== 'failed' || state.message !== REPO_PATH_MISSING) continue;
      this.states.set(agentId, { agentId, status: 'stopped', exitCode: null, message: null });
      cleared = true;
    }
    if (cleared) this.onStateChange?.(this.getStates());
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
      repoPath: input.repoPath,
      runnerCommand: input.runnerCommand,
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

    if (!input.repoPath) {
      this.setState(agent.id, { status: 'failed', exitCode: null, message: REPO_PATH_MISSING });
      return;
    }

    const pat = await this.ensurePat(agent.id);
    if (!pat || this.disposed) return; // 사유는 ensurePat 이 상태에 남겼다.
    await this.spawnRunner(agent, pat.token, input.repoPath, input.runnerCommand);
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
   * 자식이 쓸 `PATH` 를 정한다(#305). 순서가 곧 결정이다:
   *
   * 1. 로그인 셸의 `PATH` 를 **한 번** 읽어 캐시한다.
   * 2. 설정에 `pnpm` 의 절대 경로가 있으면 그 **디렉터리를 앞에** 붙인다 — 사람이 고른
   *    것이 이기되, 로그인 셸의 나머지는 버리지 않는다(`pnpm` 은 `node` 를 `PATH` 에서
   *    찾는다. 디렉터리 하나만 남기면 그 다음이 안 뜬다).
   * 3. 둘 다 없으면 **띄우지 않고 사유를 남긴다.** 여기서 조용히 앱의 `PATH` 로 시도하는
   *    것이 지금의 실패 모습이다 — Dock 으로 띄운 앱의 `PATH` 에는 `pnpm` 이 없다
   *    (`docs/operations.md` §8-1 의 같은 함정).
   */
  private async resolveChildPath(
    runnerCommand: string,
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    this.loginPathOnce ??= this.loginPath.read()
      .then((p) => (p && p.trim() ? p.trim() : null))
      .catch(() => null);
    const login = await this.loginPathOnce;
    const dir = runnerCommandDir(runnerCommand);

    if (dir) return { ok: true, path: `${dir}:${login ?? SYSTEM_PATH_FALLBACK}` };
    if (login) return { ok: true, path: login };
    return { ok: false, error: RUNNER_COMMAND_MISSING };
  }

  private async spawnRunner(
    agent: LaunchableAgent, token: string, repoPath: string, runnerCommand: string,
  ): Promise<void> {
    if (this.disposed) return;
    const path = await this.resolveChildPath(runnerCommand);
    if (this.disposed) return;
    if (!path.ok) {
      this.setState(agent.id, { status: 'failed', exitCode: null, message: path.error });
      return;
    }
    const child = await this.spawner.spawn({
      cwd: repoPath,
      env: { MURMUR_PAT: token, MURMUR_URL: this.api.baseUrl, PATH: path.path },
      onExit: (code) => this.handleExit(agent.id, code),
    });
    // spawn IPC 도 비동기다. 그 사이 앱/세션이 닫혔다면 방금 생긴 자식을 즉시 거둔다.
    if (this.disposed) {
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
  private handleExit(agentId: string, code: number | null): void {
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
  async reissue(
    target: { agent: LaunchableAgent; repoPath: string; runnerCommand: string },
  ): Promise<void> {
    const agentId = target.agent.id;
    if (!target.repoPath) {
      this.setState(agentId, { status: 'failed', exitCode: null, message: REPO_PATH_MISSING });
      return;
    }

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
    await this.spawnRunner(target.agent, token, target.repoPath, target.runnerCommand);
    if (revokeError) {
      this.setState(agentId, {
        status: 'running', exitCode: null,
        message: `새 PAT 로 다시 띄웠지만 옛 PAT(${read.value?.label}) 폐기에 실패했다 — 설정에서 손으로 폐기해라: ${revokeError}`,
      });
    }
  }

  /** 이 앱이 띄운 자식을 끝낸다. 상태는 자식의 `onExit` 이 갱신한다. */
  async stop(agentId: string): Promise<void> {
    const child = this.runners.get(agentId);
    if (!child) return;
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
 * `@tauri-apps/plugin-shell` 로 자식을 띄운다.
 *
 * 종료는 **`close` 이벤트로만** 안다. 폴링으로 `kill()` 을 시도해 "아직 살아 있나"를 보는
 * 식으로는 알 수 없고(그 호출이 곧 자식을 죽인다), 무엇보다 종료 **코드**를 잃는다 — 78 과
 * 그 밖을 가리는 것이 이 기능의 전부다.
 *
 * `RUNNER_SCOPE_NAME` 은 `src-tauri/capabilities/default.json` 의 shell 스코프 항목 이름이다:
 * 프로그램 이름을 JS 가 정하는 것이 아니라, 미리 허용된 그 한 명령을 가리킬 뿐이다.
 */
export const tauriSpawner: RunnerSpawner = {
  async spawn(req) {
    const cmd = Command.create(RUNNER_SCOPE_NAME, RUNNER_ARGS, {
      cwd: req.cwd,
      env: req.env,
    });
    let notified = false;
    const once = (code: number | null) => {
      if (notified) return;
      notified = true;
      req.onExit(code);
    };
    cmd.on('close', (payload) => once(payload.code ?? null));
    // spawn 자체가 성공했는데 플러그인이 오류를 흘리면 자식은 이미 없다 — 그것도 종료다.
    cmd.on('error', () => once(null));
    const child = await cmd.spawn();
    return { kill: () => child.kill() };
  },
};

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
 * 설정의 절대 경로로 넘어간다.
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
