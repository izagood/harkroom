/**
 * 저장소 경로를 채웠을 때 러너 자동 기동이 **다시 시도되는지**의 회귀선(#373).
 *
 * 왜 진짜 `Controller` 를 구동하는가: 이 결함은 판정이 아니라 **배선**이다 — 자동 기동의
 * 호출처가 `presence.snapshot` 한 곳뿐이라 설정 변경이 아무것도 일으키지 못한 것이었다.
 * 가짜 컨트롤러로 화면만 보면 그 자리가 테스트에 닿지 않아 결함이 초록으로 통과한다.
 *
 * 그래서 여기서는 **시도 횟수**를 센다: `startRunners()` 는 언제나 `listAgents()` 로
 * 시작하므로 그 호출 수가 곧 시도 수다. "화면이 바뀐다"만 보면 다른 이유로도 바뀌므로
 * 전이 감지를 빼도 초록으로 남는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { AgentView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { REPO_PATH_MISSING } from '../src/lib/runnerLauncher';
import type {
  LoginPathReader, RunnerProcess, RunnerSecretStore, RunnerSpawner, SpawnRequest, StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { acc, accountsResult, fakeApi, fakeWsFactory } from './helpers/fakeApi';

// 문구는 실행기에서 **가져온다**. 여기 다시 적으면 `not.toBe(REPO_PATH_MISSING)` 단언들이
// 자기 사본과 비교하는 셈이고, 실행기 쪽 문구가 갈라져도 아무것도 안 지킨다 —
// `runnerFailureDisplay.test.tsx` 가 같은 이유로 이미 한 번 고쳐진 자리다(#368).

const agentView = (id: string, extra: Partial<AgentView> = {}): AgentView => ({
  id, handle: id, displayName: id, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: 'u1', disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

function fakeSecrets(): RunnerSecretStore {
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
  } satisfies RunnerSpawner & { spawns: SpawnRequest[] };
}

const fakeLoginPath = (): LoginPathReader => ({ read: vi.fn(async () => '/login/bin') });

/** 이 파일이 세운 컨트롤러. 설정 구독을 남기지 않으려고 테스트마다 전부 `stop()` 한다. */
const started: Controller[] = [];

/** 컨트롤러를 세운다(presence 는 아직 흘리지 않는다). */
async function setup(repoPath: string, agents: AgentView[] = [agentView('rusalka')]) {
  usePrefsStore.setState({ runnerAutoStart: true, runnerRepoPath: repoPath, runnerCommand: '' });
  const spawner = fakeSpawner();
  const listAgents = vi.fn(async () => agents);
  const api = fakeApi({
    me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
    accounts: vi.fn(async () => accountsResult([
      acc('u1', 'admin', 'human', true),
      ...agents.map((a) => acc(a.id, a.handle, 'agent')),
    ])),
    listAgents,
  });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs, undefined, undefined, fakeSecrets(), spawner, fakeLoginPath());
  started.push(c);
  await c.start();
  callbacks.current!.onOpen();
  return { c, api, spawner, listAgents, callbacks };
}

/** presence 까지 흘려 **앱이 지나는 그 경로**로 첫 자동 기동을 끝낸다. */
async function boot(repoPath: string, agents: AgentView[] = [agentView('rusalka')]) {
  const s = await setup(repoPath, agents);
  s.callbacks.current!.onEvent({ type: 'presence.snapshot', online: [] });
  await waitFor(() => expect(Object.keys(useAppStore.getState().runnerStates).length)
    .toBeGreaterThan(0));
  return s;
}

const stateOf = (agentId: string) => useAppStore.getState().runnerStates[agentId];

beforeEach(() => {
  useAppStore.getState().reset();
});
afterEach(() => {
  while (started.length) started.pop()!.stop();
});

describe('경로가 비어 있다가 채워지면 자동 기동을 다시 시도한다(#373)', () => {
  it('빈 경로로 기동하면 사유를 남기고 실패한다 — 여기까지가 기존 동작이다', async () => {
    const { spawner, listAgents } = await boot('');

    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(stateOf('rusalka')!.status).toBe('failed');
    expect(stateOf('rusalka')!.message).toBe(REPO_PATH_MISSING);
  });

  it('그 뒤 경로를 채우면 기동을 **다시 시도한다** — 시도가 실제로 한 번 더 일어난다', async () => {
    const { spawner, listAgents } = await boot('');
    expect(listAgents).toHaveBeenCalledTimes(1);

    usePrefsStore.getState().setRunnerRepoPath('/Users/me/dev/murmur');

    // 화면이 아니라 **호출**을 센다: 전이 감지를 빼면 이 수가 1 로 남는다.
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(spawner.spawns).toHaveLength(1));
    expect(spawner.spawns[0]!.cwd).toBe('/Users/me/dev/murmur');
  });

  it('재시도가 성공하면 옛 "경로가 설정되지 않았다" 문구가 사라진다', async () => {
    await boot('');
    expect(stateOf('rusalka')!.message).toBe(REPO_PATH_MISSING);

    usePrefsStore.getState().setRunnerRepoPath('/repo');

    await waitFor(() => expect(stateOf('rusalka')!.status).toBe('running'));
    // 경로를 채운 뒤에도 이 문구가 보이는 것이 #373 의 증상 전부다.
    expect(stateOf('rusalka')!.message).toBeNull();
  });
});

describe('전이가 아닌 저장에는 반응하지 않는다 — 중복 기동을 만들지 않는다', () => {
  it('경로가 이미 채워진 채로 기동하면 한 번만 시도한다', async () => {
    const { spawner, listAgents } = await boot('/repo');
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(spawner.spawns).toHaveLength(1);

    // 사람이 경로를 **다른 값으로** 고쳐도 그것은 '비어 있다 → 채워졌다'가 아니다.
    // 매 저장마다 부르면 이 수가 2 가 되고, 그것이 이미 도는 러너 옆에 두 번째를 띄운다.
    usePrefsStore.getState().setRunnerRepoPath('/repo/other');
    await new Promise((r) => setTimeout(r, 0));

    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(spawner.spawns).toHaveLength(1);
  });

  it('채웠다 지웠다 다시 채우면 그때마다 한 번씩, 값이 안 바뀐 저장에는 반응하지 않는다', async () => {
    const { listAgents } = await boot('');
    const prefs = usePrefsStore.getState();
    expect(listAgents).toHaveBeenCalledTimes(1);

    prefs.setRunnerRepoPath('/repo/a');
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));

    // 같은 값으로 다시 저장한다 — 설정 화면에서 같은 문자열을 다시 넣으면 이 일이 난다.
    prefs.setRunnerRepoPath('/repo/a');
    await new Promise((r) => setTimeout(r, 0));
    expect(listAgents).toHaveBeenCalledTimes(2);

    // 지우는 것은 트리거가 아니다 — 지운 것으로 기동을 시도하면 사유만 다시 쌓인다.
    prefs.setRunnerRepoPath('');
    await new Promise((r) => setTimeout(r, 0));
    expect(listAgents).toHaveBeenCalledTimes(2);

    prefs.setRunnerRepoPath('/repo/b');
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(3));
  });

  it('presence 를 받기 전에 경로가 채워지면 여기서 띄우지 않는다 — presence 절이 제 시점에 띄운다', async () => {
    const { listAgents, callbacks } = await setup('');

    usePrefsStore.getState().setRunnerRepoPath('/repo');
    await new Promise((r) => setTimeout(r, 0));
    // presence 를 모른 채 띄우면 이미 붙어 있는 러너 옆에 두 번째가 생긴다.
    expect(listAgents).not.toHaveBeenCalled();

    callbacks.current!.onEvent({ type: 'presence.snapshot', online: [] });
    await waitFor(() => expect(stateOf('rusalka')?.status).toBe('running'));
    expect(listAgents).toHaveBeenCalledTimes(1);
  });
});

/**
 * 구독은 컨트롤러의 수명 안에 있어야 한다. 이 파일의 다른 단언들은 **살아 있는** 컨트롤러만
 * 지나므로, `stop()` 이 구독을 안 떼도 전부 초록이다(되돌려 재 보니 0건이었다).
 *
 * 새는 구독이 만드는 것은 정확히 이 이슈가 피하려는 것이다: 로그아웃하거나 커뮤니티를 바꿔
 * 죽은 컨트롤러가, 사람이 나중에 경로를 채우는 순간 **또 하나의 러너를 띄운다.**
 */
describe('구독은 컨트롤러와 함께 죽는다', () => {
  it('stop() 뒤에 경로를 채우면 그 컨트롤러는 다시 시도하지 않는다', async () => {
    const { c, listAgents } = await boot('');
    expect(listAgents).toHaveBeenCalledTimes(1);

    c.stop();
    usePrefsStore.getState().setRunnerRepoPath('/repo');
    await new Promise((r) => setTimeout(r, 0));

    expect(listAgents).toHaveBeenCalledTimes(1);
  });
});

describe('재시도가 다른 이유로 실패해도 옛 사유는 남지 않는다', () => {
  it('목록 조회가 실패해도 "경로가 설정되지 않았다"가 남아 있지 않다', async () => {
    const { listAgents } = await boot('');
    expect(stateOf('rusalka')!.message).toBe(REPO_PATH_MISSING);
    // 재시도가 그 에이전트에 **닿지 못하는** 실패다 — 상태를 덮어쓸 자리조차 없다.
    listAgents.mockRejectedValueOnce(new Error('목록 조회 실패'));

    usePrefsStore.getState().setRunnerRepoPath('/repo');

    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2));
    // 경로는 채워져 있다. 그 문구는 이미 거짓이고, 사람을 잘못된 방향으로 보낸다.
    expect(stateOf('rusalka')!.message).not.toBe(REPO_PATH_MISSING);
    expect(stateOf('rusalka')!.status).not.toBe('failed');
  });
});
