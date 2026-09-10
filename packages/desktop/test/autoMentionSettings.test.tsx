import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import type { ChannelAutoMentionRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { usePrefsStore } from '../src/state/prefsStore';
import { acc, chan } from './helpers/fakeApi';

/**
 * 자동 멘션 설정 절(#173) — 채널 멤버 패널 안.
 *
 * admin 은 에이전트마다 토글을, 나머지는 켜진 것만 읽기 전용으로 본다. 서버가 403 을 줄
 * 조작을 화면이 내주면 "할 수 있다"는 거짓 신호다(docs/design.md §4).
 */
const row = (
  channelId: string, agentAccountId: string, handle: string, mode: ChannelAutoMentionRow['mode'] = 'always',
): ChannelAutoMentionRow =>
  ({ channelId, agentAccountId, handle, mode, createdBy: 'ad', createdAt: new Date().toISOString() });

const fakeController = (rows: ChannelAutoMentionRow[]) => {
  const current = { rows };
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    toggleChannelStar: vi.fn(), send: vi.fn(), openThread: vi.fn(), loadOlder: vi.fn(),
    loadChannelMembers: vi.fn(async (channelId: string) => {
      const store = useAppStore.getState();
      store.set({ channelMembers: { ...store.channelMembers, [channelId]: [] } });
      return [];
    }),
    loadChannelAutoMentions: vi.fn(async (channelId: string) => {
      const store = useAppStore.getState();
      store.set({ channelAutoMentions: { ...store.channelAutoMentions, [channelId]: current.rows } });
      return current.rows;
    }),
    setChannelAutoMention: vi.fn(async (channelId: string, agentId: string, mode: ChannelAutoMentionRow['mode']) => {
      current.rows = [
        ...current.rows.filter((r) => r.agentAccountId !== agentId),
        row(channelId, agentId, agentId, mode),
      ];
      await c.loadChannelAutoMentions(channelId);
    }),
    unsetChannelAutoMention: vi.fn(async (channelId: string, agentId: string) => {
      current.rows = current.rows.filter((r) => r.agentAccountId !== agentId);
      await c.loadChannelAutoMentions(channelId);
    }),
  };
  setController(c as unknown as Controller);
  return c;
};

const seed = (opts: { admin: boolean }) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'me'), isAdmin: opts.admin },
    accounts: {
      u1: { ...acc('u1', 'me'), isAdmin: opts.admin },
      u2: acc('u2', 'other'),
      a1: acc('a1', 'fizz', 'agent'),
      a2: acc('a2', 'honey', 'agent'),
      a3: acc('a3', 'sleepy', 'agent', false, { disabled: true }),
    },
    channels: [chan('c1', 'general')],
    dms: [], connected: true,
  });
};

const sidebar = () => render(
  <Sidebar panel="home" onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenAgentConfig={() => {}} onOpenProfile={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />,
);

const openSection = async (): Promise<HTMLElement> => {
  // 행 자체가 트리거다(`⋯` 버튼은 없앴다) — 우클릭으로 연다.
  fireEvent.contextMenu(screen.getByRole('button', { name: /# general\b/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: '멤버 보기' }));
  return await screen.findByTestId('auto-mentions-c1');
};

// **언어를 한국어로 고정한다.** 이 파일의 축들은 사이드바의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(#619 가 대기 사슬에서
// 세운 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면
// 한국어라고 말해야 한다 — 그리고 그렇게 적어 두면 이 축들이 무엇을 재는지가 오히려
// 또렷해진다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => { vi.clearAllMocks(); usePrefsStore.getState().setLocale('ko'); });
afterEach(() => { cleanup(); usePrefsStore.getState().setLocale('system'); });

const modeSelect = (section: HTMLElement, handle: string): HTMLSelectElement =>
  within(section).getByRole('combobox', { name: `이 채널이 @${handle} 를 데리는 방식` }) as HTMLSelectElement;

describe('자동 멘션 설정 (#173, 모드 048)', () => {
  it('admin 은 에이전트마다 세 값을 고르고, 고른 값이 컨트롤러로 간다', async () => {
    seed({ admin: true });
    const c = fakeController([row('c1', 'a1', 'fizz')]);
    sidebar();

    const section = await openSection();
    await waitFor(() => expect(within(section).queryByText('불러오는 중…')).toBeNull());

    expect(modeSelect(section, 'fizz').value).toBe('always');
    // 걸리지 않은 에이전트는 '없음' 이다 — 없는 행과 꺼진 행은 같은 것이다.
    expect(modeSelect(section, 'honey').value).toBe('off');
    // 비활성 에이전트는 켤 수 없다 — 서버가 400 을 주는 조작은 내주지 않는다.
    expect(within(section).queryByRole('combobox', { name: '이 채널이 @sleepy 를 데리는 방식' })).toBeNull();
    // 사람은 목록에 없다 — 에이전트만 자동 멘션할 수 있다.
    expect(within(section).queryByText('@other')).toBeNull();
    // 배지는 고른 값과 **같은 말**을 한다. 두 값이 한 배지를 쓰면 화면은 둘을 구분하지 못한다.
    expect(within(modeSelect(section, 'fizz').closest('li')!).queryAllByText('자동')).toHaveLength(1);
    expect(within(modeSelect(section, 'honey').closest('li')!).queryByText('자동')).toBeNull();

    // 켜는 것이 곧 '매 줄에' 가 아니다 — 부를 수 있게만 두는 값이 따로 있다.
    fireEvent.change(modeSelect(section, 'honey'), { target: { value: 'available' } });
    expect(c.setChannelAutoMention).toHaveBeenCalledWith('c1', 'a2', 'available');
    await waitFor(() => expect(modeSelect(section, 'honey').value).toBe('available'));
    expect(within(modeSelect(section, 'honey').closest('li')!).queryAllByText('부를 수 있음')).toHaveLength(1);
    // '부를 수 있게' 인 줄에 '자동' 이 붙으면 매 줄에 붙는다는 거짓말이 된다.
    expect(within(modeSelect(section, 'honey').closest('li')!).queryByText('자동')).toBeNull();

    // 세기를 바꾸는 것도 같은 한 컨트롤이다 — 지웠다 다시 거는 길을 만들지 않는다.
    fireEvent.change(modeSelect(section, 'fizz'), { target: { value: 'available' } });
    expect(c.setChannelAutoMention).toHaveBeenCalledWith('c1', 'a1', 'available');

    fireEvent.change(modeSelect(section, 'honey'), { target: { value: 'off' } });
    expect(c.unsetChannelAutoMention).toHaveBeenCalledWith('c1', 'a2');
  });

  it('admin 이 아니면 읽기 전용이다 — 켜진 것만 보이고 토글이 없다', async () => {
    seed({ admin: false });
    fakeController([row('c1', 'a1', 'fizz')]);
    sidebar();

    const section = await openSection();
    await waitFor(() => expect(within(section).getByText('@fizz')).toBeTruthy());

    expect(within(section).queryAllByRole('combobox')).toEqual([]);
    expect(within(section).queryByText('@honey')).toBeNull();
    expect(within(section).getByText(/admin 만 할 수 있다/)).toBeTruthy();
  });

  it('토글 실패는 그 절 안에 사유로 남는다', async () => {
    seed({ admin: true });
    const c = fakeController([]);
    c.setChannelAutoMention.mockRejectedValueOnce(new Error('a disabled agent cannot be auto-mentioned'));
    sidebar();

    const section = await openSection();
    await waitFor(() => expect(within(section).queryByText('불러오는 중…')).toBeNull());
    fireEvent.change(modeSelect(section, 'fizz'), { target: { value: 'always' } });

    expect((await within(section).findByRole('alert')).textContent).toContain('disabled');
  });
});
