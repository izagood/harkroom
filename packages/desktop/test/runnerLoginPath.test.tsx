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
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Tauri shell 플러그인은 목이다 — 이 회귀선은 앱 빌드 없이 "무엇을 부르는가"만 본다.
const shell = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { create: shell.create } }));

import {
  RunnerLauncher, SYSTEM_PATH_FALLBACK, tauriLoginPathReader,
  type LaunchableAgent, type LoginPathReader, type RunnerProcess, type RunnerState,
  type SpawnRequest, type StoredRunnerPat,
} from '../src/lib/runnerLauncher';
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
  const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0);
  await launcher.startAll({
    agents: [agent('a')],
    myAccountId: 'me',
    liveAccountIds: new Set<string>(),
  });
  return { launcher, spawner };
}

beforeEach(() => {
  shell.create.mockReset();
  shell.execute.mockReset();
  shell.create.mockReturnValue({ execute: shell.execute });
});
afterEach(cleanup);

describe('1. PATH 조회는 고정 인자로만 부른다', () => {
  it('`sh` 를 `["-lc", "echo $PATH"]` 리터럴로 부른다 — 조립한 명령이 아니다', async () => {
    shell.execute.mockResolvedValue({ code: 0, stdout: '/usr/local/bin:/usr/bin\n', stderr: '' });

    await tauriLoginPathReader.read();

    // 리터럴로 적는다. 구현이 인자를 어디서 만들든 이 두 값이어야 하고, 그래야
    // `capabilities/default.json` 의 스코프(같은 리터럴)와 짝이 맞아 앱에서 산다.
    expect(shell.create).toHaveBeenCalledWith('login-path', ['-lc', 'echo $PATH']);
    expect(shell.create).toHaveBeenCalledTimes(1);
  });

  it('종료 코드가 0 이 아니거나 비어 있으면 얻지 못한 것이다 — 빈 PATH 를 지어내지 않는다', async () => {
    shell.execute.mockResolvedValue({ code: 1, stdout: '/usr/bin', stderr: 'boom' });
    expect(await tauriLoginPathReader.read()).toBeNull();

    shell.execute.mockResolvedValue({ code: 0, stdout: '   \n', stderr: '' });
    expect(await tauriLoginPathReader.read()).toBeNull();

    shell.execute.mockRejectedValue(new Error('ProgramNotAllowed'));
    expect(await tauriLoginPathReader.read()).toBeNull();
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
    const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0);
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
