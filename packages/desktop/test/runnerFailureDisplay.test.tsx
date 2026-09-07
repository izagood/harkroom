/**
 * #368 회귀선 — **러너 기동 실패 사유가 사람이 부른 자리에서 보인다.**
 *
 * 이 결함은 "러너가 안 떴다"가 아니라 "안 뜬 이유를 말해 주지 않는다" 였다. 사유는 앱이
 * 이미 정확히 알고 있었고, 그 문구가 닿는 자리가 설정 → Agents → 에이전트 선택 → 스크롤
 * 아래 하나뿐이었다. 그래서 이 파일이 지키는 것은 문구의 존재가 아니라 **문구가 닿는
 * 자리**다.
 *
 * ## 이 파일이 진짜 컴포넌트를 렌더하는 이유
 *
 * 앞선 판본은 상수의 값을 테스트 안에 다시 적어 자기 사본에 단언하고, 화면은 `Sidebar` 만
 * 띄워 `Agents` 라는 제목과 `@forge` 라는 글자가 있는지만 봤다. 그 상태에서 **채널 표시를
 * 통째로 지워도 desktop 1138건이 전부 초록이었다**(실측). 자리를 지키려면 그 자리를 그리는
 * 컴포넌트를 실제로 렌더해야 한다.
 *
 * ## 문구가 실행기 자신에게서 온다를 어떻게 지키나
 *
 * 테스트가 문자열을 손으로 적어 대조하면 아무것도 안 지킨다 — 하드코딩 둘이 서로 같은지
 * 보는 것일 뿐이다. 그래서 이 파일은 **실물 실행기를 실제 실패 경로로 돌려**(키체인 읽기
 * 실패 — `ensurePat` 참고) 그 실행기가 만든 `state.message` 를 받아서, 그 상태를 그대로
 * 화면에 넣고 화면에 그 글자가 나오는지 본다. 화면이 자기 문구를 새로 쓰면 실행기가 준
 * 글자가 화면에 없으므로 빨개진다.
 *
 * (`#431` 1단계 이전에는 이 실패 경로가 `runnerRepoPath` 미설정이었다 — 그 설정 자체가
 * 사라지면서 여기서도 키체인 읽기 실패로 바꿨다. 실행기가 실제로 만드는 `failed` 상태라는
 * 성질은 그대로다.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, DmView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { Sidebar } from '../src/components/Sidebar';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import {
  RunnerLauncher,
  type LoginPathReader, type RunnerApi, type RunnerSecretStore, type RunnerSpawner, type RunnerState,
} from '../src/lib/runnerLauncher';
import { fakeDaemon } from './helpers/fakeDaemon';
import { DEFAULT_PREFS, undoSendStorage } from '../src/lib/prefs';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

/** 화면에 **글자로** 나온 것만. `title` 속성은 여기 안 들어온다 — 마우스를 올려야 보이는 것은 이 이슈의 답이 아니다. */
const onScreen = () => document.body.textContent ?? '';

const AGENT_UUID = '11111111-2222-4333-8444-555555555555';

/** 이 파일의 픽스처가 재현하는 실제 실패 사유(키체인 읽기 실패). 실행기가 만드는 문구
 * 그대로를 여기 한 곳에서만 다시 적는다 — 나머지 단언은 전부 이 상수를 가리킨다. */
const KEYCHAIN_READ_FAILURE_REASON = 'boom';
const FAILURE_MESSAGE =
  `키체인을 읽지 못했다 — 돌고 있는 러너를 죽일 수 있어 새로 발급하지 않았다: ${KEYCHAIN_READ_FAILURE_REASON}`;

const failedState = (agentId: string, message: string): RunnerState =>
  ({ agentId, status: 'failed', exitCode: null, message });

/**
 * **실물 실행기를 실제 실패 경로로 돌린다.** 키체인 읽기가 실패하는 것이 그 경로다
 * (`RunnerLauncher.ensurePat`) — `runnerRepoPath` 가 있던 시절엔 그 설정 미비가 이 자리를
 * 대신했지만, `#431` 1단계에서 그 설정이 사라졌다. 어느 경로든 이 파일이 지키는 것은
 * "실행기가 실제로 만든 `state.message` 가 화면에 그대로 닿는가"이지, 실패 사유 그 자체가
 * 아니다.
 */
async function launchWithRealFailure(): Promise<RunnerState> {
  const api: RunnerApi = {
    baseUrl: 'https://murmur.example',
    listPats: vi.fn(async () => [] as { label: string; revokedAt: string | null }[]),
    mintPat: vi.fn(async (_id: string, label: string) => `murp_${label}`),
    revokePat: vi.fn(async () => ({ revoked: 0 })),
  };
  const secrets: RunnerSecretStore = {
    read: vi.fn(async () => ({ ok: false as const, error: KEYCHAIN_READ_FAILURE_REASON })),
    write: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    deviceId: vi.fn(async () => 'ab12cd34'),
  };
  const spawner: RunnerSpawner = { spawn: vi.fn() };
  const loginPath: LoginPathReader = { read: vi.fn(async () => '/login/bin') };
  const launcher = new RunnerLauncher(api, secrets, spawner, loginPath, () => 1_700_000_000_000, fakeDaemon());

  // 자동 기동이 기본으로 켜져 있다는 것이 이 결함의 전제다 — 꺼져 있으면 실행기는 아예
  // 불리지 않고 실패 상태도 안 생긴다(controller.ts::startRunners).
  expect(DEFAULT_PREFS.runnerAutoStart).toBe(true);
  await launcher.startAll({
    agents: [{ id: 'forge', handle: 'forge', ownerAccountId: 'me', disabled: false, stopRequestedAt: null }],
    myAccountId: 'me',
    liveAccountIds: new Set<string>(),
  });
  expect(spawner.spawn).not.toHaveBeenCalled();
  const state = launcher.getStates()[0]!;
  expect(state.status).toBe('failed');
  return state;
}

const channelController = () => {
  const c = {
    send: vi.fn(async () => undefined),
    openThread: vi.fn(),
    loadOlder: vi.fn(async () => undefined),
    startDm: vi.fn(async () => undefined),
    // 컴포저가 예약 목록을 읽는다(#222) — 이 표면이 없으면 채널 화면이 뜨지 않는다.
    api: scheduledApiStub(),
  };
  setController(c as unknown as Controller);
  return c;
};

const sidebarProps = {
  onOpenDirectory: () => {},
  onOpenChannelDirectory: () => {},
  onOpenInbox: () => {},
  onOpenSaved: () => {},
  onLogout: vi.fn(),
  onOpenSettings: vi.fn(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
};

const agentView = (id: string, handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

const settingsController = (agents: AgentView[]) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => ({ harness: 'claude-code', model: null, effort: null })),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    updateAgent: vi.fn(async (_id: string, _patch: Partial<AgentConfig>) => agents[0]!),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  undoSendStorage.saveWindowMs(0);
  useAppStore.getState().reset();
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------

describe('#368 채널 — 부른 자리에서 사유가 보인다', () => {
  /**
   * 채널 하나에 사람 하나·에이전트 하나. `body` 는 각 테스트가 정한다 — '불렀다'의 판정이
   * **본문**이라는 것이 이 이슈의 핵이라서다.
   */
  const setUpChannel = (body: string, runner: RunnerState | null, agentId = 'forge') => {
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin'), [agentId]: acc(agentId, 'forge', 'agent') },
      channels: [chan('c1', 'general')],
      dms: [],
      activeChannelId: 'c1',
      messages: { c1: [msg('m1', 'c1', 1, body, 'u1')] },
      runnerStates: runner ? { [runner.agentId]: runner } : {},
    });
  };

  it('손으로 @멘션한 에이전트의 러너가 failed 면 그 사유가 채널에 뜬다', async () => {
    // 이슈의 재현 그대로다: 새 채널에서 `@forge 안녕` 을 친다. 자동 멘션 설정은 없다.
    const state = await launchWithRealFailure();
    channelController();
    setUpChannel('@forge 안녕', state);

    render(<ChannelPane />);

    expect(screen.getByTestId('channel-runner-failure')).toBeTruthy();
    // 실행기가 만든 문구가 **글자로** 나온다. 화면이 자기 문구를 쓰면 이 줄이 빨개진다.
    expect(onScreen()).toContain(state.message);
    // 그 문구가 이 파일의 상수와 같은 것이라는 사실도 함께 고정한다 — 상수를 통해
    // 대조한다(테스트에 같은 문자열을 다시 적으면 하드코딩 둘을 비교하는 것뿐이다).
    expect(state.message).toBe(FAILURE_MESSAGE);
    // 원문 오류(`KEYCHAIN_READ_FAILURE_REASON`)가 그대로 남아 있어야 한다 — 앱이 사유를
    // 지어내 원문을 삼키면 사람은 진짜 원인을 못 보고 앱이 만든 설명만 본다(`#368`).
    expect(FAILURE_MESSAGE).toContain(KEYCHAIN_READ_FAILURE_REASON);
  });

  it('정규화된 본문(`<@id>` 토큰)에서도 뜬다 — 평문만 보면 이 경로에서 조용히 안 뜬다', async () => {
    const state = failedState(AGENT_UUID, FAILURE_MESSAGE);
    channelController();
    setUpChannel(`<@${AGENT_UUID}> 안녕`, state, AGENT_UUID);

    render(<ChannelPane />);

    expect(screen.getByTestId('channel-runner-failure')).toBeTruthy();
    expect(onScreen()).toContain(FAILURE_MESSAGE);
  });

  it('러너가 정상이면 안 뜬다 — 늘 떠 있으면 안내가 아니라 소음이다', async () => {
    channelController();
    setUpChannel('@forge 안녕', { agentId: 'forge', status: 'running', exitCode: null, message: null });

    render(<ChannelPane />);

    expect(screen.queryByTestId('channel-runner-failure')).toBeNull();
  });

  it('아무도 멘션하지 않은 채널에서는 안 뜬다 — 러너가 failed 여도', async () => {
    // 러너 상태는 실패다. 그런데 이 채널에서 그 에이전트를 부른 적이 없다. 부르지 않은
    // 상대의 사정을 매 채널에 띄우면 그것도 소음이다.
    channelController();
    setUpChannel('오늘 배포 얘기만 한다', failedState('forge', FAILURE_MESSAGE));

    render(<ChannelPane />);

    expect(screen.queryByTestId('channel-runner-failure')).toBeNull();
    expect(onScreen()).not.toContain(FAILURE_MESSAGE);
  });

  /**
   * **`#476`** — 하네스가 없어 물러난 러너는 이 띠가 **서지 않았다.**
   *
   * 판정이 `state?.status === 'failed'` 하나였고, `#473` 이 만든 `needs_harness` 는
   * 거기 안 들었다. 그래서 사람은 멘션을 보내고 답을 기다리다 포기했다 —
   * 이 파일 머리말이 적은 실패 방식("보내고 기다리다 포기했다")이 새 상태에서 그대로
   * 되살아나 있었다.
   *
   * **새 사용자의 기본 상태가 이것**이라 더 나쁘다(`claude`·`codex` 는 사용자가 직접
   * 설치한다, 2026-09-06 방침). 처음 멘션한 사람이 가장 먼저 만나는 상태가 화면에서
   * 가장 조용했다.
   *
   * **되돌려 RED**: `ChannelPane` 의 `|| state?.status === 'needs_harness'` 를 지우면
   * 띠가 통째로 사라져 빨개진다. 실제로 되돌려 실행해 확인했다.
   */
  it('하네스가 없어 물러난 러너도 부른 자리에서 사유와 설치처를 말한다 (#476)', async () => {
    channelController();
    const message =
      '`claude` 를 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라. Claude Code 를 설치하면 함께 깔린다: https://claude.com/product/claude-code';
    setUpChannel('@forge 안녕', {
      agentId: 'forge', status: 'needs_harness', exitCode: 78, message,
    });

    render(<ChannelPane />);

    const strip = screen.getByTestId('channel-runner-failure');
    expect(strip.dataset.runnerStatus).toBe('needs_harness');
    // **설치처가 글자로 온다.** `title` 툴팁에만 있으면 아무도 안 읽는다(이 파일의 규율).
    expect(onScreen()).toContain(message);
    expect(onScreen()).toContain('https://claude.com/product/claude-code');
    // 고장이 아니라 **설치가 아직 안 된 것**이다 — 붉은 띠로 세우면 사람은 앱이 망가진
    // 줄 알고 사유 줄을 안 읽는데, 할 일은 정확히 그 줄에만 있다.
    expect(strip.className).toContain('border-warning-border');
    expect(strip.className).not.toContain('border-danger-border');
  });

  /**
   * 2026-09-07 16:09 — `#476` 이 고친 실패 방식이 **또 다른 새 상태에서 되살아났다.**
   *
   * forge 의 claude 로그인이 만료되자 러너는 78 로 물러났고, 사람은 멘션을 두 번 보내고
   * "(답변에 실패했습니다 — 운영자 확인이 필요합니다)" 두 줄을 받았다. 무엇을 확인해야
   * 하는지는 어디에도 없었다. 사용자의 말이 정확히 이것이다: *"그럼 다시 로그인 할 수
   * 있게 알려줬어야지"*.
   *
   * **되돌려 RED**: `ChannelPane` 의 `needs_login` 조건을 지우면 띠가 사라져 빨개진다.
   */
  it('하네스 로그인이 풀린 러너도 부른 자리에서 재로그인 방법을 말한다', async () => {
    channelController();
    const message = '`claude` 로그인이 풀렸다 — 터미널에서 `claude` 를 실행해 다시 로그인하면 살아난다';
    setUpChannel('@forge 계획대로 구현 진행해', {
      agentId: 'forge', status: 'needs_login', exitCode: 78, message,
    });

    render(<ChannelPane />);

    const strip = screen.getByTestId('channel-runner-failure');
    expect(strip.dataset.runnerStatus).toBe('needs_login');
    expect(onScreen()).toContain(message);
    // 고장이 아니라 **사람이 한 단계를 해야 하는 것**이다 — 하네스 부재와 같은 톤이다.
    expect(strip.className).toContain('border-warning-border');
    expect(strip.className).not.toContain('border-danger-border');
  });

  /**
   * **대조군 — 다른 사유는 다른 띠다.**
   *
   * 없으면 위 회귀선은 "모든 상태에 띠를 세우는" 구현으로도 통과한다(그러면 정상인
   * 러너에도 뜨고, 그것은 안내가 아니라 소음이다). 그리고 `failed` 쪽이 여전히 붉은지도
   * 함께 잰다 — 두 상태가 같은 모습이 되면 사람이 할 일이 다시 뭉친다.
   */
  it('대조군 — 기동 실패는 여전히 붉은 띠이고 설치 이야기를 하지 않는다 (#476)', async () => {
    const state = await launchWithRealFailure();
    channelController();
    setUpChannel('@forge 안녕', state);

    render(<ChannelPane />);

    const strip = screen.getByTestId('channel-runner-failure');
    expect(strip.dataset.runnerStatus).toBe('failed');
    expect(strip.className).toContain('border-danger-border');
    expect(onScreen()).not.toContain('https://');
  });

  /**
   * **대조군 — `needs_reissue` 는 이 띠에 넣지 않았다.**
   *
   * 그쪽은 설정 화면에 재발급 버튼이 서고, 그 버튼 없이 여기서 사유만 읽어도 사람이 할
   * 수 있는 일이 없다. 그리고 `#473` 이전부터 이 띠에 없었으므로 이 이슈가 바꿀 자리가
   * 아니다 — **범위를 넘지 않았다는 것 자체를 고정한다.**
   */
  it('대조군 — 자격증명 재발급 상태는 이 띠를 세우지 않는다 (#476 범위)', async () => {
    channelController();
    setUpChannel('@forge 안녕', {
      agentId: 'forge', status: 'needs_reissue', exitCode: 78,
      message: 'PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다',
    });

    render(<ChannelPane />);

    expect(screen.queryByTestId('channel-runner-failure')).toBeNull();
  });

  it('DM 은 멘션이 없어도 뜬다 — 보낸 글은 전부 그 에이전트에게 간 것이다', async () => {
    channelController();
    useAppStore.getState().set({
      me: acc('u1', 'admin'),
      accounts: { u1: acc('u1', 'admin'), forge: acc('forge', 'forge', 'agent') },
      channels: [],
      dms: [{ id: 'd1', memberIds: ['u1', 'forge'], lastMessageAt: null }],
      activeChannelId: 'd1',
      messages: { d1: [msg('m1', 'd1', 1, '멘션 없이 그냥 인사', 'u1')] },
      runnerStates: { forge: failedState('forge', FAILURE_MESSAGE) },
    });

    render(<ChannelPane />);

    expect(screen.getByTestId('channel-runner-failure')).toBeTruthy();
    expect(onScreen()).toContain(FAILURE_MESSAGE);
  });
});

describe('#368 사이드바 — DM 이 없어도 사유를 읽을 수 있다', () => {
  const setUpSidebar = (dms: DmView[], runnerStates: Record<string, RunnerState>) => {
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), forge: acc('forge', 'forge', 'agent') },
      channels: [chan('c1', 'general')],
      dms,
      online: [],
      connected: true,
      activeChannelId: 'c1',
      runnerStates,
    });
  };

  it('DM 이 하나도 없어도 사유가 글자로 보인다', async () => {
    const state = await launchWithRealFailure();
    channelController();
    setUpSidebar([], { forge: state });

    render(<Sidebar panel="agents" {...sidebarProps} />);

    // 이름만 있는 것으로는 안 된다 — 이 결함의 본질이 "사유가 사람이 안 보는 곳에만 있다" 였다.
    expect(screen.getByText('@forge')).toBeTruthy();
    expect(screen.getByTestId('runner-reason-forge').textContent).toContain(state.message);
    expect(state.message).toBe(FAILURE_MESSAGE);
  });

  it('러너가 정상이면 사이드바에도 사유 줄이 없다', () => {
    channelController();
    setUpSidebar([], { forge: { agentId: 'forge', status: 'running', exitCode: null, message: null } });

    render(<Sidebar panel="agents" {...sidebarProps} />);

    expect(screen.getByText('@forge')).toBeTruthy();
    expect(screen.queryByTestId('runner-reason-forge')).toBeNull();
  });

  it('에이전트가 없으면 Agents 섹션 자체가 없다', () => {
    channelController();
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true) },
      channels: [chan('c1', 'general')],
      dms: [], online: [], connected: true, activeChannelId: 'c1', runnerStates: {},
    });

    render(<Sidebar panel="agents" {...sidebarProps} />);

    expect(screen.queryByText('Agents')).toBeNull();
  });
});

describe('#368 설정 → Agents 목록 — presence 문구로 끝내지 않는다', () => {
  it('러너가 failed 면 카드가 붉은 테와 ↻ 를 받고 사유가 목록 아래에 선다', async () => {
    const forge = agentView('forge', 'forge');
    settingsController([forge]);
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), forge },
      connected: true,
      online: [],
      runnerStates: { forge: { agentId: 'forge', status: 'failed', exitCode: 1, message: '노드를 찾지 못했다' } },
    });

    render(<AgentsSettings />);

    /**
     * **Task 15-2 로 자리가 바뀌었다.** 카드는 조용해야 하므로(문서) presence 글자는 상세로
     * 내려갔지만, **#368 이 지키는 것은 "사유가 닿는 자리"** 다 — 그래서 목록에서 여전히
     * 보여야 한다. 사진이 상태를 말하고(붉은 테 + ↻) 사유만 글자로 남는다.
     */
    const card = await screen.findByTestId('agent-card-forge');
    expect(card.dataset.face).toBe('failed');
    expect(screen.getByTestId('agent-relaunch-forge')).toBeTruthy();
    // 사유는 여전히 **목록에서** 읽힌다 — 툴팁이 아니라 글자다.
    expect(screen.getByTestId('agent-runner-failed-forge').textContent).toContain('노드를 찾지 못했다');
  });

  it('러너가 정상이면 아무 장식도 없다 — 정상이 기본값이다', async () => {
    const forge = agentView('forge', 'forge');
    settingsController([forge]);
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), forge },
      connected: true,
      online: ['forge'],
      runnerStates: {},
    });

    render(<AgentsSettings />);

    const card = await screen.findByTestId('agent-card-forge');
    expect(card.dataset.face).toBe('ok');
    // 40개 중 38개가 이 모습이면 화면이 조용하다 — 정상에는 표시를 붙이지 않는다.
    expect(screen.queryByTestId('agent-relaunch-forge')).toBeNull();
    expect(screen.queryByTestId('agent-runner-failed-forge')).toBeNull();
  });
});
