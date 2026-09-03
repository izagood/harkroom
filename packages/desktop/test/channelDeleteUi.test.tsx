import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { Controller, setController, type Controller as ControllerType } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import type { ApiClient } from '../src/lib/api';
import { acc, chan, fakeApi } from './helpers/fakeApi';

/**
 * #155 채널 삭제의 화면 쪽 보증. 서버 쪽은 `packages/server/test/channelDelete.test.ts` 가
 * 지킨다.
 *
 * 여기서 지키는 것: 삭제 항목이 **보관된 채널에만** 있고 **admin 에게만** 있다는 것,
 * 확인 단계를 거친다는 것, 확인 문구가 지울 메시지 수를 말한다는 것, 그리고 개수를
 * 못 읽었을 때 지어내지 않는다는 것.
 */

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), send: vi.fn(),
    openThread: vi.fn(), loadOlder: vi.fn(),
    channelDeleteInfo: vi.fn(async () => ({ name: 'old-project', messageCount: 1204 })),
    deleteChannel: vi.fn(async () => undefined),
  };
  setController(c as unknown as ControllerType);
  return c;
};

const archived = (id: string, name: string) => ({ ...chan(id, name), archivedAt: '2026-09-03T00:00:00.000Z' });

const seed = (isAdmin: boolean) => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: { ...acc('u1', 'me'), isAdmin },
    accounts: { u1: acc('u1', 'me') },
    channels: [chan('c1', 'general'), archived('c2', 'old-project')],
    dms: [], connected: true,
  });
};

const sidebar = () => render(
  <Sidebar onOpenDirectory={() => {}} onOpenInbox={() => {}} onOpenSaved={() => {}} onLogout={vi.fn()}
    onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />,
);

/** 보관 섹션을 펴고 그 채널의 ⋯ 메뉴를 연다. */
const openArchivedMenu = () => {
  fireEvent.click(screen.getByText(/Archived/));
  // 보관 섹션의 채널은 마지막 행이다 — 일반 목록 뒤에 온다.
  const triggers = screen.getAllByRole('button', { name: '⋯' });
  fireEvent.click(triggers[triggers.length - 1]!);
  return screen.getByRole('menu');
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); setController(null as unknown as ControllerType); });

describe('채널 삭제 UI (#155)', () => {
  // 회귀선 8. 서버가 보관되지 않은 채널의 삭제를 409 로 거절하므로, 항목을 남겨 두면
  // 눌러서 실패하는 "할 수 있다"는 거짓 신호가 된다(docs/design.md 4절).
  it('보관되지 않은 채널에는 삭제 항목이 없다', () => {
    seed(true);
    fakeController();
    sidebar();

    fireEvent.click(screen.getAllByRole('button', { name: '⋯' })[0]!);
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('보관')).toBeTruthy();
    expect(within(menu).queryByText('삭제')).toBeNull();
  });

  it('보관된 채널에는 삭제 항목이 있다', () => {
    seed(true);
    fakeController();
    sidebar();

    expect(within(openArchivedMenu()).getByText('삭제')).toBeTruthy();
  });

  // admin 만 지울 수 있다(`requireAdmin`). 비활성 항목이 아니라 부재여야 한다.
  it('admin 이 아니면 보관된 채널에도 삭제 항목이 없다', () => {
    seed(false);
    fakeController();
    sidebar();

    expect(within(openArchivedMenu()).queryByText('삭제')).toBeNull();
  });

  it('삭제는 확인 단계를 거치고, 확인 문구가 지울 메시지 수를 말한다', async () => {
    seed(true);
    const c = fakeController();
    sidebar();

    fireEvent.click(within(openArchivedMenu()).getByText('삭제'));

    // 첫 클릭으로는 지우지 않는다.
    expect(c.deleteChannel).not.toHaveBeenCalled();

    const panel = await screen.findByTestId('delete-c2');
    await waitFor(() => expect(panel.textContent).toContain('메시지 1204개'));
    expect(panel.textContent).toContain('되돌릴 수 없다');
    expect(c.channelDeleteInfo).toHaveBeenCalledWith('c2');

    fireEvent.click(within(panel).getByText('정말 삭제'));
    await waitFor(() => expect(c.deleteChannel).toHaveBeenCalledWith('c2'));
  });

  it('취소하면 지우지 않고 확인 단계가 닫힌다', async () => {
    seed(true);
    const c = fakeController();
    sidebar();

    fireEvent.click(within(openArchivedMenu()).getByText('삭제'));
    const panel = await screen.findByTestId('delete-c2');
    fireEvent.click(within(panel).getByText('취소'));

    expect(c.deleteChannel).not.toHaveBeenCalled();
    expect(screen.queryByTestId('delete-c2')).toBeNull();
  });

  /**
   * 개수 조회 실패를 0 으로 갈아 넣으면 확인 문구가 "메시지 0개를 지운다"고 거짓을 말하고,
   * 운영자는 빈 채널이라 믿고 승인한다. 못 읽었으면 확인 버튼 자체를 만들지 않는다.
   */
  it('메시지 수를 못 읽으면 개수를 지어내지 않고 확인 버튼도 없다', async () => {
    seed(true);
    const c = fakeController();
    c.channelDeleteInfo.mockImplementation(async () => { throw new Error('끊겼다'); });
    sidebar();

    fireEvent.click(within(openArchivedMenu()).getByText('삭제'));

    const panel = await screen.findByTestId('delete-c2');
    expect((await within(panel).findByRole('alert')).textContent).toContain('끊겼다');
    expect(panel.textContent).not.toContain('메시지 0개');
    expect(within(panel).queryByText('정말 삭제')).toBeNull();
    expect(c.deleteChannel).not.toHaveBeenCalled();
  });

  it('삭제 실패는 화면에 남는다 — 조용히 삼키지 않는다', async () => {
    seed(true);
    const c = fakeController();
    c.deleteChannel.mockImplementation(async () => { throw new Error('서버가 거절했다'); });
    sidebar();

    fireEvent.click(within(openArchivedMenu()).getByText('삭제'));
    const panel = await screen.findByTestId('delete-c2');
    await waitFor(() => within(panel).getByText('정말 삭제'));
    fireEvent.click(within(panel).getByText('정말 삭제'));

    expect((await within(panel).findByRole('alert')).textContent).toContain('서버가 거절했다');
  });
});

/**
 * 배선 확인. 위 테스트들은 컨트롤러를 흉내 내므로 "지웠다고 화면이 정리되는가"에 닿지
 * 않는다 — 그 자리는 컨트롤러다. 진짜 `Controller` 로 목록 갱신과 선택 비우기를 본다.
 */
describe('채널 삭제 배선 (#155)', () => {
  it('지운 채널이 목록에서 사라지고, 보고 있던 채널이면 선택이 비워진다', async () => {
    useAppStore.getState().reset();
    useAppStore.getState().set({
      me: { ...acc('u1', 'me'), isAdmin: true },
      accounts: { u1: acc('u1', 'me') },
      channels: [chan('c1', 'general'), archived('c2', 'old-project')],
      activeChannelId: 'c2',
      threadRootId: 'm9',
      dms: [], connected: true,
    });

    const deleteChannel = vi.fn(async () => undefined);
    const real = new Controller(fakeApi({
      // 삭제 뒤 서버가 주는 목록에는 c2 가 없다.
      channels: vi.fn(async () => [chan('c1', 'general')]),
      deleteChannel,
    } as unknown as Partial<ApiClient>));
    setController(real);

    await real.deleteChannel('c2');

    expect(deleteChannel).toHaveBeenCalledWith('c2');
    const state = useAppStore.getState();
    expect(state.channels.map((c) => c.id)).toEqual(['c1']);
    // 없는 채널을 가리킨 채 남으면 본문 열이 빈 채널을 그리고 작성창은 보낼 곳이 없는
    // 글을 받는다.
    expect(state.activeChannelId).toBeNull();
    expect(state.threadRootId).toBeNull();
  });

  it('보고 있지 않던 채널을 지우면 선택은 그대로다', async () => {
    useAppStore.getState().reset();
    useAppStore.getState().set({
      me: { ...acc('u1', 'me'), isAdmin: true },
      channels: [chan('c1', 'general'), archived('c2', 'old-project')],
      activeChannelId: 'c1',
      dms: [], connected: true,
    });

    const real = new Controller(fakeApi({
      channels: vi.fn(async () => [chan('c1', 'general')]),
      deleteChannel: vi.fn(async () => undefined),
    } as unknown as Partial<ApiClient>));
    setController(real);

    await real.deleteChannel('c2');

    expect(useAppStore.getState().activeChannelId).toBe('c1');
  });
});
