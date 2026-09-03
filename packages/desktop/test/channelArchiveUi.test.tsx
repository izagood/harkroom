import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { ChannelPane } from '../src/components/ChannelPane';
import { acc, chan } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(),
    createChannel: vi.fn(), updateChannel: vi.fn(), archiveChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), send: vi.fn(),
    openThread: vi.fn(), loadOlder: vi.fn(),
  };
  setController(c as unknown as Controller);
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
  <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />,
);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('채널 보관 UI (#153)', () => {
  it('보관된 채널은 일반 목록이 아니라 보관 섹션에 있다', () => {
    seed(true);
    fakeController();
    sidebar();

    // 접힌 섹션이라 기본으로는 이름이 안 보인다.
    expect(screen.queryByText('old-project')).toBeNull();
    expect(screen.getByText('general')).toBeTruthy();

    fireEvent.click(screen.getByText(/Archived/));
    expect(screen.getByText('old-project')).toBeTruthy();
  });

  it('보관된 채널에서는 입력이 없고 이유가 보인다', () => {
    seed(true);
    fakeController();
    useAppStore.getState().set({ activeChannelId: 'c2', messages: { c2: [] } });

    render(<ChannelPane />);

    // 그냥 비활성만 하면 사람이 왜 안 되는지 모른다.
    expect(screen.getByText('보관된 채널이다')).toBeTruthy();
    expect(screen.queryByPlaceholderText(/^Message /)).toBeNull();
  });

  // 눌러도 403 이 나는 항목은 "할 수 있다"는 거짓 신호다 (design.md §4).
  it('admin 이 아니면 메뉴에 보관 항목이 없다', () => {
    seed(false);
    fakeController();
    sidebar();

    fireEvent.click(screen.getAllByRole('button', { name: '⋯' })[0]!);
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('보관')).toBeNull();
    expect(within(menu).queryByText('보관 해제')).toBeNull();
  });

  it('admin 이면 보관 항목이 있고 누르면 컨트롤러를 부른다', () => {
    seed(true);
    const c = fakeController();
    sidebar();

    fireEvent.click(screen.getAllByRole('button', { name: '⋯' })[0]!);
    fireEvent.click(screen.getByText('보관'));

    expect(c.archiveChannel).toHaveBeenCalledWith('c1', true);
  });
});
