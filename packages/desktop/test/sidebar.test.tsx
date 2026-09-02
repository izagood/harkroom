import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { acc, chan } from './helpers/fakeApi';

const fakeController = () => {
  const c = { openChannel: vi.fn(), startDm: vi.fn(), logout: vi.fn(), createChannel: vi.fn() };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev', 'main-repo')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
    unread: [
      { id: 1, messageId: 'm1', reason: 'mention', readAt: null, channelId: 'c2' },
      { id: 2, messageId: 'm2', reason: 'dm', readAt: null, channelId: 'd1' },
    ],
    online: ['u2'],
    connected: true,
    activeChannelId: 'c1',
  });
});

afterEach(() => {
  cleanup();
});

describe('Sidebar', () => {
  // #97: 부트스트랩 직후 채널을 만들 수단이 UI 에 없었다. POST /channels 는 admin 전용이므로
  // 일반 사용자에게 보이면 누르는 족족 403 이 된다 — 없는 것을 있다고 표시하지 않는다.
  describe('채널 만들기 (admin 전용)', () => {
    const asAdmin = (): void => {
      useAppStore.getState().set({ me: { ...acc('u1', 'admin'), isAdmin: true } });
    };

    it('admin 이 아니면 생성 수단이 보이지 않는다', () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
      expect(screen.queryByText('+ Create channel')).toBeNull();
    });

    it('admin 이면 이름을 넣어 채널을 만들 수 있다', async () => {
      const c = fakeController();
      c.createChannel.mockResolvedValue(chan('c9', 'design'));
      asAdmin();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      fireEvent.click(screen.getByText('+ Create channel'));
      fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'design' } });
      fireEvent.click(screen.getByText('만들기'));

      await waitFor(() => expect(c.createChannel).toHaveBeenCalledWith('design'));
      // 성공하면 입력 자리는 닫힌다.
      await waitFor(() => expect(screen.queryByLabelText('New channel name')).toBeNull());
    });

    it('서버가 거절하면 사용자에게 보인다 — 조용히 사라지지 않는다', async () => {
      const c = fakeController();
      c.createChannel.mockRejectedValue(new Error('이미 있는 이름이다'));
      asAdmin();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      fireEvent.click(screen.getByText('+ Create channel'));
      fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'general' } });
      fireEvent.click(screen.getByText('만들기'));

      expect((await screen.findByRole('alert')).textContent).toContain('이미 있는 이름이다');
      // 실패했으니 입력 자리는 열린 채로 남아 고쳐 쓸 수 있어야 한다.
      expect(screen.getByLabelText('New channel name')).toBeTruthy();
    });

    it('이름 규칙에 맞지 않으면 서버에 보내지 않고 안내한다', async () => {
      const c = fakeController();
      asAdmin();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      fireEvent.click(screen.getByText('+ Create channel'));
      fireEvent.change(screen.getByLabelText('New channel name'), { target: { value: 'Design Team' } });
      fireEvent.click(screen.getByText('만들기'));

      expect((await screen.findByRole('alert')).textContent).toContain('1~48자');
      expect(c.createChannel).not.toHaveBeenCalled();
    });
  });

  it('lists channels with unread badge and opens on click', () => {
    const c = fakeController();
    render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('general')).toBeTruthy();
    expect(screen.getByTestId('unread-c2').textContent).toBe('1');
    fireEvent.click(screen.getByText('dev'));
    expect(c.openChannel).toHaveBeenCalledWith('c2');
  });

  it('shows dm with peer handle, presence dot, unread badge', () => {
    fakeController();
    render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByText('bot')).toBeTruthy();
    expect(screen.getByTestId('presence-d1').dataset.online).toBe('true');
    expect(screen.getByTestId('unread-d1').textContent).toBe('1');
  });

  it('starts a new dm from account picker', () => {
    const c = fakeController();
    render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '+ New' }));
    fireEvent.click(screen.getByRole('button', { name: /bot/ }));
    expect(c.startDm).toHaveBeenCalledWith('u2');
  });

  it('opens settings, and jumps straight to agents from the agents link', () => {
    fakeController();
    const onOpenSettings = vi.fn();
    render(<Sidebar onLogout={vi.fn()} onOpenSettings={onOpenSettings} />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    // 섹션을 지목하지 않고 연다 — 설정 화면이 기본 섹션을 고른다.
    expect(onOpenSettings).toHaveBeenCalledWith();

    fireEvent.click(screen.getByRole('button', { name: '+ Add or edit agents' }));
    expect(onOpenSettings).toHaveBeenLastCalledWith('agents');
  });
});
