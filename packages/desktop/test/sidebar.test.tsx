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

    fireEvent.click(screen.getByRole('button', { name: /@admin/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    // 섹션을 지목하지 않고 연다 — 설정 화면이 기본 섹션을 고른다.
    expect(onOpenSettings).toHaveBeenCalledWith();

    fireEvent.click(screen.getByRole('button', { name: '+ Add or edit agents' }));
    expect(onOpenSettings).toHaveBeenLastCalledWith('agents');
  });

  describe('계정 메뉴', () => {
    it('계정 행이 클릭 가능한 트리거다', () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      // ARIA 1.1 의 값은 'menu' 다 — 'true' 는 레거시 별칭이라 어느 종류의 팝업인지 말하지 못한다.
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    });

    it('계정 행을 클릭하면 메뉴가 열린다', () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      fireEvent.click(trigger);

      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      expect(screen.getByRole('menu')).toBeTruthy();
    });

    it('메뉴 안의 Settings 를 누르면 onOpenSettings 가 불린다', () => {
      fakeController();
      const onOpenSettings = vi.fn();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={onOpenSettings} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      fireEvent.click(trigger);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
      expect(onOpenSettings).toHaveBeenCalledWith();
    });

    it('메뉴 안의 Sign out 을 누르면 controller.logout 과 onLogout 이 불린다', () => {
      const c = fakeController();
      const onLogout = vi.fn();
      render(<Sidebar onLogout={onLogout} onOpenSettings={vi.fn()} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      fireEvent.click(trigger);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
      expect(c.logout).toHaveBeenCalled();
      expect(onLogout).toHaveBeenCalled();
    });

    it('Escape 로 닫히고 포커스가 트리거로 돌아온다', () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      fireEvent.click(trigger);
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it('바깥을 클릭하면 닫힌다', () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      fireEvent.click(trigger);
      expect(screen.getByRole('menu')).toBeTruthy();

      fireEvent.mouseDown(document.body);
      fireEvent.click(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('화살표 키로 항목 사이를 이동한다', async () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      const trigger = screen.getByRole('button', { name: /@admin/ });
      fireEvent.click(trigger);

      const settings = screen.getByRole('menuitem', { name: 'Settings' });
      const signout = screen.getByRole('menuitem', { name: 'Sign out' });

      await waitFor(() => expect(document.activeElement).toBe(settings));
      fireEvent.keyDown(settings, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(signout);
      fireEvent.keyDown(signout, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(settings);
    });

    it('메뉴가 닫혀 있을 때는 role="menu" 가 문서에 없다', () => {
      fakeController();
      render(<Sidebar onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

      expect(screen.queryByRole('menu')).toBeNull();
    });

    // 항목은 `<button>` 이라 Enter·Space 는 브라우저가 **click 으로** 바꿔 준다. 그래서
    // 프리미티브에 Enter/Space keydown 핸들러를 따로 두지 않는다 — 두면 실제 브라우저에서
    // keydown 핸들러와 native click 이 **둘 다** 돌아 onSelect 가 두 번 실행된다
    // (Sign out 이 두 번 불리는 식). 그래서 활성화는 click 으로 검증한다.
    it('항목을 활성화하면 그 동작이 실행되고 메뉴가 닫힌다', () => {
      const c = fakeController();
      const onLogout = vi.fn();
      render(<Sidebar onLogout={onLogout} onOpenSettings={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /@admin/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));

      expect(c.logout).toHaveBeenCalledTimes(1);
      expect(onLogout).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('menu')).toBeNull();
    });

  });
});
