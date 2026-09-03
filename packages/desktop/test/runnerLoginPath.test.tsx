/**
 * Dock 으로 띄운 앱의 `PATH` 회귀선(#305).
 *
 * 무엇을 지키는가: macOS 에서 Finder/Dock 으로 띄운 앱은 로그인 셸의 `PATH` 를 물려받지
 * 않아 `pnpm` 을 못 찾는다(`docs/operations.md` §8-1 이 launchd 감독에서 같은 함정을 이미
 * 적어 뒀다). 그 자리를 앱이 두 겹으로 메운다 — 로그인 셸의 `PATH` 를 **한 번** 읽어 쓰고,
 * 그것이 안 되면 설정의 `pnpm` 절대 경로를 쓰고, 둘 다 없으면 **무엇을 하라는 말과 함께**
 * 화면에 실패로 남는다. 조용히 기존 `PATH` 로 시도하는 것이 지금의 실패 모습이라, 그
 * 경로를 여기서 막는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// Tauri shell 플러그인은 목이다 — 이 회귀선은 앱 빌드 없이 "무엇을 부르는가"만 본다.
const shell = vi.hoisted(() => ({ create: vi.fn(), execute: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { create: shell.create } }));

import {
  RunnerLauncher, RUNNER_COMMAND_MISSING, runnerCommandDir, tauriLoginPathReader,
  validateRunnerCommand,
  type LaunchableAgent, type LoginPathReader, type RunnerProcess, type SpawnRequest,
  type StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { RunnerStatusLine } from '../src/components/RunnerStatus';
import { usePrefsStore } from '../src/state/prefsStore';

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

async function start(
  loginPath: LoginPathReader, runnerCommand: string,
) {
  const spawner = fakeSpawner();
  const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0);
  await launcher.startAll({
    agents: [agent('a')],
    myAccountId: 'me',
    liveAccountIds: new Set<string>(),
    repoPath: '/repo',
    runnerCommand,
  });
  return { launcher, spawner };
}

beforeEach(() => {
  shell.create.mockReset();
  shell.execute.mockReset();
  shell.create.mockReturnValue({ execute: shell.execute });
  usePrefsStore.setState({ runnerCommand: '' });
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
    const { spawner } = await start(fakeLoginPath(login), '');

    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]!.env.PATH).toBe(login);
    // 다른 env 를 밀어내지 않는다.
    expect(spawner.spawns[0]!.env.MURMUR_URL).toBe('https://murmur.example');
  });

  it('프로세스 생애 동안 한 번만 읽는다 — 러너 수만큼 셸을 띄우지 않는다', async () => {
    const loginPath = fakeLoginPath('/login/bin');
    const spawner = fakeSpawner();
    const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0);
    const input = {
      myAccountId: 'me', liveAccountIds: new Set<string>(), repoPath: '/repo', runnerCommand: '',
    };
    await launcher.startAll({ agents: [agent('a'), agent('b')], ...input });
    await launcher.startAll({ agents: [agent('c')], ...input });

    expect(spawner.spawns).toHaveLength(3);
    expect(loginPath.read).toHaveBeenCalledTimes(1);
  });
});

describe('3. 조회가 실패하면 설정의 절대 경로를 쓴다', () => {
  it('PATH 를 못 얻어도 설정이 있으면 그 디렉터리로 띄운다', async () => {
    const { spawner, launcher } = await start(fakeLoginPath(null), '/opt/homebrew/bin/pnpm');

    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]!.env.PATH).toBe('/opt/homebrew/bin');
    expect(launcher.getStates()[0]!.status).toBe('running');
  });

  it('둘 다 있으면 설정이 앞에 온다 — 사람이 고른 것이 이긴다', async () => {
    const { spawner } = await start(fakeLoginPath('/usr/bin'), '/opt/homebrew/bin/pnpm');

    // 로그인 셸의 나머지를 버리지 않는다: `pnpm` 은 `node` 를 PATH 에서 찾는다.
    expect(spawner.spawns[0]!.env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('둘 다 없으면 **띄우지 않고** 기동 실패와 사유를 남긴다 — 조용히 시도하지 않는다', async () => {
    const { spawner, launcher } = await start(fakeLoginPath(null), '');

    // 조용히 앱의 PATH 로 시도하는 것이 지금의 실패 모습이다. 그 경로를 여기서 막는다.
    expect(spawner.spawn).not.toHaveBeenCalled();
    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('failed');
    expect(state.message).toBe(RUNNER_COMMAND_MISSING);
  });
});

describe('4. 설정은 `pnpm` 의 절대 경로만 받는다', () => {
  it('`.../pnpm` 이 아니거나 절대 경로가 아니면 거절한다', () => {
    expect(validateRunnerCommand('/usr/local/bin/pnpm')).toBeNull();
    expect(validateRunnerCommand('')).toBeNull(); // 비어 있음은 '정하지 않았다'다

    // 다른 프로그램. 명령 전체를 사람이 정하게 하면 그것이 임의 실행 표면이다.
    expect(validateRunnerCommand('/usr/bin/npm')).toContain('pnpm');
    expect(validateRunnerCommand('/bin/sh')).toContain('pnpm');
    // 인자를 붙여 넣는 길도 막힌다 — 인자는 앱이 고정한다.
    expect(validateRunnerCommand('/usr/local/bin/pnpm --filter x start')).toContain('pnpm');
    // 상대 경로.
    expect(validateRunnerCommand('pnpm')).toContain('절대 경로');
    expect(validateRunnerCommand('~/bin/pnpm')).toContain('절대 경로');
    // `..` 로 실제 위치를 가린 경로.
    expect(validateRunnerCommand('/opt/bin/../../usr/bin/pnpm')).toContain('..');
  });

  it('거절된 값은 설정에 저장되지 않는다 — 기동 때가 아니라 여기서 막는다', () => {
    const store = usePrefsStore.getState();

    expect(store.setRunnerCommand('/opt/homebrew/bin/pnpm')).toBeNull();
    expect(usePrefsStore.getState().runnerCommand).toBe('/opt/homebrew/bin/pnpm');

    const error = store.setRunnerCommand('/usr/bin/npm');
    expect(error).toContain('pnpm');
    // 저장돼 버리면 사람은 설정 화면에서 아무 문제도 못 보고 러너만 안 뜬다.
    expect(usePrefsStore.getState().runnerCommand).toBe('/opt/homebrew/bin/pnpm');
  });

  it('거절된 값에서는 디렉터리를 뽑지 않는다', () => {
    expect(runnerCommandDir('/opt/homebrew/bin/pnpm')).toBe('/opt/homebrew/bin');
    expect(runnerCommandDir('/pnpm')).toBe('/');
    expect(runnerCommandDir('/usr/bin/npm')).toBeNull();
    expect(runnerCommandDir('')).toBeNull();
  });
});

/** 자기 자신이나 조상에 `sr-only` 가 붙어 있으면 화면에서 읽을 수 없다. */
function hiddenFromSight(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.classList.contains('sr-only')) return true;
  }
  return false;
}

describe('6. 사유가 무엇을 하라는 말이고, 보이는 자리에 있다', () => {
  it('사유에 할 일이 들어 있다 — "기동 실패"만 남기지 않는다', () => {
    expect(RUNNER_COMMAND_MISSING).toContain('설정');
    expect(RUNNER_COMMAND_MISSING).toContain('pnpm');
    expect(RUNNER_COMMAND_MISSING).toContain('절대 경로');
    expect(RUNNER_COMMAND_MISSING).toMatch(/지정하라/);
  });

  it('그 사유가 화면에 그려지고 `sr-only` 가 아니다', () => {
    render(<RunnerStatusLine state={{
      agentId: 'a', status: 'failed', exitCode: null, message: RUNNER_COMMAND_MISSING,
    }} />);

    expect(screen.getByText('기동 실패')).toBeTruthy();
    const reason = screen.getByText(new RegExp(RUNNER_COMMAND_MISSING.slice(0, 20)));
    expect(hiddenFromSight(reason)).toBe(false);
  });
});
