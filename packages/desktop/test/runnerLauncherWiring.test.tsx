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
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import {
  CREDENTIAL_REJECTED_LINE,
  EXECUTABLE_NOT_FOUND_LINE,
  type AgentView,
} from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { Controller, setController } from '../src/state/controller';
import { usePrefsStore } from '../src/state/prefsStore';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { ConnectionSettings } from '../src/components/settings/ConnectionSettings';
import type {
  LoginPathReader, RunnerProcess, RunnerSecretStore, RunnerSpawner, SpawnRequest, StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { fakeDaemon, liveRunner } from './helpers/fakeDaemon';
import { acc, accountsResult, fakeApi, fakeWsFactory } from './helpers/fakeApi';

const agentView = (id: string, extra: Partial<AgentView> = {}): AgentView => ({
  id, handle: id, displayName: id, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: 'u1', disabled: false, runnerVersion: null,
  claudeLane: null, executionPath: null,
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
async function boot(
  agents: AgentView[],
  online: string[] = [],
  daemon = fakeDaemon(),
  /** 이 앱 번들의 버전. 뒤처짐 판정의 기준이므로 재기동 회귀선이 명시적으로 준다. */
  appVersion: string | null = null,
) {
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
  const c = new Controller(
    api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath(), undefined, daemon,
    { read: vi.fn(async () => appVersion) },
  );
  setController(c);
  await c.start();
  callbacks.current!.onOpen();
  callbacks.current!.onEvent({ type: 'presence.snapshot', online });
  // 자동 기동은 fire-and-forget 이라 상태가 스토어에 닿을 때까지 기다린다.
  await waitFor(() => expect(Object.keys(useAppStore.getState().runnerStates).length)
    .toBeGreaterThan(0));
  return { api, secrets, spawner, c, daemon };
}

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(사이드바 PR 이 세운
// 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  useAppStore.getState().reset();
  usePrefsStore.setState({ runnerAutoStart: true });
  usePrefsStore.getState().setLocale('ko');
});
// 가짜 타이머를 쓴 축이 있다(아래 10번). 되돌리지 않으면 이 파일의 나머지 축이 멈춘
// 시계 위에서 `waitFor` 를 돌다 죽는다 — 이미 진짜 시계면 아무 일도 안 한다.
afterEach(() => { vi.useRealTimers(); cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('컨트롤러 → 실행기 배선', () => {
  it('presence 를 받은 뒤 내가 소유한 에이전트의 러너를 띄운다', async () => {
    const { spawner } = await boot([agentView('rusalka'), agentView('theirs', { ownerAccountId: 'u9' })]);

    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]!.env.MURMUR_PAT).toBeTruthy();
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('running');
  });

  it('daemon 이 그 러너를 들고 있으면 띄우지 않는다 — 중복 러너를 만들지 않는다', async () => {
    const { spawner } = await boot(
      [agentView('rusalka')], ['rusalka'], fakeDaemon([liveRunner('rusalka')]),
    );

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('adopted');
  });

  /**
   * `#443` — **관측이 스토어까지 흐른다.**
   *
   * 이 배선이 이 파일에 있어야 하는 이유는 이 파일 머리말 그대로다: `daemonFacts.test.tsx`
   * 는 파싱과 판정과 렌더를 각각 잡지만, 스토어에 **아무도 밀어 넣지 않아도** 그 셋이 다
   * 초록이다(렌더 회귀선이 `daemonRunners` 를 손으로 채우니까). 관측과 스토어 사이의
   * 화살표는 컨트롤러를 실제로 기동해야만 보인다.
   *
   * 그리고 이 화살표가 **`runnerStates` 와 갈라져 있다**는 것도 여기서 잡는다 — 사실을
   * 판정 안에 섞으면 실행기의 다음 `setState` 가 pid 를 지운다(`appStore.ts::daemonRunners`).
   */
  it('daemon 이 확인한 사실이 판정과 **나란히** 스토어에 오른다', async () => {
    const observed = { ...liveRunner('rusalka'), pid: 48127, incarnationId: '3', termSentAtMs: null };
    await boot([agentView('rusalka')], ['rusalka'], fakeDaemon([observed]));

    // 사실은 사실 자리에.
    expect(useAppStore.getState().daemonRunners.rusalka).toMatchObject({ pid: 48127, incarnationId: '3' });
    // 판정은 판정 자리에, 그리고 **사실이 섞여 들어오지 않았다.**
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('adopted');
    expect(useAppStore.getState().runnerStates.rusalka).not.toHaveProperty('pid');
  });

  it('장부에서 사라진 러너는 스토어에서도 사라진다 — 낡은 pid 를 남기지 않는다', async () => {
    // 관측은 그 순간의 장부 **전체**다. 병합하면 이미 없는 러너의 pid 가 화면에 남고,
    // 사람은 그 pid 로 `ps` 를 쳐 아무것도 못 찾는다(`controller.ts` 의 그 주석).
    const { daemon, c } = await boot(
      [agentView('rusalka')], ['rusalka'], fakeDaemon([{ ...liveRunner('rusalka'), pid: 48127 }]),
    );
    expect(useAppStore.getState().daemonRunners.rusalka!.pid).toBe(48127);

    // 러너가 실제로 물러났다. `kill()` 이 이것을 자동으로 하지 않는 것이 의도다 —
    // SIGTERM 은 graceful 이고 그 시차가 설계 전부다(`fakeDaemon.died` 주석).
    daemon.died('rusalka');
    // 다시 관측하게 만든다. **컨트롤러의 공개 표면으로** 부른다 — 실행기를 직접 잡으면
    // 이 회귀선이 배선을 우회해 재고, 그것이 이 파일 머리말이 금지한 그 모습이다.
    // 재기동은 종료를 확인하려 장부를 다시 읽는다(`awaitRunnerExit`).
    await c.restartRunner('rusalka');

    expect(useAppStore.getState().daemonRunners.rusalka).toBeUndefined();
  });

  /**
   * **배선 쪽 핵심 회귀선**(`#431` 2단계 A). 실측(2026-09-06, 두 번)이 재현하는 상황:
   * 다른 워크트리의 러너가 서버 presence 에 올라와 있고 내 daemon 장부에는 없다.
   *
   * 앞 판본은 여기서 `external` 로 물러나 **아무것도 안 띄웠고**, 그래서
   * `daemonSpawner.spawn()` 도 안 불려 daemon 자체가 안 떴다 — 순환의 첫 화살표다.
   */
  it('장부에 없는 러너가 presence 에 있어도 앱이 자기 에이전트를 띄운다', async () => {
    const { spawner } = await boot([agentView('rusalka')], ['rusalka'], fakeDaemon([]));

    expect(spawner.spawns).toHaveLength(1);
    expect(useAppStore.getState().runnerStates.rusalka!.status).toBe('running');
  });

  it('`runnerVersion` 이 있어도 presence 가 없으면 띄운다 — 그 값은 liveness 가 아니다', async () => {
    // 013_agent_runner_version.sql: "지금 붙어 있나는 이 테이블이 답하지 않는다."
    // 이 값으로 판정하면 한 번이라도 러너가 붙었던 에이전트는 영원히 안 뜬다.
    const { spawner } = await boot([agentView('rusalka', { runnerVersion: 'sha-abc' })]);

    expect(spawner.spawns).toHaveLength(1);
  });

  /**
   * **회귀선 ① — 앱이 뜨면 daemon 이 뜬다.** 띄울 러너가 하나도 없어도.
   *
   * `daemon` 은 러너의 부산물이 아니다. 이 성질이 없으면 "무엇이 돌고 있나"를 물을 상대가
   * 없고, 그때 판정은 다시 presence 하나로 돌아간다(`DaemonObserver` 주석의 순환).
   *
   * 되돌려 RED: `controller.start()` 의 `ensureDaemon()` 줄을 지우면 빨개진다.
   */
  it('띄울 러너가 하나도 없어도 앱 기동이 daemon 을 세운다', async () => {
    const daemon = fakeDaemon();
    const secrets = fakeSecrets();
    const spawner = fakeSpawner();
    const api = fakeApi({
      me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
      listAgents: vi.fn(async () => []),
    });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(
      api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath(), undefined, daemon,
    );
    setController(c);
    await c.start();
    callbacks.current!.onOpen();

    // presence 조차 오기 전에 이미 daemon 이 서 있어야 한다.
    await waitFor(() => expect(daemon.observeCalls).toBeGreaterThan(0));
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  /**
   * 자동 기동 토글이 꺼져 있어도 daemon 은 뜬다 — **daemon 은 그냥 떠 있는 것**이다
   * (사용자 결정). 토글이 정하는 것은 *러너*를 띄우는가이지 daemon 이 아니다.
   */
  it('자동 기동을 끄면 아무것도 띄우지 않는다', async () => {
    usePrefsStore.setState({ runnerAutoStart: false });
    const secrets = fakeSecrets();
    const spawner = fakeSpawner();
    const api = fakeApi({
      me: vi.fn(async () => acc('u1', 'admin', 'human', true)),
      listAgents: vi.fn(async () => [agentView('rusalka')]),
    });
    const { makeWs, callbacks } = fakeWsFactory();
    const c = new Controller(
      api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath(), undefined, fakeDaemon(),
    );
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
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

    expect(await screen.findByText('실행 중')).toBeTruthy();
  });

  it('자식이 78 + 자격증명 거부 구분자로 죽으면 "재발급 필요"가 화면에 보인다', async () => {
    const { spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    await screen.findByText('실행 중');

    // **꼬리를 함께 넘긴다**(`#473`). 78 만으로는 어느 사유인지 모른다 — 자격증명 거부와
    // 하네스 부재가 그 코드를 공유하고, 러너는 이 줄로 그 둘을 가른다.
    spawner.spawns[0]!.onExit(78, [CREDENTIAL_REJECTED_LINE]);

    expect(await screen.findByText(/78: 자격증명 폐기/)).toBeTruthy();
  });

  /**
   * 대조군(`#473`) — **하네스 부재가 자격증명 문구로 나오지 않는다.** 같은 화면 자리를
   * 쓰므로 여기서 나란히 잰다: 78 이 두 사유를 공유한다는 사실이 화면까지 반영됐는가.
   */
  it('자식이 78 + 하네스 부재 구분자로 죽으면 설치를 말한다', async () => {
    const { spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    await screen.findByText('실행 중');

    spawner.spawns[0]!.onExit(78, [EXECUTABLE_NOT_FOUND_LINE]);

    expect(await screen.findByText(/78: 하네스를 찾을 수 없음/)).toBeTruthy();
    expect(screen.queryByText(/자격증명 폐기/)).toBeNull();
  });

  it('다른 코드로 죽으면 그 코드가 화면에 보인다', async () => {
    const { spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
    await screen.findByText('실행 중');

    spawner.spawns[0]!.onExit(137);

    expect(await screen.findByText(/코드 137/)).toBeTruthy();
  });

  it('"PAT 재발급" 버튼이 새 발급 → 옛 폐기 → 재실행을 실제로 일으킨다', async () => {
    const { api, spawner } = await boot([agentView('rusalka')]);
    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
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
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));
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
    const c = new Controller(
      api, makeWs, undefined, undefined, secrets, spawner, fakeLoginPath(), undefined, fakeDaemon(),
    );
    setController(c);
    await c.start();
    callbacks.current!.onOpen();
    callbacks.current!.onEvent({ type: 'presence.snapshot', online: [] });
    await waitFor(() => expect(useAppStore.getState().runnerStates.rusalka).toBeTruthy());

    render(<AgentsSettings />);
    fireEvent.click(await screen.findByTestId('agent-card-rusalka'));

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

// ── 뒤처진 러너 전체 재기동 ───────────────────────────────────────────────────
//
// 러너는 daemon 이 소유하고 앱의 수명을 넘어 산다(`#431`). 앱을 새로 설치해도 도는 러너는
// 옛 번들이고, `doStartOne` 은 장부에 살아 있는 러너를 새로 띄우지 않는다. 그래서 사람이
// 갈아 줘야 한다 — 여기서 재는 것은 **누구를 고르는가**다.
describe('7. 뒤처진 러너 전체 재기동', () => {
  it('버전이 앱과 다른 러너만 고른다 — 최신인 것은 건드리지 않는다', async () => {
    const daemon = fakeDaemon([liveRunner('old', true), liveRunner('fresh', true)]);
    const { c } = await boot(
      [agentView('old', { runnerVersion: '0.1.6' }), agentView('fresh', { runnerVersion: '0.1.15' })],
      ['old', 'fresh'],
      daemon,
      '0.1.15',
    );

    // 재기동은 **실제 종료를 기다린다**(SIGTERM 은 graceful 이다). 그 시차가 이 기능의
    // 설계 전부이므로 테스트가 죽는 시점을 직접 준다 — 여기서 즉시 죽는 가짜를 쓰면
    // 기다림 자체가 회귀선에서 사라진다.
    const pending = c.restartStaleRunners();
    await waitFor(() => expect(daemon.kills).toEqual(['old']));
    daemon.died('old');
    const restarted = await pending;

    expect(restarted).toEqual(['old']);
    // 최신 러너는 건드리지 않았다.
    expect(daemon.kills).toEqual(['old']);
  });

  it('버전을 모르는 러너는 고르지 않는다 — 모르는 것을 뒤처졌다고 하지 않는다', async () => {
    const daemon = fakeDaemon([liveRunner('mystery', true)]);
    const { c } = await boot(
      [agentView('mystery', { runnerVersion: null })],
      ['mystery'],
      daemon,
      '0.1.15',
    );

    const restarted = await c.restartStaleRunners();

    expect(restarted).toEqual([]);
    expect(daemon.kills).toEqual([]);
  });

  /**
   * 앱이 자기 버전을 못 얻었으면 비교 기준이 없다. 그때 전부를 재기동하면 잘 돌던 러너를
   * 이유 없이 끊는 것이고, 그 근거는 어디에도 없다.
   */
  it('앱 버전을 모르면 아무것도 재기동하지 않는다', async () => {
    const daemon = fakeDaemon([liveRunner('old', true)]);
    const { c } = await boot([agentView('old', { runnerVersion: '0.1.6' })], ['old'], daemon, null);

    expect(await c.restartStaleRunners()).toEqual([]);
    expect(daemon.kills).toEqual([]);
  });
});

describe('8. 전체 재기동이 화면에 있다', () => {
  it('뒤처진 러너 수를 세어 버튼에 적고, 누르면 그 러너만 갈린다', async () => {
    const daemon = fakeDaemon([liveRunner('old', true), liveRunner('fresh', true)]);
    await boot(
      [agentView('old', { runnerVersion: '0.1.6' }), agentView('fresh', { runnerVersion: '0.1.15' })],
      ['old', 'fresh'],
      daemon,
      '0.1.15',
    );
    render(<AgentsSettings />);

    // 개수가 버튼에 있어야 한다 — "전체 재기동"만 적으면 몇 대가 끊길지 모르고 누른다.
    const button = await screen.findByRole('button', { name: /뒤처진 러너 전체 재기동 \(1\)/ });
    fireEvent.click(button);

    await waitFor(() => expect(daemon.kills).toEqual(['old']));
    daemon.died('old');
  });

  it('전부 최신이면 누를 것이 없다고 말한다 — 비활성 버튼에 이유를 붙인다', async () => {
    const daemon = fakeDaemon([liveRunner('fresh', true)]);
    await boot([agentView('fresh', { runnerVersion: '0.1.15' })], ['fresh'], daemon, '0.1.15');
    render(<AgentsSettings />);

    const button = await screen.findByRole('button', { name: /뒤처진 러너 전체 재기동 \(0\)/ });
    expect(button.hasAttribute('disabled')).toBe(true);
  });
});

describe('9. 전체 재기동은 기다리는 대상을 숨기지 않는다', () => {
  /**
   * **순차로 돌면 화면이 거짓을 말한다.** 첫 러너의 턴이 끝날 때까지(실측 5분 넘는 턴도
   * 있다) 나머지는 `running` 으로 남아, 사람은 "한 대만 재기동 중"으로 읽는다. 예약은
   * 전부에게 **지금** 걸려야 하고, 그 다음의 기다림은 각자의 턴 길이만큼이면 된다.
   */
  it('대상 전부에 지금 예약을 걸고, 기다림만 각자 진행한다', async () => {
    const daemon = fakeDaemon([liveRunner('old1', true), liveRunner('old2', true)]);
    const { c } = await boot(
      [agentView('old1', { runnerVersion: '0.1.6' }), agentView('old2', { runnerVersion: '0.1.6' })],
      ['old1', 'old2'],
      daemon,
      '0.1.15',
    );

    const pending = c.restartStaleRunners();

    // 둘 다 **아직 죽지 않았는데도** 예약이 둘 다 걸려 있어야 한다.
    await waitFor(() => expect([...daemon.kills].sort()).toEqual(['old1', 'old2']));
    await waitFor(() => {
      const states = useAppStore.getState().runnerStates;
      expect(states.old1?.status).toBe('restarting');
      expect(states.old2?.status).toBe('restarting');
    });

    daemon.died('old1');
    daemon.died('old2');
    expect([...(await pending)].sort()).toEqual(['old1', 'old2']);
  });
});

/**
 * 10. **눌린 것과 갈리는 중인 것이 화면에 보인다** (2026-09-08 사용자 보고).
 *
 * 보고는 세 줄이었고 셋 다 같은 뿌리다 — *"전체 재기동을 눌렀는데 UI 적으로 아무 변화가
 * 없어서 눌렀는지 알 수가 없었어"*, *"에이전트들 변화가 실시간으로 UI 에서 변하는 게
 * 아니라 다른 화면을 갔다가 와야 해서"*, *"뒤쳐진 러너를 눌렀을 때도 상태 변화가 없어서"*.
 *
 * 8번이 이미 "누르면 그 러너가 갈린다"를 재고 있었다. **그것이 통과하는데도 화면은
 * 아무 말도 안 했다** — 재는 것이 `daemon.kills` 였기 때문이다. 여기서는 사람이 보는
 * 것만 잰다: 버튼의 낱말, 띠의 줄, 카드의 칩.
 */
describe('10. 전체 재기동은 눌린 것을 화면에 말한다', () => {
  it('누른 즉시 낱말이 바뀌고 몇 대에 걸었는지 적힌다 — 다 돌아오면 그것도 적는다', async () => {
    const daemon = fakeDaemon([liveRunner('old', true)]);
    await boot([agentView('old', { runnerVersion: '0.1.6' })], ['old'], daemon, '0.1.15');
    render(<AgentsSettings />);

    fireEvent.click(await screen.findByRole('button', { name: /뒤처진 러너 전체 재기동 \(1\)/ }));

    // 앞 판본은 여기서 `disabled:opacity-50` 하나였다. 그 모양은 **0 대일 때의 평소
    // 모양과 같다** — 그래서 누른 것이 아무 흔적도 안 남겼다.
    await screen.findByRole('button', { name: '재기동 거는 중…' });
    // 그리고 몇 대에 걸었는지는 **지금** 적혀야 한다. 컨트롤러의 반환값을 기다리면 그
    // 값은 러너가 턴을 마친 뒤에야 온다(실측 상한 15분).
    await screen.findByText(/러너 1대에 재기동을 걸었다/);

    // 카드도 같은 사실을 말한다 — 뒤처짐 칩이 그대로 남아 있으면 사람은 다시 누른다.
    await waitFor(() => expect(screen.getByTestId('agent-version-old').getAttribute('data-version'))
      .toBe('restarting'));
    expect(screen.getByTestId('agent-version-old').textContent).toBe('재기동 중…');

    // 나가는 것을 **관측**해서 안다(`awaitRunnerExit`, 2초 간격) — 기본 1초로는 그
    // 한 바퀴가 안 돈다.
    daemon.died('old');
    await screen.findByText(/러너 1대가 새 번들로 돌아왔다/, {}, { timeout: 5_000 });
  });

  /**
   * 띠와 카드가 **같은 화면에서 서로 다른 말을 하던** 자리(실측 스크린샷). 사람이 그
   * 비활성 버튼을 누르고 "눌렀는지 알 수가 없다"고 말한 것이 이 어긋남이다.
   */
  it('뒤처진 러너가 남의 기기 것이면 "전부 최신"이라고 하지 않는다', async () => {
    const daemon = fakeDaemon([liveRunner('fresh', true)]);
    await boot(
      [
        agentView('fresh', { runnerVersion: '0.1.15' }),
        // 이 앱이 안 띄운 러너다 — `runnerStates` 에 없으므로 버튼의 대상이 아니다.
        agentView('other', { runnerVersion: '0.1.6', ownerAccountId: 'u2' }),
      ],
      ['fresh', 'other'],
      daemon,
      '0.1.15',
    );
    render(<AgentsSettings />);

    // 대상은 그대로 0 이다 — 남의 러너를 여기서 재기동하면 그 PAT·소유가 이 기기로 옮겨 온다.
    const button = await screen.findByRole('button', { name: /뒤처진 러너 전체 재기동 \(0\)/ });
    expect(button.hasAttribute('disabled')).toBe(true);
    // 바뀌는 것은 **말**이다. 카드가 `· 뒤처짐` 을 달고 있는 옆에서 "전부 이 번들이다"는 거짓이다.
    await screen.findByText(/뒤처진 러너 1대는 다른 기기의 것이라/);
    expect(screen.queryByText('도는 러너가 전부 이 번들이다.')).toBeNull();
    expect(screen.getByTestId('agent-version-other').getAttribute('data-version')).toBe('stale');
  });

  /**
   * 실시간 갱신. `agents` 를 읽는 자리가 마운트 한 번뿐이었고, 그것이 *"다른 화면을
   * 갔다가 와야 해서"* 의 전부다 — 그 왕복이 이 컴포넌트를 다시 마운트시킨다.
   *
   * **가짜 시계를 `boot()` 뒤에 켠다.** `boot` 안의 `waitFor` 가 멈춘 시계 위에서는
   * 20초를 기다리다 죽고, `render` 앞에 켜야 폴의 `setInterval` 이 가짜 시계에 걸린다.
   */
  it('러너 버전이 바뀌면 화면을 떠나지 않아도 카드가 따라온다', async () => {
    const daemon = fakeDaemon([liveRunner('old', true)]);
    const { api } = await boot([agentView('old', { runnerVersion: '0.1.6' })], ['old'], daemon, '0.1.15');

    vi.useFakeTimers();
    render(<AgentsSettings />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('agent-version-old').getAttribute('data-version')).toBe('stale');

    // 서버가 새 버전을 들었다(러너가 새 번들로 다시 떴다).
    api.listAgents = vi.fn(async () => [agentView('old', { runnerVersion: '0.1.15' })]);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByTestId('agent-version-old').getAttribute('data-version')).toBe('current');
  });
});
