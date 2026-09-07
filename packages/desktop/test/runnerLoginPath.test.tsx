/**
 * Dock 으로 띄운 앱의 `PATH` 회귀선(#305).
 *
 * 무엇을 지키는가: macOS 에서 Finder/Dock 으로 띄운 앱은 로그인 셸의 `PATH` 를 물려받지
 * 않는다(`docs/operations.md` §8-1 이 launchd 감독에서 같은 함정을 이미 적어 뒀다). 러너
 * (사이드카) 자신은 앱이 그 경로를 알아서 뜨지만, 그 안에서 도는 `claude`·`codex`·`avcs`·
 * `git` 은 여전히 `PATH` 로 찾아야 한다. 그래서 앱은 로그인 셸의 `PATH` 를 **한 번** 읽어
 * 자식 `env.PATH` 로 넘기고, 못 얻으면 `SYSTEM_PATH_FALLBACK` 으로 물러난다.
 *
 * (`#431` 1단계 이전에는 여기에 "설정의 `pnpm` 절대 경로" 라는 세 번째 자리가 있었다 —
 * 러너를 `pnpm --filter @murmur/agent start` 로 띄우던 시절엔 `pnpm` 자체를 `PATH` 에서
 * 찾아야 했기 때문이다. 사이드카 spawn 은 그 프로그램을 Rust 가 직접 찾으므로
 * (`main.rs::sidecar_path()`) 그 자리와 `validateRunnerCommand`·`runnerCommandDir`·
 * `RUNNER_COMMAND_MISSING` 이 통째로 사라졌다.)
 *
 * ## `#513` 이 바꾼 것 — **셸을 부르는 자리가 Rust 로 갔다**
 *
 * `#305` 판본에서 이 파일의 1번 스위트는 *"웹뷰가 `sh` 를 `['-lc', 'echo $PATH']` 로
 * 부른다"* 를 shell 플러그인 목으로 쟀다. 그 셸 호출이 사라졌다.
 *
 * **왜**: 그 값이 닿는 곳은 러너 env 하나였고 **daemon 은 못 받았다**. daemon 은 웹뷰보다
 * 먼저 뜨기 때문이다(`#431` 2단계 A — `controller.start` 가 러너를 띄울지 정하기 전에
 * `ensureDaemon` 을 부른다). 그래서 Finder 로 띄운 앱에서 daemon 사이드카의 셔뱅
 * (`#!/usr/bin/env node`)이 `node` 를 못 찾아 **모든 에이전트가 실패**했다(실측 2026-09-06).
 *
 * Rust 가 스스로 캐내되(`src-tauri/src/login_path.rs`), 웹뷰도 자기 셸을 계속 부르면
 * **출처가 둘**이 되어 갈릴 수 있다. 그래서 하나로 합쳤다 — 웹뷰는 이제 값을 **묻는다**
 * (`login_path` invoke). 이 파일의 1번 스위트가 그 계약을 잰다.
 *
 * `PATH` 폴백·캐시·자식 env 라는 나머지 성질은 **그대로다** — 아래 2·3번 스위트는
 * `#305` 판본에서 손대지 않았다. 값의 출처만 바뀌었지 그 값을 어떻게 쓰는지는 안 바뀌었다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import {
  LOGIN_PATH_COMMAND,
  RunnerLauncher, SYSTEM_PATH_FALLBACK, tauriLoginPathReader,
  type LaunchableAgent, type LoginPathReader, type RunnerProcess, type RunnerState,
  type SpawnRequest, type StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { fakeDaemon } from './helpers/fakeDaemon';
import { RunnerStatusLine } from '../src/components/RunnerStatus';

const agent = (id: string): LaunchableAgent => ({
  id, handle: id, ownerAccountId: 'me', disabled: false, stopRequestedAt: null,
});

function fakeSecrets() {
  const map = new Map<string, StoredRunnerPat>();
  return {
    read: vi.fn(async (id: string) => ({ ok: true as const, value: map.get(id) ?? null })),
    write: vi.fn(async (id: string, v: StoredRunnerPat) => { map.set(id, v); }),
    clear: vi.fn(async (id: string) => { map.delete(id); }),
    deviceId: vi.fn(async () => 'dev0'),
  };
}

function fakeSpawner() {
  const spawns: SpawnRequest[] = [];
  return {
    spawns,
    spawn: vi.fn(async (req: SpawnRequest): Promise<RunnerProcess> => {
      spawns.push(req);
      return { kill: async () => {} };
    }),
  };
}

const fakeApi = () => ({
  baseUrl: 'https://murmur.example',
  listPats: vi.fn(async () => [] as { label: string; revokedAt: string | null }[]),
  mintPat: vi.fn(async (_id: string, label: string) => `murp_${label}`),
  revokePat: vi.fn(async () => ({ revoked: 1 })),
});

/** `read()` 를 세는 목. 캐시 확인에 쓴다. */
const fakeLoginPath = (value: string | null): LoginPathReader & { read: ReturnType<typeof vi.fn> } =>
  ({ read: vi.fn(async () => value) });

async function start(loginPath: LoginPathReader) {
  const spawner = fakeSpawner();
  const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0, fakeDaemon());
  await launcher.startAll({
    agents: [agent('a')],
    myAccountId: 'me',
    liveAccountIds: new Set<string>(),
  });
  return { launcher, spawner };
}

/** Tauri invoke 표면의 목. `tauriLoginPathReader` 가 무엇을 부르는지만 본다. */
const invoke = vi.fn();
function withTauri(): void {
  (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
}
function withoutTauri(): void {
  delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

beforeEach(() => {
  invoke.mockReset();
  withTauri();
});
afterEach(() => {
  withoutTauri();
  cleanup();
});

describe('1. PATH 는 Rust 에게 묻는다 — 웹뷰가 셸을 부르지 않는다 (#513)', () => {
  it('파라미터 없는 `login_path` invoke 하나를 부른다', async () => {
    invoke.mockResolvedValue('/opt/homebrew/bin:/usr/bin');

    expect(await tauriLoginPathReader.read()).toBe('/opt/homebrew/bin:/usr/bin');

    // **커맨드 이름을 리터럴로 적는다.** 구현이 상수를 무엇으로 바꾸든 이 이름이어야
    // 하고, 그래야 Rust 가 등록한 커맨드(`main.rs::login_path`)와 짝이 맞아 앱에서 산다.
    expect(invoke).toHaveBeenCalledWith('login_path');
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(LOGIN_PATH_COMMAND).toBe('login_path');
  });

  /**
   * **되돌려 RED 의 고정 — 웹뷰가 셸을 부르는 자리가 없다.**
   *
   * 위 단언은 "invoke 를 부른다"만 재므로, 그 옆에 shell 플러그인 호출을 도로 넣어도
   * 통과한다. 그러면 출처가 다시 둘이 되고 `#513` 이 고친 것이 풀린다. 소스를 읽어
   * 못박는다.
   */
  it('실행기 소스에 `@tauri-apps/plugin-shell` import 가 없다', () => {
    const src = readFileSync(
      nodePath.resolve(__dirname, '../src/lib/runnerLauncher.ts'), 'utf8',
    );
    // **주석을 빼고 본다.** 이 이름은 주석에 여러 번 남아 있고(왜 사라졌는지의 근거),
    // 그것을 세면 근거를 적을수록 회귀선이 빨개진다 — `runnerShellScope.test.ts` 의
    // `scanCallers` 가 같은 이유로 같은 일을 한다.
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(code).not.toContain('@tauri-apps/plugin-shell');
    expect(code).not.toContain('Command.create(');
  });

  it('값이 문자열이 아니거나 비어 있으면 얻지 못한 것이다 — 빈 PATH 를 지어내지 않는다', async () => {
    invoke.mockResolvedValue('   \n');
    expect(await tauriLoginPathReader.read()).toBeNull();

    invoke.mockResolvedValue(undefined);
    expect(await tauriLoginPathReader.read()).toBeNull();

    invoke.mockRejectedValue(new Error('boom'));
    expect(await tauriLoginPathReader.read()).toBeNull();
  });

  it('invoke 표면이 없으면 `null` 이다 — 브라우저 개발에서 던지지 않는다', async () => {
    withoutTauri();
    expect(await tauriLoginPathReader.read()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

/**
 * **`#513` 회귀선 1·2 — daemon 쪽 절반.**
 *
 * 이 파일의 나머지가 재는 것은 **러너**의 `PATH` 다. 그런데 `#513` 이 비어 있던 자리는
 * **daemon** 이었다 — 그리고 daemon 을 띄우는 코드는 Rust 에 있어 vitest 가 못 부른다.
 *
 * 그래서 여기서는 **두 언어의 값이 갈리지 않는지**만 잰다(`daemonEndpointContract` 가
 * 프로토콜 버전에 하는 것과 같은 방식). daemon 이 실제로 그 값을 env 로 받는지는
 * `daemon_client.rs::tests::daemon_커맨드가_path_를_env_로_넘긴다` 가 재고,
 * 빈약한 `PATH` 로 사이드카가 정말 못 뜨는지는
 * `빈약한_path_로는_사이드카가_뜨지_않고_충분한_path_로는_뜬다` 가 실물로 잰다.
 */
describe('1-b. 폴백 값이 Rust 와 TS 에서 같다 (#513)', () => {
  const loginPathRs = readFileSync(
    nodePath.resolve(__dirname, '../src-tauri/src/login_path.rs'), 'utf8',
  );

  it('`SYSTEM_PATH_FALLBACK` 이 두 언어에서 같은 문자열이다', () => {
    const m = loginPathRs.match(/pub const SYSTEM_PATH_FALLBACK: &str = "([^"]*)";/);
    expect(m).not.toBeNull();
    // 두 곳에 같은 상수가 있는 것은 언어가 갈려서다(Rust ↔ TS). 갈리면 daemon 과 러너가
    // 서로 다른 폴백으로 뜨고, 그 어긋남은 "왜 러너만 되나" 로만 드러난다.
    expect(m![1]).toBe(SYSTEM_PATH_FALLBACK);
  });

  it('Rust 폴백도 비어 있지 않다 — 빈 PATH 를 daemon 에 넘기면 안 된다', () => {
    const m = loginPathRs.match(/pub const SYSTEM_PATH_FALLBACK: &str = "([^"]*)";/)!;
    expect(m[1]!.trim()).not.toBe('');
    expect(m[1]!.split(':').filter(Boolean).length).toBeGreaterThanOrEqual(4);
  });
});

describe('2. 얻은 PATH 가 자식 env 에 들어간다', () => {
  it('로그인 셸의 PATH 를 그대로 자식에게 넘긴다', async () => {
    const login = '/opt/homebrew/bin:/usr/local/bin:/usr/bin';
    const { spawner } = await start(fakeLoginPath(login));

    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]!.env.PATH).toBe(login);
    // 다른 env 를 밀어내지 않는다.
    expect(spawner.spawns[0]!.env.MURMUR_URL).toBe('https://murmur.example');
  });

  it('프로세스 생애 동안 한 번만 읽는다 — 러너 수만큼 셸을 띄우지 않는다', async () => {
    const loginPath = fakeLoginPath('/login/bin');
    const spawner = fakeSpawner();
    const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0, fakeDaemon());
    const input = { myAccountId: 'me', liveAccountIds: new Set<string>() };
    await launcher.startAll({ agents: [agent('a'), agent('b')], ...input });
    await launcher.startAll({ agents: [agent('c')], ...input });

    expect(spawner.spawns).toHaveLength(3);
    expect(loginPath.read).toHaveBeenCalledTimes(1);
  });
});

describe('3. 조회가 실패하면 SYSTEM_PATH_FALLBACK 을 쓴다 — 조용히 시도하지 않되, 안 뜨지도 않는다', () => {
  it('PATH 를 못 얻으면 SYSTEM_PATH_FALLBACK 으로 띄운다', async () => {
    const { spawner, launcher } = await start(fakeLoginPath(null));

    expect(spawner.spawns).toHaveLength(1);
    // 디렉터리 하나가 아니라 여러 표준 경로를 준다 — 사이드카가 부르는 `claude`·`codex`·
    // `avcs`·`git` 이 그 안에서 발견돼야 한다.
    expect(spawner.spawns[0]!.env.PATH).toBe(SYSTEM_PATH_FALLBACK);
    expect(spawner.spawns[0]!.env.PATH!.split(':')).toContain('/usr/bin');
    expect(launcher.getStates()[0]!.status).toBe('running');
  });

  it('PATH 를 얻으면 그 값이 SYSTEM_PATH_FALLBACK 을 대신한다 — 겹쳐 붙이지 않는다', async () => {
    const { spawner } = await start(fakeLoginPath('/usr/bin'));

    expect(spawner.spawns[0]!.env.PATH).toBe('/usr/bin');
    expect(spawner.spawns[0]!.env.PATH).not.toContain(SYSTEM_PATH_FALLBACK);
  });
});

/** 자기 자신이나 조상에 `sr-only` 가 붙어 있으면 화면에서 읽을 수 없다. */
function hiddenFromSight(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.classList.contains('sr-only')) return true;
  }
  return false;
}

/**
 * `#368` 의 원칙 — 실패 사유가 화면의 보이는 자리에 있다 — 은 사유가 무엇이든 지켜야
 * 한다. `RUNNER_COMMAND_MISSING` 이 사라졌으므로 여기서는 이 파일에 남아 있는 실제 실패
 * 사유(로그인 PATH 조회 자체의 예외, `#419` 의 78 종료 등과 같은 층위)를 하나 골라 같은
 * 성질을 확인한다.
 */
describe('6. 사유가 보이는 자리에 있다', () => {
  const REASON = '키체인을 읽지 못했다 — 돌고 있는 러너를 죽일 수 있어 새로 발급하지 않았다: boom';

  it('그 사유가 화면에 그려지고 `sr-only` 가 아니다', () => {
    const state: RunnerState = { agentId: 'a', status: 'failed', exitCode: null, message: REASON };
    render(<RunnerStatusLine state={state} />);

    expect(screen.getByText('기동 실패')).toBeTruthy();
    const reason = screen.getByText(new RegExp(REASON.slice(0, 20)));
    expect(hiddenFromSight(reason)).toBe(false);
  });
});

/**
 * **`#513` 회귀선 3·4 — daemon 이 `node` 를 못 찾은 사유가 화면까지 온다.**
 *
 * ## 무엇이 침묵했나
 *
 * 실측(2026-09-06, `.dmg` 설치 + Finder 로 열기)에서 사람이 받던 문구가 이것이다:
 *
 * > 기동 실패 — daemon 에 닿지 못해 러너를 띄우지 않았다: daemon 을 띄웠지만 10초 안에
 * > 붙지 못했다: daemon 이 소켓을 올리지 않았다
 *
 * **전부 사실이지만 사람이 할 수 있는 일이 하나도 없다.** 진짜 사유(`env: node: No such
 * file or directory`)는 daemon 로그 파일에만 있었고, 그 파일이 어디 있는지는 개발자만 안다.
 * `#443`·`#476` 이 반복해서 고쳐 온 침묵과 같은 모양이다.
 *
 * ## 이 스위트가 재는 자리 — **웹뷰가 사유를 삼키지 않는가**
 *
 * 문구를 만드는 자리는 Rust 다(`daemon_client.rs::node_missing_reason`) — vitest 가
 * 그 함수를 부를 수 없고, 그것을 재는 회귀선은 그쪽에 있다
 * (`daemon_이_node_를_못_찾으면_그_사실이_사유로_나온다` + 대조군 둘).
 *
 * 여기서 재는 것은 **그 문자열이 화면의 보이는 자리까지 오는가**다. 그 통로가 끊기면
 * Rust 를 아무리 잘 고쳐도 사람은 못 본다 — 그리고 그 통로를 끊는 것은 `errText` 하나를
 * 요약 문구로 바꾸는 것만으로도 된다.
 */
describe('7. daemon 이 node 를 못 찾은 사유가 화면에 온다 (#513)', () => {
  /** Rust `node_missing_reason` 이 만드는 문구 그대로. */
  const NODE_MISSING =
    'daemon 이 뜨자마자 끝났다 — 사이드카(`/A/murmur-daemon`)는 있는데 그것을 실행할 `node` 를 ' +
    '찾지 못했다. murmur 는 Node.js 를 동봉하지 않는다. ' +
    'Node.js 를 설치하라(LTS 판이면 된다): https://nodejs.org/en/download ' +
    '(daemon 로그: env: node: No such file or directory / 이때 쓴 PATH: /usr/bin:/bin)';

  async function startWithDaemonError(message: string) {
    const spawner = fakeSpawner();
    const daemon = fakeDaemon();
    daemon.error = new Error(message);
    const launcher = new RunnerLauncher(
      fakeApi(), fakeSecrets(), spawner, fakeLoginPath('/usr/bin'), () => 0, daemon,
    );
    await launcher.startAll({
      agents: [agent('a')],
      myAccountId: 'me',
      liveAccountIds: new Set<string>(),
    });
    return { launcher, spawner };
  }

  it('사유가 러너 상태에 원문 그대로 실린다 — 요약하지 않는다', async () => {
    const { launcher, spawner } = await startWithDaemonError(NODE_MISSING);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('failed');
    // **원문을 삼키지 않는다**(`#368`). 설치 주소가 사라지면 사람이 할 수 있는 일이 없다.
    expect(state.message).toContain('https://nodejs.org/en/download');
    expect(state.message).toContain('`node`');
    // daemon 이 죽었으므로 러너는 안 떴다 — 사유만 남고 자식은 없다.
    expect(spawner.spawns).toHaveLength(0);
  });

  it('그 사유가 화면의 보이는 자리에 그려진다 — `sr-only` 가 아니다', async () => {
    const { launcher } = await startWithDaemonError(NODE_MISSING);
    render(<RunnerStatusLine state={launcher.getStates()[0]!} />);

    expect(screen.getByText('기동 실패')).toBeTruthy();
    const reason = screen.getByText(/nodejs\.org/);
    expect(hiddenFromSight(reason)).toBe(false);
  });

  /**
   * **대조군 — 다른 daemon 실패에는 그 문구가 안 붙는다.**
   *
   * **이것이 없으면 위 둘은 "모든 daemon 실패에 Node 설치를 권하는" 구현으로도
   * 통과한다.** 이 저장소가 반복해서 겪은 실패 모드다 — `#476`·`#473` 이 같은 자리에서
   * 걸렸다. 사유가 다르면 사람이 할 일도 다르다.
   */
  it('대조군: 소켓 경로 길이 같은 다른 사유에는 Node 이야기가 없다', async () => {
    const { launcher } = await startWithDaemonError(
      '소켓 경로가 120바이트로 커널 상한 104바이트를 넘는다',
    );
    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('failed');
    expect(state.message).toContain('커널 상한');
    expect(state.message).not.toContain('nodejs.org');
    expect(state.message).not.toContain('Node.js 를 설치하라');
  });

  /**
   * **대조군 — 정상일 때는 아무 사유도 안 뜬다.**
   *
   * 위 대조군은 "다른 실패"를 재고 이것은 "실패가 아닌 것"을 잰다. daemon 이 멀쩡하면
   * 러너가 뜨고 상태는 `running` 이며, 문구 자리(`message`)는 비어 있어야 한다.
   */
  it('대조군: daemon 이 멀쩡하면 러너가 뜨고 문구가 안 붙는다', async () => {
    const { spawner, launcher } = await start(fakeLoginPath('/opt/homebrew/bin:/usr/bin'));

    expect(spawner.spawns).toHaveLength(1);
    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('running');
    expect(state.message ?? '').not.toContain('nodejs.org');
    expect(state.message ?? '').not.toContain('node');
  });
});
