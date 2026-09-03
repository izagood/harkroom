import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller as C } from '../src/state/controller';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan, msg, scheduledApiStub } from './helpers/fakeApi';

afterEach(() => { cleanup(); });

// 기본은 "admin 이 보는, 에이전트가 있는 빈 채널" — 안내가 **다 나오는** 상태다.
// 각 테스트는 여기서 한 조건씩 빼서 그 안내가 사라지는지 본다.
beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin', 'human', true),
    accounts: { u1: acc('u1', 'admin', 'human', true), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general')],
    activeChannelId: 'c1',
  });
  // #222: 컴포저가 채널에 붙으면 예약 목록을 읽는다 — 그 표면이 목에 없으면 화면이 뜨지 않는다.
  setController({ openChannel: vi.fn(), openThread: vi.fn(), startDm: vi.fn(), logout: vi.fn(), api: scheduledApiStub() } as unknown as C);
});

describe('빈 채널의 다음 걸음', () => {
  it('shows the empty state when the channel has no messages', () => {
    render(<ChannelPane />);

    expect(screen.getByTestId('channel-empty-state')).toBeTruthy();
    expect(screen.getByText(/#general 에 아직 메시지가 없다/)).toBeTruthy();
  });

  it('hides the empty state once a message exists', () => {
    useAppStore.getState().set({ messages: { c1: [msg('m1', 'c1', 1, 'hello', 'u2')] } });

    render(<ChannelPane />);

    expect(screen.queryByTestId('channel-empty-state')).toBeNull();
  });

  it('draws no empty state while older history is still unloaded', () => {
    // 목록은 비었지만 서버에 과거가 남아 있다. 여기서 "아직 메시지가 없다"는 거짓이다.
    useAppStore.getState().set({ messages: { c1: [] }, hasMore: { c1: true } });

    render(<ChannelPane />);

    expect(screen.queryByTestId('channel-empty-state')).toBeNull();
    // 대신 나와야 하는 것은 과거로 가는 길이다.
    expect(screen.getByText('Load older messages')).toBeTruthy();
  });

  it('names a real agent to mention when one exists', () => {
    render(<ChannelPane />);

    expect(screen.getByText(/@bot/)).toBeTruthy();
  });

  it('omits the mention hint when the workspace has no agent', () => {
    useAppStore.getState().set({ accounts: { u1: acc('u1', 'admin', 'human', true) } });

    render(<ChannelPane />);

    expect(screen.getByTestId('channel-empty-state')).toBeTruthy();
    expect(screen.queryByText(/멘션/)).toBeNull();
  });

  it('omits the mention hint for a disabled agent', () => {
    // 비활성 에이전트는 멘션 자동완성 후보가 아니다(Composer 의 필터) — 여기서만 이름을
    // 내면 자동완성에 없는 핸들을 치라고 안내하는 셈이다.
    useAppStore.getState().set({
      accounts: { u1: acc('u1', 'admin', 'human', true), u2: { ...acc('u2', 'bot', 'agent'), disabled: true } },
    });

    render(<ChannelPane />);

    expect(screen.queryByText(/@bot/)).toBeNull();
  });

  it('omits the mention hint in an archived channel', () => {
    // 보관되면 Composer 가 사라져 멘션할 자리 자체가 없다.
    useAppStore.getState().set({ channels: [{ ...chan('c1', 'general'), archivedAt: new Date().toISOString() }] });

    render(<ChannelPane />);

    expect(screen.queryByText(/@bot/)).toBeNull();
  });

  it('omits the topic hint for a non-admin', () => {
    // `PATCH /channels/:id` 가 requireAdmin 이고 사이드바 '채널 편집'도 admin 전용이다.
    useAppStore.getState().set({
      me: acc('u1', 'member', 'human', false),
      accounts: { u1: acc('u1', 'member', 'human', false), u2: acc('u2', 'bot', 'agent') },
    });

    render(<ChannelPane />);

    expect(screen.getByTestId('channel-empty-state')).toBeTruthy();
    expect(screen.queryByText(/topic/)).toBeNull();
  });

  it('shows the topic hint to an admin', () => {
    render(<ChannelPane />);

    expect(screen.getByText(/topic 을 정할 수 있다/)).toBeTruthy();
  });

  it('draws no day divider in an empty channel', () => {
    // 메시지가 없으면 나눌 날도 없다(#220 과의 상호작용).
    render(<ChannelPane />);

    expect(screen.getByTestId('channel-empty-state')).toBeTruthy();
    expect(screen.queryAllByRole('separator')).toHaveLength(0);
  });
});
