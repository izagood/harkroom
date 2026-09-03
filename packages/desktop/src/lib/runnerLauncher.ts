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

const REPO_PATH_MISSING =
  '러너를 돌릴 murmur 저장소 경로가 설정되지 않았다 — 설정 → 연결에서 지정한다';

export class RunnerLauncher {
  /** 이 앱이 띄운 자식만. 외부 러너는 여기 없다(앱은 그것을 죽일 수도, 죽여서도 안 된다). */
  private runners = new Map<string, RunnerProcess>();
  private states = new Map<string, RunnerState>();
  private onStateChange?: (states: RunnerState[]) => void;

  constructor(
    private api: RunnerApi,
    private secrets: RunnerSecretStore,
    private spawner: RunnerSpawner,
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

  private async startOne(agent: LaunchableAgent, input: StartAllInput): Promise<void> {
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
    if (!pat) return; // 사유는 ensurePat 이 상태에 남겼다.
    await this.spawnRunner(agent, pat.token, input.repoPath);
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

  private async spawnRunner(
    agent: LaunchableAgent, token: string, repoPath: string,
  ): Promise<void> {
    const child = await this.spawner.spawn({
      cwd: repoPath,
      env: { MURMUR_PAT: token, MURMUR_URL: this.api.baseUrl },
      onExit: (code) => this.handleExit(agent.id, code),
    });
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
  async reissue(target: { agent: LaunchableAgent; repoPath: string }): Promise<void> {
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
    await this.spawnRunner(target.agent, token, target.repoPath);
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
