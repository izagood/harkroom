import { describe, it, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { Workspace } from '../src/components/Workspace';
import { sidebarStorage, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_PREFS } from '../src/lib/prefs';
import { acc, chan } from './helpers/fakeApi';

const fakeController = () => {
  const c = {
    openChannel: vi.fn().mockResolvedValue(undefined),
    startDm: vi.fn(),
    logout: vi.fn(),
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(),
    toggleChannelStar: vi.fn(),
    goBack: vi.fn().mockImplementation(async () => {
      const store = useAppStore.getState();
      const entry = store.goBack();
      if (entry) {
        store.set({ historyIndex: store.historyIndex - 1, activeChannelId: entry.channelId });
        return true;
      }
      return false;
    }),
    goForward: vi.fn().mockImplementation(async () => {
      const store = useAppStore.getState();
      const entry = store.goForward();
      if (entry) {
        store.set({ historyIndex: store.historyIndex + 1, activeChannelId: entry.channelId });
        return true;
      }
      return false;
    }),
  };
  setController(c as unknown as Controller);
  return c;
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.getState().set({
    me: acc('u1', 'admin'),
    accounts: { u1: acc('u1', 'admin'), u2: acc('u2', 'bot', 'agent') },
    channels: [chan('c1', 'general'), chan('c2', 'dev')],
    dms: [{ id: 'd1', memberIds: ['u1', 'u2'] }],
    online: ['u2'],
    connected: true,
    activeChannelId: 'c1',
  });
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('사이드바 너비 조절', () => {
  it('드래그로 너비가 바뀐다', () => {
    fakeController();
    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(separator).toBeTruthy();

    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(document, { clientX: 300 });
    fireEvent.mouseUp(document);

    const aside = container.querySelector('aside');
    expect(aside).toBeTruthy();
    expect(aside?.style.width).toBe('300px');
  });

  it('최소를 넘겨 끌어도 clamp 된다', () => {
    fakeController();
    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(document, { clientX: 50 });
    fireEvent.mouseUp(document);

    const aside = container.querySelector('aside');
    expect(Number(aside?.style.width.replace('px', ''))).toBeGreaterThanOrEqual(MIN_SIDEBAR_WIDTH);
  });

  it('최대를 넘겨 끌어도 clamp 된다', () => {
    fakeController();
    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    fireEvent.mouseDown(separator);
    fireEvent.mouseMove(document, { clientX: 1000 });
    fireEvent.mouseUp(document);

    const aside = container.querySelector('aside');
    expect(Number(aside?.style.width.replace('px', ''))).toBeLessThanOrEqual(MAX_SIDEBAR_WIDTH);
  });

  it('화살표 키로도 너비가 바뀐다', () => {
    fakeController();
    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(separator).toBeTruthy();
    separator.focus();

    fireEvent.keyDown(separator, { key: 'ArrowRight' });

    const aside = container.querySelector('aside');
    expect(Number(aside?.style.width.replace('px', ''))).toBeGreaterThan(240);
  });

  it('너비가 localStorage에 남고 다시 마운트하면 복원된다', () => {
    fakeController();
    sidebarStorage.saveWidth(350);

    const { container, unmount } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const aside = container.querySelector('aside');
    expect(aside?.style.width).toBe('350px');

    unmount();

    const { container: container2 } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const aside2 = container2.querySelector('aside');
    expect(aside2?.style.width).toBe('350px');
  });

  it('localStorage가 던져도 기본 너비로 정상 렌더링된다', () => {
    fakeController();
    // `vi.spyOn(localStorage, 'getItem')` 은 jsdom 에서 **적용되지 않는다** — 그렇게 쓰면
    // 저장소가 그냥 비어 있는 경우를 확인할 뿐이라, try/catch 를 지워도 초록이다.
    // 접근이 막힌 브라우저(사생활 보호 모드 등)를 재현하려면 프로토타입을 가로채야 한다.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    onTestFinished(() => spy.mockRestore());

    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()} />
    );

    const aside = container.querySelector('aside');
    expect(aside?.style.width).toBe(`${DEFAULT_PREFS.sidebarWidth}px`);
  });
});

describe('사이드바 접기', () => {
  it('접으면 사이드바가 사라진다', () => {
    fakeController();
    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={true} onToggleCollapse={vi.fn()} />
    );

    const aside = container.querySelector('aside');
    expect(aside?.style.width).toBe('0px');
  });

  it('접을 때 토글 콜백이 불린다', () => {
    fakeController();
    const onToggleCollapse = vi.fn();
    const { container } = render(
      <Sidebar onOpenDirectory={() => {}} onLogout={vi.fn()} onOpenSettings={vi.fn()} collapsed={false} onToggleCollapse={onToggleCollapse} />
    );

    const collapseButton = container.querySelector('[aria-label="사이드바 접기"]') as HTMLButtonElement;
    fireEvent.click(collapseButton);

    expect(onToggleCollapse).toHaveBeenCalled();
  });
});

describe('뒤로/앞으로 탐색', () => {
  it('채널 A → B 이동 후 뒤로 가면 controller.goBack이 호출된다', async () => {
    const c = fakeController();
    useAppStore.getState().set({
      channels: [chan('c1', 'general'), chan('c2', 'dev'), chan('c3', 'random')],
      history: [
        { channelId: 'c1', threadRootId: null },
        { channelId: 'c2', threadRootId: null },
      ],
      historyIndex: 1,
    });

    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    const backButton = screen.getByLabelText('뒤로') as HTMLButtonElement;
    fireEvent.click(backButton);

    expect(c.goBack).toHaveBeenCalled();
  });

  // 이름이 약속한 "historyIndex 가 감소한다" 는 가짜 컨트롤러로는 확인할 수 없다 —
  // 실제 이동 로직은 `historyNav.test.ts` 가 진짜 Controller 로 검증한다.
  // 여기서는 화면이 컨트롤러를 부르는지만 본다.
  it('갈 곳이 없으면 뒤로 버튼이 비활성화된다', () => {
    fakeController();
    useAppStore.getState().set({
      history: [{ channelId: 'c1', threadRootId: null }],
      historyIndex: 0,
    });

    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    const backButton = screen.getByLabelText('뒤로') as HTMLButtonElement;
    expect(backButton).toHaveProperty('disabled', true);
  });

  it('갈 곳이 있으면 뒤로 버튼이 활성화된다', () => {
    fakeController();
    useAppStore.getState().set({
      history: [
        { channelId: 'c1', threadRootId: null },
        { channelId: 'c2', threadRootId: null },
      ],
      historyIndex: 1,
    });

    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    const backButton = screen.getByLabelText('뒤로') as HTMLButtonElement;
    expect(backButton).toHaveProperty('disabled', false);
  });
});

describe('키보드 단축키', () => {
  it('입력 요소에 포커스가 있으면 단축키를 가로채지 않는다', () => {
    const c = fakeController();
    useAppStore.getState().set({
      history: [
        { channelId: 'c1', threadRootId: null },
        { channelId: 'c2', threadRootId: null },
      ],
      historyIndex: 1,
    });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();

    fireEvent.keyDown(input, { key: '[', metaKey: true });
    fireEvent.keyDown(input, { key: ']', metaKey: true });
    fireEvent.keyDown(input, { key: '\\', metaKey: true });

    // 컴포저에서 대괄호를 치는 동안 채널이 바뀌거나 사이드바가 접히면 안 된다.
    expect(c.goBack).not.toHaveBeenCalled();
    expect(c.goForward).not.toHaveBeenCalled();
    expect(screen.getByText('murmur')).toBeTruthy();

    document.body.removeChild(input);
  });

  it('입력 밖에서는 단축키가 동작한다 — 위 테스트가 전부를 막고 있지 않다', () => {
    const c = fakeController();
    useAppStore.getState().set({
      history: [
        { channelId: 'c1', threadRootId: null },
        { channelId: 'c2', threadRootId: null },
      ],
      historyIndex: 1,
    });
    render(<Workspace onLogout={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.keyDown(document.body, { key: '[', metaKey: true });

    expect(c.goBack).toHaveBeenCalled();
  });
});
