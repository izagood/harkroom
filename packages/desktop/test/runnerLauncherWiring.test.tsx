/**
 * 러너 실행기 **배선** 회귀선(#250).
 *
 * 왜 별 파일인가: `runnerLauncher.test.ts` 는 실행기 하나를 손으로 세워 판정을 확인한다.
 * 그것만으로는 **앱에서 아무 일도 일어나지 않는 배선**이 초록으로 통과한다 — 앞선 판본이
 * 정확히 그랬다: 실행기는 `Controller` 안에 있었고 상태를 `runnerStates` 에 밀어 넣었지만,
 * 그 값을 읽는 컴포넌트가 하나도 없었고 "PAT 재발급" 버튼도 없었다. 여기서는 컨트롤러를
 * 실제로 기동해 presence 를 흘리고, **상위 컴포넌트를 띄워** 그 상태가 화면에 닿는지와
 * 버튼이 실행기에 닿는지를 본다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { AgentView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { ConnectionSettings } from '../src/components/settings/ConnectionSettings';
import type {
  LoginPathReader, RunnerProcess, RunnerSecretStore, RunnerSpawner, SpawnRequest, StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { acc, accountsResult, fakeApi, fakeWsFactory } from './helpers/fakeApi';

const agentView = (id: string, extra: Partial<AgentView> = {}): AgentView => ({
  id, handle: id, displayName: id, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: 'u1', disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

function fakeSecrets() {
  const map = new Map<string, StoredRunnerPat>();
  return {
    read: vi.fn(async (id: string) => ({ ok: true as const, value: map.get(id) ?? null })),
    write: vi.fn(async (id: string, v: StoredRunnerPat) => { map.set(id, v); }),
    clear: vi.fn(async (id: string) => { map.delete(id); }),
    deviceId: vi.fn(async () => 'dev0'),
    map,
  } satisfies RunnerSecretStore & { map: Map<string, StoredRunnerPat> };
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

/** 로그인 셸 `PATH` 조회 목(#305). 배선 테스트에서는 '조회가 된다'가 정상 상태다. */
const fakeLoginPath = (value: string | null = '/login/bin'): LoginPathReader =>
  ({ read: vi.fn(async () => value) });

/** 컨트롤러를 실제로 기동하고 presence 스냅샷까지 흘린다 — 앱이 지나는 그 경로다. */
async function boot(agents: AgentView[], online: string[] = []) {
  const secrets = fakeSecrets();
  const spawner = fakeSpawner();
  const api = fakeApi({
    me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
    accounts: vi.fn(async () => accountsResult([
      acc('u1', 'admin', 'human', true),
      ...agents.map((a) => acc(a.id, a.handle, 'agent')),
    ])),
    listAgents: vi.fn(async () => agents),
    createAgent: vi.fn(async () => agentView('created-codex', { harness: 'codex' })),
  });
  const { makeWs, callbacks } = fakeWsFactory();
  const c = new Controller(api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath());
  setController(c);
  await c.start();
  callbacks.current!.onOpen();
  callbacks.current!.onEvent({ type: 'presence.snapshot', online });
  // 자동 기동은 fire-and-forget 이라 상태가 스토어에 닿을 때까지 기다린다.
  await waitFor(() => expect(Object.keys(useAppStore.getState().runnerStates).length)
    .toBeGreaterThan(0));
  return { api, secrets, spawner, c };
}

beforeEach(() => {
  useAppStore.getState().reset();
  usePrefsStore.setState({ runnerAutoStart: true });
});
afterEach(cleanup);

describe('컨트롤러 → 실행기 배선', () => {
  it('presence 를 받은 뒤 내가 소유한 에이전트의 러너를 띄운다', async () => {
    const { spawner } = await boot([agentView('rusalka'), agentView('theirs', { ownerAccountId: 'u9' })]);

    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]!.env.MURMUR_PAT).toBeTruthy();
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('running');
  });

  it('이미 붙어 있는 러너는 띄우지 않는다 — 중복 러너를 만들지 않는다', async () => {
    const { spawner } = await boot([agentView('rusalka')], ['rusalka']);

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('external');
  });

  it('`runnerVersion` 이 있어도 presence 가 없으면 띄운다 — 그 값은 liveness 가 아니다', async () => {
    // 013_agent_runner_version.sql: "지금 붙어 있나는 이 테이블이 답하지 않는다."
    // 이 값으로 판정하면 한 번이라도 러너가 붙었던 에이전트는 영원히 안 뜬다.
    const { spawner } = await boot([agentView('rusalka', { runnerVersion: 'sha-abc' })]);

    expect(spawner.spawns).toHaveLength(1);
  });

  it('자동 기동을 끄면 아무것도 띄우지 않는다', async () => {
    usePrefsStore.setState({ runnerAutoStart: false });
    const secrets = fakeSecrets();
    const spawner = fakeSpawner();
    const api = fakeApi({
      me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
      listAgents: vi.fn(async () => [agentView('rusalka')]),
    });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath());
    setController(c);
    await c.start();
    callbacks.current!.onOpen();
    callbacks.current!.onEvent({ type: 'presence.snapshot', online: [] });

    await Promise.resolve();
    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(useAppStore.getState().runnerStates).toEqual({});
  });

  it('앱이 이미 실행 중이어도 새로 만든 Codex 에이전트의 PAT 를 저장하고 즉시 띄운다', async () => {
    const { api, secrets, spawner, c } = await boot([agentView('forge')]);

    const result = await c.createAgent({
      handle: 'codex', displayName: 'Codex', harness: 'codex',
    });

    expect(api.createAgent).toHaveBeenCalledWith(expect.objectContaining({ harness: 'codex' }));
    expect(result.agent.id).toBe('created-codex');
    expect(secrets.map.get('created-codex')).toEqual({ label: 'runner', token: result.pat });
    expect(spawner.spawns).toHaveLength(2);
    expect(spawner.spawns[1]!.env.MURMUR_PAT).toBe(result.pat);
    expect(spawner.spawns[1]!.env.MURMUR_PAT).not.toBe(spawner.spawns[0]!.env.MURMUR_PAT);
    expect(useAppStore.getState().runnerStates['created-codex']!.status).toBe('running');
  });
});

describe('설정 → 에이전트 상세가 그 상태를 그린다', () => {
  it('실행 중이면 화면에 "실행 중"이 보인다 — 스토어에 있는 값이 화면에 닿는다', async () => {
    await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect(await screen.findByText('실행 중')).toBeTruthy();
  });

  it('자식이 78 로 죽으면 "재발급 필요"가 화면에 보인다', async () => {
    const { spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));
    await screen.findByText('실행 중');

    spawner.spawns[0]!.onExit(78);

    expect(await screen.findByText(/78: 자격증명 폐기/)).toBeTruthy();
  });

  it('다른 코드로 죽으면 그 코드가 화면에 보인다', async () => {
    const { spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));
    await screen.findByText('실행 중');

    spawner.spawns[0]!.onExit(137);

    expect(await screen.findByText(/코드 137/)).toBeTruthy();
  });

  it('"PAT 재발급" 버튼이 새 발급 → 옛 폐기 → 재실행을 실제로 일으킨다', async () => {
    const { api, spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));
    await screen.findByText('실행 중');
    const mint = api.mintPat as ReturnType<typeof vi.fn>;
    const revoke = api.revokePat as ReturnType<typeof vi.fn>;
    const before = mint.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'PAT 재발급' }));

    await waitFor(() => expect(spawner.spawns).toHaveLength(2));
    expect(mint.mock.calls.length).toBe(before + 1);
    // 폐기가 **불렸다.** 이것을 빼면 옛 PAT 가 서버에 살아남아 옛 러너가 계속 돈다.
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke.mock.calls[0]![1]).toBe('desktop:dev0');
  });

  it('자동 기동을 껐어도 재발급 버튼이 실제로 동작한다 — 눌러도 아무 일 없는 버튼이 아니다', async () => {
    // 실행기가 자동 기동 때 본 것을 기억해 두고 그것에 기대면, 자동 기동을 끄고 쓰는
    // 사람에게는 이 버튼이 영원히 죽어 있다. 컨트롤러가 대상을 그 자리에서 다시 조회한다.
    usePrefsStore.setState({ runnerAutoStart: false });
    const secrets = fakeSecrets();
    const spawner = fakeSpawner();
    const api = fakeApi({
      me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
      listAgents: vi.fn(async () => [agentView('rusalka')]),
      accounts: vi.fn(async () => accountsResult([acc('u1', 'admin', 'human', true), acc('rusalka', 'rusalka', 'agent')])),
    });
    const c = new Controller(
      api, fakeWsFactory().makeWs, undefined, undefined, secrets, spawner, fakeLoginPath(),
    );
    setController(c);
    await c.start();

    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));
    fireEvent.click(await screen.findByRole('button', { name: 'PAT 재발급' }));

    await waitFor(() => expect(spawner.spawns).toHaveLength(1));
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('running');
  });

  it('소유자(admin 아님)에게도 러너 절과 재발급 버튼이 보인다', async () => {
    const secrets = fakeSecrets();
    const spawner = fakeSpawner();
    const api = fakeApi({
      me: vi.fn(async () => acc('u1', 'owner', 'human', false)),
      listAgents: vi.fn(async () => [agentView('rusalka')]),
      accounts: vi.fn(async () => accountsResult([acc('u1', 'owner'), acc('rusalka', 'rusalka', 'agent')])),
    });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath());
    setController(c);
    await c.start();
    callbacks.current!.onOpen();
    callbacks.current!.onEvent({ type: 'presence.snapshot', online: [] });
    await waitFor(() => expect(useAppStore.getState().runnerStates.rusalka).toBeTruthy());

    render(<AgentsSettings />);
    fireEvent.click(await screen.findByText('rusalka'));

    expect(await screen.findByText('러너 (이 앱)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'PAT 재발급' })).toBeTruthy();
  });
});

/**
 * `#431` 1단계에서 저장소 경로·pnpm 경로 입력 칸이 없어졌다(러너가 sidecar 로 바뀌며
 * `runnerRepoPath`·`runnerCommand` 자체가 사라졌다 — `ConnectionSettings.tsx` 참고). 남는
 * 것은 자동 기동 토글 하나뿐이라 그 회귀선만 남긴다.
 */
describe('설정 → 연결의 자동 기동 토글', () => {
  it('토글을 누르면 설정에 반영된다', async () => {
    setController(new Controller(fakeApi(), fakeWsFactory().makeWs));
    render(<ConnectionSettings onSignOut={() => {}} />);

    fireEvent.click(screen.getByRole('switch', { name: '러너 자동 기동' }));

    expect(usePrefsStore.getState().runnerAutoStart).toBe(false);
  });
});
