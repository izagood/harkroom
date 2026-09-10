/**
 * **Agents 관제탑**(본문) — 개편 컨셉의 셋째 열.
 *
 * 이 파일이 지키는 것은 모양이 아니라 **자리에 관한 판단 넷**이다:
 *
 * 1. 관제탑은 **채널 자리**에 선다. 1단계가 목록 전체를 300px 칸에 접어 넣어서 스레드
 *    이름 · 하네스 · 터미널 문이 전부 떨어졌고, 그것이 사람이 지적한 어긋남이다.
 * 2. 묶음의 이름은 **스레드**다. 채널 이름만 세우면 한 채널의 두 스레드가 같은 이름으로
 *    서서 `이 스레드 턴 전부 중단` 을 무엇에 누르는지 알 수 없다.
 * 3. **중단은 한 화면에 한 벌만** 선다 — 칸은 요약이고 멈추는 것은 본문의 일이다.
 * 4. 없는 문을 그리지 않는다 — 스레드를 말하지 않은 턴에는 터미널 문이 없다.
 *
 * 버튼은 **글자로 집지 않는다**(`data-testid`) — 로케일 기본값이 바뀌면 이유 없이 빨개진다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import type { AgentSessionView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { Workspace } from '../src/components/Workspace';
import { Sidebar } from '../src/components/Sidebar';
import { AgentTurns } from '../src/components/AgentTurns';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';
import { threadTitle } from '../src/lib/agentTurns';

/** 실제 본문의 멘션은 **uuid 토큰**이다(`MENTION_TOKEN_PATTERN` — 36자). 짧은 id 로 쓰면
    이 파일이 재려는 변환 자체가 일어나지 않아 시험이 헛것을 잰다. */
const AGENT = '11111111-1111-4111-8111-111111111111';

const turn = (over: Partial<AgentSessionView> & { sessionId: string }): AgentSessionView => ({
  agentAccountId: AGENT,
  channelId: 'c1',
  threadRootId: 't1',
  harness: 'claude-code',
  startedAt: '2026-09-09T00:00:00.000Z',
  ...over,
});

const NOW = Date.parse('2026-09-09T00:14:00.000Z');

const 판 = () => ({
  me: { ...acc('me', 'jaebin'), isAdmin: true },
  accounts: {
    me: { ...acc('me', 'jaebin'), isAdmin: true },
    [AGENT]: acc(AGENT, 'murmur', 'agent'),
  },
  channels: [chan('c1', 'murmur')],
  dms: [],
  online: [] as string[],
  connected: true,
  activeChannelId: 'c1',
  runnerStates: {},
});

/** 관제탑까지 배선을 통째로 띄운다 — props 를 손으로 넘기면 `Workspace` 가 안 물린 판본도 초록이 된다. */
const 앱 = (turns: AgentSessionView[], root = msg('t1', 'c1', 1, `<@${AGENT}> Agents 탭 개편 이어서 하자`)) => {
  const api = fakeApi({
    agentSessions: vi.fn(async () => turns),
    message: vi.fn(async () => root),
  });
  setController({
    api,
    openChannel: vi.fn().mockResolvedValue(undefined),
    openMessage: vi.fn().mockResolvedValue(undefined),
    openThread: vi.fn(), closeThread: vi.fn(),
    startDm: vi.fn(), logout: vi.fn(), notifyTyping: vi.fn(),
    refreshAccounts: vi.fn().mockResolvedValue(undefined),
    cancelAgentTurns: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(), loadOlder: vi.fn(),
    goBack: vi.fn().mockResolvedValue(false),
    goForward: vi.fn().mockResolvedValue(false),
  } as unknown as Controller);
  useAppStore.getState().set(판());
  render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
  return api;
};

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); useAppStore.getState().reset(); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('자리 — 관제탑은 채널 자리에 선다', () => {
  /**
   * **이 파일의 중심 회귀선이다.** 되돌려 RED: `Workspace` 에서 `railPanel === 'agents'`
   * 분기를 지워 `ChannelPane` 만 남기면 `agent-tower` 가 없어 빨개진다.
   */
  it('Agents 칸을 고르면 관제탑이 서고 채널 자리가 비켜난다', async () => {
    앱([turn({ sessionId: 's1' })]);
    fireEvent.click(screen.getByTestId('rail-agents'));
    expect(await screen.findByTestId('agent-tower')).toBeTruthy();
    expect(screen.queryByTestId('channel-pane')).toBeNull();
  });

  it('다른 칸으로 돌아가면 채널이 다시 온다 — 관제탑은 채널을 대신하지 않고 잠시 쓴다', async () => {
    앱([turn({ sessionId: 's1' })]);
    fireEvent.click(screen.getByTestId('rail-agents'));
    await screen.findByTestId('agent-tower');
    fireEvent.click(screen.getByTestId('rail-home'));
    expect(await screen.findByTestId('channel-pane')).toBeTruthy();
    expect(screen.queryByTestId('agent-tower')).toBeNull();
  });

  /**
   * 칸과 관제탑이 **함께** 보이므로 폴러가 둘이면 같은 요청이 5초마다 두 번 나가고, 두
   * 자리가 서로 다른 순간의 숫자를 보인다. 되돌려 RED: `useAgentTurns` 를 훅마다 타이머를
   * 갖는 판본으로 되돌리면 호출이 둘이 되어 빨개진다.
   */
  it('한 화면에 두 자리가 서도 목록은 한 번만 묻는다', async () => {
    const api = 앱([turn({ sessionId: 's1' })]);
    fireEvent.click(screen.getByTestId('rail-agents'));
    await screen.findByTestId('agent-tower');
    await waitFor(() => expect(api.agentSessions).toHaveBeenCalled());
    expect(api.agentSessions).toHaveBeenCalledTimes(1);
  });
});

describe('묶음의 이름은 스레드다', () => {
  it('루트의 첫 줄이 묶음 머리에 서고, `<@id>` 는 handle 로 그려진다', async () => {
    앱([turn({ sessionId: 's1' })]);
    fireEvent.click(screen.getByTestId('rail-agents'));
    const tower = await screen.findByTestId('agent-tower');
    await waitFor(() => expect(tower.textContent).toContain('Agents 탭 개편 이어서 하자'));
    // uuid 가 제목에 새는 것을 잡는다(#271 — `bodyWithHandles` 를 지나지 않으면 그렇게 된다).
    expect(tower.textContent).not.toContain('<@');
    expect(tower.textContent).not.toContain(AGENT);
    // 채널은 사라지지 않는다 — 이름 옆에 남아 "어디의 스레드인가"를 말한다.
    expect(tower.textContent).toContain('#murmur');
  });

  it('루트를 못 받았으면 채널 이름으로 되돌아간다 — 제목을 지어내지 않는다', async () => {
    const api = fakeApi({
      agentSessions: vi.fn(async () => [turn({ sessionId: 's1' })]),
      message: vi.fn(async () => { throw new Error('nope'); }),
    });
    setController({
      api, openChannel: vi.fn().mockResolvedValue(undefined), openMessage: vi.fn(),
      refreshAccounts: vi.fn().mockResolvedValue(undefined), cancelAgentTurns: vi.fn(),
      goBack: vi.fn().mockResolvedValue(false), goForward: vi.fn().mockResolvedValue(false),
      logout: vi.fn(), notifyTyping: vi.fn(), send: vi.fn(), loadOlder: vi.fn(),
      openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(),
    } as unknown as Controller);
    useAppStore.getState().set(판());
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByTestId('rail-agents'));
    const tower = await screen.findByTestId('agent-tower');
    await waitFor(() => expect(tower.textContent).toContain('#murmur'));
  });
});

describe('본문이 폭으로 더 내는 것 — 그리고 칸이 내지 않는 것', () => {
  const 관제탑 = (turns: AgentSessionView[], onOpenTerminal = vi.fn()) => {
    render(
      <AgentTurns
        variant="tower"
        snapshot={{ kind: 'known', turns }}
        handleOf={(id) => (id === AGENT ? 'murmur' : id)}
        channelLabel={() => '#murmur'}
        threadTitleOf={() => 'Agents 탭 개편'}
        onOpenThread={vi.fn()}
        onCancelTurns={vi.fn()}
        onOpenTerminal={onOpenTerminal}
        now={NOW}
      />,
    );
    return onOpenTerminal;
  };

  it('하네스가 자기 칸을 갖고, 머리글이 수 · 스레드 수 · 가장 오래된 것을 한 줄로 낸다', () => {
    관제탑([turn({ sessionId: 's1' }), turn({ sessionId: 's2', threadRootId: 't2', startedAt: '2026-09-09T00:13:00.000Z' })]);
    expect(screen.getByTestId('agent-turn-harness-s1').textContent).toBe('claude-code');
    const sub = screen.getByTestId('agent-turns-subline').textContent ?? '';
    expect(sub).toContain('2');
    expect(sub).toContain('14');
  });

  it('터미널 문은 스레드를 말한 턴에만 선다', () => {
    const onOpenTerminal = 관제탑([
      turn({ sessionId: 's1' }),
      turn({ sessionId: 's-noroot', threadRootId: null }),
    ]);
    fireEvent.click(screen.getByTestId('agent-turn-terminal-s1'));
    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }));
    // 열 자리가 없는 턴에는 **부재**다 — 비활성이 아니다(design.md §4).
    expect(screen.queryByTestId('agent-turn-terminal-s-noroot')).toBeNull();
  });

  it('좁은 칸은 하네스 칸도 터미널 문도 내지 않는다 — 그 폭에서는 에이전트 이름이 잘린다', () => {
    render(
      <AgentTurns
        snapshot={{ kind: 'known', turns: [turn({ sessionId: 's1' })] }}
        handleOf={() => 'murmur'}
        channelLabel={() => '#murmur'}
        onOpenThread={vi.fn()}
        onOpenTerminal={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId('agent-turn-harness-s1')).toBeNull();
    expect(screen.queryByTestId('agent-turn-terminal-s1')).toBeNull();
    expect(screen.queryByTestId('agent-turns-subline')).toBeNull();
  });
});

/**
 * **중단은 한 화면에 한 벌만.** 관제탑이 칸과 항상 함께 보이므로, 칸에도 중단이 있으면
 * 같은 일을 하는 길이 두 벌 서고 사람은 매번 어느 쪽을 누를지 고른다. 되돌려 RED:
 * `Sidebar` 가 `onCancelTurns` 를 다시 넘기면 이 시험이 빨개진다.
 */
describe('칸은 요약이다', () => {
  it('칸의 목록에는 중단 버튼이 없다', async () => {
    const api = fakeApi({
      agentSessions: vi.fn(async () => [turn({ sessionId: 's1' }), turn({ sessionId: 's2', agentAccountId: 'me' })]),
      message: vi.fn(async () => msg('t1', 'c1', 1, '스레드 이름')),
    });
    setController({
      api, openChannel: vi.fn().mockResolvedValue(undefined), openMessage: vi.fn(),
      refreshAccounts: vi.fn().mockResolvedValue(undefined), cancelAgentTurns: vi.fn(),
      logout: vi.fn(), startDm: vi.fn(),
    } as unknown as Controller);
    useAppStore.getState().set(판());
    render(
      <Sidebar panel="agents" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}}
        onOpenInbox={() => {}} onOpenAgentConfig={() => {}} onOpenProfile={() => {}}
        collapsed={false} onToggleCollapse={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('agent-turns-count')).toBeTruthy());
    expect(screen.queryByTestId('agent-turns-cancel-all')).toBeNull();
    expect(screen.queryByTestId('agent-turn-cancel-s1')).toBeNull();
    expect(screen.queryByTestId('agent-turns-cancel-group-c1-t1')).toBeNull();
  });
});

/**
 * 제목을 고르는 규칙은 **순수 함수**로 잰다 — 화면을 띄워 재면 무엇이 규칙이고 무엇이
 * 배치인지 섞인다.
 */
describe('제목 — 스레드 첫 줄에서 무엇을 걷어내나', () => {
  const row = (body: string) => msg('t1', 'c1', 1, body);
  const accounts = { [AGENT]: { handle: 'murmur' } };

  it('부른 이름은 제목이 아니다 — 같은 줄의 턴 쪽에 이미 서 있다', () => {
    expect(threadTitle(row(`<@${AGENT}> Agents 탭 개편 이어서 하자`), accounts))
      .toBe('Agents 탭 개편 이어서 하자');
  });

  it('인용으로 시작하는 스레드는 인용표를 걷어낸 첫 줄을 쓴다', () => {
    expect(threadTitle(row('> 어제 말한 것\n실제 요청은 이것이다'), accounts)).toBe('어제 말한 것');
  });

  it('이름만 있는 줄이면 이름을 남긴다 — 빈 제목을 세우지 않는다', () => {
    expect(threadTitle(row(`<@${AGENT}>`), accounts)).toBe('@murmur');
  });

  it('모르는 계정은 이름이 통째로 남는다 — `@알 수 없음` 을 잘라 말을 부수지 않는다', () => {
    const title = threadTitle(row('<@22222222-2222-4222-8222-222222222222> 확인해 줘'), accounts);
    expect(title).toContain('확인해 줘');
  });

  it('빈 본문에는 제목이 없다(null) — 채널 이름으로 되돌아갈 신호다', () => {
    expect(threadTitle(row('   \n  '), accounts)).toBeNull();
  });
});
