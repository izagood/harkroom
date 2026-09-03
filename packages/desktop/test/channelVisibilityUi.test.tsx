import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan } from './helpers/fakeApi';

/**
 * private 채널의 화면 쪽 회귀선(#182).
 *
 * 자물쇠는 장식이 아니다 — 이 표시가 없으면 사용자는 자기가 쓰는 글이 전원에게 가는지
 * 멤버에게만 가는지 화면 어디에서도 알 수 없다. 나가기 경고도 같은 종류다: 마지막 멤버가
 * 나가면 채널은 남되 아무도 못 보게 되는데, 그 사실을 조작 **전에** 말하지 않으면
 * 되돌릴 수 없는 일이 조용히 일어난다.
 */
const fakeController = (members: { accountId: string; handle: string }[]) => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), send: vi.fn(),
    openThread: vi.fn(), loadOlder: vi.fn(), markChannelUnread: vi.fn(),
    loadChannelMembers: vi.fn(async (channelId: string) => {
      const store = useAppStore.getState();
      store.set({ channelMembers: { ...store.channelMembers, [channelId]: members } });
      return members;
    }),
    inviteChannelMember: vi.fn(async () => members),
    leaveChannel: vi.fn(async () => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

const seed = () => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'me'), isAdmin: true },
    accounts: { u1: acc('u1', 'me'), u2: acc('u2', 'other') },
    channels: [chan('c1', 'general'), chan('c2', 'secret', null, 'private')],
    dms: [], connected: true,
  });
};

const sidebar = () => render(
  <Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} onOpenDirectory={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />,
);

const openMenuFor = (accessibleName: RegExp): void => {
  const row = screen.getByRole('button', { name: accessibleName }).closest('div')!;
  fireEvent.click(within(row).getByRole('button', { name: '⋯' }));
};

beforeEach(() => { vi.clearAllMocks(); seed(); });
afterEach(cleanup);

describe('private 채널 UI (#182)', () => {
  // 12
  it('private 채널에는 자물쇠가 있고 public 채널에는 없다', () => {
    fakeController([]);
    sidebar();

    // 자물쇠는 private 채널 하나에만 있다.
    const locks = screen.getAllByLabelText('비공개 채널');
    expect(locks.length).toBe(1);
    // 그 자물쇠가 붙은 행이 'secret' 이다 — 개수만 세면 어느 채널인지 확인하지 못한다.
    expect(screen.getByRole('button', { name: /비공개 채널 secret\b/ })).toBeTruthy();
    // public 채널의 행에는 자물쇠가 없다.
    const openRow = screen.getByRole('button', { name: /# general\b/ });
    expect(within(openRow).queryByLabelText('비공개 채널')).toBeNull();
  });

  // 13
  it('마지막 멤버가 나가려 하면 그 사실을 알리고 바로 나가지 않는다', async () => {
    const c = fakeController([{ accountId: 'u1', handle: 'me' }]);
    sidebar();

    openMenuFor(/비공개 채널 secret\b/);
    fireEvent.click(screen.getByRole('menuitem', { name: '나가기' }));

    expect(await screen.findByText(/나가면 아무도 이 채널을 볼 수 없다/)).toBeTruthy();
    // 경고만 하고 실제로 나가지는 않았다 — 알리는 것과 실행하는 것이 한 번에 일어나면
    // 경고는 사후 통보가 된다.
    expect(c.leaveChannel).not.toHaveBeenCalled();

    // 한 번 더 눌러야 실제로 나간다.
    fireEvent.click(screen.getByRole('button', { name: '정말 나가기' }));
    expect(c.leaveChannel).toHaveBeenCalledWith('c2', 'u1');
  });

  it('멤버가 여럿이면 경고 없이 바로 나간다', async () => {
    const c = fakeController([
      { accountId: 'u1', handle: 'me' }, { accountId: 'u2', handle: 'other' },
    ]);
    sidebar();

    openMenuFor(/비공개 채널 secret\b/);
    fireEvent.click(screen.getByRole('menuitem', { name: '나가기' }));

    await vi.waitFor(() => expect(c.leaveChannel).toHaveBeenCalledWith('c2', 'u1'));
    expect(screen.queryByText(/나가면 아무도 이 채널을 볼 수 없다/)).toBeNull();
  });

  it('멤버 조회 실패를 빈 목록으로 삼키지 않는다', async () => {
    const c = fakeController([]);
    c.loadChannelMembers.mockRejectedValueOnce(new Error('boom'));
    sidebar();

    openMenuFor(/비공개 채널 secret\b/);
    fireEvent.click(screen.getByRole('menuitem', { name: '멤버 보기' }));

    // 실패는 오류로 보인다. '멤버가 없다' 로 그리면 private 채널에서 그것은
    // "이 채널은 아무도 볼 수 없다" 는 거짓 사실이 된다.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('멤버가 없다')).toBeNull();
  });

  it('채널을 만들 때 비공개를 고르면 private 으로 만든다', () => {
    const c = fakeController([]);
    sidebar();

    fireEvent.click(screen.getByText('+ Create channel'));
    fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'newchan' } });
    fireEvent.click(screen.getByLabelText('비공개 (멤버만 볼 수 있다)'));
    fireEvent.click(screen.getByText('만들기'));

    expect(c.createChannel).toHaveBeenCalledWith('newchan', 'private');
  });
});
