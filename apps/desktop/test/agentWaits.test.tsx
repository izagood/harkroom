/**
 * **대기**(깨움 예약) 구획 — Agents 관제 4단계.
 *
 * 이 파일이 지키는 판단 셋:
 *
 * 1. **`도는 턴 0개` 와 `기다리는 것 2개` 는 같은 화면에 함께 선다.** 그 둘이 갈려 있어야
 *    사람이 "죽었나 기다리나"를 한 자리에서 판단한다 — 예약이 스레드마다 흩어져 있던
 *    동안 관제 화면은 아무 일도 없는 것처럼 보였다.
 * 2. **신뢰도가 다르다.** 세션은 릴레이가 끊기면 알 수 없지만 깨움은 테이블에 있어 언제나
 *    알 수 있다 — 세션이 `모른다` 인 순간에도 예약은 숫자를 낸다.
 * 3. 없으면 **아무것도 그리지 않는다**. `대기 없음` 줄을 세우면 화면 절반이 부재를 설명한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import type { AgentWakeView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentWaits } from '../src/components/AgentWaits';
import { Workspace } from '../src/components/Workspace';
import { acc, chan, fakeApi, msg } from './helpers/fakeApi';

const AGENT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-09-10T00:00:00.000Z');

const wake = (over: Partial<AgentWakeView> & { id: string }): AgentWakeView => ({
  agentAccountId: AGENT,
  channelId: 'c1',
  threadRootId: 't1',
  messageId: 'm-wake',
  wakeAt: '2026-09-10T00:04:00.000Z',
  reason: 'PR #741 CI 결과 확인',
  ...over,
});

const 대기 = (wakes: AgentWakeView[], onOpenThread = vi.fn(), variant: 'panel' | 'tower' = 'tower') => {
  render(
    <AgentWaits
      variant={variant}
      snapshot={{ kind: 'known', wakes }}
      handleOf={(id) => (id === AGENT ? 'murmur' : id)}
      channelLabel={() => '#murmur'}
      onOpenThread={onOpenThread}
      now={NOW}
    />,
  );
  return onOpenThread;
};

const 판 = () => ({
  me: { ...acc('me', 'jaebin'), isAdmin: true },
  accounts: { me: { ...acc('me', 'jaebin'), isAdmin: true }, [AGENT]: acc(AGENT, 'murmur', 'agent') },
  channels: [chan('c1', 'murmur')],
  dms: [],
  online: [] as string[],
  connected: true,
  activeChannelId: 'c1',
  runnerStates: {},
});

const 앱 = (over: Partial<Parameters<typeof fakeApi>[0]> = {}) => {
  const api = fakeApi({
    agentSessions: vi.fn(async () => []),
    agentWakes: vi.fn(async () => [wake({ id: 'w1' })]),
    message: vi.fn(async () => msg('t1', 'c1', 1, '스레드')),
    ...over,
  });
  setController({
    api,
    openChannel: vi.fn().mockResolvedValue(undefined),
    openMessage: vi.fn().mockResolvedValue(undefined),
    refreshAccounts: vi.fn().mockResolvedValue(undefined),
    cancelAgentTurns: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(false),
    goForward: vi.fn().mockResolvedValue(false),
    openThread: vi.fn(), closeThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    notifyTyping: vi.fn(), send: vi.fn(), loadOlder: vi.fn(),
  } as unknown as Controller);
  useAppStore.getState().set(판());
  render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
  return api;
};

beforeEach(() => { usePrefsStore.getState().setLocale('ko'); useAppStore.getState().reset(); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

describe('줄 하나가 말하는 것 — 누가 · 왜 · 언제', () => {
  it('에이전트 · 사유 · 남은 시간이 한 줄에 선다', () => {
    대기([wake({ id: 'w1' })]);
    const row = screen.getByTestId('agent-wait-w1');
    expect(row.textContent).toContain('@murmur');
    expect(row.textContent).toContain('PR #741 CI 결과 확인');
    // **남은 시간**으로 적는다 — 사람이 재는 것은 시계가 아니라 기다림의 길이다.
    expect(screen.getByTestId('agent-wait-when-w1').textContent).toContain('4');
  });

  it('누르면 예약이 돌아갈 자리로 이동한다', () => {
    const onOpen = 대기([wake({ id: 'w1' })]);
    fireEvent.click(screen.getByTestId('agent-wait-open-w1'));
    expect(onOpen).toHaveBeenCalledWith('t1');
  });

  it('사유가 지워진 예약은 줄을 남기고 왜 빈지 적는다 — 시계는 살아 있어 깨움은 그대로 온다', () => {
    대기([wake({ id: 'w1', reason: null })]);
    const row = screen.getByTestId('agent-wait-w1');
    expect(row.textContent).toContain('지워졌다');
  });

  it('시각이 지난 예약에는 `0분 뒤` 대신 곧 온다고 적는다 — sweep 은 15초마다 돈다', () => {
    대기([wake({ id: 'w1', wakeAt: '2026-09-09T23:59:00.000Z' })]);
    expect(screen.getByTestId('agent-wait-when-w1').textContent).toBe('곧');
  });

  it('예약이 없으면 아무것도 그리지 않는다', () => {
    대기([]);
    expect(screen.queryByTestId('agent-waits')).toBeNull();
  });

  it('좁은 칸은 목록이 아니라 **수**를 낸다 — 관제탑과 한 화면에 서므로 두 벌이 되면 안 된다', () => {
    대기([wake({ id: 'w1' }), wake({ id: 'w2' })], vi.fn(), 'panel');
    expect(screen.getByTestId('agent-waits-count').textContent).toContain('2');
    expect(screen.queryByTestId('agent-wait-w1')).toBeNull();
  });

  it('못 받았을 때는 0 이라고 말하지 않고 사유를 적는다', () => {
    render(
      <AgentWaits
        variant="tower"
        snapshot={{ kind: 'unknown', reason: 'fetch failed' }}
        handleOf={() => 'murmur'}
        channelLabel={() => '#murmur'}
        onOpenThread={vi.fn()}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('agent-waits-unknown').textContent).toContain('fetch failed');
  });
});

/**
 * **이 파일의 중심 회귀선이다.** 되돌려 RED: 대기 구획을 `AgentTurns` 안으로 옮기면 도는
 * 턴이 없을 때 그 컴포넌트가 일찍 돌아가 대기까지 사라져 빨개진다.
 */
describe('배선 — 도는 턴이 없어도, 몰라도 대기는 보인다', () => {
  it('도는 턴 0개인 관제탑에도 대기 줄이 선다', async () => {
    앱();
    fireEvent.click(screen.getByTestId('rail-agents'));
    const tower = await screen.findByTestId('agent-tower');
    expect(await within(tower).findByTestId('agent-wait-w1')).toBeTruthy();
    // 두 사실이 **한 화면에** 함께 선다 — 그 조합이 "죽었나 기다리나"에 답한다.
    expect(within(tower).getByTestId('agent-turns-none')).toBeTruthy();
    // 칸은 같은 목록을 다시 세우지 않는다 — 수만 낸다(#741 이 중단 버튼에 세운 규칙).
    expect(screen.getByTestId('agent-waits-count').textContent).toContain('1');
  });

  it('세션 목록이 실패해도 대기는 그대로 온다 — 테이블에서 오는 사실이다', async () => {
    앱({ agentSessions: vi.fn(async () => { throw new Error('relay down'); }) });
    fireEvent.click(screen.getByTestId('rail-agents'));
    const tower = await screen.findByTestId('agent-tower');
    await within(tower).findByTestId('agent-turns-unknown');
    expect(await within(tower).findByTestId('agent-wait-w1')).toBeTruthy();
  });

  it('예약도 세션처럼 한 번만 묻는다 — 칸과 관제탑이 같은 폴러를 쓴다', async () => {
    const api = 앱();
    fireEvent.click(screen.getByTestId('rail-agents'));
    await screen.findByTestId('agent-tower');
    await waitFor(() => expect(api.agentWakes).toHaveBeenCalled());
    expect(api.agentWakes).toHaveBeenCalledTimes(1);
  });
});
