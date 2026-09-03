import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import type { ChannelAutoMentionRow } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan } from './helpers/fakeApi';

/**
 * 자동 멘션 설정 절(#173) — 채널 멤버 패널 안.
 *
 * admin 은 에이전트마다 토글을, 나머지는 켜진 것만 읽기 전용으로 본다. 서버가 403 을 줄
 * 조작을 화면이 내주면 "할 수 있다"는 거짓 신호다(docs/design.md §4).
 */
const row = (channelId: string, agentAccountId: string, handle: string): ChannelAutoMentionRow =>
  ({ channelId, agentAccountId, handle, createdBy: 'ad', createdAt: new Date().toISOString() });

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
    setChannelAutoMention: vi.fn(async (channelId: string, agentId: string) => {
      current.rows = [...current.rows, row(channelId, agentId, agentId)];
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
  <Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()} onOpenChannelDirectory={vi.fn()} onOpenInbox={vi.fn()} onOpenSaved={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />,
);

const openSection = async (): Promise<HTMLElement> => {
  const rowEl = screen.getByRole('button', { name: /# general\b/ }).closest('div')!;
  fireEvent.click(within(rowEl).getByRole('button', { name: '⋯' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '멤버 보기' }));
  return await screen.findByTestId('auto-mentions-c1');
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('자동 멘션 설정 (#173)', () => {
  it('admin 은 에이전트마다 토글을 보고, 켜면 컨트롤러를 부른다', async () => {
    seed({ admin: true });
    const c = fakeController([row('c1', 'a1', 'fizz')]);
    sidebar();

    const section = await openSection();
    await waitFor(() => expect(within(section).queryByText('불러오는 중…')).toBeNull());

    const fizz = within(section).getByRole('checkbox', { name: '@fizz 자동 멘션' }) as HTMLInputElement;
    const honey = within(section).getByRole('checkbox', { name: '@honey 자동 멘션' }) as HTMLInputElement;
    expect(fizz.checked).toBe(true);
    expect(honey.checked).toBe(false);
    // 비활성 에이전트는 켤 수 없다 — 서버가 400 을 주는 조작은 내주지 않는다.
    expect(within(section).queryByRole('checkbox', { name: '@sleepy 자동 멘션' })).toBeNull();
    // 사람은 목록에 없다 — 에이전트만 자동 멘션할 수 있다.
    expect(within(section).queryByText('@other')).toBeNull();
    // '자동' 배지는 켜진 줄에만 붙는다 — 꺼진 줄에 붙으면 화면이 체크박스와 반대되는 말을 한다.
    expect(within(fizz.closest('li')!.parentElement!).queryAllByText('자동')).toHaveLength(1);
    expect(within(honey.closest('li')!).queryByText('자동')).toBeNull();

    fireEvent.click(honey);
    expect(c.setChannelAutoMention).toHaveBeenCalledWith('c1', 'a2');
    await waitFor(() => expect(
      (within(section).getByRole('checkbox', { name: '@honey 자동 멘션' }) as HTMLInputElement).checked,
    ).toBe(true));

    fireEvent.click(within(section).getByRole('checkbox', { name: '@fizz 자동 멘션' }));
    expect(c.unsetChannelAutoMention).toHaveBeenCalledWith('c1', 'a1');
  });

  it('admin 이 아니면 읽기 전용이다 — 켜진 것만 보이고 토글이 없다', async () => {
    seed({ admin: false });
    fakeController([row('c1', 'a1', 'fizz')]);
    sidebar();

    const section = await openSection();
    await waitFor(() => expect(within(section).getByText('@fizz')).toBeTruthy());

    expect(within(section).queryAllByRole('checkbox')).toEqual([]);
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
    fireEvent.click(within(section).getByRole('checkbox', { name: '@fizz 자동 멘션' }));

    expect((await within(section).findByRole('alert')).textContent).toContain('disabled');
  });
});
